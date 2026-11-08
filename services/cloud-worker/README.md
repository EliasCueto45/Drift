# Drift cloud worker — Owner 3

Wind-assisted regional cloud tracking, local message/artwork advection, lineage, lifecycle evidence, durable delivery and replay. The service is integrated with Owner 2's backend HTTP handlers and embedded PostGIS tests; deployed services and browser verification remain separate acceptance checks. Offline output uses Owner 4's shared Python validator; publishing uses the same canonical batch schema. The backend state/ack requirements are in [the integration proposal](../../docs/decisions/owner-3-tracking-integration.md).

## Actual backend integration checks

Owner 2's backend branch is included in this integration checkout. Install its locked dependencies with `npm ci --prefix apps/web/src/server`, then enable `DRIFT_TEST_BACKEND=1` in the environment before running the worker pytest suite. The opt-in test uses real backend handlers, transactions and an embedded PostgreSQL/PostGIS database with an explicitly injected synthetic identity. It verifies worker state reads, text posting/voting, splitting, holding/reconnecting orphan messages, duplicate delivery and confirmed expiry. It is skipped explicitly when not enabled; ordinary CI does not implicitly install the backend's separate dependency package.

For an online, current-sky check through those same backend handlers:

```sh
uv run --project services/cloud-worker --locked python services/cloud-worker/tests/live_backend_smoke.py
```

This creates a disposable embedded backend, provisions an isolated live dataset, discovers current NOAA products, publishes actual worker batches, and verifies persistence and the sky read route. It uses a fresh local state directory on every invocation because the database is disposable. It does not test Clerk, actual S3, a deployed Next host, or ordinary PostgreSQL multi-session behavior. The latest check ingested two current observations and returned one cloud with live freshness; it also exposed and led to a fix for NumPy confidence serialization at the outbox/checkpoint boundary.

For the final product, use the production backend host and its separately provisioned `troy-live` dataset with the continuous supervisor; do not deploy the test harness. See `db/README.md` for Owner 2's database migration/provisioning commands.

## Run from a clean clone

Use Python 3.12 (tested on Windows x64) and [uv](https://docs.astral.sh/uv/). All commands below run from the repository root. `uv.lock` pins transitive dependencies and distribution hashes; `pyproject.toml` pins direct dependencies. Do not commit `.venv`, `.env`, downloaded observations, journals or generated output.

```sh
uv sync --project services/cloud-worker --extra test --locked
uv run --project services/cloud-worker --locked python -m cloud_worker --mode replay --dataset troy-demo
uv run --project services/cloud-worker --extra test --locked python -m pytest services/cloud-worker/tests -q
```

Alternative without uv: create/activate a Python 3.12 virtual environment, then run `python -m pip install -r services/cloud-worker/requirements.txt`. This pins direct dependencies only; use the uv workflow for full reproducibility.

The bundled replay is **synthetic**, not NOAA history. It emits eight deterministic batches spanning scattered clouds, merge, split, overcast, outage and confirmed clearing. Numerical tests separately exercise winds, artwork, created-cloud expiry and message transfers. Replay writes `services/cloud-worker/out/batches.jsonl` and `services/cloud-worker/.worker-state/journal.json` by default. Re-running resumes without duplicate output. Use separate `--state-dir` and `--output` paths for each independent run/dataset.

The CLI prints mode, synthetic flag, dataset, batch count and sequence. It never publishes unless `--publish` is supplied. Replay IDs must end in `-demo`; live IDs must not. This separation must also be enforced by Owner 2's API configuration and Owner 1's replay label.

## Real satellite inputs

### Final hackathon: current real sky

The final product targets current observations. Historical/synthetic replay is only a rehearsal and regression tool. Use the acquisition supervisor to discover fresh products automatically rather than maintain a manifest by hand:

```sh
# One current-sky acquisition/processing check, no backend needed:
uv run --project services/cloud-worker --locked python -m cloud_worker.live --once
# Run continuously; publishes to the real API configured in the environment:
uv run --project services/cloud-worker --locked python -m cloud_worker.live --publish
```

The default is the Troy grid, `troy-live`, GOES-19's public bucket, five-minute polling, and separate state/output under `current-sky`. `--bucket` allows an explicitly selected operational satellite; never silently substitute another satellite or archived day. The supervisor searches the current and previous UTC hour, follows paginated catalogs, selects the newest two masks, matches available cloud height/infrared C13 within five minutes and earlier DMW within one hour, and uses the existing geolocation/tracking/outbox pipeline. If no mask is younger than 20 minutes, it reports unavailable and retries without processing old data as live. Future-dated observations are rejected. Missing optional products remain explicit approximations; no fixture fallback is permitted.

Stop with Ctrl+C. Acquisition failures preserve cloud content and journals. Ingestion conflicts stop for reconciliation. A separate acquisition lock prevents overlapping supervisors; after a hard crash verify the old process has stopped before manually clearing stale locks. `current-manifest.json` records exact source URLs and discovery time. `acquisition-status.json` records current observation time and availability; a wind product being present does not imply a good vector exists near every cloud. Inspect per-cloud wind confidence as well.

**Owners 1/2 MVP connection:** derive live/estimated/stale state from observation timestamps and confidence, show the satellite observation time/age, and keep the last known sky during outages. Never relabel old geometry as freshly observed because it was downloaded recently. The local acquisition-status file is operational diagnostics, not a new public API contract. A true live end-to-end demo still needs Owner 2's persistent ingestion/state API, then Owner 1's sky using that dataset. Check a fresh real observation reaches the browser before judging begins; do not substitute mock output for that acceptance check.

The implemented adapter reads GOES ABI L2 Clear Sky Mask (`ABI-L2-ACMC` for CONUS), optional cloud-top height (`ABI-L2-ACHAC`), optional co-timed infrared Cloud and Moisture Imagery (`ABI-L2-CMIPC`, e.g. C13), and Derived Motion Winds (`ABI-L2-DMWC`), using each file's metadata rather than a hardcoded satellite longitude. Product names are selection guidance; verify the chosen source's actual variables, timestamps and quality flags before enabling live ingestion.

1. Obtain a chronological series of actual regional products from [NOAA Open Data](https://www.noaa.gov/nodd/datasets) / the [GOES access guide](https://github.com/NOAA-Big-Data-Program/nodd-data-docs/blob/main/GOES/README.md). No provider credential is required for public GOES S3 objects.
2. Copy `examples/goes-manifest.json` to a local manifest and replace all product paths with actual files or exact HTTPS NOAA object URLs. Relative paths resolve against the manifest. Remote input is restricted to NOAA hosts, same-host redirects only, max 128 MiB/object, with cached downloads.
3. Select a metric regional grid. The example uses UTM zone 18N around Troy at 1 km cells. Nearest-neighbor regridding does not create finer observational resolution. Acquisition time comes from `time_coverage_start`.
4. For historical observations use `--mode replay --dataset troy-history-demo --manifest ...`; for current observations use the live command below. These are separate from the built-in synthetic replay.

```sh
uv run --project services/cloud-worker --locked python -m cloud_worker --mode live --dataset troy-live --manifest path/to/manifest.json --state-dir services/cloud-worker/.worker-state/troy-live --output services/cloud-worker/out/troy-live.jsonl
```

This command processes one manifest and exits. To continue, append newer product entries and invoke it again; the journal skips previously acknowledged acquisition times. An external acquisition scheduler can refresh that manifest. Automatic catalog discovery, cloud-provider scheduling and deployment belong in the integration follow-up; no background process is launched by this checkout.

### Masks, quality and height

- `BCM=0` is clear, `BCM=1` cloudy; other/missing values are unknown. Default accepted `DQF=[0]`; change `acceptedDqf` only after checking the actual product flag meanings.
- Reproject inverse-sampled target grid centers using `goes_imager_projection`, including sweep axis, ellipsoid and scan-angle units. Handle reversed axes and off-disk points.
- Optional `HT` requires meters and co-timing within five minutes. Missing/invalid heights use the manifest's assumed height, default 2 km. Confidence is capped for this estimate.
- Optional `CMI` radiances are normalized consistently across frames and fed to forward/backward-checked optical flow. Flat texture, invalid pixels and implausible speeds do not generate measurements. No image input means wind-only motion, not fabricated optical flow.
- The MVP does **not** correct cloud-height parallax or resolve overlapping atmospheric layers. Cloud footprints are approximate, even with a height product. Confidence is capped at .85 (or .7 with estimated heights); these are heuristic scores, not calibrated probabilities.

### Wind sources

Use `windFormat: dmw` for a GOES DMW NetCDF. It requires `lon`, `lat`, `wind_speed`, `wind_direction`, `pressure`, `DQF`; only good-quality vectors are used. Speed is m/s, direction meteorological degrees **from** north, pressure hPa. Pressure is converted to approximate geometric height using a standard atmosphere, so DMW confidence starts at .5 and is marked correlated with imagery. This is not a measured height profile.

Use `windFormat: json` for normalized altitude winds (see `examples/winds.json`). These can be derived from an external forecast model or measured profile; this worker does not download/decode GFS GRIB. Preserve provenance when normalizing. The [GFS inventory](https://www.nco.ncep.noaa.gov/pmb/products/gfs/) identifies pressure-level UGRD/VGRD products; pressure must be converted using appropriate height data before entering the geometric-height JSON format.

The JSON adapter requires `units: m/s`, `heightUnits: m`, source and samples with lon/lat, altitude, valid time, confidence, and either east/north components or speed/direction. It interpolates vertically and temporally, then spatially over up to four nearby columns. Nearest-height/surface-only fallbacks lose confidence. Default availability: within 100 km and one hour. Missing winds hold position; no surface-wind substitution is hidden.

## Tracking and lifecycle

- Predict at <=60-second geodesic substeps using altitude-aware winds; correct local motion with image flow. Disagreement reduces confidence. Same-imagery DMW and flow cannot increase certainty through double counting.
- Match predicted/current region overlap with altitude gating. Use connected association graphs for simultaneous merges/splits. IDs and event IDs are deterministic for a dataset/run/input order.
- Transport message anchors and artwork world control points locally, preserving overcast positions. A split assigns each parcel to at most one successor. Boundary ties use overlap and ID; orphaned parcels are held pending reassociation, never copied into every child.
- Invalid coverage intersecting a track defers association conservatively. Three consecutive good clear observations spanning ten minutes confirm dissipation. Missing/invalid observations reset that evidence. Region exits do not delete content.
- Prediction stops 30 minutes after the last good cloud match. Created clouds are separately advected, never merged with observed regions, and obey their supplied expiry/creator deletion. The backend assigns the 24-hour lifetime and remains authoritative for immediate API expiry.

## Publish to Owner 2's API

Copy `.env.example` to `.env` and set variables in your process environment using your normal secret-loading workflow. The worker reads environment variables; it does not automatically load dotenv files. Never use a Clerk/browser key as the ingestion secret.

```sh
uv run --project services/cloud-worker --locked python -m cloud_worker --mode replay --dataset troy-demo --publish --batch-schema packages/contracts/schemas/drift.schema.json --state-dir services/cloud-worker/.worker-state/publish-demo
```

The canonical bundled schema now exists and is the default in a repository checkout. Its TrackingBatch definition is explicitly selected, including timestamp formats; passing the definitions-only root directly would not validate a batch. Standalone wheel installs must supply --batch-schema. Offline JSONL output also validates against the shared contract. The client accepts the adopted sequence-only acknowledgement and checks optional batch/dataset IDs when present. HTTP is allowed only on loopback; all other API targets require HTTPS. Redirects are rejected to avoid forwarding bearer credentials. Retries are bounded; 401/403/422 are not retried.

Before every new observation, fetch all paginated active state and reconcile newly posted/deleted messages and created clouds. Stage both batch and candidate engine state in an atomic JSON journal **before** sending. A valid acknowledgement advances the checkpoint. Lost acknowledgements resend the exact same batch ID/body after restart. A 409 refreshes and recomputes once only if server sequence still equals the checkpoint. Otherwise stop and retain the journal for explicit reconciliation. No backend integration is claimed until Owners 2/4 validate this flow against their real DB and schemas.

## Recovery and operations

- One producer per dataset/run. The CLI takes an exclusive `worker.lock` in its state directory. After a crash, verify the old process has stopped before removing that lock; never clear the journal to bypass a conflict.
- Back up the journal. It includes internal geometries, parcel/control-point positions, evidence counters, previous frame and pending batch. It contains no message bodies, media or authentication secret, but its location data still needs appropriate local access controls.
- Keep state and sink paired. Switching API/output path requires a fresh state directory and deliberate sequence/bootstrap coordination, not silently reusing a checkpoint.
- Preserve the pending batch during network failures. Re-run with the same arguments to retry. If the server has a different producer/sequence, stop and reconcile with Owner 2; snapshots alone cannot recreate historical clearing evidence.
- Worker state/bootstrap currently starts at sequence zero for a new run. Server state must match the configured dataset/run. Restore the journal for an existing nonzero run rather than resetting it.
- JSON checkpoints and exact pixel polygonization favor correctness for a small region over global scale. Benchmark memory, segmentation fragmentation and throughput before increasing coverage. Simplification, spatial indexing, calibrated uncertainty, full layer handling and parallax are future work.

## Verification coverage

Tests exercise real OpenCV translation, synthetic NetCDF geostationary navigation, UTC/units, meteorological direction, altitude/time fallback, merge/split lineage, local overcast expiry, artwork transport, outages/horizon, created-cloud deletion, orphan reassociation across restart, atomic outbox recovery, version conflicts, authenticated loopback HTTP retries and replay isolation. Synthetic fixtures are not proof of tracking accuracy on real satellite imagery.

An additional real-data smoke check loaded GOES-19 CONUS ACM masks at **2025-07-19 17:01:18.1 UTC** and **17:06:18.1 UTC**, plus that hour's first DMW product (18,782 quality-filtered vectors). All 4,096 Troy-grid cells were valid in both masks; segmentation found three then four regions and the engine emitted sequences 1 and 2. Measured processing time was approximately six seconds per 64×64 observation on the development machine. Spatial degree buckets prune full-disk winds before regional sampling. This verifies archive ingestion and pipeline execution, not identity accuracy, wind-layer correctness or real-time operation. Current live acquisition, optional real height/CMI products and real-backend smoke checks remain outstanding integration checks. Downloaded files are ignored local output, not repository fixtures.

References: [NOAA ACM metadata](https://www.ncei.noaa.gov/access/metadata/landing-page/bin/iso?id=gov.noaa.ncdc%3AC01503), [NOAA DMW algorithm](https://www.star.nesdis.noaa.gov/goesr/documents/ATBDs/Enterprise/ATBD_Enterprise_Derived_Motion_Winds_v4.2_2024_06_05.pdf), [PROJ geostationary geometry](https://proj.org/en/stable/operations/projections/geos.html), [OpenCV optical flow](https://docs.opencv.org/4.x/d4/dee/tutorial_optical_flow.html).

Integration check after pulling main: the full publish CLI, restart/deduplication and shared smoke suite pass against tools/mock-api.mjs. This development mock now exposes worker state; it remains in-memory and does not establish real DB transaction correctness.
