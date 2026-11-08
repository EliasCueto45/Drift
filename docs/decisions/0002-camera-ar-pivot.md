# 0002 - Camera AR as the primary experience (PROPOSAL)

**Status:** proposed by Owner 1. README updated to describe the new product direction; contract v1 schema is unchanged until affected owners review.

**Change.** Drift becomes an augmented reality app: users point their phone camera at the sky, choose a real cloud, and paste a post (text, link, or image) onto it. Other users see posts on the same clouds through their own cameras. Previously, camera AR alignment was explicitly out of scope and the sky was a 2D canvas only. The 2D sky map remains as a fallback when camera or sensors are unavailable.

**Frontend (Owner 1).** New camera AR view using the rear camera feed, geolocation, compass, and device orientation. `SkyProjection` now takes a cloud altitude and may return `null` for off-screen points; a `CameraPose` type is added (see README). Map fallback and a labeled simulated pose for testing.

**Contract questions (Owner 4, Owner 2).**
- Post types narrow to text, link, image. For now they map to existing kinds `text`, `song`, `png`, so no breaking change is required.
- Proposed follow-up: rename `song` to `link` with a broader HTTPS allowlist, and stop accepting `audio` and `drawing` in the MVP. Renaming or removing kinds is breaking and needs a v2 or a compatibility plan.
- AR rendering needs each cloud's altitude. `wind.altitudeM` exists today; confirm it is always populated for observed clouds (Owner 3) or define a default.

**Tracking (Owner 3).** No algorithm change. AR makes alignment errors visible, so altitude and confidence values become user-facing.

**Privacy.** Camera frames stay on the device and are never uploaded or recorded.

**Decide by:** before Milestone 2 (first integrated slice).
