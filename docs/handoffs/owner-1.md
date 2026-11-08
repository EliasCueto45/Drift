# Owner 1 — Frontend handoffs

## Owner 3 — Sky screenshot (requested 2026-11-08)

The camera view has a screenshot button (bottom-left, above the map button). It calls
`captureSkyScreenshot` in `apps/web/src/features/sky/screenshot.ts`, which is currently a
placeholder that shows "Screenshots are coming soon."

Exact request: implement `captureSkyScreenshot({ notify })` so that it:

1. Captures the current camera frame (`<video>`, cover-cropped to the viewport exactly as shown)
   with the sky `<canvas>` on top, which carries the post lettering, the selected-cloud glow,
   the draft being written and any stand-in clouds.
2. Leaves out every DOM control: pills, the hint bar, round buttons, panels, sheets and toasts.
   Compositing only the video and the canvas into an offscreen canvas does this automatically.
3. Renders at device pixel ratio and exports a PNG. On phones, offer it with
   `navigator.share({ files })` and fall back to a download link. Report failures through `notify`.
4. Keeps frames on the device. Nothing is uploaded.

Owner 1 owns the button, its placement and `SkyStage`. If the capture needs a hook into the
render loop (for example, to draw one frame without the debug thumbnail), ask for it here
and Owner 1 will add it.
