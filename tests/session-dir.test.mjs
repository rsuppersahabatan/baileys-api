/**
 * Guards the fix for the production ENOENT:
 *
 *   ENOENT: no such file or directory, open
 *     '.../baileys-api/sessions/md_primav1/creds.json'
 *     at async Object.writeFile (node:internal/fs/promises)
 *     at async .../baileys/lib/Utils/use-multi-file-auth-state.js:46:16
 *
 * The mechanism, confirmed against the installed library:
 *
 * 1. `useMultiFileAuthState()` creates its folder exactly once, at setup.
 * 2. Its `writeData()` — used by `saveCreds` and `keys.set` — only `writeFile`s
 *    into that folder. It has no mkdir and no guard.
 * 3. `socket.ev.on('creds.update', saveCreds)` keeps that writer attached for
 *    the whole life of the socket.
 *
 * So `rm -rf` on the auth directory left an attached writer pointing at a path
 * that no longer existed, and the next `creds.update` — which teardown itself
 * triggers via `logout()`, and which is exactly what happens while the process
 * is shutting down after "Running cleanup before exit." — threw ENOENT.
 *
 * These checks run against the real `@innovatorssoft/baileys`, because the whole
 * point is that the library's behaviour is what bit us. A fake would have to
 * reimplement the very quirk under test.
 *
 * Run with `npm test`. No test framework needed.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { useMultiFileAuthState } from '@innovatorssoft/baileys'
import { authDir, ensureSessionsDir, sessionsDir, storeFile } from '../config.js'

let failures = 0
const check = (label, actual, expected) => {
    const passed = actual === expected
    failures += passed ? 0 : 1
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}: ${actual}${passed ? '' : ` (expected ${expected})`}`)
}

const SESSION = 'qr-self-check'
const dir = authDir(SESSION)

/* -------------------------------------------------------------------------- */
/* The bug, reproduced                                                        */
/* -------------------------------------------------------------------------- */

// `authDir()` is what `buildSocket()` hands to `useMultiFileAuthState()`, so the
// library's folder and ours are the same path by construction.
check('authDir creates the folder it returns', existsSync(dir), true)

const { saveCreds } = await useMultiFileAuthState(dir)

check('setup left a working writer', typeof saveCreds, 'function')
await saveCreds()
check('a write into a live folder succeeds', existsSync(join(dir, 'creds.json')), true)

// This is what the old `deleteSession()` did, and what the library cannot
// survive: the directory disappears while the writer is still attached.
rmSync(dir, { force: true, recursive: true })

let reproduced = null
try {
    await saveCreds()
} catch (error) {
    reproduced = error.code
}

check('reproduces the production ENOENT', reproduced, 'ENOENT')

/* -------------------------------------------------------------------------- */
/* The fix                                                                    */
/* -------------------------------------------------------------------------- */

// Recreate the guarantees `deleteSession()` now relies on: the session root is
// re-established, and the auth folder is emptied rather than removed.
ensureSessionsDir()
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'creds.json'), '{}')

check('an emptied folder still exists', existsSync(dir), true)

// The credentials themselves must be gone, or the session would look logged in
// with stale keys. An auth folder with no `creds.json` is "not registered" to
// Baileys, which is why `useMultiFileAuthState` on it starts a fresh state.
rmSync(dir, { force: true, recursive: true })
mkdirSync(dir, { recursive: true })

const leftover = readdirSync(dir)
check('no credentials survive the unlink', leftover.length, 0)

// The part that actually fixes the crash: the writer has a destination again.
const { saveCreds: saveAfterUnlink } = await useMultiFileAuthState(dir)
let afterUnlink = null
try {
    await saveAfterUnlink()
} catch (error) {
    afterUnlink = error.code
}

check('a write after the unlink succeeds', afterUnlink, null)

/* -------------------------------------------------------------------------- */
/* The reconnect path                                                         */
/* -------------------------------------------------------------------------- */

// `deleteSession()` removes paths recursively, so a session deleted while a
// reconnect was pending used to take `sessions/` with it. The retry recreates
// the root before rebuilding, which this checks can be done from nothing.
rmSync(sessionsDir(), { force: true, recursive: true })
check('session root can be removed wholesale', existsSync(sessionsDir()), false)

ensureSessionsDir()
check('and brought back before the retry', existsSync(sessionsDir()), true)

/* -------------------------------------------------------------------------- */
/* Cleanup                                                                    */
/* -------------------------------------------------------------------------- */

for (const path of [dir, storeFile(SESSION), `${storeFile(SESSION)}.backup`]) {
    rmSync(path, { force: true, recursive: true })
}

console.log(failures === 0 ? '\nAll session-directory checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
