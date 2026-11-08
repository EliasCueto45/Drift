# AR follow-up handoffs from Owner 3

## Last-known sky and supplied branding

User-requested outage behavior now exports `last-known-sky.json` from the acknowledged worker checkpoint, excluding pending batches and message bodies. API opt-in `DRIFT_SKY_FALLBACK_FILE` enables public geometry-only `GET /sky?lastKnown=1` reads without Atlas; normal sky reads fall back on MongoDB availability errors. Existing canonical SkyResponse is unchanged; `X-Drift-Sky-Source: last-known` distinguishes the read-only source. Dataset isolation, radius and created-cloud expiry are retained. Frontend reloads warm this cache, time out live attempts before the next poll, label the retained observation stale, avoid message reconciliation against an unavailable DB, and disable posting/cloud creation on saved geometry. Owner 2 exact handoff: deploy the optional file path/shared read-only volume and preserve geometry-only access; restore Atlas separately. Owner 1 exact handoff: retain observation-age/read-only hints and do not present empty cached previews as no existing posts. Tests cover acknowledged/pending isolation, DB independence, distance/expiry/dataset checks, reload, recovery and hung reads.

The supplied `Drift_logo_1.png` is copied unchanged to `apps/web/public/brand/drift-logo.png`. Responsive `DriftLogo` appears on onboarding, the map/simulated-view header and snapshot preview; the camera header stays unbranded at the user's request. Clerk `appearance.options` and browser/Apple icon metadata use the same asset. Owner 1 exact handoff: retain the provided artwork and keep branding out of clean captured sky pixels. No logo transformation or additional image generation was used.

## User-requested sky snapshot UI

The camera/simulated sky now exposes a clean frame capture to Owner 1's bottom-left screenshot icon, above the map button. Local PNG composition includes the object-fit camera crop, sky/cloud visuals and published notes, excluding DOM chrome, reticle, selection glow, draft and debug renderers. A native dialog previews the file; a second explicit tap invokes file sharing so mobile user activation is retained. Unsupported/failed sharing offers download and long-press image options, and cancel does not trigger a download. Simulated/illustrated images retain provenance. No API/storage/schema changes or automatic frame uploads.

Owner 1 exact handoff: retain the `SkyStage.onCaptureReady` / `SnapshotCapture` boundary, and test rear-camera cropping plus Save Image/Photos and a chosen messaging app through the native share sheet on iOS Safari and Android Chrome. Snapshot is offered in the camera and simulated 3D views, not the map. Owner 4 exact request: keep production HTTPS and the same-origin web-share policy available; no new API keys are required.

Validation: 94 frontend tests passed, including crop/PNG encoding, unready camera, file-share activation, cancellation, unsupported sharing, preview and URL cleanup. TypeScript, scoped ESLint and production build passed (existing font fallback warning). Browser verification using isolated labeled fixtures showed a cloud and its published note in the clean PNG preview, without UI/debug overlays; a first download succeeded, and a second browser download was declined at the approval gate and not retried. Actual phone share destinations remain a device acceptance check. The existing Atlas API timed out during this check; QA used separate loopback mock/proxy ports without changing live routing, then stopped them.

## Live Atlas persistence diagnosis — November 8, 2026

### Posted-content coverage correction

The held posts were outside the fixed 64x64 km Troy sampling crop, not outside actual cloud: reprocessing the cached 10:56 UTC NOAA mask on a wider grid found valid cloudy pixels at all three held anchors. The old mask was 100% overcast, so its unchanged outline was the rectangular crop, not evidence of stationary atmospheric material. No anchor rollback/snap or synthetic cloud creation is justified by this evidence.

Live acquisition now starts with a 128x128 km Troy window (covering the phone's 50 km radius) and grows in aligned 32-cell tiles to retain a 32 km buffer around tracked message anchors. Grid growth preserves the projected CRS, resolution, coordinates, sequence, cloud identity, journal and pending batches; shifts/shrinks/reprojection are rejected. Missing previous imagery on the newly covered area uses the existing wind fallback for the transition. A 512-cell axis budget reports unavailable rather than silently dropping content or inventing clear sky. Growth is a regional MVP fix, not global coverage: follow-up regional handoffs or moving per-content windows should avoid retaining the whole journey's observation area. Persistent temporal matching remains content-only; empty clouds remain discovery objects.

Regression checks cover boundary crossing and recovery without snapping, invalid grid changes, pending-journal growth, and actual FastAPI/disposable-MongoDB persistence of posts/votes across expansion and restart. Owner 1 exact request: consume refreshed anchors and reconcile locally created copies; the coverage fix does not add smooth client interpolation. Owner 4 exact request: provision regional handoffs/moving windows before claiming unlimited long-distance journeys; monitor acquisition `unavailable` and observation age.

Live recovery verified against shared Atlas at sequence 13, observation 2026-11-08T11:06:18.300Z: expanded grid 128x160 cells, original cloud ID retained, all three real posts non-held/non-expired and within observation coverage. Two independent public phone-URL reads returned the same three preview IDs with live freshness. No post bodies or credentials were logged, no messages were recreated, and no database dataset/run/sequence was reset. Worker suite: 51 passed/1 opt-in skipped; the expanded actual FastAPI/disposable-MongoDB test separately passed. Canonical fixture checks and scoped Python F/E9 lint passed.

Live polling recovery: a transient product-download DNS failure at 10:46 UTC stopped the supervisor after sequence 8. The worker CLI now propagates classified transport failures to the supervisor, which reports unavailable and retries on its normal polling interval while preserving the journal/outbox. API transport exhaustion is classified the same way. HTTP authentication failures, invalid batches, and unreconciled state errors still stop for operator intervention. Restart uses the same `atlas-live` journal and dataset; no resets or synthetic fallback.

The reported disappearing post was persisted, active and not held in Atlas. Its anchor was 25,410.85 m from the fallback campus viewer. `GET /messages?scope=all` returned it; the 25 km sky/Nearby filter excluded it. The local created-post overlay concealed that mismatch until reload. No database repair, synthetic replacement, or message-body logging was needed.

The user-requested integration fix makes the phone sky and Nearby reads use the supported 50 km radius and rejects placements beyond that same radius, both at tap time and submission time. API defaults and canonical contracts are unchanged. Owner 1 exact handoff: retain `features/sky/discovery.ts` as the shared phone range policy, verify the existing post reappears after a phone reload, and test two signed-in users on the current live tunnel. More than three posts still require opening the cloud; moving clouds/viewers can leave the radius. Owner 2 exact handoff: continue the separate caller-location transport work for server-side creation-radius enforcement; the browser guard does not replace server validation.

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
