import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { config, schedulerFile } from '../config.js'
import { AppError, badRequest } from '../errors.js'
import { sendMessage } from './actions.js'
import { toJid } from './jid.js'
import { getSession, isSessionConnected } from './registry.js'

/**
 * Message scheduler.
 *
 * Jobs live in memory and are mirrored to a single json file so a restart does
 * not lose them. Only one timer exists at a time: it is always armed for the
 * earliest due job and re-armed whenever the job list changes.
 *
 * Like `actions.js`, this module never touches the socket directly — it goes
 * through `sendMessage` so the library stays swappable.
 */

/**
 * `setTimeout` overflows past this and fires immediately, so a job scheduled
 * further out is re-armed in chunks instead of firing early.
 */
const MAX_TIMEOUT = 2 ** 31 - 1

/** @type {Map<string, object>} */
const jobs = new Map()

let timer = null
let ticking = false
let filePath = schedulerFile()

/** Serialise disk writes so two mutations cannot interleave. */
let writeChain = Promise.resolve()

/* -------------------------------------------------------------------------- */
/* Pure helpers — no state, so `npm test` can cover the tricky parts directly. */
/* -------------------------------------------------------------------------- */

/**
 * Accept an epoch millisecond number (or a numeric string) or an ISO 8601 date.
 *
 * @param {unknown} value
 * @returns {number} epoch milliseconds
 */
export const parseScheduledAt = (value) => {
    if (value === undefined || value === null || value === '') {
        throw badRequest('"scheduledAt" is required.', 'SCHEDULED_AT_REQUIRED')
    }

    const numeric = typeof value === 'number' ? value : Number(String(value).trim())
    const timestamp = Number.isFinite(numeric) ? numeric : Date.parse(String(value))

    if (!Number.isFinite(timestamp)) {
        throw badRequest(
            '"scheduledAt" must be an epoch millisecond number or an ISO 8601 date string.',
            'SCHEDULED_AT_INVALID',
        )
    }

    return timestamp
}

/** When the earliest pending job wants to run, or `null` when none is pending. */
export const nextRunAt = (list) => {
    return list.reduce((earliest, job) => {
        if (job.status !== 'pending') {
            return earliest
        }

        return earliest === null || job.runAt < earliest ? job.runAt : earliest
    }, null)
}

/**
 * What should happen to a job that was pending when the process stopped?
 *
 * A short restart must not lose a message that was due seconds ago, but sending
 * something days late is worse than admitting it was missed, so anything past
 * the grace window is marked `missed` and left for the caller to reschedule.
 */
export const recoveredStatus = (job, now, grace) => {
    if (job.status !== 'pending') {
        return job.status
    }

    return now - job.runAt <= grace ? 'pending' : 'missed'
}

/**
 * Keep every unfinished job, plus the newest `limit` finished ones, so the list
 * cannot grow without bound.
 */
export const pruneFinished = (list, limit) => {
    const unfinished = list.filter((job) => job.status === 'pending')
    const finished = list.filter((job) => job.status !== 'pending')

    if (finished.length <= limit) {
        return list
    }

    const newest = [...finished].sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)).slice(0, limit)

    return [...unfinished, ...newest]
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

/** Drop finished jobs past the history limit. Returns how many were removed. */
const prune = () => {
    const kept = pruneFinished([...jobs.values()], config.scheduler.historyLimit)

    if (kept.length === jobs.size) {
        return 0
    }

    jobs.clear()

    for (const job of kept) {
        jobs.set(job.id, job)
    }

    return kept.length
}

/** Write through a temp file so a crash mid-write cannot truncate the real one. */
const writeNow = () => {
    prune()
    mkdirSync(dirname(filePath), { recursive: true })

    const temp = `${filePath}.tmp`

    writeFileSync(temp, JSON.stringify({ version: 1, jobs: [...jobs.values()] }, null, 2))
    renameSync(temp, filePath)
}

const persist = () => {
    writeChain = writeChain.then(writeNow).catch((error) => {
        console.error(`Could not save the scheduler: ${error.message}`)
    })

    return writeChain
}

/* -------------------------------------------------------------------------- */
/* Timer                                                                      */
/* -------------------------------------------------------------------------- */

const clearTimer = () => {
    if (timer) {
        clearTimeout(timer)
        timer = null
    }
}

const arm = () => {
    clearTimer()

    const runAt = nextRunAt([...jobs.values()])

    if (runAt === null) {
        return
    }

    const wait = Math.max(runAt - Date.now(), 0)
    timer = setTimeout(tick, Math.min(wait, MAX_TIMEOUT))

    // The HTTP server keeps the process alive; the timer must not hold it open.
    timer.unref?.()
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                  */
/* -------------------------------------------------------------------------- */

/** Send one job through the normal socket path, failing loudly if it cannot. */
const defaultSend = async (job) => {
    if (!isSessionConnected(job.sessionId)) {
        throw new AppError(`Session "${job.sessionId}" is not connected to WhatsApp.`, {
            status: 503,
            code: 'SESSION_NOT_CONNECTED',
        })
    }

    return sendMessage(getSession(job.sessionId), job.jid, job.message, {}, 0)
}

const finish = (job, status, error = null) => {
    job.status = status
    job.finishedAt = Date.now()
    job.lastError = error
}

const execute = async (job, send) => {
    job.attempts += 1
    job.lastAttemptAt = Date.now()

    try {
        const result = await send(job)

        finish(job, 'sent')
        job.sentAt = job.finishedAt
        job.messageId = result?.key?.id ?? null
    } catch (error) {
        if (job.attempts < config.scheduler.maxAttempts) {
            // Still pending, just later: `runAt` moves so the re-arm below
            // schedules the retry.
            job.runAt = Date.now() + config.scheduler.retryDelay
            job.lastError = error.message

            return
        }

        finish(job, 'failed', error.message)
    }
}

/**
 * Run every job that is due, then re-arm.
 *
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {(job: object) => Promise<unknown>} [options.send] injectable for tests
 */
export const runDueJobs = async ({ now = Date.now(), send = defaultSend } = {}) => {
    // A tick must not overlap itself, or a job could be sent twice.
    if (ticking) {
        return []
    }

    ticking = true

    try {
        const due = [...jobs.values()]
            .filter((job) => job.status === 'pending' && job.runAt <= now)
            .sort((a, b) => a.runAt - b.runAt)

        // Sequential on purpose: keeps a burst of due jobs from hitting the
        // socket all at once.
        for (const job of due) {
            await execute(job, send)
        }

        if (due.length > 0) {
            await persist()
        }

        return due
    } finally {
        ticking = false
        arm()
    }
}

const tick = () => {
    runDueJobs().catch((error) => console.error(`Scheduler tick failed: ${error.message}`))
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Register a message to be sent later.
 *
 * @param {string} sessionId
 * @param {object} input
 * @param {string} input.receiver phone number or JID
 * @param {object} input.message Baileys message content
 * @param {number|string} input.scheduledAt epoch ms or ISO 8601
 * @param {boolean} [input.isGroup]
 */
export const schedule = async (sessionId, { receiver, message, scheduledAt, isGroup = false }) => {
    const runAt = parseScheduledAt(scheduledAt)

    if (runAt <= Date.now()) {
        throw badRequest('"scheduledAt" must be in the future.', 'SCHEDULED_AT_IN_PAST')
    }

    const job = {
        id: randomUUID(),
        sessionId,
        receiver: String(receiver),
        jid: toJid(receiver, isGroup),
        isGroup: Boolean(isGroup),
        message,
        scheduledAt: runAt,
        runAt,
        status: 'pending',
        attempts: 0,
        createdAt: Date.now(),
        lastAttemptAt: null,
        finishedAt: null,
        sentAt: null,
        messageId: null,
        lastError: null,
    }

    jobs.set(job.id, job)
    await persist()
    arm()

    return job
}

/** Every job of a session, newest first. */
export const list = (sessionId) => {
    return [...jobs.values()].filter((job) => job.sessionId === sessionId).sort((a, b) => b.createdAt - a.createdAt)
}

/** One job, or `null` when the id is unknown or belongs to another session. */
export const find = (sessionId, jobId) => {
    const job = jobs.get(jobId)

    return job?.sessionId === sessionId ? job : null
}

/** Cancel a pending job. Returns `null` when the id is unknown. */
export const cancel = async (sessionId, jobId) => {
    const job = find(sessionId, jobId)

    if (!job) {
        return null
    }

    if (job.status !== 'pending') {
        return job
    }

    finish(job, 'cancelled')
    await persist()
    arm()

    return job
}

/**
 * Change when a pending job runs, or revive a cancelled / failed / missed one.
 *
 * `attempts` is reset so a revived job gets the full retry budget again.
 */
export const update = async (sessionId, jobId, { scheduledAt, receiver, message, isGroup }) => {
    const job = find(sessionId, jobId)

    if (!job) {
        return null
    }

    if (receiver !== undefined) {
        job.receiver = String(receiver)
        job.jid = toJid(job.receiver, isGroup ?? job.isGroup)
    }

    if (isGroup !== undefined) {
        job.isGroup = Boolean(isGroup)
        job.jid = toJid(job.receiver, job.isGroup)
    }

    if (message !== undefined) {
        job.message = message
    }

    if (scheduledAt !== undefined) {
        const runAt = parseScheduledAt(scheduledAt)

        if (runAt <= Date.now()) {
            throw badRequest('"scheduledAt" must be in the future.', 'SCHEDULED_AT_IN_PAST')
        }

        job.scheduledAt = runAt
        job.runAt = runAt
        job.status = 'pending'
        job.attempts = 0
        job.finishedAt = null
        job.lastError = null
    }

    await persist()
    arm()

    return job
}

/** Drop every job of a session — called when the session itself is deleted. */
export const forgetSession = async (sessionId) => {
    const doomed = [...jobs.values()].filter((job) => job.sessionId === sessionId)

    if (doomed.length === 0) {
        return 0
    }

    for (const job of doomed) {
        jobs.delete(job.id)
    }

    await persist()
    arm()

    return doomed.length
}

/**
 * Load the jobs written by a previous run.
 *
 * Jobs whose time passed while the process was down are re-armed if they are
 * within the grace window and marked `missed` otherwise.
 *
 * @param {object} [options]
 * @param {string} [options.file] overridden by tests
 */
export const restore = async ({ file } = {}) => {
    if (file) {
        filePath = file
    }

    jobs.clear()
    clearTimer()

    if (!existsSync(filePath)) {
        return { restored: 0, missed: 0 }
    }

    let parsed

    try {
        parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    } catch (error) {
        throw new AppError(`The scheduler file could not be read: ${error.message}`, {
            code: 'SCHEDULER_FILE_INVALID',
            cause: error,
        })
    }

    const now = Date.now()
    let missed = 0

    for (const job of parsed?.jobs ?? []) {
        const status = recoveredStatus(job, now, config.scheduler.lateGrace)

        if (status !== job.status) {
            missed += 1
        }

        job.status = status
        jobs.set(job.id, job)
    }

    await persist()
    arm()

    return { restored: jobs.size, missed }
}

/** Wait for every queued write to land. Used on shutdown. */
export const flush = () => writeChain

/* -------------------------------------------------------------------------- */
/* Test seams                                                                 */
/* -------------------------------------------------------------------------- */

/** Point the scheduler at another file. */
export const useFile = (file) => {
    filePath = file
}

/** Forget every in-memory job without touching disk. */
export const reset = () => {
    clearTimer()
    jobs.clear()
    ticking = false
    writeChain = Promise.resolve()
}
