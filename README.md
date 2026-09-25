# Baileys API

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/andresayac/baileys-api)

An implementation of [@innovatorssoft/Baileys](https://github.com/innovatorssoft/Baileys) as a simple RESTful API service with multiple device support. This project implements both **Multi-Device** client so that you can choose and use one of them easily.

## Requirements

- **NodeJS** version **20.0.0** or higher — enforced by `@innovatorssoft/baileys` at install time.

## Installation

1. Download or clone this repo.
2. Enter to the project directory.
3. Install the dependencies.
4. Copy `.env.example` to `.env` and adjust the values.

## Project structure

```
app.js                  express bootstrap, graceful shutdown
config.js               every environment variable, parsed once
routes.js               route mounting, 404 and error handling
response.js             the shared { success, message, data } envelope
errors.js               AppError + helpers used to give socket failures a status
logger.js               pino logger handed to baileys
controllers/            one module per route group
middlewares/            api key, request validation, session validation
routes/                 route definitions only
whatsapp/
  session.js            socket lifecycle: create, delete, recover, cleanup
  events.js             socket event -> webhook wiring
  webhook.js            webhook delivery and event filtering
  actions.js            the only module that calls baileys
  scheduler.js          queued messages, their timer and their JSON file
  typing.js             typing-indicator timing arithmetic
  media.js              media download and base64 helpers
  jid.js                phone / group / LID JID normalisation
  registry.js           live sessions and reconnect bookkeeping
store/                  in-memory message store with a JSON file on disk
tests/                  dependency-free regression checks
```

## `.env` Configurations

```env
# Api host and port
HOST=127.0.0.1
PORT=8000

# Number of reconnects after a dropped connection, -1 for infinite
MAX_RETRIES=-1

# Delay in milliseconds before reconnecting to whatsapp
RECONNECT_INTERVAL=5000

# Authentication
AUTHENTICATION_GLOBAL_AUTH_TOKEN=A4gx18YGxKAvR01ClcHpcR7TjZUNtwvE

# WEBHOOK CONFIGURATION
APP_WEBHOOK_URL=""
APP_WEBHOOK_ALLOWED_EVENTS=MESSAGES_UPSERT,MESSAGES_DELETE,MESSAGES_UPDATE
APP_WEBHOOK_FILE_IN_BASE64=false

# MESSAGE STORE
MAX_MESSAGES_PER_CHAT=150
STORE_AUTOSAVE_INTERVAL=10000

# silent | error | warn | info | debug
LOG_LEVEL=silent

# Fetch link previews for links found in incoming messages
GENERATE_HIGH_QUALITY_LINK_PREVIEW=true

# MESSAGE SCHEDULER
SCHEDULER_LATE_GRACE=300000
SCHEDULER_MAX_ATTEMPTS=3
SCHEDULER_RETRY_DELAY=30000
SCHEDULER_HISTORY_LIMIT=100
```

Every value has a default, so the app also starts without a `.env` file.

## Usage

1. You can start the app by executing `npm run start` or `node .`.

```
$ npm run install
$ npm approve-scripts --allow-scripts-pending
$ npm run start
```

2. Now the endpoint should be available according to your environment variable configurations. Default is at `http://localhost:8000`.

Also check out the `examples` directory for the basic usage examples.

## Scripts

| Command                | What it does                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `npm start`            | Run the API                                                                                   |
| `npm test`             | Store, QR-lifecycle, libsignal, scheduler, contacts, typing and collection checks (244 total) |
| `npm run lint`         | ESLint (flat config)                                                                          |
| `npm run lint:fix`     | ESLint with `--fix`                                                                           |
| `npm run format`       | Prettier write                                                                                |
| `npm run format:check` | Prettier check                                                                                |

## API Docs

The API documentation is available online [here](https://documenter.getpostman.com/view/9471522/2s8YehTwHJ). You can also import the **Postman Collection File** `(postman_collection.json)` into your Postman App alternatively.

The collection covers every route the app serves. Before sending anything, set
these collection variables:

| Variable   | What it is                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `base_url` | Where the API runs, e.g. `http://localhost:8000`                                               |
| `session`  | The session id you created with `POST /sessions/add`                                           |
| `receiver` | A phone number to send to                                                                      |
| `jid`      | A group id, without the `@g.us` suffix                                                         |
| `isGroup`  | `false` — **unquoted**, see the note in the collection description                             |
| `apikey`   | Sent as a query parameter; only needed when the server sets `AUTHENTICATION_GLOBAL_AUTH_TOKEN` |

`npm test` keeps it honest. `tests/postman.test.mjs` reads the route files and the
controllers and fails if the collection drifts: an endpoint added but not
documented, an endpoint documented that no route serves, a path or query
parameter that does not match, a body that is not valid JSON, or a `{{variable}}`
that is not defined. That check exists because the collection had already drifted
in ways that failed silently — a query parameter documented as `cursor_id` while
the controller read `cursorId` meant paging quietly returned the newest page every
time, and two documented endpoints had never been implemented.

The server will respond in following JSON format:

```javascript
{
    success: true|false, // bool
    message: "", // string
    data: {}|[] // object or array of object
}
```

## Session Lifecycle

This is the part of the API that surprises people, so it is worth reading before
you build a UI on top of it.

### One QR per request

`POST /sessions/add` creates the session and answers **exactly once**, with a
single QR code as a base64 data URL:

```json
{
    "success": true,
    "message": "QR code received, please scan the QR code.",
    "data": { "qrcode": "data:image/png;base64,..." }
}
```

WhatsApp rotates the QR about **once a minute**. Each rotation produces a new
code, and the only way to hand a code to a client is to answer that one
still-open HTTP request. Once the response has been sent there is no channel
left, so a rotated QR cannot be delivered to anybody.

That interval is measured, not copied from the ~20 seconds often quoted
elsewhere: three runs against this codebase dropped the session after 61.6s,
61.6s and 61.8s, so plan for roughly 60 seconds of QR validity.

### A QR that rotates unscanned deletes the session

If the QR is not scanned before WhatsApp rotates it, the session logs itself out
and is deleted. Concretely, you will see:

- the log line `Session "<id>" was not scanned before its QR rotated, dropping it.`
- the session disappearing from `GET /sessions/list`, and `GET /sessions/status/<id>`
  answering `404` with `"Session not found."`
- the `sessions/md_<id>` auth directory, `<id>_store.json` and its `.backup`
  copy removed from disk
- no further `QRCODE_UPDATED` webhook events for that session

The session is dropped rather than kept around because a session with an
invalidated QR cannot finish logging in. Leaving it registered would only mean
`/sessions/status` keeps reporting a login that is already dead, while your UI
keeps showing a QR that WhatsApp no longer accepts.

**To retry, call `POST /sessions/add` again.** Each call is a fresh login
attempt, and only one QR comes back from it.

A session recovered at boot that was never registered is dropped the same way:
nobody is waiting for its QR, so there is no way to complete the login.

### What this means for your UI

- **Show the QR immediately** and never cache it between attempts. From the
  moment you receive it you have roughly a minute.
- **Do not poll for a new QR from the same request.** There is only ever one
  code per `POST /sessions/add` call.
- **Detect the drop with `/sessions/status/<id>`.** A `404` means the session is
  gone and you should start a new login attempt, which is also the natural way to
  implement a "QR expired, show a new one" screen.
- **Subscribe to `CONNECTION_UPDATE`** if you would rather react to a webhook
  than poll. A successful scan reports `connection: "open"`.

### Pairing code sessions are exempt

With `usePairingCode: true` no QR is ever shown, so QR rotations are ignored
instead of being treated as a failed scan. That keeps the session alive while
the user types the 8 digit code into their phone.

If such a session loses its connection, the reconnect follows the normal QR
rules and the session is cleaned up: the pairing code that was already issued is
stale by then, so there is nothing left to complete.

## Message Scheduler

Queue a message now, have it sent later. Jobs are held in memory, mirrored to
`sessions/scheduler.json`, and re-armed on boot so a restart does not lose them.

### Endpoints

| Method   | Path                             | Session  | What it does                    |
| -------- | -------------------------------- | -------- | ------------------------------- |
| `POST`   | `/scheduler?id=<sessionId>`      | required | Queue a message                 |
| `GET`    | `/scheduler/list?id=<sessionId>` | required | Every job of that session       |
| `GET`    | `/scheduler/find/:jobId?id=`     | required | One job                         |
| `PUT`    | `/scheduler/update/:jobId?id=`   | required | Reschedule, or edit the content |
| `DELETE` | `/scheduler/delete/:jobId?id=`   | required | Cancel a pending job            |

The job id is always the path parameter `:jobId`, never `:id`, because the
session middlewares also read `req.params.id` — naming both `id` would make one
silently shadow the other.

### Queueing a message

```bash
curl -X POST "http://localhost:8000/scheduler?id=my-session" \
  -H 'Content-Type: application/json' \
  -d '{
        "receiver": "628123456789",
        "message": { "text": "selamat pagi" },
        "scheduledAt": "2026-09-26T01:00:00.000Z"
      }'
```

`message` is passed to Baileys untouched, so anything `POST /chats/send` accepts
works here too — text, image with a `url`, document, and so on. `isGroup: true`
switches `receiver` to group JID handling, and `typing` works exactly as it does
on `/chats/send`, so a queued message can arrive with a typing indicator before
it.

`scheduledAt` accepts an epoch millisecond number, a numeric string, or an ISO
8601 date string. It must be in the future; a past timestamp is rejected with
`400` and the code `SCHEDULED_AT_IN_PAST`.

The response is the job itself, with `201`:

```json
{
    "success": true,
    "message": "The message has been scheduled.",
    "data": {
        "id": "657d117d-ab1d-476c-8979-791f0dc78ed0",
        "sessionId": "my-session",
        "receiver": "628123456789",
        "jid": "628123456789@s.whatsapp.net",
        "message": { "text": "selamat pagi" },
        "typing": false,
        "scheduledAt": 1790311257000,
        "runAt": 1790311257000,
        "repeat": null,
        "runs": 0,
        "status": "pending",
        "attempts": 0
    }
}
```

`scheduledAt` is what you asked for and `runAt` is when it will actually run.
They differ once a job has been retried.

### Job statuses

| Status      | Meaning                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| `pending`   | Waiting, waiting to retry, or an unfinished series waiting for its slot |
| `sent`      | A one-off handed to WhatsApp; `messageId` and `sentAt` are filled in    |
| `completed` | A repeating job that ran its full `count`, or passed its `until`        |
| `failed`    | Every attempt failed; `lastError` says why                              |
| `cancelled` | Cancelled before it ran                                                 |
| `missed`    | A one-off whose time passed while the process was down past the grace   |

A failed attempt is retried up to `SCHEDULER_MAX_ATTEMPTS` times, waiting
`SCHEDULER_RETRY_DELAY` between tries. Exhausting the budget marks the job
`failed`; it is never dropped silently.

`PUT /scheduler/update/:jobId` with a new `scheduledAt` puts a `cancelled`,
`failed` or `missed` job back to `pending` with a fresh attempt budget, which is
how you recover one.

### After a restart

On boot every pending job is re-armed. A job whose time passed while the process
was down is sent only if it is within `SCHEDULER_LATE_GRACE` (5 minutes by
default); anything later is marked `missed` instead. Sending a message hours
late is usually worse than admitting it did not go, and either way the job stays
visible in `/scheduler/list` rather than vanishing.

Finished jobs are kept until `SCHEDULER_HISTORY_LIMIT` of them exist, so the list
does not grow without bound. Deleting a session deletes its queued jobs with it —
they belong to a session that no longer exists and could never be sent.

### It keeps working while WhatsApp is down

`POST /scheduler` requires a live connection, because a job queued for a socket
that cannot send only burns through its retry budget. The other four routes only
read or edit the queue, so they deliberately use a weaker session check and keep
working while a session is reconnecting. That is the moment you are most likely
to want to cancel something, and being locked out of your own queue because the
socket dropped would be the wrong answer.

Sending still needs a live connection. A job that comes due while the session is
disconnected fails, records `SESSION_NOT_CONNECTED` in `lastError`, and retries.

Note that "live connection" here means the websocket is open, which is also true
while a QR code is still waiting to be scanned. A job queued in that window is
accepted, then fails with the real reason at send time.

### Repeating messages

Add `repeat` to send the same message over and over:

```bash
curl -X POST "http://localhost:8000/scheduler?id=my-session" \
  -H 'Content-Type: application/json' \
  -d '{
        "receiver": "628123456789",
        "message": { "text": "laporan harian" },
        "scheduledAt": "2026-09-26T01:00:00.000Z",
        "repeat": { "every": "daily", "count": 5 }
      }'
```

`every` accepts `hourly` / `daily` / `weekly`, a duration string (`30s`, `15m`,
`2h`, `1d`) or a number of milliseconds. Anything under 1000 ms is rejected as
`REPEAT_INTERVAL_TOO_SMALL` — that is a loop, not a schedule. A bare string works
as shorthand: `"repeat": "daily"` means the same as `{ "every": "daily" }`.

Two optional limits sit alongside it:

| Field   | Meaning                                                  |
| ------- | -------------------------------------------------------- |
| `count` | Total sends, the first one included. Omit for unlimited. |
| `until` | Last time an occurrence may run. Omit for no end.        |

`runs` on the job counts the occurrences actually delivered, so it is also the
cursor into the series. A repeating job stays `pending` between sends and only
becomes `completed` when `count` is used up or the next slot would fall past
`until`.

A few deliberate choices worth knowing about:

- **The cadence is anchored to `scheduledAt`, not to the last send.** A slow send
  or a retry does not push every later occurrence back, so a `daily` job keeps
  running at the time you asked for.
- **Occurrences missed while the process was down are skipped, not queued up.** A
  week of downtime on a `daily` job resumes at the next slot instead of firing
  seven messages at once.
- **A missed series survives a restart.** Unlike a one-off, which is marked
  `missed`, a repeating job is moved forward to its next slot and stays
  `pending` — a daily reminder missed during an outage should still fire
  tomorrow. Skipped slots do not consume the `count` budget.
- **Rescheduling restarts the series.** `PUT /scheduler/update/:jobId` with a new
  `scheduledAt` resets `runs` to `0`, so the new time becomes occurrence zero.
- **A failed occurrence burns the job, not the series.** If every attempt for one
  occurrence fails the job ends as `failed`; revive it with
  `PUT /scheduler/update/:jobId`.

### Not included

Cron expressions. `repeat` covers fixed intervals, which is what a message
scheduler usually needs; for "every weekday at 09:00" you would compute the next
`daily` anchor yourself.

## Contact Lookups

Check whether a phone number, LID or username exists on WhatsApp, and resolve
between the three.

### Endpoints

| Method | Path                          | What it does                                 |
| ------ | ----------------------------- | -------------------------------------------- |
| `POST` | `/contacts/check?id=`         | Check any mix of numbers, LIDs and usernames |
| `GET`  | `/contacts/username/:jid?id=` | The username of a JID, if it has one         |

The JID is the path parameter `:jid`, never `:id`, because the session
middlewares also read `req.params.id` — naming both `id` would make one silently
shadow the other.

### Checking

```bash
curl -X POST "http://localhost:8000/contacts/check?id=my-session" \
  -H 'Content-Type: application/json' \
  -d '{
        "numbers": ["628123456789"],
        "lids": ["111111111111111"],
        "usernames": ["budi"]
      }'
```

All three fields are optional, but at least one is required. Each is an array,
and each is reported back separately:

```json
{
    "success": true,
    "message": "Checked 3 target(s), 3 exist on WhatsApp.",
    "data": {
        "numbers": [
            {
                "input": "628123456789",
                "jid": "628123456789@s.whatsapp.net",
                "exists": true,
                "lid": "111111111111111@lid"
            }
        ],
        "lids": [
            {
                "input": "111111111111111",
                "jid": "628123456789@s.whatsapp.net",
                "lid": "111111111111111@lid",
                "exists": true
            }
        ],
        "usernames": [{ "input": "budi", "jid": "628123456789@s.whatsapp.net", "exists": true, "contact": true }]
    }
}
```

They are kept apart rather than merged into one list because each answers a
different question: a number lookup wants its LID back, a LID lookup wants the
phone number behind it, and a username lookup wants the JID.

A few details that matter in practice:

- **`lid` is the only way to learn the number ↔ LID mapping.** LIDs are opaque
  numbers, so nothing about them can be derived — they only ever come from
  WhatsApp. A number that has no published LID reports `lid: null`; it still
  exists.
- **A LID lookup answers with the phone number in `jid`.** That is the reverse
  mapping, and it is the reason the two lists are not merged: the same account
  appears in both with the fields swapped.
- **`contact` says whether the account is a saved contact** of the session, not
  whether the username exists.
- **Unknown values are reported, not dropped.** They come back with
  `exists: false`, in the same order you sent them, so you can line the results
  up with your input.
- **Numbers are normalised.** `+62 811 111 1111` and `628111111111` resolve to
  the same JID. A value with no digits at all is rejected with `400` rather than
  quietly becoming `@s.whatsapp.net`, which could never match anything.
- **Long lists are batched.** USync queries are sent 50 users at a time, because
  a single query with hundreds is rejected by the server.

### The session has to be logged in

Both routes answer with `400 There is no connection with whatsapp at the moment`
unless the session is actually logged in.

This is stricter than the rest of the API on purpose. The standard session check
only asks whether the websocket is open, which is also true while a QR code is
still waiting to be scanned — baileys opens the socket before the login finishes.
An unlogged socket does not fail fast either: it never answers the query, it just
waits out the timeout. Measured on this codebase, that is **over 40 seconds of a
client sitting on nothing** before the fix, versus an immediate `400` now.

### Getting a username

```bash
curl "http://localhost:8000/contacts/username/628123456789@s.whatsapp.net?id=my-session"
```

```json
{
    "success": true,
    "message": "The username has been obtained successfully.",
    "data": { "jid": "628123456789@s.whatsapp.net", "username": "budi" }
}
```

`username` is `null` for an account that has not set one. That is a `200`, not a
`404` — "this account has no username" is an answer, not an error.

## Typing Indicator

`POST /chats/send`, `POST /chats/send-bulk` and `POST /scheduler` all accept a
`typing` option. When set, the session shows "typing…" for a moment and clears it
before the message is sent, so the recipient sees a pause rather than a message
appearing out of nowhere.

```bash
curl -X POST "http://localhost:8000/chats/send?id=my-session" \
  -H 'Content-Type: application/json' \
  -d '{
        "receiver": "628123456789",
        "message": { "text": "halo, sebentar ya" },
        "typing": true
      }'
```

| Value                  | What happens                                            |
| ---------------------- | ------------------------------------------------------- |
| `true`                 | Derive a duration from the message text                 |
| `1500`                 | Show it for 1500 ms                                     |
| `{ "duration": 1500 }` | Same thing                                              |
| `false`, `0`, `""`     | No indicator — the default, and what you get if omitted |

The order on the wire is always the same: `composing`, wait, `paused`, then the
message. Clearing it explicitly rather than letting WhatsApp time it out keeps
the pause from bleeding into whatever is sent next.

**Derived durations** scale with the length of the text, using
`base + length × perCharacter`, clamped between `min` and `max`. The defaults
are 400 ms, 45 ms per character, 700 ms and 6000 ms, so a one-word reply still
reads as a pause rather than an instant flip. A caption counts as text, because a
long caption is still typed. An explicit duration is clamped to 30 s.

`0` is treated as "off" rather than "instant". An indicator cleared the moment it
appears is a flicker, which is worse than not sending one at all.

**The indicator is cosmetic, so it can never cost you the message.** If the
socket refuses to send presence updates the send goes ahead anyway; if the socket
is genuinely broken the send fails on its own and reports the real reason. Only
`sendTypingIndicator` used directly, on its own, surfaces a presence failure.

## Available Features

At this moment we are working to bring more functionalities

### Autentication

    * ApiKey (By default it is not active, change it in env by adding your custom key)

### Sessions

    * Find Session
    * Session Status
    * List Sessions
    * Create New Session
        => QR method (Default)
        => Pairing Code method
    * Delete Session

### Chats

    * Get Chat List
    * Get Conversation
    * Forward Message
    * Send Presence Update
    * Read Message
    * Send  Bulk Message
    * Send with Typing Indicator
    * Send Message Types
        => Send Message Text
        => Send Message Image
        => Send Message Audio
        => Send Message Video
        => Send Message Document
        => Send Message Gif
        => Send Message Sticker
        => Send Message Contact
        => Send Message Location
        => Send Message React
        => Send Message How To Forward

### Groups

    * Get Chat List
    * Get Conversation
    * Get Group Metadata
    * Create Group
    * Group Update Participants
    * Group Update Subject
    * Group Update Description
    * Group Update Settings
    * Group Get Invite Code
    * Group Join Invite Code
    * Group Revoke Invite Code
    * Group Update Picture
    * Group List Without Participants

### Contacts

    * Check Numbers, LIDs and Usernames on WhatsApp
    * Get the Username of a JID

### Scheduler

    * Schedule Message
    * Schedule Repeating Message
    * List Scheduled Messages
    * Find Scheduled Message
    * Update / Reschedule Message
    * Cancel Scheduled Message

### Misc

    * Update Profile Status
    * Update Profile Name
    * Update Progile Image
    * Get My Profile {name, phote, status}
    * Get Profile User
    * Block And Unblock User
    * Public Story Status (NEW)

### Webhook

    * Global webhook

## Webhook Events

Configure in .env by default this `MESSAGES_UPSERT,MESSAGES_DELETE,MESSAGES_UPDATE` or use `ALL`
If it is necessary to send multimedia message in base64 use `APP_WEBHOOK_FILE_IN_BASE64=true`

| Name                      | Event                     | TypeData | Description                                                                                                                  |
| ------------------------- | ------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| ALL                       |                           |          | All event send to Webhook                                                                                                    |
| QRCODE_UPDATED            | qrcode.updated            | json     | Sends the base64 of the qrcode for reading                                                                                   |
| CONNECTION_UPDATE         | connection.update         | json     | Informs the status of the connection with whatsapp                                                                           |
| MESSAGES_UPSERT           | message.upsert            | json     | Notifies you when a message is received                                                                                      |
| MESSAGES_UPDATE           | message.update            | json     | Tells you when a message is updated                                                                                          |
| MESSAGES_DELETE           | messages.delete           | JSON     | Notifies when message is delete                                                                                              |
| MESSAGING_HISTORY_SET     | messaging-history.set     | JSON     | set chats (history sync), everything is reverse chronologically sorted                                                       |
| MESSAGES_MEDIA_UPDATE     | messages.media-update     | JSON     | Notifies when a message message media have update                                                                            |
| MESSAGES_REACTION         | messages.reaction         | JSON     | message was reacted to. If reaction was removed -- then "reaction.text" will be falsey                                       |
| MESSAGES_RECEIPT_UPDATE   | message-receipt.update    | JSON     | Notifies when a message have update                                                                                          |
| MESSAGES_DELETE           | messages.delete           | JSON     | Notifies when a message is delete                                                                                            |
| CONTACTS_SET              | contacts.set              | json     | Performs initial loading of all contacts</br>This event occurs only once                                                     |
| CONTACTS_UPSERT           | contacts.upsert           | json     | Reloads all contacts with additional information</br>This event occurs only once                                             |
| CONTACTS_UPDATE           | contacts.update           | json     | Informs you when the chat is updated                                                                                         |
| PRESENCE_UPDATE           | presence.update           | json     | Informs if the user is online, if he is performing some action like writing or recording and his last seen</br>'unavailable' | 'available' | 'composing' | 'recording' | 'paused' |
| CHATS_SET                 | chats.set                 | json     | Send a list of all loaded chats                                                                                              |
| CHATS_UPDATE              | chats.update              | json     | Informs you when the chat is updated                                                                                         |
| CHATS_UPSERT              | chats.upsert              | json     | Sends any new chat information                                                                                               |
| CHATS_DELETE              | chats.delete              | JSON     | Notifies when chats is delete                                                                                                |
| GROUPS_UPSERT             | groups.upsert             | JSON     | Notifies when a group is created                                                                                             |
| GROUPS_UPDATE             | groups.update             | JSON     | Notifies when a group has its information updated                                                                            |
| GROUP_PARTICIPANTS_UPDATE | group-participants.update | JSON     | Notifies when an action occurs involving a participant</br>'add'                                                             | 'remove'    | 'promote'   | 'demote'    |
| BLOCKLIST_SET             | blocklist.set             | JSON     | Notifies when is set contact in blocklist                                                                                    |
| BLOCKLIST_UPDATE          | blocklist.update          | JSON     | event of add/remove contact in blocklist                                                                                     |
| LABELS_EDIT               | labels.edit               | JSON     | event edit label                                                                                                             |
| LABELS_ASSOCIATION        | labels.association        | JSON     | add/remove chat label association action                                                                                     |

## Known Issue

Currently there's no known issues in the application code. If you find any, please kindly open a new one.

### Fixed — `ENOENT ... sessions/md_<id>/creds.json` on shutdown

If you deployed a version of this API from before this fix and saw this at exit:

```
Error: ENOENT: no such file or directory, open
  '.../baileys-api/sessions/md_primav1/creds.json'
    at async Object.writeFile (node:internal/fs/promises)
    at async .../baileys/lib/Utils/use-multi-file-auth-state.js:46:16
Running cleanup before exit.
```

it came from the session teardown, and the cause is worth knowing because it is
a property of how Baileys stores its auth state:

- `useMultiFileAuthState()` creates its folder **once**, at setup.
- Its `writeData()` — used by `saveCreds` and `keys.set` — only calls
  `writeFile` into that folder. There is no mkdir and no guard.
- `socket.ev.on('creds.update', saveCreds)` keeps that writer attached for as
  long as the socket lives.

`deleteSession()` used to `rm -rf` the auth directory. That left the attached
writer pointing at a path that no longer existed, so the next `creds.update`
threw `ENOENT` — and teardown itself triggers one, because `logout()` emits it.
"Running cleanup before exit." is not part of the error; it is the next log line,
which is why the failure always seemed to happen on shutdown.

Four things changed:

1. Session teardown **detaches the socket's listeners before touching any file**,
   so nothing can write to the session while it is being removed.
2. The auth directory is **emptied and recreated** instead of deleted. An auth
   directory with no `creds.json` still means "not registered" to Baileys, so the
   credentials are genuinely gone, but there is always a destination for a write
   that is already in flight.
3. The session is unregistered from the registry _before_ its files are removed,
   so background helpers that look sessions up by id stop finding a session whose
   files are mid-deletion.
4. `sessions/` is now created by the app itself rather than assumed. It is
   ignored by Git, so a fresh clone and a fresh deployment start without it —
   `restoreSessions()` used to return silently in that case instead of recovering
   anything.

`tests/session-dir.test.mjs` locks this down by reproducing the `ENOENT` against
the real library and then asserting a write after teardown succeeds.

The advisories below are a separate matter: they come from upstream packages and
are tracked here so they are not rediscovered on every `npm audit`.

### Dependency advisories

`npm audit` reports advisories inherited from `@innovatorssoft/baileys` that this
project cannot patch on its own. `package-lock.json` is committed, so the tree
described below is reproducible from the repo.

#### Fixed here — `protobufjs` (critical)

`@itsukichan/libsignal-node` pins `protobufjs` to exactly `6.8.8`, which sits
inside a critical advisory range (`<=7.6.2`). `npm audit fix` cannot resolve
this, because an exact pin is not a range — it reports "fix available" and then
changes nothing. So `package.json` carries an override instead:

```json
"overrides": {
    "protobufjs": "^7.6.6"
}
```

This is safe because the library only reaches for `protobufjs/minimal`
(`Reader`, `Writer`, `util`, `roots`), all of which protobufjs 7 kept stable.
`npm test` proves it rather than assuming it: the libsignal check runs a real
X3DH handshake and a real encrypt/decrypt round trip, so both
`PreKeyWhisperMessage` and `WhisperMessage` cross the wire as protobuf.

#### Not fixed — `link-preview-js` (high)

SSRF via IPv6 and loopback, **no fix published** — even the latest release is in
the vulnerable range, so there is nothing to upgrade to. It matters here because
`generateHighQualityLinkPreview` is enabled by default, which makes the server
fetch links found in incoming messages.

Mitigation: set `GENERATE_HIGH_QUALITY_LINK_PREVIEW=false`, or do not expose this
API to untrusted callers.

#### Not fixed — `file-type` (moderate)

Infinite loop in the ASF parser on malformed input, reached through
`music-metadata@7`. Fixing it means overriding `music-metadata` to `11`, which
Baileys does not support — it declares `^7.12.3`.

That override was tried and did parse WAV, OGG/Opus and M4A identically to
version 7 on both call paths Baileys uses. It was still not adopted, for two
reasons. It crosses four major versions of a dependency the upstream library
owns, and the exposure is narrow: `getAudioDuration` is only called on the
**outgoing** send path, so triggering it requires a caller to send a malformed
audio file through this API. Accepted as a moderate, self-inflicted risk rather
than traded for silent breakage in audio handling.

## Notes

- The app only provide a very simple validation, you may want to implement your own.
- When sending message, your `message` property will not be validated, so make sure you sent the right data!
- The API key is only enforced when `AUTHENTICATION_GLOBAL_AUTH_TOKEN` is set.
- The message store keeps everything in memory and mirrors it to a json file per session; you may want to use a better data management.
- The store also writes a `.backup` copy before a history sync overwrites existing data. It is removed together with the session.
- `QRCODE_UPDATED` is only sent to the webhook while a session creation request is still waiting for a QR, since the session is dropped as soon as a QR can no longer be delivered.
- **An unscanned QR expires and takes the session with it.** See [Session Lifecycle](#session-lifecycle) for the full rules and what your UI should do about it.
- Scheduled messages live in one file, `sessions/scheduler.json`, rather than one per session. See [Message Scheduler](#message-scheduler) for the retry and restart rules.
- The standard session check asks whether the websocket is open, not whether the account is logged in — baileys opens the socket before the login finishes. Endpoints that genuinely need a usable account must check further; [Contact Lookups](#contact-lookups) explains why that distinction matters there.
- If you have problems when deploying on **CPanel** or any other similar hosting, transpiling your code into **CommonJS** should fix the problems.

## Notice

This project is intended for learning purpose only, don't use it for spamming or any activities that's prohibited by **WhatsApp**.
