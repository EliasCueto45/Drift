/**
 * Sky screenshot: the camera frame plus the post lettering drawn on the canvas, without any
 * of the on-screen buttons, pills or panels.
 *
 * Placeholder. Owner 3 implements the capture (see docs/handoffs/owner-1.md). Expected
 * approach: draw the <video> frame (cover-cropped to the viewport) and then the sky <canvas>
 * into an offscreen canvas at device pixel ratio, export a PNG, and offer it with the Web
 * Share API (navigator.share with files) or a download link. DOM chrome is never captured
 * because only the video and canvas are composited. Frames stay on the device.
 */
export async function captureSkyScreenshot({ notify }: { notify: (text: string) => void }): Promise<void> {
  notify("Screenshots are coming soon.");
}
