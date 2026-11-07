# Tracking integration proposal — Owners 2 and 4 review required

No canonical schemas or backend existed when Owner 3 began. Worker internal dataclasses are not shared API types. The worker emits README v1 field names; publishing requires a supplied canonical JSON Schema (`--batch-schema`) and remains unverified against a real backend.

## Exact state/ack shape to adopt

`GET /api/internal/tracking/state?datasetId=...&cursor=...`:

```json
{"data":{"datasetId":"troy-demo","trackingRunId":"regional-v1","sequence":0,"clouds":[],"messages":[]},"nextCursor":null}
```

All pages must use one consistent dataset sequence. `clouds` uses README snapshots; include created clouds and retired origins still referenced by pending messages. `messages` includes `id`, `cloudId`, `version`, `anchor`, `updatedAt`, optional `positionAt`, optional `artworkControlPoints` (array of `{longitude,latitude}`), optional `expiredAt`. No author/media data is needed. `positionAt` is the geometric time of the parcel; it must not be changed by votes. If omitted on a new parcel, `updatedAt` must initially equal its placement time.

POST acknowledgement:

```json
{"data":{"datasetId":"troy-demo","batchId":"opaque-id","sequence":1}}
```

Do not return success until the batch transaction commits. Duplicate IDs return the original acknowledgement. Use unique event IDs and a single authoritative producer per dataset/run.

## Hold and retirement semantics

`action: hold`, `targetCloudId: null` means retain content pending reassociation, update its predicted position/control points/version, and hide it from public cloud queries while unresolved. It does not expire/delete it. Retirement during merge/split must not cascade-delete votes, media or pending messages. An explicit `expire` marks content expired. Worker checkpoints preserve pending successor IDs and clear-sky evidence, including across restarts.

The optional internal-state `positionAt` and control-point shape clarify unspecified v1 fields; Owner 4 decides schema inclusion/versioning. `updatedAt` on cloud snapshots is the geometric position time, which can stop at the prediction horizon; `observedAt` remains last actual match. Batch `observedAt` is the current processing observation time. Retirement is not evidence of dissipation.

## Concurrency and recovery

Every anchor update increments message version. If votes also update that version, return 409 on a stale expected version; worker refreshes state and recomputes with a new batch ID only when server sequence still equals the prior checkpoint. Otherwise retain the outbox and stop for explicit reconciliation. After a lost acknowledgement, resend the identical batch before fetching new state.

Apply all snapshots/events/transfers in one transaction. Newly posted messages are fetched before each observation; deleted/expired messages disappear from worker state. Producer checkpoint loss cannot reconstruct confidence history/evidence from snapshots alone: restore the journal or start a reviewed new run, never silently reset sequence.

Owner 2 acceptance: real DB tests for merge with concurrent posting/voting, held content on retired origin, duplicate ack after network failure, pagination snapshot consistency, media/vote preservation. Owner 4 acceptance: canonical-schema validation of every worker batch and generated Python bindings replacing raw wire dictionaries when available.
