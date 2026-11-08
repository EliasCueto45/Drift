/**
 * On-device registration of camera clouds to tracked clouds (docs/decisions/0004).
 * Pure functions: segment a small camera frame into cloud vs. sky, then find the screen
 * shift that best lays the projected tracked outlines over the visible clouds.
 * Frames are processed in memory only; nothing here touches the network.
 */
import { DEG, type Vec3 } from "./geo";

export interface CloudMask {
  w: number;
  h: number;
  /** Cloudiness per pixel, 0 (clear blue sky) to 1 (cloud). */
  cloud: Float32Array;
  /** 1 where the pixel is usable sky (above horizon, not too dark, not glare). */
  valid: Uint8Array;
  validFraction: number;
  /** Mean cloudiness over valid pixels. */
  cloudFraction: number;
}

/** Darker than this (max channel) is night, ground or shadow: unusable. */
export const MIN_BRIGHTNESS = 45;

/**
 * Red/blue ratio segmentation, the standard ground sky-imager method: clear sky scatters
 * blue so R/B is low (~0.5); cloud is white or grey so R/B approaches 1.
 */
export function cloudiness(r: number, g: number, b: number): number | null {
  const max = Math.max(r, g, b);
  if (max < MIN_BRIGHTNESS) return null;
  if (r > 248 && g > 248 && b > 248) return null; // sun glare / blown out
  const ratio = r / Math.max(b, 1);
  return Math.min(1, Math.max(0, (ratio - 0.62) / 0.2));
}

export function segmentFrame(rgba: Uint8ClampedArray, w: number, h: number, isSky: (x: number, y: number) => boolean = () => true): CloudMask {
  const cloud = new Float32Array(w * h);
  const valid = new Uint8Array(w * h);
  let n = 0;
  let sum = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!isSky(x, y)) continue;
      const c = cloudiness(rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!);
      if (c === null) continue;
      cloud[i] = c;
      valid[i] = 1;
      n++;
      sum += c;
    }
  }
  return { w, h, cloud, valid, validFraction: n / (w * h), cloudFraction: n ? sum / n : 0 };
}

/** Even-odd scanline fill of polygons (mask pixel coordinates) into a 0/1 grid. */
export function rasterize(rings: { x: number; y: number }[][], w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = y + 0.5;
    const xs: number[] = [];
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i]!, b = ring[j]!;
        if (a.y > sy !== b.y > sy) xs.push(a.x + ((sy - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k]! - 0.5));
      const x1 = Math.min(w - 1, Math.floor(xs[k + 1]! - 0.5));
      for (let x = x0; x <= x1; x++) out[y * w + x] = 1;
    }
  }
  return out;
}

export interface ShiftResult {
  dx: number;
  dy: number;
  /** Mean agreement (-1..1) of the shifted outlines with the mask at the best shift. */
  score: number;
  /** Agreement with no shift. */
  baseScore: number;
  /** Fraction of outline pixels that land on valid sky at the best shift. */
  coverage: number;
}

/**
 * Agreement of the outline model shifted by (dx, dy) with the cloud mask: +1 where the
 * outline covers cloud, -1 where it covers clear sky, averaged over valid covered pixels.
 */
function scoreAt(mask: CloudMask, model: Uint8Array, idx: Int32Array, dx: number, dy: number) {
  const { w, h, cloud, valid } = mask;
  let s = 0;
  let n = 0;
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k]!;
    const x = (i % w) + dx;
    const y = ((i / w) | 0) + dy;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const j = y * w + x;
    if (!valid[j]) continue;
    s += 2 * cloud[j]! - 1;
    n++;
  }
  return { score: n ? s / n : 0, coverage: idx.length ? n / idx.length : 0 };
}

/** Coarse-to-fine search over screen shifts within ±maxDx, ±maxDy mask pixels. */
export function bestShift(mask: CloudMask, model: Uint8Array, maxDx: number, maxDy: number): ShiftResult | null {
  const list: number[] = [];
  for (let i = 0; i < model.length; i++) if (model[i]) list.push(i);
  if (list.length < 12) return null;
  // Subsample big outlines; a few thousand pixels are plenty for a 2-parameter fit.
  const stride = Math.max(1, Math.floor(list.length / 2500));
  const idx = Int32Array.from(list.filter((_, k) => k % stride === 0));
  const base = scoreAt(mask, model, idx, 0, 0);
  // Ties go to the smaller shift, so a featureless sky doesn't pull the overlay sideways.
  const better = (s: number, dx: number, dy: number, b: { score: number; dx: number; dy: number }) =>
    s > b.score + 1e-9 || (Math.abs(s - b.score) <= 1e-9 && Math.hypot(dx, dy) < Math.hypot(b.dx, b.dy));
  let best = { dx: 0, dy: 0, score: base.score, coverage: base.coverage };
  const step = 3;
  for (let dy = -maxDy; dy <= maxDy; dy += step) {
    for (let dx = -maxDx; dx <= maxDx; dx += step) {
      const r = scoreAt(mask, model, idx, dx, dy);
      if (r.coverage > 0.5 && better(r.score, dx, dy, best)) best = { dx, dy, ...r };
    }
  }
  const coarse = best;
  for (let dy = coarse.dy - step + 1; dy <= coarse.dy + step - 1; dy++) {
    for (let dx = coarse.dx - step + 1; dx <= coarse.dx + step - 1; dx++) {
      if (Math.abs(dx) > maxDx || Math.abs(dy) > maxDy) continue;
      const r = scoreAt(mask, model, idx, dx, dy);
      if (r.coverage > 0.5 && better(r.score, dx, dy, best)) best = { dx, dy, ...r };
    }
  }
  return { dx: best.dx, dy: best.dy, score: best.score, baseScore: base.score, coverage: best.coverage };
}

export type RegistrationState = "matched" | "searching" | "no-sky" | "no-contrast" | "no-clouds";

/** Whether a frame can be registered at all, and why not. */
export function frameUsable(mask: CloudMask): RegistrationState | null {
  if (mask.validFraction < 0.2) return "no-sky"; // night, ground, glare
  if (mask.cloudFraction < 0.04 || mask.cloudFraction > 0.85) return "no-contrast"; // clear or overcast
  return null;
}

/** A shift is trusted only when it clearly beats the unshifted overlay. */
export function acceptShift(r: ShiftResult): boolean {
  return r.score > 0.35 && r.score - r.baseScore > 0.12 && r.coverage > 0.5;
}

function azEl([e, n, u]: Vec3) {
  return { az: Math.atan2(e, n) / DEG, el: Math.asin(Math.max(-1, Math.min(1, u))) / DEG };
}

/**
 * Pose correction for an overlay shift: what is drawn at `from` should be drawn at `to`.
 * The world direction under `from` must end up under `to`, so the camera turns the other way.
 */
export function correctionFromShift(rayAt: (x: number, y: number) => Vec3, from: { x: number; y: number }, to: { x: number; y: number }) {
  const a = azEl(rayAt(from.x, from.y));
  const b = azEl(rayAt(to.x, to.y));
  const dAz = ((b.az - a.az + 540) % 360) - 180;
  return { dAzDeg: -dAz, dElDeg: -(b.el - a.el) };
}
