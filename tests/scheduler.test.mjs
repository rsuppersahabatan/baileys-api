/**
 * Message scheduler: the pure rules, the HTTP surface, and a real send.
 *
 * The interesting part is that none of this needs WhatsApp. A fake socket is
 * registered in the session registry with `readyState === 1`, so the real
 * Express routes, the real middlewares and the real scheduler run exactly as
 * they do in production — only `socket.sendMessage` is a stub that records what
 * it was asked to send.
 *
 * Run with `npm test`. No test framework needed.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import express from 'express'
import routes from '../routes.js'
import * as registry from '../whatsapp/registry.js'
import * as scheduler from '../whatsapp/scheduler.js'

let failures = 0
const check = (label, actual, expected) => {
    const passed = actual === expected
    failures += passed ? 0 : 1
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}: ${actual}${passed ? '' : ` (expected ${expected})`}`)
}

const ok = (label, condition) => check(label, Boolean(condition), true)

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = async (predicate, timeoutMs = 6000) => {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
        if (predicate()) {
            return true
        }

        await wait(100)
    }

    return false
}

/* -------------------------------------------------------------------------- */
/* Setup: temp file, fake session, real HTTP server                           */
/* -------------------------------------------------------------------------- */

const workDir = mkdtempSync(join(tmpdir(), 'scheduler-test-'))
const storePath = join(workDir, 'scheduler.json')

scheduler.useFile(storePath)
scheduler.reset()

const SESSION = 'test-session'
const OTHER_SESSION = 'other-session'

/** Records every send so the test can assert on it. */
const sent = []
const sentByOther = []

const fakeSocket = (sink) => ({
    ws: { socket: { readyState: 1 } },
    sendMessage: async (receiver, message) => {
        sink.push({ receiver, message })

        return { key: { id: `fake-${sink.length}` } }
    },
})

registry.addSession(SESSION, fakeSocket(sent))
registry.addSession(OTHER_SESSION, fakeSocket(sentByOther))

const app = express()
app.use(express.json())
app.use('/', routes)

const server = app.listen(0)
await new Promise((resolve) => server.once('listening', resolve))

const base = `http://127.0.0.1:${server.address().port}`

const call = async (method, path, body) => {
    const res = await fetch(base + path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    })

    return { status: res.status, json: await res.json() }
}

/* -------------------------------------------------------------------------- */
/* Pure rules                                                                 */
/* -------------------------------------------------------------------------- */

const throwsWith = (label, fn, expectedCode) => {
    try {
        fn()
        check(label, 'no error', `AppError(${expectedCode})`)
    } catch (error) {
        check(label, error.code ?? error.name, expectedCode)
    }
}

throwsWith('parseScheduledAt rejects empty', () => scheduler.parseScheduledAt(''), 'SCHEDULED_AT_REQUIRED')
throwsWith('parseScheduledAt rejects junk', () => scheduler.parseScheduledAt('besok pagi'), 'SCHEDULED_AT_INVALID')

const iso = '2030-01-01T00:00:00.000Z'
check('parseScheduledAt accepts ISO 8601', scheduler.parseScheduledAt(iso), Date.parse(iso))
check('parseScheduledAt accepts epoch ms', scheduler.parseScheduledAt(1790310000000), 1790310000000)
check('parseScheduledAt accepts a numeric string', scheduler.parseScheduledAt('1790310000000'), 1790310000000)

check('nextRunAt of nothing', scheduler.nextRunAt([]), null)
check(
    'nextRunAt ignores finished jobs',
    scheduler.nextRunAt([
        { status: 'sent', runAt: 1 },
        { status: 'pending', runAt: 500 },
        { status: 'pending', runAt: 300 },
    ]),
    300,
)

const NOW = 1_000_000
check(
    'recovered job inside the grace window stays pending',
    scheduler.recoveredStatus({ status: 'pending', runAt: NOW - 1000 }, NOW, 5000),
    'pending',
)
check(
    'recovered job past the grace window is missed',
    scheduler.recoveredStatus({ status: 'pending', runAt: NOW - 60_000 }, NOW, 5000),
    'missed',
)
check(
    'recovered job keeps its finished status',
    scheduler.recoveredStatus({ status: 'sent', runAt: NOW - 60_000 }, NOW, 5000),
    'sent',
)

const pruneInput = [
    { id: 'p1', status: 'pending', finishedAt: null },
    { id: 'f1', status: 'sent', finishedAt: 10 },
    { id: 'f2', status: 'failed', finishedAt: 30 },
    { id: 'f3', status: 'cancelled', finishedAt: 20 },
]
const pruned = scheduler.pruneFinished(pruneInput, 2)
check(
    'pruneFinished keeps pending jobs',
    pruned.some((job) => job.id === 'p1'),
    true,
)
check('pruneFinished keeps only the newest finished', pruned.filter((job) => job.status !== 'pending').length, 2)
check(
    'pruneFinished keeps the very newest',
    pruned.some((job) => job.id === 'f2'),
    true,
)
check(
    'pruneFinished drops the oldest finished',
    pruned.some((job) => job.id === 'f1'),
    false,
)

/* -------------------------------------------------------------------------- */
/* HTTP surface                                                               */
/* -------------------------------------------------------------------------- */

const missingId = await call('POST', '/scheduler', { receiver: '628', message: { text: 'x' }, scheduledAt: iso })
check('POST /scheduler without ?id is rejected', missingId.status, 400)

const ghost = await call('POST', `/scheduler?id=ghost`, { receiver: '628', message: { text: 'x' }, scheduledAt: iso })
check('POST /scheduler with an unknown session', ghost.status, 404)
check('  ...and says so', ghost.json.message, 'Session not found.')

const noReceiver = await call('POST', `/scheduler?id=${SESSION}`, { message: { text: 'x' }, scheduledAt: iso })
check('POST /scheduler without receiver is rejected', noReceiver.status, 400)

const past = await call('POST', `/scheduler?id=${SESSION}`, {
    receiver: '628123456789',
    message: { text: 'x' },
    scheduledAt: Date.now() - 60_000,
})
check('POST /scheduler with a past time', past.status, 400)
check('  ...and explains why', past.json.message, '"scheduledAt" must be in the future.')

const created = await call('POST', `/scheduler?id=${SESSION}`, {
    receiver: '628123456789',
    message: { text: 'halo dari masa lalu' },
    scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
})
check('POST /scheduler creates the job', created.status, 201)
check('  ...status is pending', created.json.data.status, 'pending')
check('  ...receiver is normalised to a JID', created.json.data.jid, '628123456789@s.whatsapp.net')
check('  ...the session is recorded on the job', created.json.data.sessionId, SESSION)

const jobId = created.json.data.id
ok('  ...and the job got an id', typeof jobId === 'string' && jobId.length > 0)

const listed = await call('GET', `/scheduler/list?id=${SESSION}`)
check('GET /scheduler/list finds it', listed.json.data.length, 1)
check('  ...with the same id', listed.json.data[0].id, jobId)

const otherList = await call('GET', `/scheduler/list?id=${OTHER_SESSION}`)
check('GET /scheduler/list is scoped to the session', otherList.json.data.length, 0)

const found = await call('GET', `/scheduler/find/${jobId}?id=${SESSION}`)
check('GET /scheduler/find returns the job', found.json.data.id, jobId)

const notFound = await call('GET', `/scheduler/find/does-not-exist?id=${SESSION}`)
check('GET /scheduler/find with an unknown id', notFound.status, 404)

const crossSession = await call('GET', `/scheduler/find/${jobId}?id=${OTHER_SESSION}`)
check('a job is invisible to another session', crossSession.status, 404)

const rescheduledAt = new Date(Date.now() + 7_200_000).toISOString()
const updated = await call('PUT', `/scheduler/update/${jobId}?id=${SESSION}`, { scheduledAt: rescheduledAt })
check('PUT /scheduler/update reschedules', updated.status, 200)
check('  ...runAt follows', updated.json.data.runAt, Date.parse(rescheduledAt))
check('  ...and it is pending again', updated.json.data.status, 'pending')

const cancelled = await call('DELETE', `/scheduler/delete/${jobId}?id=${SESSION}`)
check('DELETE /scheduler/delete cancels', cancelled.status, 200)
check('  ...status is cancelled', cancelled.json.data.status, 'cancelled')

/* -------------------------------------------------------------------------- */
/* A job that actually fires                                                  */
/* -------------------------------------------------------------------------- */

const firing = await call('POST', `/scheduler?id=${SESSION}`, {
    receiver: '628999888777',
    message: { text: 'pesan terjadwal' },
    scheduledAt: Date.now() + 700,
})

const fired = await waitFor(() => sent.length === 1)
ok('a due job is sent without any manual tick', fired)
check('  ...to the normalised JID', sent[0]?.receiver, '628999888777@s.whatsapp.net')
check('  ...with the queued content', sent[0]?.message?.text, 'pesan terjadwal')

const afterFire = await call('GET', `/scheduler/find/${firing.json.data.id}?id=${SESSION}`)
check('the fired job is marked sent', afterFire.json.data.status, 'sent')
check('  ...and records the message id', afterFire.json.data.messageId, 'fake-1')

/* -------------------------------------------------------------------------- */
/* Retry, then give up                                                        */
/* -------------------------------------------------------------------------- */

const flaky = await call('POST', `/scheduler?id=${SESSION}`, {
    receiver: '628111',
    message: { text: 'akan gagal' },
    scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
})

// Fail every attempt so the job exhausts its budget. `maxAttempts` defaults to
// 3, so it takes three passes to reach `failed` — the first two only move the
// job's `runAt` forward.
let attempts = 0
const failingSend = async () => {
    attempts += 1
    throw new Error('socket down')
}

// `runAt` is already epoch milliseconds — `Date.parse` would turn it into NaN.
let clock = flaky.json.data.runAt

for (let pass = 0; pass < 3; pass++) {
    await scheduler.runDueJobs({ now: clock, send: failingSend })
    clock += 120_000
}

const afterRetry = await call('GET', `/scheduler/find/${flaky.json.data.id}?id=${SESSION}`)
check('a failing job is retried up to maxAttempts', attempts, 3)
check('  ...and is marked failed', afterRetry.json.data.status, 'failed')
check('  ...with the reason kept', afterRetry.json.data.lastError, 'socket down')

const revived = await call('PUT', `/scheduler/update/${flaky.json.data.id}?id=${SESSION}`, {
    scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
})
check('a failed job can be revived', revived.json.data.status, 'pending')
check('  ...with a fresh attempt budget', revived.json.data.attempts, 0)

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

await scheduler.flush()
const onDisk = JSON.parse(readFileSync(storePath, 'utf8'))
ok('the scheduler file was written', Array.isArray(onDisk.jobs))
check('  ...with every job in it', onDisk.jobs.length, 3)
ok('  ...and it is valid json with a version', onDisk.version === 1)

// A restart with a job whose time passed long ago must not send it late.
const stalePath = join(workDir, 'stale.json')
const stale = {
    version: 1,
    jobs: [
        {
            id: 'stale',
            sessionId: SESSION,
            status: 'pending',
            runAt: Date.now() - 86_400_000,
            scheduledAt: Date.now() - 86_400_000,
            attempts: 0,
        },
        {
            id: 'fresh',
            sessionId: SESSION,
            status: 'pending',
            runAt: Date.now() + 3_600_000,
            scheduledAt: Date.now() + 3_600_000,
            attempts: 0,
        },
    ],
}

writeFileSync(stalePath, JSON.stringify(stale))
const restored = await scheduler.restore({ file: stalePath })
check('restore brings both jobs back', restored.restored, 2)
check('  ...and reports the missed one', restored.missed, 1)

const restoredList = scheduler.list(SESSION)
check('the day-old job is missed', restoredList.find((job) => job.id === 'stale').status, 'missed')
check('the future job is still pending', restoredList.find((job) => job.id === 'fresh').status, 'pending')

/* -------------------------------------------------------------------------- */
/* Cleanup                                                                    */
/* -------------------------------------------------------------------------- */

const forgotten = await scheduler.forgetSession(SESSION)
ok('deleting a session drops its jobs', forgotten > 0)
check('  ...and nothing is left', scheduler.list(SESSION).length, 0)
check('  ...while other sessions are untouched', scheduler.list(OTHER_SESSION).length, 0)

server.close()
rmSync(workDir, { recursive: true, force: true })

console.log(failures === 0 ? '\nAll scheduler checks passed.' : `\n${failures} scheduler check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
