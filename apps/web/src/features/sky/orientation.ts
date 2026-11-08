/**
 * Device orientation -> camera angles. Pure functions; the hook in usePose.ts feeds them.
 *
 * W3C DeviceOrientation: R = Rz(alpha) * Rx(beta) * Ry(gamma) maps the device frame
 * (x right, y toward the top edge, z out of the screen) into East/North/Up when alpha is
 * referenced to north. The rear camera looks along device -z.
 */
import { DEG, add, dot, scale, sub, unit, type Vec3 } from "./geo";
import { anglesFromBasis } from "./projection";

function rotate(alpha: number, beta: number, gamma: number, v: Vec3): Vec3 {
  const [x0, y0, z0] = v;
  const cg = Math.cos(gamma * DEG), sg = Math.sin(gamma * DEG);
  const x1 = cg * x0 + sg * z0, y1 = y0, z1 = -sg * x0 + cg * z0; // Ry(gamma)
  const cb = Math.cos(beta * DEG), sb = Math.sin(beta * DEG);
  const x2 = x1, y2 = cb * y1 - sb * z1, z2 = sb * y1 + cb * z1; // Rx(beta)
  const ca = Math.cos(alpha * DEG), sa = Math.sin(alpha * DEG);
  return [ca * x2 - sa * y2, sa * x2 + ca * y2, z2]; // Rz(alpha)
}

/**
 * Forward (rear camera) and screen-up vectors in ENU.
 * `screenAngle` is screen.orientation.angle: 0 portrait, 90 when the device is turned
 * counterclockwise into landscape (its right edge up).
 */
export function deviceVectors(alpha: number, beta: number, gamma: number, screenAngle = 0) {
  const t = screenAngle * DEG;
  const forward = rotate(alpha, beta, gamma, [0, 0, -1]);
  const up = rotate(alpha, beta, gamma, [Math.sin(t), Math.cos(t), 0]);
  return { forward, up };
}

/**
 * iOS reports a tilt-compensated magnetic compass heading separately and a relative alpha.
 * Heading is clockwise from north while alpha is counterclockwise, so alpha = 360 - heading.
 */
export function alphaFromCompassHeading(heading: number) {
  return (360 - heading) % 360;
}

/** Exponential smoothing of the forward/up pair, re-orthonormalised. k in (0, 1]. */
export function smoothVectors(prev: { forward: Vec3; up: Vec3 } | null, next: { forward: Vec3; up: Vec3 }, k: number) {
  if (!prev) return next;
  // Large jumps (e.g. orientation snap) reset the filter instead of sweeping across the sky.
  if (dot(prev.forward, next.forward) < Math.cos(60 * DEG)) return next;
  const forward = unit(add(scale(prev.forward, 1 - k), scale(next.forward, k)));
  const blended = add(scale(prev.up, 1 - k), scale(next.up, k));
  const up = unit(sub(blended, scale(forward, dot(blended, forward))));
  return { forward, up };
}

/** Camera angles from device vectors, plus a heading offset (declination + user nudge). */
export function poseAngles(v: { forward: Vec3; up: Vec3 }, headingOffsetDeg: number) {
  const a = anglesFromBasis(v.forward, v.up);
  return { ...a, azimuthDeg: (((a.azimuthDeg + headingOffsetDeg) % 360) + 360) % 360 };
}

/**
 * Magnetic declination (east positive) for converting compass headings to true north.
 * A full World Magnetic Model is not bundled yet; this covers the HackRPI demo region
 * (Troy, NY is about 13 degrees west). Elsewhere it returns null and the UI says the
 * compass is uncorrected so the user can nudge alignment by hand.
 */
export function declinationDeg(latitude: number, longitude: number): number | null {
  const override = process.env.NEXT_PUBLIC_DRIFT_DECLINATION_DEG;
  if (override && Number.isFinite(Number(override))) return Number(override);
  const nearTroy = Math.abs(latitude - 42.73) < 3 && Math.abs(longitude + 73.69) < 4;
  return nearTroy ? -13 : null;
}

/**
 * Visible horizontal field of view of an object-fit:cover video in a viewport.
 * diagFovDeg is the stream's diagonal FOV (typical phone main camera ~ 26 mm equivalent).
 */
export function visibleHfovDeg(
  viewport: { width: number; height: number },
  stream: { width: number; height: number } | null,
  diagFovDeg = 78,
) {
  const s = stream && stream.width > 0 && stream.height > 0 ? stream : portraitDefault(viewport);
  const halfDiag = Math.tan((diagFovDeg * DEG) / 2);
  const diag = Math.hypot(s.width, s.height);
  const tanHalfW = (halfDiag * s.width) / diag;
  const coverScale = Math.max(viewport.width / s.width, viewport.height / s.height);
  const visibleFraction = viewport.width / coverScale / s.width;
  return (2 * Math.atan(tanHalfW * visibleFraction)) / DEG;
}

function portraitDefault(viewport: { width: number; height: number }) {
  return viewport.height >= viewport.width ? { width: 3, height: 4 } : { width: 4, height: 3 };
}
