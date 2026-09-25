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
  media.js              media download and base64 helpers
  jid.js                phone / group JID normalisation
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
```

Every value has a default, so the app also starts without a `.env` file.

## Usage

1. You can start the app by executing `npm run start` or `node .`.
2. Now the endpoint should be available according to your environment variable configurations. Default is at `http://localhost:8000`.

Also check out the `examples` directory for the basic usage examples.

## Scripts

| Command                | What it does                    |
| ---------------------- | ------------------------------- |
| `npm start`            | Run the API                     |
| `npm test`             | Run the store regression checks |
| `npm run lint`         | ESLint (flat config)            |
| `npm run lint:fix`     | ESLint with `--fix`             |
| `npm run format`       | Prettier write                  |
| `npm run format:check` | Prettier check                  |

## API Docs

The API documentation is available online [here](https://documenter.getpostman.com/view/9471522/2s8YehTwHJ). You can also import the **Postman Collection File** `(postman_collection.json)` into your Postman App alternatively.

The server will respond in following JSON format:

```javascript
{
    success: true|false, // bool
    message: "", // string
    data: {}|[] // object or array of object
}
```

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

Currently there's no known issues. If you find any, please kindly open a new one.

### Dependency advisories

`npm audit` reports advisories inherited from `@innovatorssoft/baileys` that this
project cannot patch on its own:

- `link-preview-js` — SSRF via IPv6 / loopback, **no fix published**. Relevant
  because `generateHighQualityLinkPreview` is enabled, so links found in incoming
  messages are fetched server side. Do not expose this API to untrusted callers
  without turning that option off.
- `protobufjs` (through `@itsukichan/libsignal-node`) — several advisories,
  fixable with `npm audit fix`. Note that `package-lock.json` is gitignored here,
  so the fix is not reproducible from the repo until it is committed or pinned
  with an `overrides` entry.

## Notes

- The app only provide a very simple validation, you may want to implement your own.
- When sending message, your `message` property will not be validated, so make sure you sent the right data!
- The API key is only enforced when `AUTHENTICATION_GLOBAL_AUTH_TOKEN` is set.
- The message store keeps everything in memory and mirrors it to a json file per session; you may want to use a better data management.
- The store also writes a `.backup` copy before a history sync overwrites existing data. It is removed together with the session.
- `QRCODE_UPDATED` is only sent to the webhook while a session creation request is still waiting for a QR.
- **An unscanned QR expires.** `POST /sessions/add` answers with one QR code; if it is not scanned before WhatsApp rotates it, the session logs itself out and is deleted, and you have to call `/sessions/add` again. Keep that in mind when your UI shows the QR.
- If you have problems when deploying on **CPanel** or any other similar hosting, transpiling your code into **CommonJS** should fix the problems.

## Notice

This project is intended for learning purpose only, don't use it for spamming or any activities that's prohibited by **WhatsApp**.
