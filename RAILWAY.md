# Railway runtime

This repository retains its Cloudflare Worker deployment. `apps/railway` runs the same Hono applications in one Node 24 process. It uses SQLite on the mounted volume, Redis for player settings, Railway's S3 compatible buckets for CDN and images, and an in-process SignalR notification hub.

## Resources and service settings

Use the existing Railway project resources:

| Resource | Purpose |
| --- | --- |
| `CampfireRec-Servers` | Node application, HTTP and WebSocket traffic |
| `Redis` | `RECFLARE_PLAYER_SETTINGS` KV binding |
| `recflare-cdn` | `CDN_ASSETS` bucket |
| `recflare-img` | `IMAGES` bucket |
| Persistent volume mounted at `/data` | SQLite database and notification state |

The application service must use **one replica** until notification synchronization across replicas is implemented. The hub shares live WebSocket state only within the current Node process. The notification state database is stored beside the main database as `${DATABASE_PATH}.notifications.sqlite`.

Railpack detects the root `build` and `start` scripts: run `pnpm build` (which runs `pnpm railway:build`) and `pnpm start`. `railpack.json` and `.mise.toml` select Node 24, while the root `package.json` selects pnpm 10.14.0. Keep the Railway service root directory at the repository root, set `PORT=8080`, and configure Railway's health check path as `/health`. The server binds `0.0.0.0:$PORT`.

The start command **automatically applies migrations before opening the HTTP listener**. Railway's pre-deploy phase cannot be relied upon to see the mounted volume, so do not put migrations there. `pnpm railway:migrate` is available for manual use against a volume-mounted environment. Every existing migration is tracked in its service's own `d1_migrations_*` table, and subsequent runs skip applied files. SQLite uses a write transaction while each migration is checked and applied, so concurrent processes do not both apply it.

## Variables

Required for a complete production service:

| Variable | Value/source |
| --- | --- |
| `JWT_SECRET` | Secret signing key, shared by all services |
| `DOMAIN` | Base domain, for example `campfire.recanite.net` |
| `PORT` | `8080` |
| `DATABASE_PATH` | `/data/recflare.sqlite` |
| `NODE_ENV` | `production` |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` |
| `CDN_BUCKET` | `${{recflare-cdn.BUCKET}}` |
| `CDN_S3_ENDPOINT` | `${{recflare-cdn.ENDPOINT}}` |
| `CDN_S3_ACCESS_KEY_ID` | `${{recflare-cdn.ACCESS_KEY_ID}}` |
| `CDN_S3_SECRET_ACCESS_KEY` | `${{recflare-cdn.SECRET_ACCESS_KEY}}` |
| `CDN_S3_REGION` | `${{recflare-cdn.REGION}}` |
| `IMG_BUCKET` | `${{recflare-img.BUCKET}}` |
| `IMG_S3_ENDPOINT` | `${{recflare-img.ENDPOINT}}` |
| `IMG_S3_ACCESS_KEY_ID` | `${{recflare-img.ACCESS_KEY_ID}}` |
| `IMG_S3_SECRET_ACCESS_KEY` | `${{recflare-img.SECRET_ACCESS_KEY}}` |
| `IMG_S3_REGION` | `${{recflare-img.REGION}}` |

Only `JWT_SECRET` is required to start a local server. Unconfigured Redis and buckets report `false` from `/health` and dependent routes are unavailable. `/health` returns 200 while SQLite is healthy and 503 if SQLite is unhealthy; the JSON includes `database`, `redis`, `cdn`, and `img` status without credentials.
For local runs without `DATABASE_PATH`, SQLite defaults to `./data/recflare.sqlite` relative to the process working directory. Set `DATABASE_PATH=/data/recflare.sqlite` in Railway so data survives deployments.

Recommended service-discovery override: `SUBDOMAINS={"moderation":"api"}`. This advertises the functional API reporting routes in place of the upstream moderation stub.

Optional integration and policy variables (exact names accepted by the runtime):

| Group | Variables |
| --- | --- |
| Meta login | `META_APP_SECRET` |
| Photon | `PHOTON_REALTIME_APP_ID`, `PHOTON_VOICE_APP_ID`, `PHOTON_CHAT_APP_ID`, `PHOTON_REGION` |
| Tachyon | `TACHYON_HOST_PORT`, `TACHYON_HOST_PORT_SANDBOX` |
| Economy and rooms | `STARTING_TOKENS`, `ROOM_REDIRECTS`, `MAX_ROOMS_PER_ACCOUNT`, `MAX_CLUBS_PER_ACCOUNT`, `MAX_TOKEN_GIFT`, `MAX_XP_GIFT` |
| Uploads and signup limits | `MAX_UPLOAD_BYTES`, `MAX_API_UPLOAD_BYTES` (also accepts `RECFLARE_MAX_API_UPLOAD_BYTES`), `MAX_ACCOUNTS_PER_PLATFORM_ID`, `MAX_ACCOUNTS_PER_IP`, `MAX_ACCOUNTS_PER_DEVICE_ID`, `PASSWORD_SIGNUP`, `BAN_EVASION_MATCH` |
| Turnstile signup | `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` |
| Discord OAuth, benefits and scheduled gifts | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_BENEFITS_ROLE_IDS`, `DISCORD_ROLE_TOKENS` |
| Image signing | `IMG_SIGNING_KEY`, `IMG_SIGNING_ENABLED` |
| CV2 AI requests | `OPENAIKEY`, `RRTOKEN` |
| CV2 counter | `RRTOKEN` |
| CV2 Escapees imports | `RRTOKEN`, `CDN_*` bucket credentials; optional `ESCAPEES_API_URL` |
| Deployment metadata | `SENTRY_RELEASE` |

The CV2 discovery chip can request `/sections/pagesource/AIRequest[Prompt:"Hello",Model:"gpt-6-luna",SystemPrompt:"You are an AI created for Rec Room",Reasoning:"none"]8254TOKEN"<RRTOKEN value>"` (URL-encode the path segment). The response is a one-item discovery section list with the model's text in `id` and `sourceMetadata`. The trailing token must match `RRTOKEN`; the server uses `OPENAIKEY` only after that check. The supported fields are `Prompt`, `Model`, `SystemPrompt`, and `Reasoning`; `Temp` is no longer accepted or sent to OpenAI. Errors appear as `AIError:...` in the same section fields. The `Ping` probe also requires a token: `Ping8254TOKEN"<RRTOKEN value>"`. The Railway request logger records custom request names without their arguments or token.

The discovery service also accepts `EscapeesImport[...]` and `EscapeesImportProgress[...]` page sources. It stages a map in the CDN bucket, converts its volumes in a background task and records the new private room for `RRUser`. The scheduler resumes interrupted imports each minute. Apply the discovery migration when updating the server; command and response details are in [the discovery README](apps/discovery/README.md).

The discovery service also accepts `CounterAdd8254TOKEN"<RRTOKEN value>"` and `CounterGet8254TOKEN"<RRTOKEN value>"`. Either command can include `[Anticache:"..."]` before `8254TOKEN`; the value is ignored. They share one persistent SQLite counter and return its updated or current value in the section's `id` and `sourceMetadata`. The counter starts at 0; the discovery migration creates it.

The related feature follows the upstream behavior when an optional integration is absent. In particular, web signup requires Turnstile when enabled, Meta nonce login needs the Meta secret, Discord benefits need their credentials, and image signing uses the existing optional configuration.
Web password signup is disabled by default in Recflare's current auth and website code. Set `PASSWORD_SIGNUP=on` alongside the Turnstile keys to offer it on Railway. Platform signup in the game remains available.

For Photon Realtime, configure the Photon Dashboard Custom Authentication URL as `https://auth.<DOMAIN>/photon/authenticate` (for this deployment, `https://auth.campfire.recanite.net/photon/authenticate`). The auth app verifies the token minted by `/player/connection-info` using `JWT_SECRET` and `PHOTON_REALTIME_APP_ID`. A plain GET without a token returns HTTP 200 with Photon `ResultCode: 3`; this is a safe route smoke test.

## Domains and routing

Point both `campfire.recanite.net` and `*.campfire.recanite.net` to the same Railway application service. The apex serves the existing `ns` discovery document. A service subdomain dispatches to its Hono app with the path unchanged. The server includes `accounts`, `ai`, `api`, `auth`, `cards`, `cdn`, `chat`, `clubs`, `commerce`, `datacollection`, `discovery`, `econ`, `img`, `leaderboard`, `link`, `lists`, `match`, `moderation`, `notify`, `ns`, `platformnotifications`, `playersettings`, `roomcomments`, `rooms`, `storage`, and `www`.

Create both custom domains in Railway and copy the DNS records shown there into the domain's DNS provider. Railway requires the apex CNAME and verification TXT. The wildcard requires its own CNAME, an `_acme-challenge` CNAME for certificate issuance, and the verification TXT shown for the domain. A CNAME without its TXT can resolve yet still return Railway's `Application not found` fallback.

For local development, a first path segment selects the service and is removed before dispatch: `http://localhost:8080/rooms/api/rooms` reaches `/api/rooms`. `http://localhost:8080/health` checks the runtime.

The `www` React SPA is built as ordinary Vite static files. Other static asset bindings read only their designated `static` directories. All service API routes stay in the existing Worker app modules.

## Scheduled jobs

CV2 Agent runs use the existing `OPENAIKEY` and `RRTOKEN`. The discovery scheduler
recovers queued runs and expires interrupted runs every minute. Watch
`[CV2 Agent][cv2agent_...]` in the Railway console for progress. The command,
save staging policy and compiler limits are documented in
[apps/discovery/CV2_AGENT.md](apps/discovery/CV2_AGENT.md).

The single application process runs the existing scheduled handlers automatically on UTC time:

| Job | Schedule |
| --- | --- |
| `match` and `rooms` | Every five minutes |
| `econ` | Monday 05:00 UTC |
| `www` | Daily 04:30 UTC |

For manual execution, `pnpm railway:cron match`, `pnpm railway:cron rooms`, `pnpm railway:cron econ`, and `pnpm railway:cron www` call those same handlers. Do not configure separate Railway Cron services while the in-process schedule is enabled, or jobs will run twice. Separate Cron services would also need access to the same persistent SQLite volume and a way to send notifications to the live application process.

## Verification

Run `pnpm install`, `pnpm railway:build`, `pnpm --filter railway check:types`, `pnpm --filter railway test`, and `pnpm railway:smoke`. The smoke command starts a temporary local server and checks `/health`, the apex discovery response, and hostname routing.

Cloudflare is still needed only for the original Worker deployment and its own test harness. The Railway server does not run Wrangler or connect to D1, KV, R2, Durable Objects, or the Cloudflare API.
