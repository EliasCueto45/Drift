# 0004 - On-device registration of camera clouds to tracked clouds (PROPOSAL)

**Status:** proposed by Owner 1, 2026-11-08. Frontend only. No contract, API or worker change.

## Problem

Drift's promise is that the cloud you see is the cloud that carries the posts and drifts on to other people. Today the link is purely geometric: the tracked cloud (satellite outline, height, motion) is projected into the camera using GPS, compass and tilt. Every input has error:

- phone compass: roughly 5 to 15 degrees, worse near metal or cars
- GOES cloud mask: about 2 km pixels, so small cumulus are clusters, not individual objects
- observation latency: 5 to 15 minutes
- height: cloud-top retrieval or the assumed 2 km plane, not the visible base (see 0003)
- satellite parallax: tall clouds are displaced several km unless corrected

Added together, the projected outline can sit beside the cloud it represents. That breaks the core claim, and the manual heading nudge asks the user to fix something they cannot judge.

## Decision

The frontend registers what the camera sees to what the satellite tracks, on the device.

1. **Segment** cloud vs. sky in a downscaled camera frame (about 160 px wide, a few times per second) with the red/blue ratio method used by ground sky imagers. Clear sky is strongly blue; cloud is white or grey. No model, no network.
2. **Register.** Search a small pose correction (heading and pitch offset, a few degrees) that maximises overlap between the projected tracked outlines and the segmented cloud mask. Accept it only when the overlap gain is clear, and apply it with heavy smoothing. It replaces the manual nudge as the primary calibration; the nudge stays as an override.
3. **Confirm on post.** A tap anchors to the tracked cloud whose registered outline contains it. If the camera shows no cloud at the tap, or no tracked cloud matches the visible cloud, the UI says so instead of anchoring silently.

## Honesty rules

- Placement is labeled **matched** only when registration succeeded recently. Otherwise **approximate** (sensor-only), as today.
- At night, in fog, or with the lens pointed at the sun, segmentation is unreliable. Registration switches off and placement is approximate. The satellite (IR) still tracks clouds at night.
- Overcast skies are one cloud. Registration has no contrast to fit; placement is approximate within it.
- Small cumulus below satellite resolution are posted on as part of a cloud field, not a single puff. Copy must not claim a specific puff is tracked.

## Privacy

Unchanged from 0002: frames are processed in memory on the device and are never uploaded, stored or recorded. Only the resulting pose correction is used, and it is not sent anywhere.

## Effects on other owners

- **Owner 3:** none required. Parallax correction and height quality (0003) directly reduce the correction registration has to find, so they remain valuable.
- **Owner 2 / Owner 4:** none. No new fields. A later optional field could record whether a post was placed while matched; that would be a separate proposal.

## Acceptance

On an iPhone in daylight with scattered cloud: after registration, tracked outlines overlap their visible clouds, the correction stays stable while panning, and a post placed from one viewpoint appears on the same visible cloud from a second viewpoint (Owner 3's two-viewpoint check).
