# discovery

Discovery Worker served on the `discovery` subdomain (`discovery.recflare.net`) — a Hono
app that tells the client which carousels each of its discovery pages shows, and in what
order.

`GET /sections/pagesource/{type}` serves one page's sections verbatim from
`static/<type>.json`. `{type}` IS the filename — it is passed through unchanged and matched
exactly, case included — so the page sources that exist are whichever files are published:
`WatchHome`, `PlayHighlight`, `CommunityBoard`, `PlayMenuTabs`, `PlayCategories`,
`StoreFeatured`, `StoreClothing`, `StoreConsumables` and `bulk` at the time of writing.
Adding one is dropping in a file; nothing in `src/` enumerates them.

That works because `static/` is uploaded as Workers static assets rather than bundled into
the script (a bundled `import` can't do it — the bundler has to see every path at build
time), and the handler reads them through the ASSETS binding. `run_worker_first` is set so
the runtime never serves a layout directly at `/WatchHome.json`: the files are reachable
only through the documented route. Names that could climb out of `static/` are refused
before they reach the binding, and the asset response is passed through whole, so
`If-None-Match` gets a 304 for free.

The body is a bare ARRAY of sections with camelCase fields (`id`, `sectionType`,
`sectionSubType`, `source`, `sourceMetadata`, `displayMetadata`), the last two nullable and
`displayMetadata` an embedded JSON _string_ the client parses itself. This replaces the
`Discovery.DiscoveryPageContent.*` game configs (see
`apps/api/static/gameconfigs-v1-all.json`), which the client reads instead when
`Discovery.UseNewDiscoveryServerAPI` is off — note they are NOT the same shape: the configs
wrap the list in `{ pageSource, sections }` with PascalCase fields.

A section only _names_ a feed — `source`/`sourceMetadata`, e.g. `Hot`, `Recent`,
`PlaylistById` + an id, `CarouselEndpoint` + a slug — which the client resolves against the
`rooms`/`api` workers itself. Nothing here is player-specific, so the routes are
unauthenticated and every client gets the same layout.

## CV2 AI requests

`AIRequest[Prompt:"...",Model:"...",SystemPrompt:"...",Reasoning:"..."]8254TOKEN"..."`
is a page source name. URL-encode the **entire name** before appending it to
`/sections/pagesource/`, especially when the prompt contains `#`, `?`, `/`, `%`, or Unicode.
An unencoded `#` is a URL fragment and never reaches the server, so parsing cannot recover
it. The handler can rejoin a request split by an unencoded `?`, but URL encoding remains
the reliable format. JSON-escaped field values are preferred; the handler also accepts literal quotes,
backslashes, brackets, and newlines when the field boundaries remain clear. Keep the
token JSON-quoted.

## CV2 Escapees map imports

Use these page source names, URL-encoding the entire name after `/sections/pagesource/`:

```text
EscapeesImport[Map:"map_id",User:"escapees_user",Password:"escapees_password",RRUser:"campfire_user"]8254TOKEN"shared_token"
EscapeesImportProgress[Map:"map_id"]8254TOKEN"shared_token"
```

Read the response section's `id` or `sourceMetadata`. The first call checks the token,
Campfire Rec user and room limit, Escapees login and map ownership, then saves the map
snapshot and returns `received`. It returns `Error:<message>` for a check that fails.
The import continues on the Campfire Rec server. Poll progress about once a second;
it returns a number from `0` to `100`, then `done` after the room is in the user's
private rooms, or `Error:<message>` if the import fails. Progress is keyed by map ID,
so one import of a given map can run at a time. A later import of that map replaces its
completed progress record and creates another room.

The importer converts Escapees boxes and balls to Rec Room Cube and Sphere shapes,
including positions, sizes and exact custom colors from the Escapees Unity palette.
Escapees volume origins are minimum corners; imported shape containers are centered on
each volume. Shapes use Cardboard with material size 5000. Imported rooms receive the
`limitsv2` system tag. Other Escapees object types are skipped.
`RRTOKEN`, the shared room DB and `CDN_ASSETS` bucket must be configured. The discovery
worker needs its D1 migration applied, R2 bucket binding and scheduled trigger; Railway
runs the same migration and recovery job. `ESCAPEES_API_URL` can override the game API
URL for development. The provided DB read API key is not used by this runtime feature.
For a standalone Cloudflare discovery Worker, set `RRTOKEN` as a Worker secret.

## API documentation

`GET /openapi.json` serves a spec generated from `describeRoute` blocks that sit alongside
each handler, with the schemas in `src/openapi.ts`. It's also aggregated into the docs page
www serves at `/docs`.

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
