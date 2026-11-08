# Drift

**Leave a message. Let the sky carry it.**

Drift is an augmented reality social app for HackRPI 2026: In The Clouds. It turns the sky into one huge shared sketch board. Point your phone camera at the sky, choose a real cloud, and paste a post onto it: text, a link, or an image. Anyone who looks at the sky through Drift sees the posts sitting on the same clouds they were placed on. As clouds drift, their posts travel with them and reach new people under new skies. Clouds move, merge, split, and dissipate; content shares that journey.

Repository: https://github.com/EliasCueto45/Drift

## Status and implementation baseline

The Python API persists to MongoDB Atlas; the Python tracking worker publishes through authenticated endpoints. Shared contracts, deterministic synthetic fixtures, development tooling and tests run in Python. The frontend has not been implemented in this checkout. Numeric defaults below are MVP decisions. Live observations and replay use separate datasets and clocks.

Architecture: Python 3.12 + FastAPI, PyMongo/Atlas, Clerk session JWT verification, private S3-compatible media storage and the existing Python/OpenCV tracking worker. FastAPI owns public APIs and tracking ingestion. A future browser frontend can consume these HTTP/JSON routes independently. Browser canvas, drawing and Clerk widgets may require browser JavaScript; there is no browser application to convert here yet. See [the Python migration decision](docs/decisions/0003-python-runtime.md).

```text
Satellite imagery + altitude-aware winds
                |
       Python tracking worker
                |
     authenticated tracking batches
                |
 FastAPI API --- MongoDB Atlas
      |          private media storage
      |          Clerk identity
 Camera AR sky / discovery / composer UI (phone)
```

Planned directories:

```text
apps/web/src/server/drift_api/      Python API, auth, DB, storage, lifecycle
apps/web/src/features/sky/         camera AR, sensor pose, projection, map fallback, previews, expansion
apps/web/src/features/composer/    posts, links, image uploads, voting UI
services/cloud-worker/            satellite/wind adapters and tracker
packages/contracts/               canonical JSON Schema and Python validator
db/                               database setup and environment reference
fixtures/                         shared API examples and replay inputs
docs/handoffs/                     owner-1.md through owner-4.md
docs/decisions/                    reviewed architecture/contract changes
```

## Required experience

- **Look through the camera.** The main screen is the phone's rear camera feed with tracked clouds, their outlines, and their posts drawn over the real sky. Users pan the phone around the sky to discover posts.
- **Aim to choose a cloud.** A center reticle highlights the cloud it points at; tapping a cloud on screen does the same. Selecting shows up to three nearby post previews. Double tap or the **Open cloud** button expands it to see other posts.
- **Paste a post.** While aiming at a selected cloud, the user taps the spot to place a post there, writes it, previews it on the cloud, and publishes. The tapped spot becomes the post's geographic anchor on that cloud; do not snap to a centroid. Warn at composition that the anchor is publicly discoverable.
- **Everyone sees the same placement.** Posts render on the same cloud and spot for every viewer, seen from each viewer's own position and direction. As the cloud drifts, its posts move with it and become visible to people under its new position.
- **Map fallback.** When the camera or motion sensors are unavailable or denied (desktop, permission refused, unsupported browser), show the same clouds and posts on a 2D sky map with the same select, open, and post actions. Keyboard activation works in this view.
- Anonymous users can browse. Clerk sign-in is required to post, upload, create clouds, or vote. Display authors by public profile, never email or GPS history.
- Filter previews by proximity first, then sort by upvotes descending, creation time descending, ID ascending. Expanded view defaults to a paginated **Nearby** tab; an explicit **All in cloud** tab exposes the rest. No limit on total messages per cloud; paginate responses.
- One upvote per user/message. Tapping again removes it. Counts are authoritative on the server; optimistic UI must reconcile or roll back. Popularity never extends content lifetime.
- Post types: **text**, **link**, and **image**. In contract v1 these map to message kinds `text`, `song` (an allowlisted HTTPS link), and `png`. Images support positioning, scaling, rotation, and alpha transparency, are clipped to the cloud boundary, and move with local cloud motion. The v1 `audio` and `drawing` kinds are out of the MVP UI; see `docs/decisions/0002-camera-ar-pivot.md`.
- Initial validation limits: text 2,000 characters; link URL 2,048 characters; image 5 MiB / 4,096 pixels per side. These are per-message limits.
- Default discovery radius is 25 km; maximum query/creation radius is 50 km. A post can anchor anywhere inside an eligible visible cloud within the creation radius.

### Weather-specific behavior

| Condition | Behavior |
| --- | --- |
| Scattered clouds | Attach notes anywhere within visible eligible footprints; move anchors with local motion. |
| Full overcast | Allow posting anywhere on the visible cover, including far from its centroid. Retain distinct geographic anchors; changing its bounding box must not rescale all notes. |
| Clear sky | Offer **Draw a cloud**: trace a closed outline on the camera view (or map fallback), preview, then publish a user-created cloud. |
| Created cloud | Label **Created cloud**, show creator, advect with wind, expire 24 hours after creation. All message types work on it. |
| Rain/storm | Change visual styling; retain posting/media behavior. Rain alone does not delete notes. |
| Night | Use appropriate infrared/cloud-mask data; visible-image darkness is not disappearance. |
| Missing data | Show **Estimated** or **Stale**. Stop extrapolating after 30 minutes; never treat an outage as dissipation. |

Created clouds are independent synthetic objects: they never automatically merge with observed clouds or each other. Overlapping layers must be selectable. Use an assumed altitude of 2 km, labeled as estimated. Creator deletion expires its contents; editing its published outline is outside the MVP. Anyone signed in can post to it.

A created outline is a simple geographic polygon with 3–256 distinct vertices, no self-intersections, and maximum diameter 10 km. Store geographic geometry, not screen pixels. Drawing a cloud is distinct from uploading image posts. Satellite tracking identifies estimated regions from above, not guaranteed individual clouds visible from the ground.

## Camera AR view

The AR view places tracked clouds over the live camera image. It is a geometric overlay driven by phone sensors, not image recognition of clouds in the camera feed.

1. **Camera pose.** Read the viewer's position from geolocation, heading from the compass, and tilt/roll from device orientation sensors. Combine them into a camera pose (position, azimuth from true north, elevation, roll) and smooth sensor noise. Correct magnetic heading to true north.
2. **Place clouds in the sky.** Treat each cloud as geometry at its estimated altitude (`wind.altitudeM`, or 2 km assumed for created clouds). For each cloud vertex and post anchor, compute azimuth and elevation from the viewer, then map those angles to screen pixels with the camera's field of view. The inverse maps a screen tap back to a geographic anchor on the cloud plane at that altitude. Both directions live in the single `SkyProjection` implementation.
3. **Visibility.** Only draw clouds above the horizon and inside the discovery radius. Far clouds sit low on the horizon; label them so users know they are distant.
4. **Honest alignment.** Overlays are approximate: compass error is often 5–15°, and satellite regions may not match the exact cloud seen from the ground. Show a light alignment hint (for example "Estimated position") and let users nudge their heading calibration. Never claim exact cloud matching.
5. **Permissions and platforms.** Camera access needs HTTPS and an explicit prompt. iOS Safari requires a user gesture to grant motion/orientation access. Ask for camera, location, and motion permissions in context, explain why, and fall back to the 2D map when any is denied. Video stays on the device; never upload or record camera frames.
6. **Testing without real clouds.** Support a simulated pose (manual location and heading) so fixture clouds around Troy can be viewed in AR from anywhere, labeled as simulated.

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

Owner 4 maintains versioned JSON Schema under `packages/contracts/`. Python boundaries validate the same schema directly. All IDs are opaque strings, timestamps ISO 8601 UTC, geometry GeoJSON WGS84, distances meters, velocities m/s. Every persisted mutable cloud/message has an integer `version`.

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

- MongoDB replica-set transactions, unique/2dsphere indexes and historical snapshots keep current state separate from history. Atlas supplies the replica set; standalone MongoDB cannot run these transactions.
- Clerk is identity authority. Python verifies RS256 session signatures, issuer, expiry and authorized browser origin before deriving the public profile. Never trust user IDs in request bodies. Frontend sign-in/provider integration remains to be built.
- Enforce ownership on every mutation and asset completion. Clerk browser sessions never authorize worker routes. Atomic unique vote rows prevent retry inflation.
- Expiry immediately removes content from API reads, rankings, and new media authorizations. Queue cleanup transactionally. Retry deletion of media, strokes, votes and payload rows within 24 hours; retain only non-content lineage metadata. Avoid logging message bodies. Document backup retention before production; app disappearance does not imply immediate backup erasure.
- Initial per-user limits: 10 posts/minute, 60 vote changes/minute. Request geolocation explicitly and support manual location. Warn at composition that the content anchor is discoverable; never publish a user's location trail.

## Four-person execution plan

Assign names to Owners 1–4 at kickoff. Each person uses a separate clone/worktree and feature branch. Each assistant continuation reads README.md, AGENTS.md, contracts, and handoffs first. Missing services may use committed schema-valid fixtures with visible demo labeling.

| Owner | Owned paths | Required outputs |
| --- | --- | --- |
| **1: Frontend** | UI layouts/pages, `features/sky/`, `features/composer/`, frontend styles/components | Entire frontend: camera AR view, sensor pose and projection, 2D map fallback, weather, previews/expansion, post composer (text/link/image), voting UI, Clerk screens/client provider. |
| **2: Backend** | `apps/web/src/server/`, `db/` | Python APIs, database/migrations, server-side Clerk verification, authorization, votes, storage, tracking ingestion, expiry and cleanup. |
| **3: Tracking** | `services/cloud-worker/`, atmospheric fixture inputs | Satellite/wind adapters, navigation, fusion, lineage, local advection, expiry proposals, replay, Python tests. |
| **4: Integration** | Root tooling, `packages/contracts/`, shared fixture infrastructure, CI, end-to-end tests, deployment configuration | Bootstrap coordination, generated types, shared API client, local setup, integration checks, deployment and final merges. |

Owner 1 owns the whole frontend, including UI layouts/pages and the sole projection implementation. Owner 2 owns FastAPI routes and server logic. Clerk responsibilities are explicit: Owner 1 handles client sign-in/provider placement; Owner 2 verifies identity and permissions server-side; Owner 4 assembles environment/deployment configuration.

Frontend ownership means design and integration accountability, not exclusive authorship. Owner 4 can help with isolated UI components after agreeing the files and interface with Owner 1. Keep sky/drawing interaction work with Owner 1; Owner 4 supplies fixtures and integration support. Every owner supplies subsystem tests and environment requirements; Owner 4 assembles shared setup and checks.

Stabilize these component boundaries at kickoff, using canonical contract fields:

Projection coordinates use CSS pixels relative to the canvas. Owner 1 supplies one altitude-aware projection with camera pose (viewer longitude/latitude, true-north azimuth, elevation, roll, horizontal field of view, and a sensors/simulated source), invertible screen-to-geographic and geographic-to-screen operations, and a null result for off-screen points or taps without an intersection. The 2D map is the fallback when camera or sensors are unavailable. Sky selection emits cloud IDs and geographic anchors; the composer consumes those values and emits saved/cancel events. Voting sends the desired boolean state and reconciles the returned count. These browser interfaces are still to be implemented.

### Milestones

1. **Bootstrap together, Owner 4 coordinates.** Owner 4 maintains Python tooling, schema validation, fixture infrastructure and CI. Owner 1 scaffolds the frontend; Owner 2 supplies FastAPI, MongoDB/storage and migrations; Owner 3 maintains the worker and atmospheric fixtures. Owner 4 assembles Compose, environment templates and deterministic scattered/overcast/clear/merge/split/dissipation/outage/created-cloud scenarios. All four owners review contracts and run the same fixture before branching.
2. **First integrated slice.** Clerk sign-in → aim the camera (or simulated pose) at a fixture cloud → post text → see it on the same cloud from a second phone/browser → vote → preview reorders → double tap expands. Merge this against the actual API/database before adding all media modes. Demo bypasses satellite acquisition, never authentication.
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

### Local Python setup

Prerequisites: Python 3.12 and Git. Use Atlas for persistence; Docker is optional for local MongoDB/media and needed by the documented CI replica-set test setup. Node and pnpm are no longer required.

```sh
python -m venv .venv
# Windows PowerShell: .\.venv\Scripts\Activate.ps1
# macOS/Linux: source .venv/bin/activate
python -m pip install -r requirements.lock.txt
python -m pip install --no-deps --no-build-isolation -e . -e services/cloud-worker
# Copy .env.example privately; keep existing .env and apps/web/.env.local.
python -m drift_api.cli config-check
python -m drift_api.cli db-check
python -m drift_api.cli prepare
python -m drift_api.cli serve
```

The API listens on `http://127.0.0.1:3000`; it does not yet serve a frontend. Root `.env` and `apps/web/.env.local` load automatically, with explicit environment variables taking precedence. Configure `MONGODB_URI`, `MONGODB_DB`, Clerk public/secret keys, `TRACKING_INGEST_SECRET`, `DRIFT_DATASET_ID` and private S3 settings. Existing local credentials remain usable. See [database setup](db/README.md) for provisioning and media checks, and [worker setup](services/cloud-worker/README.md) for publishing. Prepare only creates synthetic fixtures and an isolated `*-demo` replay dataset; live provisioning is explicit.

```sh
python -m drift_tools.cli check-contracts
python -m ruff check .
python -m mypy
python -W error -m pytest
# Enable DRIFT_TEST_BACKEND=1 for real worker/API/MongoDB integration:
python -W error -m pytest services/cloud-worker/tests
python -m drift_tools.cli smoke
```

Backend tests require a disposable replica set via `DRIFT_TEST_MONGODB_URI`, a `mongod` on PATH or `MONGOD_BINARY`. They create/drop only unique `drift_test_*` databases and never use production `MONGODB_URI`. See CI for a Docker example. The development mock runs with `python -m drift_tools.cli mock`; replay uses `python -m drift_tools.cli replay --scenario scattered-advection --repeat`. Signed-in smoke steps are explicitly skipped without `SMOKE_AUTH_TOKEN`. Fixture regeneration: `python -m drift_tools.cli fixtures-gen`.

## Acceptance checks

- [ ] Clean clone can start, migrate, seed and replay with documented setup and privately supplied Clerk keys.
- [ ] Two users post and vote/unvote; retries do not inflate counts; anonymous reads work, forged identities and unauthorized mutations fail.
- [ ] Nearby filtering precedes vote ranking; previews show the highest-ranked eligible messages; double tap/button expands paginated Nearby and All tabs.
- [ ] Clear-day cloud drawing creates a labeled object with wind movement and 24-hour expiry. Overlap never silently merges it with real clouds.
- [ ] On a phone, the camera view shows fixture clouds and their posts in the expected direction; aiming at a cloud selects it and tapping places a post there.
- [ ] A post placed by one user appears on the same cloud for a second user viewing from a different location, and moves with the cloud.
- [ ] Denying camera, location, or motion permission falls back to the 2D map with the same actions; camera frames are never uploaded.
- [ ] Transparent image posts preserve placement, clipping and motion; malformed/oversized uploads fail.
- [ ] Two distant notes under overcast remain distinct during local advection and changing cloud boundaries.
- [ ] Wind from west at 10 m/s moves approximately 6 km east in 10 minutes before image correction; test units, timestamps, altitude selection and vector conventions.
- [ ] Wind/image disagreement lowers confidence; missing imagery never deletes content; prediction freezes after its horizon.
- [ ] Merge/split preserves each message, artwork and votes exactly once. Confirmed local clearing expires only affected parcels.
- [ ] Duplicate/reordered batches, posting during merge, version conflicts, concurrent votes and cleanup retries are handled transactionally.
- [ ] Expired/deleted content disappears from reads immediately; fresh media URLs are denied and cleanup completes. Nonowners cannot delete content.
- [ ] Historical replay is repeatable, labeled, isolated from live state, and runs through the same APIs/database as the app.

## Implementation references

These support implementation choices; the behavior and numeric defaults above are Drift decisions.

- [Clerk manual JWT verification](https://clerk.com/docs/guides/sessions/manual-jwt-verification)
- [MongoDB Python transactions](https://www.mongodb.com/docs/languages/python/pymongo-driver/current/crud/transactions/)
- [NOAA derived-motion winds quick guide](https://www.goes.noaa.gov/documents/QuickGuide_BaselineDerivedMotionWinds.pdf)
- [NOAA derived-motion winds algorithm](https://www.star.nesdis.noaa.gov/goesr/documents/ATBDs/Enterprise/ATBD_Enterprise_Derived_Motion_Winds_v4.2_2024_06_05.pdf)
