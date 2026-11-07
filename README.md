# Drift

**Leave a message. Let the sky carry it.**

Drift is a location-based social sky for HackRPI 2026: In The Clouds. Text, voice notes, music links, drawings, and PNG artwork travel with clouds. People underneath discover what arrived from somewhere else. Clouds move, merge, split, and dissipate; content shares that journey.

Repository: https://github.com/EliasCueto45/Drift

## Status and implementation baseline

This is a development specification, not a working application. No app scaffold, credentials, deployment, or running services exist yet. Numeric defaults below are explicit MVP decisions. Start around Troy, New York with a regional web app and a clearly labeled, deterministic historical replay. Live observations and replay must use separate datasets and clocks.

Chosen architecture: Next.js App Router + TypeScript, Clerk users, PostgreSQL/PostGIS, private S3-compatible media storage, a Python/OpenCV tracking worker, and a 2D canvas sky. The web app owns all public APIs. The worker submits authenticated lifecycle batches. Start with five-second polling. Owner 4 coordinates compatible runtime/dependency versions with the implementing owners and commits lockfiles during bootstrap.

```text
Satellite imagery + altitude-aware winds
                |
       Python tracking worker
                |
     authenticated tracking batches
                |
 Next.js API ---- Postgres/PostGIS
      |          private media storage
      |          Clerk identity
 Sky / discovery / composer UI
```

Planned directories:

```text
apps/web/src/app/                  pages and API routes
apps/web/src/server/               auth, DB, storage, lifecycle application
apps/web/src/features/sky/         sky, projection, previews, expansion
apps/web/src/features/composer/    posts, drawings, uploads, voting UI
services/cloud-worker/            satellite/wind adapters and tracker
packages/contracts/               JSON Schema and generated TS/Python types
db/migrations/                    ordered SQL, including PostGIS
fixtures/                         shared API examples and replay inputs
docs/handoffs/                     owner-1.md through owner-4.md
docs/decisions/                    reviewed architecture/contract changes
```

## Required experience

- Anonymous users can browse. Clerk sign-in is required to post, draw, upload, create clouds, or vote. Display authors by public profile, never email or GPS history.
- Single tap selects a cloud and shows up to three nearby message previews. Double tap expands it to see other messages. Provide an **Open cloud** button and keyboard activation for the same action.
- Filter previews by proximity first, then sort by upvotes descending, creation time descending, ID ascending. Expanded view defaults to a paginated **Nearby** tab; an explicit **All in cloud** tab exposes the rest. No limit on total messages per cloud; paginate responses.
- One upvote per user/message. Tapping again removes it. Counts are authoritative on the server; optimistic UI must reconcile or roll back. Popularity never extends content lifetime.
- Message types: `text`, `audio`, `song`, `drawing`, `png`. Artwork is attached to the cloud and appears as an upvotable message in the expanded view. Audio requires explicit playback; songs remain links.
- Freehand drawing directly on a cloud stores editable strokes in normalized local coordinates and a transparent PNG rendering. PNG uploads support positioning, scaling, rotation, and alpha transparency. Clip artwork to the cloud boundary. Transport its anchor/control points with local cloud motion.
- Initial validation limits: text 2,000 characters; song URL 2,048 characters; audio 60 seconds / 10 MiB; PNG 5 MiB / 4,096 pixels per side; drawing 10,000 points. These are per-message limits.
- Default discovery radius is 25 km; maximum query/creation radius is 50 km. A post can anchor anywhere inside an eligible visible cloud within the creation radius. Do not snap anchors to a cloud centroid.

### Weather-specific behavior

| Condition | Behavior |
| --- | --- |
| Scattered clouds | Attach notes anywhere within visible eligible footprints; move anchors with local motion. |
| Full overcast | Allow posting anywhere on the visible cover, including far from its centroid. Retain distinct geographic anchors; changing its bounding box must not rescale all notes. |
| Clear sky | Offer **Draw a cloud**: trace a closed outline, preview, then publish a user-created cloud. |
| Created cloud | Label **Created cloud**, show creator, advect with wind, expire 24 hours after creation. All message types work on it. |
| Rain/storm | Change visual styling; retain posting/media behavior. Rain alone does not delete notes. |
| Night | Use appropriate infrared/cloud-mask data; visible-image darkness is not disappearance. |
| Missing data | Show **Estimated** or **Stale**. Stop extrapolating after 30 minutes; never treat an outage as dissipation. |

Created clouds are independent synthetic objects: they never automatically merge with observed clouds or each other. Overlapping layers must be selectable. Use an assumed altitude of 2 km, labeled as estimated. Creator deletion expires its contents; editing its published outline is outside the MVP. Anyone signed in can post to it.

A created outline is a simple geographic polygon with 3–256 distinct vertices, no self-intersections, and maximum diameter 10 km. Store geographic geometry, not screen pixels. Drawing a cloud is distinct from uploading PNG artwork. Use a deterministic invertible sky-map projection for placement; camera AR alignment is outside scope. Satellite tracking identifies estimated regions from above, not guaranteed individual clouds visible from the ground.

## Wind-assisted satellite tracking

Wind direction and speed are required motion inputs. Satellite navigation locates pixels; winds predict how mapped cloud regions move between observations. Surface winds alone are insufficient when winds change with altitude.

1. **Geolocate observations.** Read acquisition timestamps, navigation metadata, masks, cloud heights/pressures, and quality flags. Reproject the region into a metric CRS for flow/overlap calculations; output GeoJSON WGS84 `[longitude, latitude]`. Correct parallax where height/view geometry permit, otherwise expose uncertainty. Use acquisition time, not download time.
2. **Select winds at cloud altitude.** Prefer quality-controlled satellite derived-motion winds or model winds interpolated in space, time, and height/pressure. Record source, valid time, units, layer, and confidence. Nearest-layer or surface-only fallback increases uncertainty and is visibly estimated.
3. **Normalize vectors.** Store eastward `u` and northward `v` in m/s. Meteorological direction `theta` is where wind comes **from**, clockwise from true north: `u = -speed*sin(theta)`, `v = -speed*cos(theta)` with radians. A west wind at 10 m/s moves east. Do not reverse products already expressed as east/north components.
4. **Predict.** Advect cloud masks and content parcels through the wind field with substeps of at most 60 seconds. Convert metric displacement through a projection/geodesic operation, never add meters to degrees. Use actual observation time differences. Limit uncorrected prediction to 30 minutes.
5. **Correct with imagery.** Segment successive quality-controlled masks and estimate optical flow. Match wind-predicted footprints to observations using overlap, uncertainty-gated distance, layer compatibility, and deformation. Fuse wind and image motion with uncertainty weighting. Derived-motion winds from the same imagery are correlated evidence; do not count them as independent measurements. On disagreement reduce confidence rather than forcing identity.
6. **Preserve lineage.** Associate overlapping predicted/current regions as a graph. Ordinary continuations retain identity; merges/splits create successors with parent IDs. Process connected components so simultaneous merges and splits cannot duplicate content.
7. **Transport local anchors.** Apply the fused local displacement field to messages and artwork control points. Merges preserve positions in the successor. Splits assign each message to the child containing its updated anchor; boundary ties use greatest local overlap then ID. Never copy into every child. Unmatched anchors remain uncertain pending confirmation.
8. **Handle overcast as a field.** Use local motion across broad connected cover, not a single centroid translation or bounding-box scale. Convert drawing coordinates to metric/geographic control points for transport. Preserve posting anywhere on the visible footprint.
9. **Confirm disappearance.** Expire a parcel only after three consecutive good observations spanning at least 10 minutes show clear conditions at its predicted location. Whole-cloud dissipation requires no cloudy descendants/parcels remaining. Missing frames, low quality, nonmatches, and leaving regional coverage produce uncertainty/out-of-region status, not deletion. A large overcast cloud may lose individual content parcels where it clears locally.
10. **Publish idempotently.** Emit snapshots, lineage events, explicit anchor transfers/expiry instructions, observation time, and monotonic batch sequence. Checkpoint after acknowledgement. Replay retries safely. Historical replay never mutates live data.

Created clouds use altitude-aware wind advection without satellite segmentation correction. Hold their last position during wind outages; explicit 24-hour expiry still applies. This is an engineering identity model, not perfect atmospheric object identity; display confidence and freshness.

## Shared contract v1

Owner 4 maintains versioned JSON Schema under `packages/contracts/` and generates TypeScript/Python bindings before feature branches diverge. Every boundary validates them. All IDs are opaque strings, timestamps ISO 8601 UTC, geometry GeoJSON WGS84, distances meters, velocities m/s. Every persisted mutable cloud/message has an integer `version`.

| Entity | Required fields/invariants |
| --- | --- |
| User | `id` = verified Clerk user ID; nullable `displayName`, `avatarUrl`. |
| Cloud | `id`, `version`, `kind: observed\|created`, `status: active\|uncertain\|out_of_region\|expired`, `geometry: MultiPolygon`, `observedAt`, `updatedAt`, `confidence` 0..1, `wind: {uMps,vMps,altitudeM,source,validAt,confidence}`, `parentIds`, nullable `creatorId`, nullable `expiresAt`, `datasetId`, `trackingRunId`. Created clouds require expiresAt. |
| Message | `id`, `version`, `cloudId`, `authorId`, `kind`, `anchor: {longitude,latitude}`, `createdAt`, `updatedAt`, nullable `expiredAt`, `voteCount`, `viewerHasUpvoted`, nullable `body`, `assetId`, `songUrl`, `artworkTransform`. Validate payload by kind. |
| Artwork | `widthM`, `heightM`, `rotationDeg` clockwise; anchor is center. Strokes use `[0,1]` rectangle coordinates. Extent at most 1 km, positive scale. Persist world control points for advection/deformation. |
| Asset | `id`, `ownerId`, `kind: png\|audio\|drawing`, private `objectKey`, `mimeType`, `sizeBytes`, nullable dimensions/duration, `state: pending\|ready\|deleted`, `createdAt`. Return authorized signed URLs, never private object keys. |
| Vote | Unique `(messageId,userId)`; client never supplies authoritative count. |
| TrackingBatch | `schemaVersion:1`, `batchId`, `datasetId`, `trackingRunId`, `sequence`, `observedAt`, `snapshots`, `events`, `anchorUpdates`. |
| LifecycleEvent | `eventId`, `type: created\|updated\|merged\|split\|uncertain\|out_of_region\|dissipated`, `sourceCloudIds`, `targetCloudIds`, `effectiveAt`. |
| AnchorUpdate | `messageId`, `expectedMessageVersion`, nullable `targetCloudId`, `anchor`, optional `artworkControlPoints`, `action: move\|hold\|expire`. Null target only for hold/expire. |

One authoritative worker per dataset/run. Unique batch/event IDs, ordered sequences, and transactional ingestion are mandatory. Duplicate batches acknowledge their original result. Reject out-of-order sequences. Merge/split retires predecessors and transfers content atomically without deleting it. On stale message versions, return `409` without partial writes; worker refreshes state and submits a new batch ID at the same next sequence. Posting to a retired predecessor returns successor IDs for composer refresh, without guessing the intended child.

### API v1

Public prefix `/api/v1`. Success `{data,nextCursor?}`; error `{error:{code,message,requestId}}`. Opaque pagination, max 50 records/page. Ranked pagination uses a snapshot token to avoid duplicates/skips when votes change. Refresh creates a new ranking snapshot.

| Method / route | Contract |
| --- | --- |
| `GET /sky` | Query `lat,lng,radiusM,datasetId,cursor?`; returns clouds with up to three server-ranked nearby previews each, `asOf`, weather, freshness. Max radius 50 km. |
| `GET /clouds/:id` | Current cloud, lifecycle and successor IDs; expired detail reveals lifecycle metadata only. |
| `POST /clouds` | Auth; `{outline:Polygon,assumedAltitudeM:2000}`; server validates and assigns creator/expiry. |
| `DELETE /clouds/:id` | Created cloud's creator only; idempotently expires cloud and content. |
| `GET /clouds/:id/messages` | `scope=nearby\|all`, nearby requires `lat,lng`; radius default 25 km/max 50 km; cursor/ranking snapshot. |
| `POST /clouds/:id/messages` | Auth; `{kind,anchor,expectedCloudVersion,body?,assetId?,songUrl?,artworkTransform?,strokes?}`. Server derives author. Text requires body, song requires songUrl, audio/png/drawing require owned ready asset; drawing includes strokes. |
| `DELETE /messages/:id` | Author only; idempotent; schedules media deletion. |
| `PUT /messages/:id/upvote` | Auth; `{active:boolean}` sets desired state idempotently; returns current count and viewer vote state. |
| `POST /assets/upload-url` | Auth; `{kind,mimeType,sizeBytes}` → `{assetId,uploadUrl,expiresAt}`; pending asset owned by caller. |
| `POST /assets/:id/complete` | Owner only; verify actual bytes/signature, decoded dimensions/duration and limits before ready. Re-encode PNG to strip metadata. |
| `POST /api/internal/tracking/batches` | Outside public prefix; separate worker bearer secret; validate/apply batch transactionally. |
| `GET /api/internal/tracking/state` | Worker secret; dataset sequence plus paginated cloud/message anchors, versions, artwork control points and lineage needed to calculate next batch. No media bodies/authors required. |

Use `401` unauthenticated, `403` forbidden, `404` unknown, `409` conflict, `410 CLOUD_EXPIRED`, `413` oversized, `422` invalid, `429` rate limit. All content writes verify footprint containment and current lifecycle. Reject votes on expired messages.

Upload URLs expire after five minutes; media playback URLs after one minute, bounded by known expiry. Every URL issuance rechecks content lifecycle. Existing signed links can remain valid until their short TTL elapses; invalidate object/CDN access on cleanup. Allowlisted HTTPS song links only, no arbitrary server-side preview fetching.

### Persistence and Clerk

- Enable PostGIS, GiST indexes, metric radius queries and historical snapshots. Keep current state separate from history.
- Clerk is identity authority. Use `ClerkProvider`, SDK/version-appropriate middleware or proxy, and server-side `auth()` for writes. Never trust user IDs in request bodies. Upsert local profiles on authenticated access; verified webhooks are optional later.
- Enforce ownership on every mutation and asset completion. Clerk browser sessions never authorize worker routes. Atomic unique vote rows prevent retry inflation.
- Expiry immediately removes content from API reads, rankings, and new media authorizations. Queue cleanup transactionally. Retry deletion of media, strokes, votes and payload rows within 24 hours; retain only non-content lineage metadata. Avoid logging message bodies. Document backup retention before production; app disappearance does not imply immediate backup erasure.
- Initial per-user limits: 10 posts/minute, 60 vote changes/minute. Request geolocation explicitly and support manual location. Warn at composition that the content anchor is discoverable; never publish a user's location trail.

## Four-person execution plan

Assign names to Owners 1–4 at kickoff. Each person uses a separate clone/worktree and feature branch. Each assistant continuation reads README.md, AGENTS.md, contracts, and handoffs first. Missing services may use committed schema-valid fixtures with visible demo labeling.

| Owner | Owned paths | Required outputs |
| --- | --- | --- |
| **1: Frontend** | UI layouts/pages, `features/sky/`, `features/composer/`, frontend styles/components | Entire frontend: sky/projection, weather, previews/expansion, drawing, media composer, voting UI, Clerk screens/client provider. |
| **2: Backend** | `apps/web/src/app/api/`, `apps/web/src/server/`, `db/` | APIs, database/migrations, server-side Clerk verification, authorization, votes, storage, tracking ingestion, expiry and cleanup. |
| **3: Tracking** | `services/cloud-worker/`, atmospheric fixture inputs | Satellite/wind adapters, navigation, fusion, lineage, local advection, expiry proposals, replay, Python tests. |
| **4: Integration** | Root tooling, `packages/contracts/`, shared fixture infrastructure, CI, end-to-end tests, deployment configuration | Bootstrap coordination, generated types, shared API client, local setup, integration checks, deployment and final merges. |

Owner 1 owns the whole frontend, including root UI layouts/pages and the sole projection implementation. Owner 2 owns API routes even inside the Next.js app directory. Clerk responsibilities are explicit: Owner 1 handles client UI/provider placement; Owner 2 verifies identity and permissions server-side; Owner 4 assembles environment/deployment configuration.

Frontend ownership means design and integration accountability, not exclusive authorship. Owner 4 can help with isolated UI components after agreeing the files and interface with Owner 1. Keep sky/drawing interaction work with Owner 1; Owner 4 supplies fixtures and integration support. Every owner supplies subsystem tests and environment requirements; Owner 4 assembles shared setup and checks.

Stabilize these component boundaries at kickoff, using generated contract types:

```ts
type SkyProjection = {
  // CSS pixels relative to canvas, never device pixels.
  screenToGeo(p: {x:number;y:number}): {longitude:number;latitude:number};
  geoToScreen(p: {longitude:number;latitude:number}): {x:number;y:number};
};
// SkyView emits onCloudOpen(cloudId) and onPlace(cloudId, anchor).
// Composer: {cloudId, anchor, projection, onSaved, onCancel}.
// CreateCloudTool: {projection, onCreated, onCancel}.
// VoteButton: {messageId, voteCount, viewerHasUpvoted, onChanged}.
```

### Milestones

1. **Bootstrap together, Owner 4 coordinates.** Owner 4 sets up root tooling, contracts/generated bindings, shared API client, fixture infrastructure and CI. Owner 1 scaffolds the frontend; Owner 2 supplies server/API scaffolding, PostGIS/storage and migrations; Owner 3 scaffolds the worker and atmospheric fixtures. Owner 4 assembles Compose, environment templates and deterministic scattered/overcast/clear/merge/split/dissipation/outage/created-cloud scenarios. All four owners review contracts and run the same fixture before branching.
2. **First integrated slice.** Clerk sign-in → select fixture cloud → post text → read from second browser → vote → preview reorders → double tap expands. Merge this against the actual API/database before adding all media modes. Demo bypasses satellite acquisition, never authentication.
3. **Parallel features.** Owner 1 completes sky/discovery, artwork and created-cloud UI; Owner 2 completes APIs, authorization, persistence, expiry and cleanup; Owner 3 connects real tracking batches; Owner 4 maintains contract fixtures, verifies end-to-end behavior and resolves integration gaps with the responsible owners. Merge small complete slices frequently.
4. **Final connection, Owner 4 leads.** Substitute worker output for fixture batches through the same API. Exercise drawings, lifecycle, concurrency and media on shared persistence. Rehearse a labeled historical replay. Live acquisition is a separate smoke check.
5. **Release gate.** Clean-clone setup and acceptance checks pass; update setup to actual tested commands; Owner 4 coordinates final review with affected owners, deployment and the final PR, recording remaining limitations. No hidden mock fallback.

### Coordination across continued prompting

Each owner maintains `docs/handoffs/owner-N.md` in every feature PR: branch/commit, milestone, files/interfaces changed, completed checks with commands/results, blockers, next task, and exact contract requests. Keep it concise, not a conversation transcript.

Use this continuation prompt, replacing N:

> You are Owner N for Drift. Read README.md, AGENTS.md, packages/contracts and docs/handoffs. Inspect git status and recent changes. Continue the next unfinished milestone in your ownership area. Honor committed API schemas and projection interfaces. Use schema-valid fixtures for unavailable dependencies and label demos. Do not silently change contracts or edit another owner's module without an agreed scoped handoff. Document exact cross-owner requests. Run relevant checks, update your handoff with evidence and next steps, and leave a reviewable change. Do not claim integration until the vertical slice passes against the real API and persistence.

Contract changes require a short `docs/decisions/` proposal: old/new payload, affected owners, migration, fixture changes, compatibility plan. Owner 4 integrates schemas/bindings after affected-owner review; consumers rebase before implementation. Additive optional fields may remain v1; breaking changes need v2 and migration. Never rename endpoints independently or duplicate contracts.

```sh
git clone https://github.com/EliasCueto45/Drift.git
cd Drift
git switch -c owner-1/frontend
# Others: owner-2/backend, owner-3/tracking, owner-4/integration.
git fetch origin
git rebase origin/main
# Commit your changes after relevant checks, then:
git push -u origin HEAD
```

PR into main with behavior summary, contract impact, validation, and handoff link. Owner 4 coordinates merges; owners review changes affecting their interfaces. Rebase after shared-contract merges. Do not force-push main, commit secrets, overwrite teammates' changes, or discard unfamiliar merge conflicts.

### Local setup target — not executable yet

Owner 4 must assemble and verify this setup with inputs from Owners 1–3, then replace this notice with actual prerequisites and tested commands. At present the commands below have no backing scripts.

Prerequisites: Git, Docker Compose, pinned Node LTS/pnpm, pinned Python. Bootstrap supplies `.env.example` and a worker environment template. Create one shared development Clerk application, distribute keys privately, and configure each local/deployment URL.

```sh
pnpm install --frozen-lockfile
docker compose up -d db storage
pnpm db:migrate
pnpm db:seed
pnpm dev
# Separate terminal after creating/activating Python virtual environment:
python -m pip install -r services/cloud-worker/requirements.txt
python -m cloud_worker --mode replay --dataset troy-demo
```

Web variables: `DATABASE_URL`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `TRACKING_INGEST_SECRET`, `DRIFT_DATASET_ID`. Worker: `DRIFT_API_BASE_URL`, `TRACKING_INGEST_SECRET`, `DRIFT_DATASET_ID`, provider configuration. Owner 3 documents exact satellite/wind products, provider access, quality filters, region, and licenses when adapters are selected; do not assume a specific satellite remains operational.

Required bootstrap checks: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `python -m pytest services/cloud-worker/tests`. CI also verifies generated types match schemas and both languages accept the same fixtures.

## Acceptance checks

- [ ] Clean clone can start, migrate, seed and replay with documented setup and privately supplied Clerk keys.
- [ ] Two users post and vote/unvote; retries do not inflate counts; anonymous reads work, forged identities and unauthorized mutations fail.
- [ ] Nearby filtering precedes vote ranking; previews show the highest-ranked eligible messages; double tap/button expands paginated Nearby and All tabs.
- [ ] Clear-day cloud drawing creates a labeled object with wind movement and 24-hour expiry. Overlap never silently merges it with real clouds.
- [ ] Freehand art and transparent PNGs preserve placement, clipping and motion; malformed/oversized uploads fail.
- [ ] Two distant notes under overcast remain distinct during local advection and changing cloud boundaries.
- [ ] Wind from west at 10 m/s moves approximately 6 km east in 10 minutes before image correction; test units, timestamps, altitude selection and vector conventions.
- [ ] Wind/image disagreement lowers confidence; missing imagery never deletes content; prediction freezes after its horizon.
- [ ] Merge/split preserves each message, artwork and votes exactly once. Confirmed local clearing expires only affected parcels.
- [ ] Duplicate/reordered batches, posting during merge, version conflicts, concurrent votes and cleanup retries are handled transactionally.
- [ ] Expired/deleted content disappears from reads immediately; fresh media URLs are denied and cleanup completes. Nonowners cannot delete content.
- [ ] Historical replay is repeatable, labeled, isolated from live state, and runs through the same APIs/database as the app.

## Implementation references

These support implementation choices; the behavior and numeric defaults above are Drift decisions.

- [Clerk Next.js App Router quickstart](https://clerk.com/docs/nextjs/getting-started/quickstart)
- [Clerk server auth](https://clerk.com/docs/nextjs/reference/app-router/auth)
- [NOAA derived-motion winds quick guide](https://www.goes.noaa.gov/documents/QuickGuide_BaselineDerivedMotionWinds.pdf)
- [NOAA derived-motion winds algorithm](https://www.star.nesdis.noaa.gov/goesr/documents/ATBDs/Enterprise/ATBD_Enterprise_Derived_Motion_Winds_v4.2_2024_06_05.pdf)
