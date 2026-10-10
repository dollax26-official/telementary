# Telementary

A tiny, Railway-ready telemetry API for Minecraft activity data — built to receive reports from the **Fern** mod (and anything else that talks JSON over HTTPS).

It receives JSON, stamps it with a receive time, and stores it in a local file. One service, no database.

```
Minecraft + Fern  ──POST /api/telemetry──▶  Telementary (Railway)  ──▶  data/telemetry.json
                        (Bearer token)
```

## Endpoints

| Method | Path                       | Auth | Description                                     |
| ------ | -------------------------- | ---- | ----------------------------------------------- |
| `GET`  | `/`                        | –    | Service info                                    |
| `GET`  | `/api/health`              | –    | Health check — `{ "status": "ok" }`             |
| `POST` | `/api/telemetry`           | ✔    | Store one record (object) or a batch (array)    |
| `GET`  | `/api/telemetry?limit=100&offset=0` | ✔ | Read records (`offset` skips back from the newest) |

**Auth:** every `/api/telemetry` request must include your secret token, sent either as
`Authorization: Bearer <token>`, `x-telemetry-token: <token>`, or `x-api-key: <token>`.

## Example payload (what Fern sends)

Fern's local `activity.json` is already in the right shape — POST it as-is:

```json
{
  "player": "Player786",
  "uuid": "8280f006-3f61-3ece-adfd-8952041aff70",
  "minecraftVersion": "1.21.11",
  "singlePlayerWorlds": [
    {
      "name": "New World",
      "gameMode": "survival",
      "hardcore": false,
      "firstPlayed": "2026-10-07T15:22:57Z",
      "lastPlayed": "2026-10-09T18:04:11Z"
    }
  ],
  "sessions": [
    {
      "server": "example.com",
      "joined": "2026-10-07T15:22:57Z",
      "commands": [{ "time": "2026-10-07T15:23:01Z", "command": "/help" }],
      "chats": [
        { "time": "2026-10-07T15:23:10Z", "direction": "sent", "message": "hello" },
        { "time": "2026-10-07T15:23:40Z", "direction": "received", "sender": "Alex", "message": "hi Player786" }
      ],
      "left": "2026-10-07T15:24:04Z"
    },
    {
      "server": "local:E:a12b9bf3",
      "singleplayer": true,
      "world": { "name": "New World", "gameMode": "survival", "hardcore": false },
      "joined": "2026-10-08T10:00:00Z",
      "commands": [],
      "chats": [],
      "left": "2026-10-08T10:31:22Z"
    }
  ]
}
```

### Telemetry fields

| Field | Where | Meaning |
| --- | --- | --- |
| `sessions[].commands` | per session | Commands the player ran |
| `sessions[].chats` | per session | Chat messages. `direction` is `sent` or `received`; `sender` is set for received messages |
| `sessions[].singleplayer` + `sessions[].world` | single-player sessions | World name, game mode and hardcore flag of the integrated-server world |
| `singlePlayerWorlds` | root | Summary of every single-player world the mod user has opened |

The server accepts **any JSON object or array** and stores it as-is, so newer Fern builds
can add fields without any server changes. Fern v0.2+ sends chat logs and single-player
world metadata; the JSON body limit is 1 MB so chat-heavy activity files fit comfortably.

## Quick test

```bash
export URL="https://YOUR-APP.up.railway.app"
export TOKEN="your-secret-token"

# health (no auth)
curl "$URL/api/health"

# send a record
curl -X POST "$URL/api/telemetry" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"player":"Steve","minecraftVersion":"Fabric","sessions":[]}'

# read it back
curl "$URL/api/telemetry?limit=10" -H "Authorization: Bearer $TOKEN"
```

## Deploy on Railway (5 minutes)

1. **Create the project** — Railway: *New Project → Deploy from GitHub repo* → pick `telementary`.
2. **Set the token** — open the service → **Variables** → add `TELEMETRY_TOKEN` = a long random secret.
   Generate one with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
3. **Generate a public domain** — service → **Settings → Networking → Generate Domain**. You'll get
   something like `https://telementary-production-xxxx.up.railway.app`.
4. **Verify** — open `https://YOUR-DOMAIN/api/health` in a browser; you should see `{"status":"ok", ...}`.

That's it — one service, no database, no Docker.

### ⚠️ Data persistence

Railway containers have an **ephemeral filesystem**: `data/telemetry.json` resets on every
redeploy unless you attach a **volume**:

1. Service → **New → Volume** → mount it at `/app/data`.
2. Done — recorded telemetry now survives restarts and redeploys.

## Run locally

```bash
npm install
TELEMETRY_TOKEN=dev-secret npm start        # http://localhost:3000
npm test                                    # self-contained smoke test
```

On Windows PowerShell: `$env:TELEMETRY_TOKEN="dev-secret"; npm start`

## Local backup (sync to your PC)

`sync.js` downloads **everything** from your Railway server and stores it on this computer:

- `local-data/telemetry.json` — the full local archive (de-duplicated)
- `local-data/viewer.html` — a readable page showing all sessions and commands

Run it any time — with `npm run sync` or by double-clicking `sync.bat` (Windows).

Setup: add your server address to `.env`:

```
SYNC_SERVER_URL=https://YOUR-APP.up.railway.app
TELEMETRY_TOKEN=<same secret as in Railway>
```

On Windows you can also schedule `sync-silent.bat` in Task Scheduler to get automatic backups.

## Project structure

```
telementary/
├── server.js           # the whole API (Express, ~180 lines)
├── sync.js             # local backup tool: Railway -> this PC
├── sync.bat            # double-click to run the backup (Windows)
├── sync-silent.bat     # silent version for Task Scheduler
├── test/smoke-test.mjs # self-contained endpoint tests
├── railway.json        # Railway deploy config (healthcheck, restart policy)
├── .env.example        # environment variable template
├── data/               # JSON storage (git-ignored)
└── local-data/         # local backup output (git-ignored)
```

## Environment variables

| Variable          | Required | Default   | Purpose                                                                                  |
| ----------------- | -------- | --------- | ---------------------------------------------------------------------------------------- |
| `TELEMETRY_TOKEN` | ✅       | –         | Shared secret for `POST`/`GET /api/telemetry`. When unset, all telemetry requests are rejected. |
| `PORT`            | –        | `3000`    | HTTP port (Railway sets this automatically).                                             |
| `DATA_DIR`        | –        | `./data`  | Folder for `telemetry.json`. Mount your Railway volume here.                             |
| `MAX_RECORDS`     | –        | `5000`    | Keep only the newest N records; older ones are dropped on write.                         |

## Security notes

- **Fails closed**: with no `TELEMETRY_TOKEN` set, nothing is stored.
- Token comparison is constant-time (`crypto.timingSafeEqual`).
- `data/telemetry.json` is git-ignored — collected data never goes into the repository.
- Only collect telemetry from devices whose owners have agreed to it.
- No rate limiting yet — rotate the token if it ever leaks.

## Roadmap

- [x] Fern-side uploader (HTTPS POST from the mod on join / leave / command / chat)
- [x] `singlePlayerWorlds` + chat logs in the mod
- [x] Local backup + viewer (`sync.js` → `local-data/viewer.html`)


## Single-player world backup API

World backups are separate ZIP archives, not the JSON world summaries in telemetry.

- `POST /api/worlds` — device-token upload of a ZIP archive. Requires the
  `X-World-Backup-Consent: true` header, plus `X-World-Name` and
  `X-Minecraft-Username`. Send the raw ZIP bytes with
  `Content-Type: application/zip`. Requests without explicit consent are rejected.
- `GET /api/worlds` — master-token-only list of backup metadata.
- `GET /api/worlds/:id/download` — master-token-only download of a ZIP archive.

Device uploads are tied to the registering device token. The master token is
never returned to mod clients. Downloads require the dashboard's master token;
archive IDs are not public download credentials.

**Railway persistence:** set `DATA_DIR` to a directory on a Railway persistent
volume. The API stores archive files in `DATA_DIR/worlds` and metadata in
`DATA_DIR/worlds.json`. Without a persistent volume, files may be lost when
the service is redeployed or its container is replaced. World backups can be
large; keep an appropriate volume quota and backup-retention policy.
