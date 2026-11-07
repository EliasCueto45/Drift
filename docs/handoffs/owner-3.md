# Owner 3 — Tracking

Branch: `owner-3/tracking`. Base: `b4fd1fa`.

Planned seven commits: service scaffold; wind/advection; satellite/segmentation; motion/lineage; content lifecycle; delivery/replay CLI; regression tests and operational documentation.

Scope: `services/cloud-worker/`, atmospheric fixtures, this handoff and tracking integration proposals. No frontend/backend implementation changes.

Shared schemas and backend endpoints are absent. Internal dataclasses represent scientific state only; Owner 4 remains responsible for canonical wire schemas. Do not claim backend integration until those schemas and Owner 2's endpoints are tested together.

Completed: isolated Python package scaffold, pinned direct dependencies, internal frame/grid/track/parcel types and timestamp/evidence validation tests.

Completed wind slice: altitude/time interpolation, spatial sampling, explicit surface/stale fallback confidence, meteorological direction conversion, and geodesic transport in <=60-second substeps. Checks: worker pytest suite (5 passed).

Completed satellite slice: metadata-driven GOES BCM/DQF geostationary navigation, co-timed height/CMI inputs, DMW ingestion with explicitly estimated pressure-height conversion, and hole-preserving regional polygonization. Tests use synthetic NetCDF files, not fetched satellite observations. Uncorrected parallax remains an explicit limitation.

Next: optical-flow fusion and many-to-many cloud association. Run full worker pytest before each commit.
