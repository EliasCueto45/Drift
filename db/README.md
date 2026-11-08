# Drift backend setup

The backend uses MongoDB Atlas (or another transaction-capable MongoDB replica set), Clerk sessions, and private S3-compatible media. Public API contracts and tracking payloads remain v1. Remaining team integration work is tracked in `docs/handoffs/owner-2.md`.

## Local environment

- `apps/web/.env.local`: `MONGODB_URI`, `MONGODB_DB`, Clerk keys, and media settings.
- Root `.env`: `TRACKING_INGEST_SECRET`, `DRIFT_API_BASE_URL`, `DRIFT_DATASET_ID`, and optional `SMOKE_AUTH_TOKEN`.
- Both filenames are ignored by Git. `db/.env.example` contains placeholders only.
- Backend CLI processes load both files automatically. Explicit process variables take precedence. Restart the process after changing a key.
- The database URI contains the database user's credentials; separate MongoDB username/password variables are unnecessary. `DATABASE_URL` and the PostgreSQL driver are no longer used.
- Clerk uses the publishable and secret keys from its dashboard. Signed-in flows require a real Clerk session.

Next.js reads env files from its app root, so web credentials belong in `apps/web/.env.local`, outside `src/`. The backend's `environment.mjs` also loads the shared root file for CLI/worker settings.

## Install, initialize, and run

Use Node 24 and run from the repository root:

```sh
pnpm install --frozen-lockfile
npm ci --prefix apps/web/src/server
npm --prefix apps/web/src/server run config:check
npm --prefix apps/web/src/server run clerk:check
node db/check.mjs
node db/prepare.mjs
npm --prefix apps/web/src/server start
```

`config:check` prints presence/format booleans, never credential values. `clerk:check` verifies that Clerk accepts the secret, both keys identify the same application, and forged sessions are rejected; it does not create users or log key material. `db/check.mjs` initializes collections/indexes, pings MongoDB, and verifies a transaction. `db/prepare.mjs` idempotently seeds the eight synthetic fixture datasets and provisions a configured `*-demo` replay dataset at sequence zero if absent. It never resets existing sequences/data or auto-creates a live dataset.

The standalone API binds to `http://localhost:3000` and serves the same paths as the Next route adapter. It verifies real Clerk cookie/bearer sessions; there is no production synthetic-identity bypass. Set `PORT` to change the port, `DRIFT_API_ORIGIN` for the canonical API URL, and `DRIFT_APP_ORIGIN` for the Clerk authorized party when needed. Browser mutations are restricted to the same origin. A frontend served elsewhere should use the Next API adapter/proxy on its own origin.

Example synthetic read:

```text
http://localhost:3000/api/v1/sky?lat=42.7284&lng=-73.6918&radiusM=50000&datasetId=fx-scattered
```

Run a real database/HTTP readiness check after seeding:

```sh
npm --prefix apps/web/src/server run smoke:atlas
```

This check uses the actual configured Atlas database and real anonymous/worker authentication boundaries, without creating real-user messages. It explicitly does not exercise Clerk sign-in or the media service.

## Datasets and tracking

Provision a fresh worker run explicitly, using a UTC start no later than its first observation:

```sh
node db/provision.mjs troy-live live regional-v1 1970-01-01T00:00:00.000Z
```

Duplicate provisioning fails rather than resetting a checkpoint. Keep `troy-live`, synthetic `fx-*`, and `*-demo` replay datasets/clocks/journals separate. Set `DRIFT_DATASET_ID` to the intended dataset and use the same worker secret at both services. Worker publishing retains the canonical `/api/internal/tracking/state` and `/api/internal/tracking/batches` paths.

A dedicated `transaction_guards` document serializes competing MongoDB sessions before any reads/writes. MongoDB retries conflicting transaction callbacks, preserving post/retirement, vote/deletion and tracking-version invariants. Duplicate batch IDs return their original committed acknowledgement. Holds retain parcels/media/votes, hide content publicly, and preserve the worker's geometric horizon.

This global guard favors correctness for the hackathon and limits throughput. Media reads/writes/deletes inside retried callbacks use deterministic object keys and idempotent S3 operations; long object operations can hold a transaction open. Move media to reserved/outbox operations and narrow guards after measuring production contention.

## Storage and cleanup

Create a private S3-compatible bucket and configure upload CORS. Upload URLs expire in five minutes. Completion verifies actual PNG/audio bytes, decoded dimensions/duration and size limits. PNGs are re-encoded without metadata. Verified playback objects use separate keys from upload staging, so a valid upload URL cannot overwrite ready media. Playback URLs last at most one minute and recheck message/cloud lifecycle.

One cleanup pass:

```sh
npm --prefix apps/web/src/server run cleanup
```

A continuously running five-minute cleanup loop:

```sh
npm --prefix apps/web/src/server run cleanup:watch
```

Alternatively schedule the one-shot command externally at least every five minutes. Each pass handles up to 100 expiry/cleanup records. Monitor failures/backlog and increase throughput before tasks approach 24 hours. Object deletion retries are idempotent; failures leave content unavailable and retain the task. Successful deletion removes message payloads, drawing strokes and votes. Expired staging objects and abandoned assets are cleaned separately.

Content visibility uses the dataset clock and explicit expiry, not MongoDB TTL timing. TTL indexes apply only to cursor/rate metadata. Historical replay content must not be purged by a wall-clock TTL. Record the actual Atlas/object-store backup retention and noncurrent-object lifecycle before deployment.

## Verification

```sh
npm --prefix apps/web/src/server run lint
npm --prefix apps/web/src/server run typecheck
npm --prefix apps/web/src/server test
pnpm check:contracts
pnpm lint
pnpm typecheck
pnpm test
```

The backend suite starts disposable actual MongoDB replica sets and exercises transactions, unique/2dsphere indexes, concurrent sessions, all fixture scenarios, frozen/chunked pagination, geometry, expiry, media validation and shared HTTP smoke. The first run downloads an official MongoDB binary into the ignored dependency cache. Synthetic identities and object transports appear only in tests; the decoders and database operations are real.

The shared dissipation generator still emits stale expected message versions in batches 3/4. Tests verify rejection, then emulate worker refresh/recomputation. Owner 4 must fix the generator to emit versions 2/3; do not weaken version checks or hand-edit generated fixtures.

Lint checks JavaScript syntax. Typecheck covers the TypeScript Next adapter/middleware boundary, not every JavaScript implementation detail. Root workspace commands still skip this nested npm package until Owner 4 consolidates the web workspace. Root build success is not evidence of a complete Next app build.

Owner 3's Python tests can launch `apps/web/src/server/test/backend-harness.mjs` for a disposable MongoDB-backed API. It accepts the existing `TEST_DATASET`, `TEST_MODE`, `TEST_RUN`, and `TRACKING_INGEST_SECRET` test environment variables and writes the ready `{base}` JSON to stdout. Its synthetic identity is confined to this test entry point. Adapt the worker's old embedded-PostGIS harness to this path.

## Interface details and remaining limits

- GeoJSON uses `[longitude,latitude]`; anchors stay geographic, including under overcast. MongoDB message queries use `2dsphere`/spherical radius filtering before vote ranking. Regional cloud discovery currently scans the selected dataset's footprints and computes geodesic distance to their boundary; it does not approximate broad cover by centroid distance. Optimize candidate selection before wider regions.
- Drawing/artwork control points are computed geodesically and transported by the worker. The frontend clips rendering to the footprint.
- Rank/state snapshots store individual items in bounded BSON documents, retain a frozen ordering/sequence, bind cursors to the query/viewer, and expire after five minutes. Reads filter current lifecycle/assignment; deleted/transferred content can produce short or empty pages with a continuation cursor.
- Repeating the same desired vote state is idempotent and consumes no extra change allowance. Votes do not advance geometric message versions.
- Supporting reads `GET /api/v1/assets/:id/url` and `GET /api/v1/messages/:id/artwork` need shared response-schema adoption. Drawing strokes currently use normalized `[x,y]` polyline arrays with at most 10,000 total points.
- Canonical creation requests still lack the caller's selected/manual location, so a 50 km creation-distance check remains a shared-contract task. Footprint containment, outline validity/diameter and read radii are enforced.

The Next host, client Clerk provider/screens, real signed-in two-browser acceptance, media provider/CORS, worker deployment, shared CI, and full live browser acceptance still need integration.
