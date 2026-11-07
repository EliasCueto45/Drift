# Owner 3 — Tracking

Branch: `owner-3/tracking`. Base: `b4fd1fa`.

Planned seven commits: service scaffold; wind/advection; satellite/segmentation; motion/lineage; content lifecycle; delivery/replay CLI; regression tests and operational documentation.

Scope: `services/cloud-worker/`, atmospheric fixtures, this handoff and tracking integration proposals. No frontend/backend implementation changes.

Shared schemas and backend endpoints are absent. Internal dataclasses represent scientific state only; Owner 4 remains responsible for canonical wire schemas. Do not claim backend integration until those schemas and Owner 2's endpoints are tested together.

Completed: isolated Python package scaffold, pinned direct dependencies, internal frame/grid/track/parcel types and timestamp/evidence validation tests.

Completed wind slice: altitude/time interpolation, spatial sampling, explicit surface/stale fallback confidence, meteorological direction conversion, and geodesic transport in <=60-second substeps. Checks: worker pytest suite (5 passed).

Completed satellite slice: metadata-driven GOES BCM/DQF geostationary navigation, co-timed height/CMI inputs, DMW ingestion with explicitly estimated pressure-height conversion, and hole-preserving regional polygonization. Tests use synthetic NetCDF files, not fetched satellite observations. Uncorrected parallax remains an explicit limitation.

Completed motion slice: forward/backward quality-checked Farneback flow, uncertainty fusion (including correlated DMW), wind-predicted overlap/layer gating, graph-based many-to-many association and deterministic lineage IDs. Merge/split and actual image-translation tests included.

Completed lifecycle slice: engine emits one transfer per parcel, moves artwork control points, preserves overcast locations, handles uncertainty/out-of-region, confirms clear-sky expiry and keeps created clouds independent with explicit expiry. Outages reset consecutive-clear evidence.

Integration detail for Owners 2/4: `hold` with null target preserves content as pending (hidden until reassociated) rather than deleting it when the predecessor retires. Worker checkpoints retain pending descendant IDs and geometric position times. Canonical schemas/backend must support this semantic; proposal accompanies delivery slice.

Completed delivery slice: atomic JSON checkpoint/outbox, exact lost-ack resends, authenticated/paginated state client, version-conflict reconciliation, NOAA/local product acquisition, replay/live CLI isolation and synthetic Troy fixture. Canonical JSON Schema is mandatory before publishing. See `docs/decisions/owner-3-tracking-integration.md` for precise state/ack/hold semantics requiring Owners 2/4 review.

Next: broader numerical/failure regressions, operational README/environment template and final verification. No backend exists yet; HTTP integration is not claimed.
