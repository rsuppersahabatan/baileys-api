import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { config, schedulerFile } from '../config.js'
import { AppError, badRequest } from '../errors.js'
import { sendMessageWithTyping } from './actions.js'
import { toJid } from './jid.js'
import { getSession, isSessionConnected } from './registry.js'

/**
 * Message scheduler.
 *
 * Jobs live in memory and are mirrored to a single json file so a restart does
 * not lose them. Only one timer exists at a time: it is always armed for the
 * earliest due job and re-armed whenever the job list changes.
 *
 * A job either fires once (`sent`) or repeats (`repeat`), in which case it
 * stays `pending` and walks forward slot by slot until its `count` or `until`
 * limit runs out, at which point it is `completed`. `runs` counts the
 * occurrences actually delivered, so it doubles as the series cursor.
 *
 * Like `actions.js`, this module never touches the socket directly — it goes
 * through `sendMessageWithTyping` so the library stays swappable.
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

/** Shorthand for the intervals people actually schedule. */
const INTERVAL_PRESETS = {
    hourly: 3_600_000,
    daily: 86_400_000,
    weekly: 604_800_000,
}

const INTERVAL_UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** A repeat faster than this is a loop, not a schedule. */
export const MIN_INTERVAL_MS = 1000

/**
 * How long between occurrences.
 *
 * Accepts `hourly` / `daily` / `weekly`, a duration string (`30s`, `15m`, `2h`,
 * `1d`) or a number of milliseconds.
 *
 * @param {unknown} value
 * @returns {number} milliseconds
 */
export const parseInterval = (value) => {
    if (value === undefined || value === null || value === '') {
        throw badRequest('"repeat.every" is required when "repeat" is set.', 'REPEAT_INTERVAL_REQUIRED')
    }

    const text = String(value).trim().toLowerCase()

    if (INTERVAL_PRESETS[text] !== undefined) {
        return INTERVAL_PRESETS[text]
    }

    let milliseconds

    if (/^\d+$/.test(text)) {
        milliseconds = Number(text)
    } else {
        const match = /^(\d+)\s*(s|m|h|d)$/.exec(text)

        if (!match) {
            throw badRequest(
                '"repeat.every" must be hourly / daily / weekly, a duration like "30m", or milliseconds.',
                'REPEAT_INTERVAL_INVALID',
            )
        }

        milliseconds = Number(match[1]) * INTERVAL_UNITS[match[2]]
    }

    if (milliseconds < MIN_INTERVAL_MS) {
        throw badRequest(
            `"repeat.every" must be at least ${MIN_INTERVAL_MS} milliseconds.`,
            'REPEAT_INTERVAL_TOO_SMALL',
        )
    }

    return milliseconds
}

/**
 * Normalise the `repeat` option.
 *
 * `repeat` may be the interval on its own (`"daily"`) or an object with `every`,
 * plus optional `count` (total sends, the first one included) and `until` (last
 * allowed time).
 *
 * @returns {{ intervalMs: number, count: number|null, until: number|null }|null}
 */
export const parseRepeat = (value) => {
    if (value === undefined || value === null || value === false || value === '' || value === 'false') {
        return null
    }

    const spec = typeof value === 'object' ? value : { every: value }
    const intervalMs = parseInterval(spec.every ?? spec.interval)

    const rawCount = spec.count
    const count = rawCount === undefined || rawCount === null || rawCount === '' ? null : Number(rawCount)

    if (count !== null && (!Number.isInteger(count) || count < 1)) {
        throw badRequest('"repeat.count" must be a positive integer.', 'REPEAT_COUNT_INVALID')
    }

    const rawUntil = spec.until
    const until = rawUntil === undefined || rawUntil === null || rawUntil === '' ? null : parseScheduledAt(rawUntil)

    return { intervalMs, count, until }
}

/**
 * When a repeating job runs next, or `null` when the series is finished.
 *
 * The cadence is anchored to `scheduledAt` rather than to when the last send
 * actually happened, so a slow send or a retry does not push every later
 * occurrence back. Occurrences that slipped past while the process was down are
 * skipped instead of fired in a burst — computed arithmetically rather than by
 * looping, because a year of downtime on a one minute interval is half a million
 * iterations.
 *
 * @param {object} job
 * @param {number} now
 * @returns {number|null}
 */
export const nextOccurrence = (job, now) => {
    const { repeat } = job

    if (!repeat) {
        return null
    }

    if (repeat.count !== null && job.runs >= repeat.count) {
        return null
    }

    // Occurrence `k` sits at `scheduledAt + k * intervalMs`, and the next send is
    // at least occurrence `runs`.
    const elapsed = Math.floor((now - job.scheduledAt) / repeat.intervalMs) + 1
    const step = Math.max(job.runs, elapsed)
    const next = job.scheduledAt + step * repeat.intervalMs

    if (repeat.until !== null && next > repeat.until) {
        return null
    }

    return next
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

    return sendMessageWithTyping(getSession(job.sessionId), job.jid, job.message, { typing: job.typing }, 0)
}

const finish = (job, status, error = null, now = Date.now()) => {
    job.status = status
    job.finishedAt = now
    job.lastError = error
}

const execute = async (job, send, now) => {
    job.attempts += 1
    job.lastAttemptAt = now

    try {
        const result = await send(job)

        job.runs += 1
        job.sentAt = now
        job.messageId = result?.key?.id ?? null
        job.lastError = null

        // A repeating job is not finished by sending — it moves to its next
        // slot and stays pending. Only the last occurrence of a series ends it.
        const next = nextOccurrence(job, now)

        if (next !== null) {
            job.runAt = next
            job.attempts = 0

            return
        }

        finish(job, job.repeat ? 'completed' : 'sent', null, now)
    } catch (error) {
        if (job.attempts < config.scheduler.maxAttempts) {
            // Still pending, just later: `runAt` moves so the re-arm below
            // schedules the retry.
            job.runAt = now + config.scheduler.retryDelay
            job.lastError = error.message

            return
        }

        finish(job, 'failed', error.message, now)
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
            await execute(job, send, now)
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
 * Register a message to be sent later, optionally on a repeating schedule.
 *
 * @param {string} sessionId
 * @param {object} input
 * @param {string} input.receiver phone number, LID or JID
 * @param {object} input.message Baileys message content
 * @param {number|string} input.scheduledAt epoch ms or ISO 8601
 * @param {boolean} [input.isGroup]
 * @param {unknown} [input.repeat] interval, or `{ every, count, until }`
 * @param {unknown} [input.typing] show a typing indicator before sending
 */
export const schedule = async (sessionId, { receiver, message, scheduledAt, isGroup = false, repeat, typing }) => {
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
        typing: typing ?? false,
        scheduledAt: runAt,
        runAt,
        repeat: parseRepeat(repeat),
        // How many occurrences have actually been delivered. Serves as the
        // cursor for `nextOccurrence`, and as the `count` budget.
        runs: 0,
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
 * `attempts` is reset so a revived job gets the full retry budget again, and
 * `runs` is reset alongside it: rescheduling restarts the series from the new
 * `scheduledAt`, so an earlier `count` must not carry over.
 */
export const update = async (sessionId, jobId, { scheduledAt, receiver, message, isGroup, repeat, typing }) => {
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

    if (typing !== undefined) {
        job.typing = typing
    }

    if (repeat !== undefined) {
        job.repeat = parseRepeat(repeat)
        job.runs = 0
    }

    if (scheduledAt !== undefined) {
        const runAt = parseScheduledAt(scheduledAt)

        if (runAt <= Date.now()) {
            throw badRequest('"scheduledAt" must be in the future.', 'SCHEDULED_AT_IN_PAST')
        }

        job.scheduledAt = runAt
        job.runAt = runAt
        job.runs = 0
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
        // Files written before repeating jobs existed have no cursor.
        job.runs = job.runs ?? 0

        if (job.status === 'pending' && job.repeat) {
            // A live series is moved to its next slot instead of being written
            // off: a daily reminder missed during an outage should still fire
            // tomorrow, unlike a one-off that would only arrive pointlessly
            // late. Skipped slots were never sent, so they do not consume the
            // `count` budget.
            const next = nextOccurrence(job, now)

            if (next === null) {
                job.status = 'completed'
                job.finishedAt = now
                missed += 1
            } else {
                job.runAt = next
            }

            jobs.set(job.id, job)

            continue
        }

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
