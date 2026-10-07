# Campfire CV2 Agent

The discovery page-source command runs `gpt-6.1-sol` against an isolated, in-memory
CV2 workspace. It uses the existing `OPENAIKEY`, `RRTOKEN`, room database, scene
bucket, Responses integration and background scheduler. No live save is mutated
while the agent works.

URL-encode the complete command passed to `/sections/pagesource/{type}`:

```text
CV2AGENT[Room:"MyRoom",Prompt:"Change the timer from 5 seconds to 8 seconds",RequestId:"timer-edit-001"]8254TOKEN"<RRTOKEN>"
```

`Room` and `Prompt` are required. `SubRoom` optionally selects a subroom by name
or numeric ID; otherwise the first subroom in the room's ordered list is used.
`RequestId` is optional; reuse it when retrying the same request to return the
same run, and choose a new value for a new run. One run per subroom can be active.
`Anticache` is accepted and ignored. The existing shared token authorizes the
command, and new saves are attributed to the room creator.

The response is the usual discovery section list. Its `id` and `sourceMetadata`
carry a run ID such as `cv2agent_<32 hex digits>`. Poll with:

```text
CV2AGENTSTATUS[Run:"cv2agent_<32 hex digits>",Anticache:"1"]8254TOKEN"<RRTOKEN>"
```

Status returns `queued:<run>`, `running:<run>`, `done:Save:<id>`, or
`Error:failed:<reason>` / `Error:aborted:<reason>`. Commands use `Cache-Control:
no-store`. Normal room saves are staged for the owner to publish through the
existing publish-save flow. Dorm saves publish immediately, as usual.

## Workspace and compiler

`src/cv2-agent/language.ts` defines the line-oriented IR. Every disconnected
component is a virtual `.cv2` file under `/room/graphs/`. Saved graph GUIDs and
chip GUIDs appear as the exact 16 serialized bytes in hex, without GUID byte
order conversion. Names, field ordering and file ordering are deterministic.
Layout stays in the original chip message; new chips use nearby positions.

Chip fields and connections use actual `CircuitNodeData`, `NodeGroupData`,
`CircuitSignalData` and `StaticEdgeData` fields. JSON bytes are base64, enums use
their protobuf names, and 64-bit integers use decimal strings. Constants are
one field per line, so a small value edit produces a small diff. Unknown fields,
original wire ordering and untouched layout/geometry bytes survive compilation.
The runner verifies a byte-for-byte baseline round trip before contacting OpenAI.

The agent can list, search and read graph sections, search documentation, retrieve
chip/type definitions, apply exact revision-checked patches, validate graphs and
the room, inspect the diff, and finish or abort. Chip references come from the
save's actual type GUIDs, instance metadata and serialized port descriptions.
Definitions are instance-specific; event receivers of one type can have different
ports. Missing definitions are reported explicitly. No chip behavior is inferred
from an unrelated protobuf field name.

Compilation checks fields/scalars/enums, identity, known templates, references,
input structure, port direction and compatibility where a connection changes.
Chip configuration variants and opaque legacy port metadata remain fixed to their
verified saved representation; another chip's protobuf payload cannot be substituted.
Finalization requires validation and diff inspection after the last patch.
The model uses a tool loop with encrypted continuity and automatic Responses
compaction at 24,000 tokens. The decoded room is never put into the model context.

## Supported edits and current limits

- Existing chips can have their names, typed constants and configuration edited
  when the save supplies the corresponding representation.
- Legacy saves without entity topology support creating chips from known templates
  and editing connections when both endpoints have serialized type descriptions.
- Saves with `CircuitRootData.entities` contain a second authoritative topology.
  Chip/connection creation and deletion are deliberately rejected for those saves;
  an adapter for the entity ID allocators and bindings is still required. Existing
  chip field edits preserve that topology. This is not yet a universal CV2 compiler.
- Opaque `backing_bytes`, deprecated GUID port wiring, arbitrary port arity changes,
  new saved graph containers and invented chip types are unsupported. The supplied
  protobuf definitions describe storage, not every built-in chip's runtime behavior
  or every signal byte encoding. The agent must abort requests requiring those.
- The latest history save is used, including staged work. A missing/invalid scene
  blob fails explicitly. Raw `PersistedRoomData` scenes up to 32 MiB are supported;
  compressed/encrypted exports need a verified envelope adapter.

## Commit, recovery and logs

Every result gets a new scene blob and save-history row, with a sanitized comment
`AI Run "<prompt>" Complete`. The previous blob and row stay unchanged, and asset,
version and other save metadata carry forward. An atomic database comparison
guards the history head, published/staged pointers and active run deadline. Run
completion is recorded in the same transaction as save creation.

If the history changes, the compiler rebases only when the edited component,
layout, connections and relevant CV2 metadata still agree with the base. Changes
to unrelated components or geometry are retained. Ambiguous changes abort. A race
at commit discards the uploaded blob and retries at most three times. Transport
errors are checked against history before deleting a possibly committed blob.

Railway logs use `[CV2 Agent][<run>]` for tool activity, files, compiler attempts,
validation errors, token usage, latency, conflict checks, duration and final save
ID. They do not print credentials, upstream error bodies or model reasoning.
Workspace objects are run-local and released when execution returns; run status
records remain for polling. Runs are bounded to 60 model calls, 250,000 cumulative
tokens, five failed validation attempts and a 15-minute deadline. The discovery
scheduler recovers queued runs and expires interrupted runs. Long model runs are
intended for Railway; standalone Worker `waitUntil` lifetime limits still apply.

Apply `discovery/migrations/0004_cv2_agent.sql` before enabling the command.
Railway's existing startup migration runner applies it automatically. No new
secrets are required beyond the existing `OPENAIKEY` and `RRTOKEN`.

## Schema provenance and tests

`cv2-schema/RR_ProtobufDefinitions.zip` is the user-supplied authoritative archive.
`cv2-schema/source.json` records its SHA-256. `cv2-schema/generate.mjs` regenerates
the reflection schema and static codecs; run `node apps/discovery/cv2-schema/generate.mjs`
from the repository root. Codecs are compiled ahead of time because Workers forbid
runtime code generation. Only message types reachable from `PersistedRoomData`
need executable codecs; full metadata remains searchable through type tools.

`apps/railway/src/cv2-agent.test.ts` covers round trips, unknown fields, isolation,
stable IDs/layout, invalid scripts/types/ports, patches, validation gates, repair
limits, command authentication/idempotency, save history and concurrent rebases.
Set `CV2_NATIVE_ROOM` to the path of an exported raw `persisted_room_data.original.binpb`
to run the native-room regression in addition to the portable fixtures. The
discovery codec integration test also exercises encoding inside the Worker runtime.
Model calls in automated tests are mocked; no paid live OpenAI run is performed.

The Responses tool loop and automatic compaction follow OpenAI's
[function calling](https://developers.openai.com/api/docs/guides/function-calling)
and [compaction](https://developers.openai.com/api/docs/guides/compaction) documentation.
