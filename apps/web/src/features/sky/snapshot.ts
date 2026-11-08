export type SnapshotCapture = () => Promise<Blob>;

/** Match the camera video's object-fit: cover crop, rather than stretching it. */
export function cameraCrop(videoWidth: number, videoHeight: number, width: number, height: number) {
  if (![videoWidth, videoHeight, width, height].every((v) => Number.isFinite(v) && v > 0)) {
    throw new Error("The sky is not ready for a snapshot yet.");
  }
  const scale = Math.max(width / videoWidth, height / videoHeight);
  const sw = width / scale, sh = height / scale;
  return { sx: (videoWidth - sw) / 2, sy: (videoHeight - sh) / 2, sw, sh };
}

/** Compose only camera/sky pixels and published notes. No DOM/UI is captured. */
export function captureSkyImage({ width, height, pixelRatio, video, draw }: {
  width: number;
  height: number;
  pixelRatio: number;
  video: HTMLVideoElement | null;
  draw: (ctx: CanvasRenderingContext2D) => void;
}): Promise<Blob> {
  cameraCrop(width, height, width, height); // Validate before allocating a canvas.
  const ratio = Math.min(Math.max(1, pixelRatio || 1), 2.5, 4096 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't prepare the snapshot.");
  ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
  if (video) {
    if (video.readyState < 2) throw new Error("Wait for the camera, then try again.");
    const { sx, sy, sw, sh } = cameraCrop(video.videoWidth, video.videoHeight, width, height);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, width, height);
  }
  draw(ctx);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Couldn't create the snapshot. Try again.")), "image/png");
  });
}

type ShareNavigator = Pick<Navigator, "share" | "canShare">;

export function canShareSnapshot(file: File, nav: ShareNavigator = navigator): boolean {
  try {
    return typeof nav.share === "function" && typeof nav.canShare === "function" && nav.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/** Call directly from a tap, with the already prepared file, to retain user activation. */
export async function shareSnapshot(file: File, nav: ShareNavigator = navigator): Promise<"shared" | "cancelled" | "unsupported"> {
  if (!canShareSnapshot(file, nav)) return "unsupported";
  try {
    await nav.share({ files: [file], title: "Sky notes" });
    return "shared";
  } catch (error) {
    if (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError") return "cancelled";
    throw error;
  }
}

export function saveSnapshot(file: File) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Give mobile browsers time to consume the download before revoking it.
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}
