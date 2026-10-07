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
chip/type/event definitions, apply exact revision-checked patches, validate graphs
and the room, inspect the diff, and finish or abort. Every run also has the global
registry described below, including runs on valid saves with no chips. Configured
ports remain instance-specific; event receivers of one type can have different
ports. Missing definitions are reported explicitly. No chip behavior is inferred
from an unrelated protobuf field name.

Compilation checks fields/scalars/enums, identity, registry definitions, references,
input structure, port direction and compatibility where a connection changes.
Chip configuration variants and opaque legacy port metadata remain fixed to their
verified saved representation; another chip's protobuf payload cannot be substituted.
Finalization requires validation and diff inspection after the last patch.
The model uses a tool loop with encrypted continuity and automatic Responses
compaction at 24,000 tokens. The decoded room is never put into the model context.

## Global CV2 definition registry

`src/cv2-agent/registry.ts` exposes `Cv2DefinitionRegistry` through the lazy,
process/Worker-isolate singleton `getCv2DefinitionRegistry()`. All workspaces share
immutable indexes; target-room observations never alter global knowledge. No
metadata is downloaded or regenerated during an AI run. Deployment with regenerated
artifacts replaces the cache when its underlying sources change.

The pinned [official CircuitsV2Resources export](https://tyleo-rec.github.io/CircuitsV2Resources/)
provides 1,328 chip GUIDs, names, descriptions, descriptor groups, ordered input/output
ports, execution/data distinctions, type names, generic constraints, filters and
availability metadata. Its normal palette contains 1,147 chips; the full export
also contains hidden/development entries, which are explicitly identified. The
catalog describes its export version, so existence in this catalog does not
guarantee availability in a particular Campfire client version or room mode.

The protobuf schema supplies configuration fields/numbers, message dependencies,
enum values, type structures, variable memory modes, event structures and storage
defaults. Field numbers are never treated as chip type identifiers. Chip-to-payload
associations are included only where bundled saves contain that exact serialized
type GUID and payload. Five checked-in rooms contribute observed configurations,
port descriptions, arity and scoped event definitions. These observations are
separate from published chip definitions and are never promoted to chip defaults
or universal built-in event IDs. Matching concrete descriptors can associate a
published type name with an observed serialized type; unmatched identities remain
explicitly unknown.

Registry methods include `getChip(idOrName)`, `searchChips`, `getType`, `searchTypes`,
`getEvent`, `getDefinition`, `searchDefinitions` and `getChipVariants`. Searches
support category filters, deterministic pagination and `*` enumeration, with at
most 50 results per page. Agent tools expose these methods plus `get_registry_info`.
`get_chip_definition` returns global knowledge and separate target-room instances;
it accepts public names, definition IDs, standard GUID text or serialized hex IDs.
Agents are instructed to search globally before declaring a chip unavailable.

Catalog `runtimeGuid` uses standard C# GUID text; `typeId` is the byte-order-correct
16-byte hex used in scripts. For example, Event Receiver's catalog GUID
`8b533ccb-643a-491d-982c-94417ce99954` becomes serialized
`cb3c538b3a641d49982c94417ce99954`. Removing dashes is not a valid conversion.

Every entry exposes provenance, scope and missing information. `Cv2ChipFactory` in
`construction.ts` builds every published palette chip type from its known GUID and
descriptor groups, assigning fresh IDs and initializing protobuf messages. The
factory shares the registry cache; construction needs neither a recipe nor a
matching chip in the target room. `get_chip_construction` reports the input layout,
generic constraints, mapped payload fields and required scoped bindings;
`create_chip` inserts the fresh instance into a revision-checked virtual graph.
Raw IR additions use this same factory. Template and recipe selector directives
are removed from the language and agent tools.

Inputs use protobuf wire defaults, not guessed client factory settings. Public
descriptors supply one input per descriptor; reference layouts optionally enrich
known variadic expansion indices. Published output descriptors supply output order;
unknown additional configured ports remain unavailable. Mapped configuration
messages start empty, with protobuf defaults; output-count fields derive from the
published output descriptors. Variables need an explicit name and memory mode.
Generic bindings need compatible concrete wires so runtime inference agrees.
Configured events and object chips need valid scoped bindings and authoritative
port metadata; source-save IDs are never copied. Configuration JSON can supply
known payload fields, but cannot substitute another chip's payload. Hidden/development
chips, unknown GUIDs, invented ports/types and opaque signal encodings remain rejected.

## Supported edits and current limits

- Existing chips can have their names, typed constants and configuration edited
  when the save supplies the corresponding representation.
- Legacy saves without entity topology support factory creation even in empty graph
  containers, and wiring using published descriptors or verified instance metadata.
- Saves with `CircuitRootData.entities` contain a second authoritative topology.
  Chip/connection creation and deletion are deliberately rejected for those saves;
  an adapter for the entity ID allocators and bindings is still required. Existing
  chip field edits preserve that topology. This is not yet a universal CV2 compiler.
- Opaque `backing_bytes`, deprecated GUID port wiring, arbitrary port arity changes,
  new saved graph containers and invented chip types are unsupported. The supplied
  protobuf definitions describe storage, and the global catalog supplies built-in
  descriptors; neither completely specifies every serialized instantiation or
  signal byte encoding. The agent must abort requests requiring missing details.
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
the reflection schema, static codecs, `published-catalog.json` and
`reference-catalog.json`; run `node apps/discovery/cv2-schema/generate.mjs`
from the repository root. Codecs are compiled ahead of time because Workers forbid
runtime code generation. Only message types reachable from `PersistedRoomData`
need executable codecs; full metadata remains searchable through type tools.

`cv2-schema/upstream/` retains both official exports and their MIT license, pinned
to commit `d4dc2523506862a46844e4c6064bcc2cbc2a08bb`. Its source manifest records the
repository and paths; generated catalog provenance records both export hashes and
all reference-save hashes. To update it, replace the exports with files from a
chosen upstream commit, update the source manifest's commit, regenerate, and review
the resulting definitions. These are generated catalogs, not manually maintained
chip lists. No secret or new deployment environment variable is needed.

`apps/railway/src/cv2-agent.test.ts` covers round trips, unknown fields, isolation,
stable IDs/layout, invalid scripts/types/ports, patches, validation gates, repair
limits, command authentication/idempotency, save history and concurrent rebases.
Set `CV2_NATIVE_ROOM` to the path of an exported raw `persisted_room_data.original.binpb`
to run the native-room regression in addition to the portable fixtures. The
discovery codec integration test also exercises encoding inside the Worker runtime.
Model calls in automated tests are mocked; no paid live OpenAI run is performed.
`apps/railway/src/cv2-registry.test.ts` additionally checks the complete official
catalog, GUID byte ordering, typed/generic ports, schema enums/configuration,
pagination, scoped observations, source hashes, cache sharing, empty-room tools and
preservation of the compiler's no-invention rule.

The Responses tool loop and automatic compaction follow OpenAI's
[function calling](https://developers.openai.com/api/docs/guides/function-calling)
and [compaction](https://developers.openai.com/api/docs/guides/compaction) documentation.
