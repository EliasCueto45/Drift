# MongoDB Atlas and Python API setup

Use Python 3.12 and the root `requirements.lock.txt`. Install the root project and tracking worker as editable packages following the root README. No Node/pnpm installation is required. Canonical HTTP payloads and the existing MongoDB collection format remain compatible with the previous backend; this port requires no data export or reset.

## Private configuration

Keep shared settings in the ignored root `.env` and server settings in the ignored `apps/web/.env.local`. The latter overrides file defaults; explicitly exported process variables override both files. Existing local keys are accepted. Examples in `.env.example` and `db/.env.example` contain placeholders only.

- `MONGODB_URI`: Atlas Drivers connection string, with a database user/password URL-encoded. `MONGODB_DB` defaults to `drift`. Atlas database users and network access must allow the machine running the API; no Atlas management API key is needed for normal database connections.
- `CLERK_PUBLISHABLE_KEY` (or the existing `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`) and full `CLERK_SECRET_KEY`: from the same Clerk application. The API uses JWKS/RS256 session verification and retrieves only public profile fields. `DRIFT_APP_ORIGIN` is the browser origin, without a trailing slash.
- `TRACKING_INGEST_SECRET`: the same private worker bearer secret on API and worker. It cannot authenticate public user mutations.
- `DRIFT_DATASET_ID`: target dataset for user-created clouds. Keep replay and live IDs/runs separate. Worker also uses `DRIFT_API_BASE_URL`.
- `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and optional `S3_ENDPOINT`: private S3-compatible storage. Atlas stores metadata, not uploaded media bytes. Grant only the required private bucket object permissions and configure browser PUT CORS for the frontend origin. Use MinIO locally if desired; provision a private bucket before testing uploads.

## Commands from the repository root

### Connecting from Atlas's Python dialog

1. In Atlas choose **Connect → Drivers/Client Library → Python → PyMongo (Synchronous)**. This matches the backend's synchronous PyMongo client; FastAPI runs database work in its thread pool. Leave network compression unchecked unless its optional dependencies are deliberately installed; keep the legacy URI toggle off.
2. Under **Database Access**, give the database user `readWrite` access to the `drift` database. Under **Network Access**, allow your current public IP, and later the deployed API/worker host as required. The browser never connects directly to Atlas.
3. Copy the SRV connection string to ignored `apps/web/.env.local` as `MONGODB_URI`, replacing `<db_password>` locally with the database user's URL-encoded password. Set `MONGODB_DB=drift`. Existing credentials and URI continue working across the JavaScript-to-Python port; no new cluster, account, database, or Atlas management API key is required.

```dotenv
MONGODB_URI="mongodb+srv://DATABASE_USER:URL_ENCODED_PASSWORD@YOUR_CLUSTER.mongodb.net/?retryWrites=true&w=majority&appName=Drift"
MONGODB_DB=drift
```

The application reads these variables in `drift_api/config.py`, creates the PyMongo pool in `drift_api/database.py`, and selects the named database explicitly. Do not paste credentials into Python source or commit a real env file. Standalone `MONGODB_USERNAME`/`MONGODB_PASSWORD` variables are unnecessary when the URI contains them. After installation, run `db-check` then `smoke-atlas` below; a successful check means the connection is already configured.

```sh
python -m drift_api.cli config-check
python -m drift_api.cli clerk-check
python -m drift_api.cli db-check
python -m drift_api.cli smoke-atlas
python -m drift_api.cli migrate
python -m drift_api.cli prepare
python -m drift_api.cli serve
```

Config checks report presence only. Clerk check performs read-only calls and verifies the secret/public keys identify the same application; it does not sign in a real browser user. Database check verifies connectivity, indexes and transactions. Migrate creates missing collections/indexes idempotently. Prepare seeds the eight explicitly synthetic `fx-*` scenarios only when absent and provisions an empty `*-demo` replay dataset at sequence zero without resetting existing sequences. Live datasets are never auto-provisioned.

```sh
python -m drift_api.cli provision troy-live live regional-v1 1970-01-01T00:00:00Z
python -m drift_api.cli cleanup
python -m drift_api.cli cleanup --watch
```

Provision is insert-only: an existing dataset produces an error rather than resetting its clock. Its explicit initial UTC timestamp may be epoch for a new run, before the first actual observation. Configure the worker with exactly the same dataset/run/secret and publish through `/api/internal/tracking/batches`. The cleanup watcher runs every five minutes and responds to termination signals; deploy it as a supervised process or use a scheduler for one-shot runs.

## Local database and verification

Transactions require a replica set. Atlas already supplies one. For a local alternative:

```sh
docker compose up -d db
python -m drift_tools.init_mongo
```

Set local `MONGODB_URI=mongodb://127.0.0.1:27017/?directConnection=true` when running the API on the host. The optional Compose database is bound to loopback and uses its own MongoDB volume; it does not reuse the earlier PostgreSQL volume. The convenience initializer refuses remote/Atlas URIs.

Backend tests never use `MONGODB_URI`. Set `DRIFT_TEST_MONGODB_URI` to a disposable replica set, or provide a local `mongod` via PATH/`MONGOD_BINARY`. Tests create and remove unique `drift_test_*` databases. The old locally cached official MongoDB test binary remains usable without Node installed. The explicit test harness injects synthetic users; production has no auth bypass.

```sh
python -W error -m pytest
# Set DRIFT_TEST_BACKEND=1 before running this suite:
python -W error -m pytest services/cloud-worker/tests
python -m drift_tools.cli smoke
```

Smoke operates on seeded synthetic datasets and advances their replay sequences. Run it against a disposable test stack for repeatable checks, not a live dataset. Without `SMOKE_AUTH_TOKEN`, real-user post/vote checks report SKIP. Production acceptance still needs two real Clerk browser sessions and actual private storage upload, completion, playback and deletion tests. Establish hosting, scheduled cleanup monitoring and real backup/noncurrent-object retention before release.
