# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Mobile-first web app, used primarily on phones held up to the sky. A 2D sky-map fallback serves desktop and devices without camera or motion-sensor access.

## Stack

Next.js App Router + TypeScript (README architecture). The frontend is not scaffolded yet; `apps/web` currently holds only server code. Backend, storage, Clerk auth, and the Python tracking worker are owned by other team members.

## Users

Primary: the HackRPI 2026 ("In The Clouds") demo audience. Judges and attendees try Drift on their own phones during the event, often for the first time, with little patience for setup. They may be outdoors under a real sky or indoors viewing synthetic fixture clouds around Troy, NY via a simulated pose.

The long-term audience (anyone outdoors who looks up and wants a small moment of connection with strangers) is a direction, not the current success bar.

## Product Purpose

Drift turns the sky into a huge shared sketch board. Users point their phone camera at the sky, choose a real cloud, and paste a post onto it: text, a link, or an image. Anyone who looks at the sky through Drift sees posts on the same clouds they were placed on. As clouds drift, their posts travel with them and reach people under new skies.

Success right now: a first-time judge can, within a minute, see posts on clouds through their camera, place one of their own, and watch it appear for someone else.

## Positioning

Content is attached to real, moving clouds tracked from satellite imagery and altitude-aware winds. Distribution comes from weather, not followers or algorithms: where a post goes depends on where its cloud drifts. Clouds merge, split, and dissipate, and posts share that lifecycle.

## Operating Context

- Used standing outside, phone raised, panning across the sky; one hand often busy holding the phone steady.
- Sunlight, glare, and a bright, constantly changing camera background behind every overlay.
- Short sessions: look up, discover, post, put the phone away.
- Demo conditions: crowded event space, varied phones and browsers, permission prompts (camera, location, motion) met for the first time, possibly no real clouds overhead.
- Overlays are approximate (compass error, satellite regions vs. clouds seen from the ground) and must be presented honestly.

## Capabilities and Constraints

- Post types: text (2,000 chars), link (HTTPS, 2,048 chars), image (PNG with transparency, 5 MiB, 4,096 px per side). In contract v1 these map to `text`, `song`, `png`.
- Aim or tap to select a cloud; up to three nearby previews; double tap or **Open cloud** expands to paginated **Nearby** / **All in cloud** tabs.
- One upvote per user per post, toggleable; server count is authoritative.
- Browsing is anonymous; posting, uploading, creating clouds, and voting require Clerk sign-in.
- Clear sky: **Draw a cloud** creates a labeled **Created cloud** that drifts with the wind and expires after 24 hours.
- Weather states (rain, night, missing data) change styling or show **Estimated** / **Stale**; content is never deleted because data is missing.
- Camera frames never leave the device. Users are warned that a post's anchor is publicly discoverable; location trails are never shown.
- **Open decision — post identity modes.** The intended product has two modes: an **anonymous mode** (message in a bottle; the author is not shown) and a **social expression mode** (author's public profile shown). Contract v1 always displays the author's public profile, so anonymous mode needs a contract proposal with Owners 2 and 4 before it can ship.
- Open decision — renaming `song` to `link` and dropping `audio` / `drawing` (see `docs/decisions/0002-camera-ar-pivot.md`).

## Brand Commitments

- Name: **Drift** (final).
- Tagline and HackRPI theme treatment are not fixed yet.

## Evidence on Hand

- Product spec: `README.md`; integration plan: `docs/INTEGRATION.md`; decisions: `docs/decisions/`.
- Synthetic fixture scenarios in `fixtures/scenarios/` (scattered, overcast, merge, split, dissipation, outage, clear-sky, created-cloud). These are labeled synthetic and must never be presented as live data.
- No logo, brand assets, user research, testimonials, or real usage data exist. Do not fabricate them.

## Product Principles

1. **A message in a bottle, carried by the sky.** Posts should feel like ideas released into the clouds, found by chance, whether signed or anonymous.
2. **The sky stays the hero.** The real sky through the camera is the canvas; UI exists to reveal posts on it, not to cover it.
3. **Honest about uncertainty.** Positions, freshness, and synthetic data are labeled plainly; never imply exact cloud matching or live data that is not live.
4. **First minute wins the demo.** Permissions, the first post discovered, and the first post placed must work for a stranger with no explanation.
5. **Always a way in.** When the camera, sensors, or real clouds are unavailable, the map fallback and simulated pose keep every action possible.

## Accessibility & Inclusion

- Every AR action (select, open, post, vote) also works in the 2D map fallback, including keyboard activation.
- Overlay text must stay legible against bright, moving sky backgrounds.
- Motion-sensor and camera use are optional; denial never blocks reading or posting.
