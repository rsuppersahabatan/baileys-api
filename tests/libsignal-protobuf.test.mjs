/**
 * Proof that `@itsukichan/libsignal-node` still works after `package.json`
 * forces `protobufjs` to `^7.6.6`.
 *
 * Why this test exists: libsignal-node pins `protobufjs` to exactly `6.8.8`,
 * which is inside a critical advisory range (`<=7.6.2`). npm cannot fix that on
 * its own — an exact pin is not a range — so `package.json` carries an
 * `overrides` entry. The library only uses `protobufjs/minimal`
 * (`Reader`, `Writer`, `util`, `roots`), all of which protobufjs 7 kept stable,
 * but "should be compatible" is not evidence.
 *
 * So this test runs the real thing: two parties, a real X3DH session handshake,
 * and a real encrypt/decrypt round trip. Both message types cross the wire as
 * protobuf — `PreKeyWhisperMessage` (the first message) and `WhisperMessage`
 * (every reply after it) — so a broken protobufjs would fail right here.
 *
 * Run with `npm test`. No test framework needed.
 */
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

const libsignal = require('@itsukichan/libsignal-node')
const { keyhelper, ProtocolAddress, SessionBuilder, SessionCipher } = libsignal

let failures = 0
const check = (label, actual, expected) => {
    const passed = actual === expected
    failures += passed ? 0 : 1
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}: ${actual}${passed ? '' : ` (expected ${expected})`}`)
}

const ok = (label, condition) => check(label, Boolean(condition), true)

/**
 * The unified storage object libsignal expects. The library calls
 * `getOurIdentity`, `getOurRegistrationId`, `isTrustedIdentity`,
 * `loadSession`, `storeSession`, `loadPreKey`, `loadSignedPreKey` and
 * `removePreKey`; the rest are conveniences for this test.
 */
const createStorage = ({ identityKeyPair, registrationId }) => {
    const sessions = new Map()
    const preKeys = new Map()
    const signedPreKeys = new Map()

    return {
        preKeys,
        signedPreKeys,
        sessions,

        getOurIdentity: async () => identityKeyPair,
        getOurRegistrationId: async () => registrationId,

        // Everything is trusted here; identity changes are a WhatsApp-level
        // concern, not a protobuf one.
        isTrustedIdentity: async () => true,

        // `SessionCipher.getRecord` throws unless this returns a SessionRecord
        // instance, so the objects are stored as-is rather than serialized.
        loadSession: async (id) => sessions.get(id) ?? null,
        storeSession: async (id, record) => void sessions.set(id, record),

        // libsignal reads `.privKey` straight off these, so unwrap `keyPair`.
        loadPreKey: async (id) => preKeys.get(id)?.keyPair ?? null,
        loadSignedPreKey: async (id) => signedPreKeys.get(id)?.keyPair ?? null,
        removePreKey: async (id) => void preKeys.delete(id),

        storePreKey: async (id, record) => void preKeys.set(id, record),
        storeSignedPreKey: async (id, record) => void signedPreKeys.set(id, record),
    }
}

const PRE_KEY_ID = 31337
const SIGNED_PRE_KEY_ID = 22

// Bob is the party being messaged first, so he publishes a prekey bundle.
const bobIdentity = keyhelper.generateIdentityKeyPair()
const bobRegistrationId = keyhelper.generateRegistrationId()
const bobPreKey = keyhelper.generatePreKey(PRE_KEY_ID)
const bobSignedPreKey = keyhelper.generateSignedPreKey(bobIdentity, SIGNED_PRE_KEY_ID)

const bobStorage = createStorage({ identityKeyPair: bobIdentity, registrationId: bobRegistrationId })
await bobStorage.storePreKey(bobPreKey.keyId, bobPreKey)
await bobStorage.storeSignedPreKey(bobSignedPreKey.keyId, bobSignedPreKey)

const aliceIdentity = keyhelper.generateIdentityKeyPair()
const aliceRegistrationId = keyhelper.generateRegistrationId()
const aliceStorage = createStorage({ identityKeyPair: aliceIdentity, registrationId: aliceRegistrationId })

const aliceAddress = new ProtocolAddress('alice', 1)
const bobAddress = new ProtocolAddress('bob', 1)

// Alice runs X3DH against Bob's bundle.
await new SessionBuilder(aliceStorage, bobAddress).initOutgoing({
    identityKey: bobIdentity.pubKey,
    signedPreKey: {
        keyId: bobSignedPreKey.keyId,
        publicKey: bobSignedPreKey.keyPair.pubKey,
        signature: bobSignedPreKey.signature,
    },
    preKey: { keyId: bobPreKey.keyId, publicKey: bobPreKey.keyPair.pubKey },
    registrationId: bobRegistrationId,
})

const aliceToBob = 'halo dari alice, lewat protobufjs 7'
const firstMessage = await new SessionCipher(aliceStorage, bobAddress).encrypt(Buffer.from(aliceToBob))

check('first message is a PreKeyWhisperMessage (type 3)', firstMessage.type, 3)
ok('PreKeyWhisperMessage encoded to bytes', Buffer.isBuffer(firstMessage.body) && firstMessage.body.length > 0)

const bobCipher = new SessionCipher(bobStorage, aliceAddress)
const decryptedByBob = await bobCipher.decryptPreKeyWhisperMessage(firstMessage.body)

check('Bob read the PreKeyWhisperMessage', decryptedByBob.toString(), aliceToBob)
check('Bob consumed the one-time prekey', bobStorage.preKeys.has(PRE_KEY_ID), false)
ok('Bob stored the session it built from the handshake', bobStorage.sessions.size === 1)

// Bob replies, which is the plain WhisperMessage path.
const bobToAlice = 'balasan bob, sesi sudah terbentuk'
const reply = await bobCipher.encrypt(Buffer.from(bobToAlice))

check('reply is a WhisperMessage (type 1)', reply.type, 1)
ok('WhisperMessage encoded to bytes', Buffer.isBuffer(reply.body) && reply.body.length > 0)

const decryptedByAlice = await new SessionCipher(aliceStorage, bobAddress).decryptWhisperMessage(reply.body)

check('Alice read the WhisperMessage', decryptedByAlice.toString(), bobToAlice)

// A third message proves the ratchet keeps advancing after the handshake.
const followUp = 'pesan ketiga, ratchet berlanjut'
const third = await new SessionCipher(aliceStorage, bobAddress).encrypt(Buffer.from(followUp))
const thirdRead = await bobCipher.decryptWhisperMessage(third.body)

check('ratchet still advances after the handshake', thirdRead.toString(), followUp)

console.log(failures === 0 ? '\nAll libsignal checks passed.' : `\n${failures} libsignal check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
