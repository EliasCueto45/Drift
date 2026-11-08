# AR follow-up handoffs from Owner 3

Read [decision 0003](../decisions/0003-ar-height-and-content-tracking.md). Worker output now carries optional canonical `Cloud.altitude`; Python validators read the canonical schema directly; the Python runtime decision removes generated TS bindings. Existing `wind.altitudeM` remains available. The live supervisor defaults to content-driven tracking; replay remains compatible.

## Owner 1 — Phone camera and projection

- Consume `cloud.altitude` when present. `meters` equals `wind.altitudeM`; read `reference`, `estimated`, `measuredFraction`, `source` and `parallaxCorrected`. Missing metadata on legacy clouds means unknown/estimated, not measured height.
- Add viewer elevation and its reference/accuracy to your CameraPose handling. Do not subtract a sea-level cloud height from an ellipsoidal GPS height. Convert using a verified local geoid offset, or clearly indicate estimated alignment. See Python reference functions/tests for overhead, eastward and viewer-height cases; these intentionally do not implement screen pixels.
- Cloud-top height can differ from the visible cloud base. Sensor errors, uncertainty, unsupported datum and uncorrected parallax must be reflected in calibration hints. Do not promise exact physical cloud matching.
- Keep messages facing the viewer by default. Apply existing 2D artwork rotation within that billboard. An optional Earth-fixed orientation needs Owner 4's schema and Owner 2's persistence agreement; do not reinterpret `rotationDeg` as one.
- Empty detection IDs may change when their outlines change. Refresh/reselect on expired/version-conflict responses in an open composer. Posting activates persistent tracking without needing the camera frame uploaded.
- Phone acceptance: place one post from two separated viewpoints and verify consistent geographic anchor and altitude, viewer-facing readability, then movement/merge/split. Denied permissions must retain map fallback.

## Owner 2 — State and concurrency

- Preserve optional `Cloud.altitude` when ingesting, storing and returning snapshots. Do not recompute provenance from wind speed or erase it when freezing a position. Current payload persistence accepts the optional field; keep that behavior.
- Continue returning every live message anchor/version (including held messages) and needed retired origins in worker state. The worker derives active IDs from these messages and pending descendants; no new active-tracking endpoint is required.
- Enforce current retirement concurrency checks: if a user posts after the worker state read, reject retirement of an untransferred parcel atomically, then allow refresh/recompute. Never expire a real post merely because empty discovery was replaced.
- Validate preservation of posts/votes/artwork during first-message activation, split/hold/reassociation, last-message deletion and policy switching. The worker's MongoDB integration test now runs content mode.

## Owner 4 — Contract and integration review

- Review additive optional `Cloud.altitude` in the canonical schema and its Python validator coverage. Legacy v1 fixtures intentionally omit it and remain valid. Coordinate frontend use without requiring old consumers to send it.
- Agree viewer altitude reference/geoid conversion and optional fixed-orientation representation with Owner 1 before advertising accurate AR. Do not rename/remove message kinds as part of this additive change.
- Review source vertical metadata before enabling manifest parallax correction; supply a verified reference and local geoid value. Keep unknown datum and approximate placement visible. No hardcoded geoid value has been invented.
- Run worker tests with DRIFT_TEST_BACKEND=1 after installing Owner 2's backend dependencies. The migrated harness now delegates to Owner 2's MongoDB implementation; older PostGIS tests are no longer launched.
- Complete actual phone/current-sky acceptance after wiring the frontend. A simulated pose or synthetic fixture cannot demonstrate current cloud alignment. Paused operational edits remain in the local stash and are not reapplied by this work.
