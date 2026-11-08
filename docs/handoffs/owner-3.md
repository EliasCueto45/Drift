# Owner 3 — Tracking

## Current-real-sky MVP requirement

The final hackathon product must use current sky observations. Added `python -m cloud_worker.live` for continuous automatic NOAA catalog discovery and polling, plus `--once` for diagnostics. Default Troy live dataset/state are distinct from replay. Selects recent masks, height/IR where co-timed, and altitude-aware DMW; rejects stale/future masks and never falls back to fixtures. Acquisition failures retain state/content; ingest errors stop with the durable journal intact. New acquisition tests plus existing worker/shared integration suite: 37 passed with warnings as errors. Missing five-minute acquisitions reset clear-sky evidence before further expiry decisions.

Real current-sky smoke passed: discovered at 2026-11-08 00:38:32 UTC (Nov 7, 7:38 p.m. Eastern), processed masks at 00:26:18.3 and 00:31:18.3 UTC plus matching ACHAC/C13 and earlier DMWC. Two validated live batches emitted locally, dataset troy-live; no backend publishing attempted. Post-download age is also checked before live delivery. Current manifest/source provenance and diagnostics are ignored local artifacts, not generated shared fixtures.

Owner 2 exact request: connect this supervisor's `--publish` to persistent ingestion/state endpoints and preserve observation timestamps/uncertainty. Owner 1 exact request: use `troy-live`, display observation age and estimated/stale status, and verify current satellite movement reaches the browser. Local acquisition status is diagnostic only; no shared contract changes. Replay remains rehearsal, not the final demo. Full live browser acceptance awaits the backend/UI.

CI correction: the Python job invokes the shared Node smoke suite, so it now explicitly provisions Node 22/pnpm and installs the frozen workspace dependencies. The previous isolated runner failed with `ERR_MODULE_NOT_FOUND: ajv`; local node_modules had masked this setup omission. Integration tests remain enabled.

## Integration update after pulling main (`902219c`)

Merged main into `owner-3/tracking`. Adopted Owner 4's canonical validator for offline batches, wrapped the bundled schema with an explicit TrackingBatch reference (root alone has only definitions), enabled timestamp format validation, accepted the adopted sequence-only ack, and reconciled canonical artwork control points. No contract or generated-type changes.

Integration authorization also covered two small shared-tool fixes: portable generated-content check on Windows, and the mock worker-state endpoint needed to exercise the entire publishing CLI. The mock remains explicitly development-only.

Verification: combined worker/shared Python suite; all shared fixtures and wind cases; actual worker batches through Node mock with duplicate acks; CLI publish and restart through that mock; shared `tools/smoke.mjs` with synthetic auth; root lint/typecheck/test/build; portable check:contracts. No real backend/DB or Clerk integration exists on pulled main.

Owner 2 still needs the transactional state/hold/expiry/version semantics in the integration proposal. Owner 4 can now merge this branch and add worker publishing to CI using the mock for tooling checks. Cloud-relative anchors remain an unadopted proposal; this worker continues using canonical world anchors and local deformation, which are required under overcast.

Branch: `owner-3/tracking`. Base: `b4fd1fa`.

Implementation delivered in eight commits: service scaffold; wind/advection; satellite/segmentation; motion/lineage; content lifecycle; delivery/replay CLI; correctness regressions; operating guide/dependency lock and real-data smoke verification.

Scope: `services/cloud-worker/`, atmospheric fixtures, this handoff and tracking integration proposals. No frontend/backend implementation changes.

Shared schemas and backend endpoints are absent. Internal dataclasses represent scientific state only; Owner 4 remains responsible for canonical wire schemas. Do not claim backend integration until those schemas and Owner 2's endpoints are tested together.

Completed: isolated Python package scaffold, pinned direct dependencies, internal frame/grid/track/parcel types and timestamp/evidence validation tests.

Completed wind slice: altitude/time interpolation, spatial sampling, explicit surface/stale fallback confidence, meteorological direction conversion, and geodesic transport in <=60-second substeps. Checks: worker pytest suite (5 passed).

Completed satellite slice: metadata-driven GOES BCM/DQF geostationary navigation, co-timed height/CMI inputs, DMW ingestion with explicitly estimated pressure-height conversion, and hole-preserving regional polygonization. Tests use synthetic NetCDF files, not fetched satellite observations. Uncorrected parallax remains an explicit limitation.

Completed motion slice: forward/backward quality-checked Farneback flow, uncertainty fusion (including correlated DMW), wind-predicted overlap/layer gating, graph-based many-to-many association and deterministic lineage IDs. Merge/split and actual image-translation tests included.

Completed lifecycle slice: engine emits one transfer per parcel, moves artwork control points, preserves overcast locations, handles uncertainty/out-of-region, confirms clear-sky expiry and keeps created clouds independent with explicit expiry. Outages reset consecutive-clear evidence.

Integration detail for Owners 2/4: `hold` with null target preserves content as pending (hidden until reassociated) rather than deleting it when the predecessor retires. Worker checkpoints retain pending descendant IDs and geometric position times. Canonical schemas/backend must support this semantic; proposal accompanies delivery slice.

Completed delivery slice: atomic JSON checkpoint/outbox, exact lost-ack resends, authenticated/paginated state client, version-conflict reconciliation, NOAA/local product acquisition, replay/live CLI isolation and synthetic Troy fixture. Canonical JSON Schema is mandatory before publishing. See `docs/decisions/owner-3-tracking-integration.md` for precise state/ack/hold semantics requiring Owners 2/4 review.

Completed correctness slice (commit 7): 24 tests pass, including horizon freeze, local overcast clearing, orphan/restart/reassociation, version-conflict recomputation and loopback authenticated HTTP retry. Fixed deleted-created-cloud resurrection and checkpoint destination changes; API redirects cannot forward the worker credential.

Final slice: operational README, `.env.example`, product/wind examples, packaged replay fixture and full `uv.lock`. Updated NetCDF to 1.7.5.1.post1; the prior binary-size warning no longer occurs. Final check: `python -W error -m pytest services/cloud-worker/tests -q` (25 passed). Documented uv replay command emitted eight batches at sequence 8 without publishing. `uv build --project services/cloud-worker --out-dir services/cloud-worker/out/dist` produced source and wheel distributions, including the packaged replay fixture. `git diff --check` passed.

Real NOAA archive smoke: GOES-19 ACMC on 2025-07-19 at 17:01:18.1 and 17:06:18.1 UTC, first DMWC product in hour 17 (18,782 quality-filtered vectors). Troy 64x64 region: 4,096 valid cells both times, 541 then 173 cloudy cells, three then four segmented regions, sequences 1 and 2. Added spatial wind buckets after full-disk sampling proved too slow; optimized pipeline took ~6 seconds/observation locally. This verifies archive ingestion/execution only, not tracking accuracy or present-day live acquisition. No real backend has been validated.

For Owner 4: root README still describes the whole repository as documentation-only; update its status/setup when integrating all workstreams. Worker setup is executable now through `services/cloud-worker/README.md`; root pnpm/Compose commands remain planned. Adopt/review canonical schema and generated Python binding, state/ack shape, held-message lifecycle and geometric time semantics from the integration proposal before publishing.

For Owner 2: implement transactional ingestion/dedupe, snapshot-consistent pagination, and state reconciliation contract; test actual DB behavior against worker batches. The worker deliberately does not implement your API or mutate frontend code.

Remaining operational follow-ups: deploy/schedule manifest acquisition, validate real height/CMI/current observations, correct parallax/resolve layers if accuracy requires it, and benchmark wider regions. All eight commits remain on `owner-3/tracking`; do not merge directly into main without integration review.
