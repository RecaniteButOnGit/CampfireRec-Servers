# studio

The RecFlare Studio host (`https://studio.<domain>`).

Device login stays on Auth, `GET /account/me` stays on Accounts, and the approval
page is WWW `/device`. This worker answers the editor's build list, stores a
locally built Windows and Android bundle pair, and answers the co-owner
presence list. It does not serve the bundle bytes. A stored build is loaded from
Rooms (`CurrentSave.UnitySubAssets`, and `GET /rooms/{roomId}/subrooms/{subRoomId}/unityasset`)
and from the bucket at `/room/{filename}`.

| Method | Path                            | Purpose                                                                                                                                                                                                                                                                                                                               |
| ------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/cloud-builds/for-room`        | Cloud builds for that room and subroom, newest first (`results`, `totalResults`). Query: `roomId`, `subRoomId`, `skip`, `take`. A bad query is an empty page.                                                                                                                                                                         |
| `POST` | `/cloud-builds/from-editor`     | Multipart Windows bundle (`windows`) and Android bundle (`android`), optional `windowsStripped` and `androidStripped`. Stores a finished cloud build on the subroom's latest save and sets `BecameRRStudioRoomAt` the first time. Bearer required, and the token must include `betastudio`. Caller must be the creator or a co-owner. |
| `GET`  | `/collaboration/owners-in-room` | Account ids of the room's co-owners (creator, or a Creator/CoOwner role) whose live presence is in that `roomId` and `subRoomId`. Body: `{ success: true, error: null, value: number[] }`. Bearer required.                                                                                                                           |

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

### Migrate

This worker owns `studio_cloud_build` on the shared `recflare` database (`migrations/`,
tracked in its own `d1_migrations_studio` table). The bundles themselves are rows of the
rooms worker's `unity_asset` (one per platform and kind: target 0 Windows / 2 Android,
`studio/<roomId>/<name>.assetbundle` as `filename` — the bytes sit at `room/<filename>` in
the bucket, the prefix the client adds — base64 SHA-256 as `hash`), so a stored build needs
the rooms migrations too. Deploying does not apply either.

```sh
just migrate -F studio             # remote
just migrate -F studio -- --local  # dev db
```
