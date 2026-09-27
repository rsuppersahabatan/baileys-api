/**
 * Send pacing.
 *
 * The point of this module is *timing*, so the assertions are about elapsed
 * milliseconds rather than return values. The configured range is set to a
 * small fixed window through the environment before the module is imported —
 * a static import would be hoisted above the assignment and `config.js` would
 * read the real defaults instead.
 *
 * Run with `npm test`. No test framework needed.
 */

process.env.SEND_MIN_DELAY = '60'
process.env.SEND_MAX_DELAY = '60'

const { forgetPacing, paceSend, pacingGap, resetPacing } = await import('../whatsapp/throttle.js')

let failures = 0
const check = (label, actual, expected) => {
    const passed = actual === expected
    failures += passed ? 0 : 1
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}: ${actual}${passed ? '' : ` (expected ${expected})`}`)
}

const ok = (label, condition, detail = '') => {
    failures += condition ? 0 : 1
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${condition || !detail ? '' : ` — ${detail}`}`)
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Timers are allowed to fire a hair early; anything beyond this is a real bug. */
const TOLERANCE = 8

const CONFIGURED_GAP = 60

/* -------------------------------------------------------------------------- */
/* The gap arithmetic                                                         */
/* -------------------------------------------------------------------------- */

check('a fixed range gives that value', pacingGap(100, 100), 100)
check(
    'the low end of the range is reachable',
    pacingGap(100, 200, () => 0),
    100,
)
check(
    'the high end of the range is reachable',
    pacingGap(100, 200, () => 1),
    200,
)
check(
    'the jitter lands inside the range',
    pacingGap(100, 200, () => 0.5),
    150,
)

// A negative floor would produce a negative wait, which `setTimeout` reads as
// "immediately" — harmless, but the value should not be nonsense either.
check(
    'a negative minimum is clamped to zero',
    pacingGap(-50, 10, () => 0),
    0,
)

// An inverted range means the caller mistyped; collapsing to the floor is the
// only reading that cannot produce a shorter gap than they asked for.
check(
    'an inverted range collapses to the minimum',
    pacingGap(200, 100, () => 1),
    200,
)

const drawn = Array.from({ length: 40 }, () => pacingGap(100, 200))
ok('the gap is not constant', new Set(drawn).size > 1, `all ${drawn.length} draws were ${drawn[0]}`)
ok(
    'every draw stays in range',
    drawn.every((gap) => gap >= 100 && gap <= 200),
)

/* -------------------------------------------------------------------------- */
/* Pacing a socket                                                            */
/* -------------------------------------------------------------------------- */

resetPacing()

const starts = []
const record = (label) => async () => {
    starts.push({ label, at: Date.now() })

    return label
}

const socket = {}

// The first send on a socket has nothing to be too close to, so it must not be
// delayed — otherwise every single-message request would pay the gap.
const beforeFirst = Date.now()
await paceSend(socket, record('first'))
const firstDelay = Date.now() - beforeFirst

ok('the first send is not delayed', firstDelay < CONFIGURED_GAP, `waited ${firstDelay}ms`)

await paceSend(socket, record('second'))
const gap = starts[1].at - starts[0].at

ok(
    'a second send waits out the gap',
    gap >= CONFIGURED_GAP - TOLERANCE,
    `only ${gap}ms between sends, expected ~${CONFIGURED_GAP}ms`,
)

/* --- the gap is measured from the start, not the end ---------------------- */

resetPacing()

const slowSocket = {}
const slowStarts = []

const slowTask = (ms) => async () => {
    slowStarts.push(Date.now())

    await wait(ms)
}

// A task that takes longer than the gap already provides the spacing. Waiting
// the gap *again* on top would make a slow send slow every send after it.
await paceSend(slowSocket, slowTask(150))
await paceSend(slowSocket, slowTask(0))

const slowGap = slowStarts[1] - slowStarts[0]

ok(
    'a slow send does not stack the gap on top of its own duration',
    slowGap < 150 + CONFIGURED_GAP,
    `${slowGap}ms, which is more than the ${150}ms task plus the ${CONFIGURED_GAP}ms gap`,
)

/* --- concurrent sends are serialised -------------------------------------- */

resetPacing()

const busySocket = {}
const events = []

const busyTask = (name) => async () => {
    events.push(`start:${name}`)

    await wait(40)

    events.push(`end:${name}`)
}

// Fired without awaiting, exactly as two simultaneous HTTP requests would be.
await Promise.all([
    paceSend(busySocket, busyTask('a')),
    paceSend(busySocket, busyTask('b')),
    paceSend(busySocket, busyTask('c')),
])

const interleaved = events.some((event, index) => {
    if (!event.startsWith('start:')) {
        return false
    }

    // The next event must be the end of the same task, or two sends overlapped.
    return events[index + 1] !== `end:${event.slice('start:'.length)}`
})

ok('concurrent sends never overlap', !interleaved, events.join(' '))
check('every concurrent send ran', events.filter((event) => event.startsWith('start:')).length, 3)

/* --- separate sockets do not queue behind each other ---------------------- */

resetPacing()

const occupiedSocket = {}
const idleSocket = {}
const idleStarts = []

// Occupy one socket with a long send, deliberately not awaited, so its queue is
// still draining when the other socket is used.
const occupying = paceSend(occupiedSocket, async () => {
    await wait(200)
})

const idleAt = Date.now()

await paceSend(idleSocket, async () => {
    idleStarts.push(Date.now())
})

ok(
    'an idle socket is not held up by a busy one',
    idleStarts[0] - idleAt < 50,
    `waited ${idleStarts[0] - idleAt}ms behind an unrelated socket`,
)

await occupying

/* -------------------------------------------------------------------------- */
/* An explicit gap                                                            */
/* -------------------------------------------------------------------------- */

resetPacing()

const overrideStarts = []
const overrideTask = async () => {
    overrideStarts.push(Date.now())
}

const overrideTarget = {}

await paceSend(overrideTarget, overrideTask)
await paceSend(overrideTarget, overrideTask, { minDelay: 150 })

const overrideGap = overrideStarts[1] - overrideStarts[0]

ok(
    'an explicit gap overrides the configured range',
    overrideGap >= 150 - TOLERANCE,
    `waited ${overrideGap}ms, expected ~150ms`,
)

resetPacing()

const zeroStarts = []
const zeroTask = async () => {
    zeroStarts.push(Date.now())
}

const zeroTarget = {}

await paceSend(zeroTarget, zeroTask)
// `0` is what the old `sendMessage` signature used to mean "no extra wait", and
// it must keep meaning *no override* — read literally it would switch pacing
// off for exactly the callers that need it.
await paceSend(zeroTarget, zeroTask, { minDelay: 0 })

const zeroGap = zeroStarts[1] - zeroStarts[0]

ok(
    'a zero gap means "use the configured range", not "no pacing"',
    zeroGap >= CONFIGURED_GAP - TOLERANCE,
    `only ${zeroGap}ms between sends`,
)

/* -------------------------------------------------------------------------- */
/* A failure must not poison the queue                                        */
/* -------------------------------------------------------------------------- */

resetPacing()

const failingSocket = {}
const survivor = []

let rejection = null

const failing = async () => {
    throw new Error('socket down')
}

const surviving = async () => {
    survivor.push(Date.now())

    return 'delivered'
}

const first = paceSend(failingSocket, failing).catch((error) => {
    rejection = error.message
})

const second = paceSend(failingSocket, surviving)

const [result] = await Promise.all([second, first])

check('the failing send rejects with its own reason', rejection, 'socket down')
check('the send queued behind it still runs', result, 'delivered')
check('  ...exactly once', survivor.length, 1)

/* -------------------------------------------------------------------------- */
/* forgetPacing                                                               */
/* -------------------------------------------------------------------------- */

resetPacing()

const forgetSocket = {}
const forgetStarts = []
const forgetTask = async () => {
    forgetStarts.push(Date.now())
}

await paceSend(forgetSocket, forgetTask)
forgetPacing(forgetSocket)
// With its state dropped the socket looks brand new, so this send is a "first"
// send again and must not wait.
await paceSend(forgetSocket, forgetTask)

ok(
    'forgetPacing makes the next send immediate again',
    forgetStarts[1] - forgetStarts[0] < CONFIGURED_GAP,
    `waited ${forgetStarts[1] - forgetStarts[0]}ms`,
)

console.log(failures === 0 ? '\nAll throttle checks passed.' : `\n${failures} throttle check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
