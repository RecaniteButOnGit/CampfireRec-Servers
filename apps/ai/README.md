# ai

AI worker served on the `ai` subdomain (`ai.recflare.net`). The client checks here before
offering any of its AI features — Game AI in a room, the Roomie assistant, and Maker AI's
usage meter.

The worker serves access and budget checks and mints Roomie session credentials. The
checks are mostly static because they do not meter usage:

- **Game AI** access is enabled only in rooms named exactly `GameAI` or `GameAIRooms2`.
  This worker does not run Game AI models or meter their usage.
- **Roomie** runs on the **client**. Its budget reads grant everything. Session creation
  asks OpenAI for a short-lived client secret when `OPENAIKEY` is configured.
- **Maker AI** meters model usage in dollars. Nothing here bills, so every figure is zero.

- `GET /` — service status `{ "service": "ai", "status": "ok" }`. No auth.
- `GET /gameai/user/access?roomId=<id>` — `[Authorize]`. Resolves the room by ID from the
  shared rooms database. If its canonical `Name` is exactly `GameAI` or `GameAIRooms2`,
  returns:

  ```json
  { "success": true, "error_id": null, "error": null }
  ```

  Every other, missing, or malformed room ID returns:

  ```json
  {
    "success": false,
    "error_id": "AI.RoomDoesNotSupportGameAI",
    "error": "This room does not support Rec Room Game AI"
  }
  ```

  Both answers use HTTP 200 because the client branches on `success`. The bearer token is
  validated first; missing or invalid tokens still get an empty-body 401.

- `GET /gameai/room/<roomId>/spendsummary` — `[Authorize]`. Uses the same room eligibility
  check. The two eligible rooms get an unmetered empty summary:

  ```json
  { "success": true, "error_id": null, "error": null, "value": {} }
  ```

  Other rooms retain the denied response:

  ```json
  {
    "success": false,
    "error_id": "AI.RoomDoesNotSupportGameAI",
    "error": "This room does not support Rec Room Game AI",
    "value": null
  }
  ```

  The available 2025 protocol evidence contains only a denied spend-summary example, so
  the successful `value` DTO has not been verified against a client capture. The empty
  object adds no speculative spend fields and needs a real client test.

- `GET /roomieai/user/access` — `[Authorize]`. Roomie AI's energy budget, granted in full:

  ```json
  {
    "success": true,
    "error_id": null,
    "error": null,
    "value": {
      "MaxEnergyFromSubscriptions": 2147483647,
      "EnergyLeft": 2147483647,
      "NextSubscriptionEnergyRechargeAt": null,
      "OutputAudioEnabled": true
    }
  }
  ```

  Granted rather than refused because Roomie runs on the CLIENT and only asks this service
  how much energy it may spend — so for a server that meters nothing, "as much as you can
  count" is the honest answer. That number is `int.MaxValue`: the client's field is a
  signed 32-bit int, and anything larger overflows on the way in and reads as negative,
  i.e. no energy at all. Nothing depletes, so nothing recharges — hence the null
  `NextSubscriptionEnergyRechargeAt`.

  Note the envelope: `{ success, error_id, error, value }`, not the flat body the Game AI
  check answers with. The two shapes are different on purpose; don't unify them.

- `GET /roomieai/user/facts` — `[Authorize]`. What Roomie has been told about the caller:

  ```json
  { "UserContext": "", "UserFacts": [] }
  ```

  Live, `UserContext` is a prose profile written from past conversations and `UserFacts`
  holds the discrete `(Predicate, Object)` claims behind it — things the player told Roomie
  about themselves. Nothing on this server observes a conversation, so there is nothing to
  remember and Roomie starts every session knowing nothing about who it's talking to. A
  flat body, like the Maker AI balances below.

- `GET /makerai/user/balances` — `[Authorize]`. What Maker AI has cost the caller, metered
  live in **dollars** against a per-user ceiling and a separate RR+ allowance, and rendered
  by the client as a usage bar with a status word:

  ```json
  {
    "UsageDollars": 0,
    "UsersMaxUsageDollars": 0,
    "RRPlusUsageDollars": 0,
    "UsersMaxRRPlusUsageDollars": 0,
    "TimeBalanceStatus": "Empty",
    "TimeExpiresAt": "0001-01-01T00:00:00",
    "UsageBalanceStatus": "Good",
    "UsagePercent": 0,
    "RRPlusUsageBalanceStatus": "Good",
    "RRPlusUsagePercent": 0
  }
  ```

  Zeroed rather than refused: nothing here bills for model usage, so the caller has spent
  nothing. Both usage buckets report `Good` — an untouched allowance, not an exhausted one.
  The time bucket is `Empty` at `DateTime.MinValue`, this server selling no timed access
  for it to hold. Flat body, no envelope.

- `POST /realtime-session/create` — `[Authorize]`. Posted when the player uses Roomie.
  The server calls OpenAI's GA `POST /v1/realtime/client_secrets` endpoint and returns
  only the session id and short-lived client secret:

  ```json
  {
    "success": true,
    "error": null,
    "error_id": null,
    "value": { "SessionId": "sess_...", "ClientSecret": "ek_..." }
  }
  ```

  `OPENAIKEY` stays server-side and is never returned. The default model is
  `gpt-realtime-2.1-mini`; set `OPENAI_REALTIME_MODEL` to override it. Both variables are
  optional for backend startup, but session creation needs `OPENAIKEY`. A missing key,
  OpenAI failure, or invalid response returns HTTP 200 with `success: false`, a safe
  `error`, `error_id: ""`, and `value: null`. The posted `AIType` is optional; extra fields
  and malformed bodies do not prevent session creation.

  Minting a GA client secret does not establish whether the July 2025 Rec Room client can
  connect with it. After deployment, inspect `Player.log` for the client's attempted
  Realtime endpoint, protocol headers, and any connection error.

The worker exists so the client gets a definite answer on the host its endpoints document
already names (`AI` → `ai`, see `apps/ns`), instead of a failed request to a host with
nothing behind it.

Not served here: `GET /api/makerai/checkfreetrialeligibility`, which despite the name lives
on the `api` host in the reference server and belongs to `apps/api`.

## API documentation

`GET /openapi.json` serves a spec generated from `describeRoute` blocks that sit alongside
each handler, with the schemas in `src/openapi.ts`. It's also aggregated into the docs page
www serves at `/docs`. A test asserts every route appears in it.

**The spec is descriptive, not enforced** — same rationale as the other workers: a
reverse-engineered protocol, lenient handlers, no runtime validation.

## Development

### Run in dev mode

```sh
pnpm dev
```

### Run tests

```sh
pnpm test
```

### Deploy

```sh
pnpm turbo deploy
```
