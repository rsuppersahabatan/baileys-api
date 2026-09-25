/**
 * Keeps `postman_collection.json` honest.
 *
 * A hand-maintained collection drifts in ways that never announce themselves.
 * Both of these had already happened here:
 *
 *  - a query parameter was documented as `cursor_id` while the controller read
 *    `cursorId`. Express ignores query parameters it does not recognise, so
 *    nothing errored — paging just quietly returned the newest page every time.
 *  - two endpoints were documented that no route serves, and two more routes
 *    were missing from the collection entirely.
 *
 * So these checks compare the collection against the source of truth: the route
 * files, the controllers and the middlewares. No server, no dependencies.
 *
 * Run with `npm test`.
 */
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const root = join(import.meta.dirname, '..')
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8')

let failures = 0
const check = (label, actual, expected) => {
    const passed = JSON.stringify(actual) === JSON.stringify(expected)
    failures += passed ? 0 : 1
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}`)
    if (!passed) {
        console.log(`        expected: ${JSON.stringify(expected)}`)
        console.log(`        actual:   ${JSON.stringify(actual)}`)
    }
}

const ok = (label, value) => check(label, Boolean(value), true)

/* -------------------------------------------------------------------------- */
/* What the app actually serves                                               */
/* -------------------------------------------------------------------------- */

const routesSource = read('routes.js')

// Resolve the route file through its import rather than by lowercasing the
// binding: `sessionsRoute` -> `routes/sessionsRoute.js` only works by accident on
// a case-insensitive filesystem.
const routeModules = new Map(
    [...routesSource.matchAll(/import\s+(\w+)\s+from\s+'\.\/(routes\/[\w.]+)'/g)].map(([, binding, file]) => [
        binding,
        file,
    ]),
)

/** `:jid` and `{{jid}}` both collapse to `:p`, so the two spellings compare equal. */
const asPattern = (path) => path.replace(/:[A-Za-z]+/g, ':p').replace(/\/$/, '')

/** `GET /chats/:p` -> the parameter names the route declares. */
const realRoutes = new Map()

for (const [, prefix, binding] of routesSource.matchAll(/router\.use\('(\/[a-z-]+)',\s*(\w+)\)/g)) {
    const file = routeModules.get(binding)

    if (!file) {
        continue
    }

    for (const [, method, path] of read(file).matchAll(/router\.(get|post|put|delete|patch)\(\s*'([^']*)'/g)) {
        const full = `${prefix}${path}`
        const params = [...full.matchAll(/:([A-Za-z]+)/g)].map(([, name]) => name)

        realRoutes.set(`${method.toUpperCase()} ${asPattern(full)}`, params)
    }
}

ok('the route table was read', realRoutes.size > 30)

/* -------------------------------------------------------------------------- */
/* What the collection claims                                                 */
/* -------------------------------------------------------------------------- */

const collection = JSON.parse(read('postman_collection.json'))

const documented = []

const walk = (items, folder = null) => {
    for (const item of items ?? []) {
        if (item.item) {
            walk(item.item, item.name)
            continue
        }

        documented.push({ folder, ...item })
    }
}

walk(collection.item)

ok('the collection was read', documented.length > 0)

/** The route key a documented request maps to. */
const keyOf = (item) => {
    const raw = String(item.request?.url?.raw ?? '').replace(/^\{\{base_url\}\}/, '')
    const [path] = raw.split('?')

    return `${item.request?.method} ${asPattern(path)}`
}

/* -------------------------------------------------------------------------- */
/* Coverage                                                                   */
/* -------------------------------------------------------------------------- */

const documentedKeys = new Set(documented.map(keyOf))

check(
    'every route the app serves is documented',
    [...realRoutes.keys()].filter((key) => !documentedKeys.has(key)).sort(),
    [],
)

check(
    'nothing is documented that no route serves',
    [...documentedKeys].filter((key) => !realRoutes.has(key)).sort(),
    [],
)

/* -------------------------------------------------------------------------- */
/* Path parameters                                                            */
/* -------------------------------------------------------------------------- */

const paramMismatches = []

for (const item of documented) {
    const expected = realRoutes.get(keyOf(item))

    if (!expected) {
        continue
    }

    const actual = (item.request.url?.path ?? [])
        .filter((segment) => segment.startsWith(':'))
        .map((segment) => segment.slice(1))

    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        paramMismatches.push(
            `${item.name}: documents ${JSON.stringify(actual)}, route declares ${JSON.stringify(expected)}`,
        )
    }
}

check('path parameters match the routes', paramMismatches, [])

/* -------------------------------------------------------------------------- */
/* Query parameters                                                           */
/* -------------------------------------------------------------------------- */

// Everything the server reads out of the query string, however it reads it.
const readParams = new Set()

const serverSources = ['controllers', 'middlewares', 'routes'].flatMap((dir) =>
    readdirSync(join(root, dir)).map((file) => read(join(dir, file))),
)

for (const source of serverSources) {
    for (const [, name] of source.matchAll(/req\.query\.(\w+)/g)) {
        readParams.add(name)
    }

    // express-validator declarations, e.g. `query('id').notEmpty()`.
    for (const [, name] of source.matchAll(/\bquery\('([^']+)'\)/g)) {
        readParams.add(name)
    }

    // Destructured reads, e.g. `const { limit = 25, cursorId } = req.query`.
    for (const [, block] of source.matchAll(/const\s*\{([^}]*)\}\s*=\s*req\.query/g)) {
        for (const entry of block.split(',')) {
            const name = entry.split('=')[0].split(':')[0].trim()

            if (name) {
                readParams.add(name)
            }
        }
    }
}

const sentParams = new Set()

for (const item of documented) {
    // Disabled entries count too: a parameter sitting switched-off in the UI is
    // still documentation, and a wrong name there misleads just as much.
    for (const entry of item.request.url?.query ?? []) {
        sentParams.add(entry.key)
    }
}

// A parameter the server does not read is worse than a missing one: it looks
// like it works and changes nothing.
check(
    'every query parameter the collection sends is read by the server',
    [...sentParams].filter((name) => !readParams.has(name)).sort(),
    [],
)

/* -------------------------------------------------------------------------- */
/* Variables                                                                  */
/* -------------------------------------------------------------------------- */

const definedVariables = new Set((collection.variable ?? []).map((entry) => entry.key))

for (const item of documented) {
    for (const entry of item.request.url?.variable ?? []) {
        definedVariables.add(entry.key)
    }
}

const undefinedVariables = []

for (const item of documented) {
    const sources = [
        item.request.url?.raw,
        ...(item.request.url?.host ?? []),
        item.request.body?.raw,
        ...(item.request.url?.variable ?? []).map((entry) => entry.value),
    ]

    for (const source of sources) {
        for (const [, name] of String(source ?? '').matchAll(/\{\{([\w-]+)\}\}/g)) {
            if (!definedVariables.has(name)) {
                undefinedVariables.push(`${item.name}: {{${name}}}`)
            }
        }
    }
}

check('no request uses an undefined variable', [...new Set(undefinedVariables)].sort(), [])

/* -------------------------------------------------------------------------- */
/* Requests and saved examples                                                */
/* -------------------------------------------------------------------------- */

const missingDescriptions = []
const quotedBooleans = []
const invalidBodies = []
const missingSnapshots = []
const nonRawBodies = []

for (const item of documented) {
    if (!item.request?.method || !item.request?.url?.raw) {
        missingDescriptions.push(`${item.name} (no method or url)`)
    }

    if (!item.request?.description) {
        missingDescriptions.push(item.name)
    }

    const body = item.request?.body?.raw

    if (body) {
        if (item.request.body.mode !== 'raw') {
            nonRawBodies.push(item.name)
        }

        // `isGroup` must be a boolean on the wire. Quoting it breaks either way:
        // `"false"` is truthy on the server, and `"{{isGroup}}"` substitutes the
        // *string* "false", which is truthy too. Both turn a private chat into a
        // group. So any quote after `"isGroup":` is a bug.
        if (/"isGroup":\s*"/.test(body)) {
            quotedBooleans.push(item.name)
        }
    }

    for (const example of item.response ?? []) {
        if (!example.originalRequest) {
            missingSnapshots.push(item.name)
        }

        try {
            JSON.parse(example.body)
        } catch {
            invalidBodies.push(`${item.name} (${example.code})`)
        }
    }
}

check('every request has a method, a url and a description', missingDescriptions, [])
check('every request body is a raw json body', nonRawBodies, [])
check('isGroup is never sent as a quoted boolean', quotedBooleans, [])
check('every saved example keeps its original request', [...new Set(missingSnapshots)].sort(), [])
check('every saved example is valid JSON', [...new Set(invalidBodies)].sort(), [])

/* -------------------------------------------------------------------------- */
/* The header the collection advertises                                       */
/* -------------------------------------------------------------------------- */

const recursiveCount = (items) =>
    (items ?? []).reduce((total, item) => total + (item.item ? recursiveCount(item.item) : 1), 0)
const claimed = /\*\*(\d+) requests\*\*/.exec(collection.info?.description ?? '')

check('the advertised request count is right', claimed ? Number(claimed[1]) : null, recursiveCount(collection.item))

const claimedFolders = /across (\d+) folders/.exec(collection.info?.description ?? '')

check('the advertised folder count is right', claimedFolders ? Number(claimedFolders[1]) : null, collection.item.length)

console.log(
    failures === 0
        ? `\nAll ${documented.length}-request collection checks passed.`
        : `\n${failures} collection check(s) failed.`,
)
process.exit(failures === 0 ? 0 : 1)
