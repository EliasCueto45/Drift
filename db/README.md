# Backend implementation and operating plan

Owner 2 implementation lives in `apps/web/src/app/api/`, `apps/web/src/server/`, and `db/`. Read `docs/handoffs/owner-2.md` for remaining integration work.

## Backend components

1. **Persistence and boundary validation** — PostGIS migration, migration ledger, explicit live/replay dataset provisioning, synthetic fixture seeding, connection/transaction helpers, canonical-schema validation, dependency manifest and lock. Verify spatial SQL against PostgreSQL/PostGIS.
2. **Public API and identity** — Next route adapter, server-side Clerk identity, public profile persistence, cloud creation/deletion, text/media message placement, geodesic containment, ownership, desired-state voting, rate limits, frozen ranking pagination and discovery. Verify anonymous reads, forged identities, retry behavior and query contracts.
3. **Tracking ingestion** — worker bearer authentication, original duplicate acknowledgements, ordered dataset/run sequences, atomic snapshots/history/lineage/anchor updates, conflicts, held parcels and consistent paginated worker state. Verify merge/split transfers, rollback on stale versions/concurrent posts, dataset isolation and the 30-minute geometric clock.
4. **Media and lifecycle** — private staged uploads, actual-byte validation, PNG metadata stripping, audio duration limits, immutable ready objects, short playback authorizations, transactional expiry queue, cleanup retries, HTTP smoke and operating handoff. Verify expiry removes content before physical cleanup and failed deletion can be retried.

## Requirements

- Node 24 (used locally), npm, and the root project's pinned pnpm toolchain. The existing smoke imports TypeScript directly, so older Node 20 cannot execute that test unchanged.
- PostgreSQL 16+ with PostGIS 3.4+, a dedicated development database and a role allowed to install PostGIS. Migrations run transactionally and record applied filenames. Existing migrations must not be edited after deployment.
- A Next.js App Router scaffold from Owners 1/4, with compatible Next/React/Clerk dependencies. No frontend scaffold existed when this work started.
- A development Clerk application, public/secret keys distributed privately, client provider/sign-in UI, and the server middleware described below. Authentication has no development bypass.
- An S3-compatible private bucket, server credentials, browser PUT CORS for the app origin and `Content-Type`, and access through short signed GET URLs. Disable public bucket/CDN access. Do not cache media publicly.
- A separate `TRACKING_INGEST_SECRET`, dataset/run identifiers, and an external scheduler for cleanup. Do not reuse a Clerk credential as a worker secret.

Web environment requirements are the existing root `.env.example`: `DATABASE_URL`, Clerk keys, S3 settings, `TRACKING_INGEST_SECRET`, and `DRIFT_DATASET_ID`. CLI commands do not implicitly load dotenv; use Node's `--env-file` option or export environment variables. Do not commit `.env`.

## Development setup

Run from the repository root after privately preparing `.env`:

```sh
pnpm install --frozen-lockfile
npm ci --prefix apps/web/src/server
# Start the existing Compose db/storage services on a machine with Docker.
docker compose up -d db storage
node --env-file=.env db/migrate.mjs
node --env-file=.env db/seed.mjs
```

The backend has an isolated package/lock under its owned server directory because no `apps/web/package.json` existed and root tooling belongs to Owner 4. This is a bootstrap boundary, not a second proposed application. Owner 4 should consolidate dependencies/scripts into the actual web workspace and update its pnpm lock during frontend bootstrap. Until then root recursive checks **do not discover the backend**; always run its explicit checks below.

Seeding loads the first cloud snapshots/events and all public users/text messages from every synthetic scenario. It also records the sequence-1 acknowledgement, so the replay tool can safely resend the first batch. Existing datasets are skipped rather than reset. It never seeds a live dataset. Recreate only an explicitly disposable database to restart a scenario.

Provision a real worker dataset before publishing; mode is stored in the database and cannot be changed by batches. Start time must be no later than the first observation:

```sh
node --env-file=.env db/provision.mjs troy-demo replay regional-v1 2026-10-24T00:00:00.000Z
```

Use the worker's actual run ID (its default is `regional-v1`) and separate database rows, IDs and checkpoints for live runs. `fx-*` rows are synthetic fixtures; `troy-demo` is the worker's synthetic replay. A duplicate dataset provision fails rather than resetting sequence/history.

Owner 3's live acquisition work is merged in `d56c544` and uses the existing API contract. Provision `troy-live` in `live` mode with run `regional-v1` and a UTC start before its first observation; set the web `DRIFT_DATASET_ID=troy-live` and publish with `python -m cloud_worker.live --publish` in the configured worker environment. Do not switch an existing replay row to live or reuse an offline worker journal for publishing. `/sky.asOf` is the acquisition timestamp. Freshness uses observation age: over 30 minutes is stale; over 10 minutes, future timestamps, uncertain/low-confidence regions or synthetic-only clouds are estimated; recent active observed regions with confidence at least 0.5 can be live. These display thresholds do not advance or delete cloud/message state. Recheck freshness on every cursor request too.

Owner 4 must place the Clerk integration in the host web scaffold. For Next 16, `apps/web/src/proxy.ts` should import/re-export the default from `./server/clerk-middleware` and declare a literal `config = { matcher: ['/api/v1/:path*'] }`. On Next 15 use `src/middleware.ts` instead. Literal matcher configuration is necessary for Next's static analysis. The implementation calls async server `auth()` and fetches the public Clerk profile, never a user ID submitted by the browser. See [Clerk auth](https://clerk.com/docs/reference/nextjs/app-router/auth) and [middleware documentation](https://clerk.com/docs/reference/nextjs/clerk-middleware).

The API catch-all delegates to the owned backend handler and uses Node runtime plus `force-dynamic`. Internal routes use only the worker secret. Public API reads/writes send `Cache-Control: private, no-store`; mutations reject a different browser Origin. Configure the host's authorized origins correctly if deploying behind a proxy.

## Verification

```sh
npm --prefix apps/web/src/server run lint
npm --prefix apps/web/src/server run typecheck
npm --prefix apps/web/src/server test
pnpm check:contracts
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Backend lint checks JavaScript syntax; typecheck checks the TypeScript route/middleware boundary, not all JavaScript implementation internals. Production payloads validate the canonical JSON Schema. The SQL tests use **actual embedded PostgreSQL/PostGIS**, not a simulated SQL engine. They cover the migration, transactions, spatial operations and the shared smoke script through a loopback HTTP server. Their identity and S3 transport are explicitly synthetic test adapters; PNG/audio validation runs actual decoders. This suite does not prove multi-session locking, real Clerk sessions, real S3 behavior or Next deployment.

After the host/service setup is complete, run `pnpm smoke` against the Next web server with `SMOKE_AUTH_TOKEN` set to a real test-user Clerk JWT. Run two-browser authorization/voting, concurrent transactions on ordinary PostgreSQL, the actual worker publishing CLI, and private-bucket upload/playback/cleanup before release. Root `build` currently finds no web package, so its success alone is not a web build.

The shared dissipation fixtures contain a known version bug: batches 3 and 4 still expect message version 1 after earlier holds increment it. Production intentionally returns 409. The backend test demonstrates rejection, then recomputes versions/new batch IDs like the worker. Owner 4 must fix `tools/fixtures-gen.mjs` to emit versions 2 and 3 and regenerate fixtures; do not weaken ingestion or hand-edit generated JSON.

## API integration details

- Canonical `/api/v1` routes and worker paths follow the README. All content reads recheck lifecycle, held status and current cloud assignment. Frozen cursors retain ordering, while payloads/counts are current; deletions/transfers can yield short pages. Continue through `nextCursor` even when a page becomes empty.
- Discovery uses PostGIS geography meters, filters nearby messages before ranking, and serves at most three previews per cloud. Message pages cap at 50. Cursor tokens are random, query/viewer-bound, DB-backed, and expire after five minutes.
- Posting requires an active cloud/version and a contained geographic anchor. The API does not rescale anchors when footprints change. Artwork corners are derived geodesically from the center, dimensions and clockwise rotation; the frontend must clip its rendering to the cloud. Worker control points update with anchors.
- Votes use unique `(message_id,user_id)` rows and return freshly computed counts. Repeating the same desired state consumes no additional change allowance and does not increment the message's geometric version. Actual state changes are limited to 60/minute, posts/clouds to a shared 10/minute.
- Retired-cloud posting returns `409 CLOUD_RETIRED`; its error message includes successor IDs. Machine-readable error details are not in the current shared error contract; use `GET /clouds/:id` for `successorIds` before recomposing.
- Worker state includes frozen sequence, clouds and author/body-free message anchor metadata. `hold` updates position/version and hides the parcel, retaining media/votes on the retired origin. Explicit `expire` schedules cleanup. Every live parcel on a newly retired predecessor needs an explicit transfer/hold/expiry or the batch rolls back.
- All DB operations currently share one transaction-scoped advisory lock. This makes the hackathon implementation easy to reason about but limits throughput. S3 verification/deletion currently holds that lock too. Use ordered per-dataset/row locks and object-operation reservations before scaling.
- Upload responses are canonical `{assetId,uploadUrl,expiresAt}`. PUT exact declared bytes and Content-Type within five minutes, then call complete as the owner. Complete decodes signatures/dimensions/duration before marking ready; ready objects have a different key from the PUT URL. Pending/staging objects cannot be played.
- **Proposed supporting reads:** `GET /api/v1/assets/:id/url` returns `{data:{url,expiresAt}}` for an attached visible ready asset, anonymous discovery included; `GET /api/v1/messages/:id/artwork` returns `{data:{strokes,artworkTransform}}` for visible drawing messages. Each rechecks lifecycle. Owner 4 must add canonical response schemas and Owner 1 must adopt these paths.
- **Proposed drawing convention:** `strokes` is an array of polylines, each an array of normalized `[x,y]` pairs. Count all points across all lines, maximum 10,000. Existing schema leaves stroke items unspecified; this convention still requires Owner 1/4 agreement.
- **Unresolved creation-radius contract:** create-message and create-cloud payloads do not carry the viewer's selected/manual location. Footprint containment, outline diameter and read radii are enforced, but distance from the creator cannot be calculated from the current input. Owner 4 must define a location transport with Owner 1 before a 50 km creation-radius check can be enforced without breaking current consumers. Do not claim this acceptance criterion passes yet.

## Expiry and cleanup

Reads/authorization compare created-cloud expiry against the dataset clock, so replay does not accidentally expire against today's wall time. Author/creator deletion and explicit worker expiry mark content unavailable and queue cleanup in the same transaction. Playback authorization is at most 60 seconds and bounded by known cloud expiry. Existing URLs may remain usable until their short TTL elapses.

Schedule the following **at least every five minutes** with the web service's environment, and alert on failures/queued work approaching 24 hours:

```sh
node --env-file=.env apps/web/src/server/cleanup-cli.mjs
```

Each run processes up to 100 expiry/cleanup records; increase scheduler throughput when backlog grows. Deletion is retryable: failures retain the queue record, content stays inaccessible, and the next run retries both pending/ready objects. Success removes message payloads, strokes and vote rows. Cloud history/lineage contains no message bodies. Abandoned pending/ready assets are reaped after 24 hours; attached ready assets keep their playback object but lose the expired staging object. Schedule this externally; no timer runs inside a serverless request.

No deployed backup policy exists in this checkout. Before production, Owner 4 must record the actual database/object-store backup retention, encryption, access and restoration/deletion procedures. Application expiry is not proof of backup erasure. S3 versioning/lifecycle must also remove noncurrent object versions if enabled.
