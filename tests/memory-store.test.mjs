/**
 * Regression checks for the in-memory store's paging and lookup helpers.
 *
 * These are the parts the REST API depends on directly (`getMessages`,
 * `forward`, `download-media`) and the parts that were silently broken before:
 * `loadMessages` used to take `(jid, messageId, options)`, so every caller
 * passing a `limit` got an empty array back.
 *
 * Run with `npm test`. No test framework needed.
 */
import makeInMemoryStore from '../store/memory-store.js'

const store = makeInMemoryStore({ autoSaveInterval: 0, maxMessagesPerChat: 100 })
const jid = '628111@s.whatsapp.net'

const make = (id, timestamp, fromMe = false) => ({
    key: { id, remoteJid: jid, fromMe },
    message: { conversation: `msg ${id}` },
    messageTimestamp: timestamp,
})

/**
 * m2, m3 and m4 deliberately share a timestamp. `Array.prototype.sort` is
 * stable, so equal timestamps keep their insertion order — that is what makes
 * cursor paging by message id safe.
 */
const messages = new Map()
for (const [id, timestamp] of [
    ['m1', 100],
    ['m2', 200],
    ['m3', 200],
    ['m4', 200],
    ['m5', 300],
]) {
    messages.set(id, make(id, timestamp))
}
store.messages.set(jid, messages)

const ids = (list) => list.map((message) => message.key.id).join(',')

let failures = 0
const check = (label, actual, expected) => {
    const passed = actual === expected
    failures += passed ? 0 : 1
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}: ${actual}${passed ? '' : ` (expected ${expected})`}`)
}

// Ordering and windowing
check('default order is newest first', ids(await store.loadMessages(jid, { limit: 10 })), 'm5,m2,m3,m4,m1')
check('limit', ids(await store.loadMessages(jid, { limit: 2 })), 'm5,m2')
check('offset', ids(await store.loadMessages(jid, { limit: 2, offset: 2 })), 'm3,m4')
check('ascending order', ids(await store.loadMessages(jid, { limit: 10, sortOrder: 'asc' })), 'm1,m2,m3,m4,m5')
check('unknown jid', ids(await store.loadMessages('unknown@s.whatsapp.net')), '')

// Cursor by message id — previously impossible to express
check('before keeps older', ids(await store.loadMessages(jid, { before: { id: 'm3' } })), 'm4,m1')
check('before a tied timestamp', ids(await store.loadMessages(jid, { before: { id: 'm4' } })), 'm1')
check('after keeps newer', ids(await store.loadMessages(jid, { after: { id: 'm3' } })), 'm5,m2')
check('before, ascending', ids(await store.loadMessages(jid, { before: { id: 'm3' }, sortOrder: 'asc' })), 'm1,m2')
check('after, ascending', ids(await store.loadMessages(jid, { after: { id: 'm3' }, sortOrder: 'asc' })), 'm4,m5')
check(
    'unknown cursor is ignored',
    ids(await store.loadMessages(jid, { limit: 10, before: { id: 'nope' } })),
    'm5,m2,m3,m4,m1',
)

// Cursor by timestamp still supported
check('before a timestamp', ids(await store.loadMessages(jid, { before: 300 })), 'm2,m3,m4,m1')
check('after a timestamp', ids(await store.loadMessages(jid, { after: 200 })), 'm5')

// `fromMe` disambiguates two messages that share an id
messages.set('dup', make('dup', 400, true))
check(
    'cursor honours fromMe',
    ids(await store.loadMessages(jid, { before: { id: 'dup', fromMe: true } })),
    'm5,m2,m3,m4,m1',
)

// getMessage — backs `forward` and `download-media`
check('getMessage hit', store.getMessage(jid, 'm3')?.message?.conversation, 'msg m3')
check('getMessage miss', String(store.getMessage(jid, 'nope')), 'null')
check('getMessage without id', String(store.getMessage(jid, null)), 'null')
check('getMessage normalises the jid', store.getMessage('628111:5@s.whatsapp.net', 'm1')?.key?.id, 'm1')

// dispose() must stop the auto-save timer, otherwise a deleted session keeps writing
const timerStore = makeInMemoryStore({ autoSaveInterval: 50 })
check('auto-save timer is running', String(timerStore.autoSaveTimer !== null), 'true')
timerStore.dispose()
check('auto-save timer is cleared', String(timerStore.autoSaveTimer), 'null')

store.dispose()
timerStore.dispose()

console.log(failures === 0 ? '\nAll store checks passed.' : `\n${failures} store check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
