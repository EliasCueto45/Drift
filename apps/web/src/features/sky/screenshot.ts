import type { SnapshotCapture } from "./snapshot";

/** Prepare a local PNG for preview; native sharing happens on a separate explicit tap. */
export async function captureSkyScreenshot({ capture, notify }: {
  capture: SnapshotCapture | null;
  notify?: (text: string) => void;
}): Promise<File> {
  try {
    if (!capture) throw new Error("Wait for the sky to appear, then try again.");
    const blob = await capture();
    const name = `drift-sky-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    return new File([blob], name, { type: "image/png" });
  } catch (error) {
    notify?.(error instanceof Error ? error.message : "Couldn't take a snapshot. Try again.");
    throw error;
  }
}
