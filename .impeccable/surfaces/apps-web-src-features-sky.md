---
version: 1
slug: "apps-web-src-features-sky"
primary_target: "apps/web/src/features/sky"
related_targets: ["apps/web/src/features/composer","apps/web/src/app"]
---

# Sky view (camera AR, simulated sky, map fallback)

Mode: Operate. Phone held up to a daytime sky; first-time HackRPI judges; one minute to see a post, place one, and watch it appear elsewhere.

Job: find posts written on real clouds, pick a cloud, read and upvote its posts, place a new one at a tapped spot. Map fallback keeps every action when camera or sensors are unavailable.

User steer (pinned, round 1): realism. Posts are embedded in the cloud itself in the camera view, with no boundary or background besides the actual cloud. A panel appears only when a cloud is selected.

Unresolved: author display (API returns only authorId); anonymous mode needs a contract proposal; image posts and Draw a cloud are post-MVP.

## Direction contract

THESIS: The live camera sky is the photograph and stays unframed; posts are written into clouds as vapor, and the interface surfaces only as a photo-caption sheet when a cloud is chosen. Refuses the category default of floating labels, stickers and glass cards over AR.

OWN-WORLD: White vapor letterforms lit from above with a shaded blue-grey underside (#ffffff on #2e4666 shadow), no outlines ever on the sky; a white caption sheet (#ffffff, ink #1b2533, secondary #5e7a99, hairline #e6eaee) with a coral primary (#e4572e); one humanist face (Atkinson Hyperlegible Next) at many sizes. The chosen cloud brightens with a feathered glow; others fade a step. State is form: crisp letters live, softened estimated, thin and faded stale. Upvotes set letter size.

STORY: The visitor looks up, sees words sitting in clouds, aims or taps one, reads its caption sheet, upvotes, taps Post on this cloud, taps a spot, writes, watches the words settle into the cloud, and knows anyone under that sky will see them there.

FIRST VIEWPORT: Edge-to-edge camera (or simulated sky labeled synthetic). Top-left one freshness caption on a soft dark pill; top-right account. Vapor posts inside clouds in the upper two thirds; a small white reticle at center. No panel until a cloud is selected; then a white sheet rises from the bottom (about a third of the height) with title (distance and direction), height and certainty line, up to three posts with upvote toggles, and Post on this cloud (coral) plus All posts. Map toggle bottom-left when nothing is selected.

FORM: Cloud-spotting photography, assigned candidate 5 of 7 on the re-rolled list (realism steer). seed:47e44676abd3c420

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
