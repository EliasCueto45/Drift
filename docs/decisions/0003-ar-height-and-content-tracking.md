# 0003 — Owner 3 AR height boundary and content-driven tracking

Status: implemented worker follow-up; additive optional v1 `Cloud.altitude` proposed for affected-owner review. Announced in the implementation chat and Owner 3 handoff. Existing v1 fields and legacy fixtures remain valid. No camera frames are sent to the worker.

## Height conventions

`wind.altitudeM` remains the numerical cloud-plane estimate for compatibility. Optional `altitude` records the same meters plus `reference` (`mean_sea_level`, `wgs84_ellipsoid`, `unknown`), `source`, `estimated`, `measuredFraction`, and `parallaxCorrected`. It is not the wind vector's independently measured vertical location. Height provenance is aggregated per segmented region, not inferred from an unrelated region. It persists through lineage, uncertainty, hydration and checkpoints. An unknown vertical datum implies estimated AR placement even if the height product supplies all pixels.

GOES metadata explicitly naming height above mean sea level/ellipsoid is honored; otherwise the reference is unknown. A verified manifest `heightReference` can supply the missing convention. Do not infer the datum from the units `m`. Missing heights use an assumed 2 km MSL plane; created clouds use their configured assumed MSL plane. The cloud-top retrieval is not a measurement of the cloud base visible from below.

AR calculations must use a common datum. WGS84 ellipsoidal coordinates convert to ECEF/ENU. Sea-level height H converts to ellipsoidal h using **h = H + N**, where N is local geoid undulation. Missing viewer height/geoid/datum must produce estimated alignment, not a silently exact conversion. `cloud_worker.altitude` is a numerical reference for frontend tests, not a second screen projection implementation.

## Optional parallax correction

An opt-in manifest `parallaxCorrection: true` uses the satellite-to-cloud ray's intersection with the reference ellipsoid to inverse-sample the apparent satellite pixel. Mask, DQF, height and radiance sampling use consistent navigation. Height is first sampled for the displacement estimate, then sampled on the corrected footprint. This remains an approximation on a regional grid. `heightReference` must be documented; `geoidUndulationM` is required for MSL/assumed pixels. Unknown datum fails closed when correction is requested. Default live acquisition leaves correction off until a verified vertical conversion is configured. This avoids inventing a geoid offset or silently double-correcting a source.

References: [PROJ topocentric conversions](https://proj.org/en/stable/operations/conversions/topocentric.html), [PROJ height offsets](https://proj.org/en/stable/operations/transformations/geogoffset.html), [NOAA height requirements](https://goes-r.noaa.gov/syseng/docs/MRD.pdf). Product height definitions require verification for the actual source; NOAA distinguishes terrain-relative and sea-level reporting.

## Content-driven tracking

Live supervisor defaults to `--tracking-policy content`; explicit replay defaults to `all` for compatibility. All nearby regions are still detected so users can choose an empty cloud. Only occupied observed tracks and pending-message descendant candidates enter temporal matching and local motion transport. Created clouds retain independent wind motion/lifetime for their visible user-created experience.

Empty observations use lightweight shape-derived discovery identities, reused while the footprint is unchanged. Replacing an empty detection retires its old selectable record with an `updated` event, not a false `dissipated` event. Retired IDs are never resurrected. First posting activates the selected identity on the next state refresh. Deletion of the last message permits dropping temporal tracking. Splits retain the necessary lineage while a parcel is unresolved. A post racing retirement must cause the backend to reject the stale batch, refresh state, and recompute rather than lose the post. An open composer may need to refresh its selection after empty geometry changes.

Existing journals load without new fields. Policy switches happen only after any staged outbox batch is acknowledged unchanged; new batches checkpoint the selected policy. `--tracking-policy all` is a fallback for comparing tracking behavior. Do not reset server sequence or change an established dataset/run to switch policy.

## Rendering boundary

Owner 1 owns rear-camera permission, true heading, tilt/roll, calibration, camera intrinsics, the sole SkyProjection and viewer-facing billboards. Storing fixed 3D image orientation is separate from moving an anchor and requires an agreed optional contract. Existing artwork `rotationDeg` is clockwise in its artwork rectangle, not an Earth-fixed 3D quaternion.
