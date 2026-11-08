/**
 * SkyProjection: the single geographic <-> screen mapping for Drift (README "Camera AR view").
 * Screen coordinates are CSS pixels relative to the canvas, origin top-left.
 * Pose angles: azimuth clockwise from true north, elevation above the horizon,
 * roll clockwise about the optical axis (as seen by the user holding the phone).
 */
import type { Anchor, Cloud } from "@/lib/contracts";
import {
  DEG,
  add,
  cross,
  dot,
  enuBasis,
  fromEcef,
  groundDistanceM,
  scale,
  sub,
  toEcef,
  unit,
  type Vec3,
} from "./geo";

export type HeightReference = "wgs84_ellipsoid" | "mean_sea_level" | "unknown";

export interface CameraPose {
  longitude: number;
  latitude: number;
  /** Viewer height. Only used when its datum matches the cloud's (see resolveHeights). */
  heightM: number;
  heightReference: HeightReference;
  azimuthDeg: number;
  elevationDeg: number;
  rollDeg: number;
  /** Horizontal field of view of the visible (cropped) camera image. */
  hfovDeg: number;
  source: "sensors" | "simulated";
}

export interface Viewport {
  width: number;
  height: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
  /** Slant distance from the viewer, meters. */
  distanceM: number;
}

export const ASSUMED_CLOUD_HEIGHT_M = 2000;
const NEAR_M = 1;

/** Cloud-plane height: canonical altitude, then wind layer, then the 2 km MVP assumption. */
export function cloudHeight(cloud: Pick<Cloud, "altitude" | "wind">): {
  meters: number;
  reference: HeightReference;
  estimated: boolean;
} {
  if (cloud.altitude) {
    return {
      meters: cloud.altitude.meters,
      reference: cloud.altitude.reference,
      estimated: cloud.altitude.estimated || cloud.altitude.reference === "unknown",
    };
  }
  const wind = cloud.wind?.altitudeM;
  if (typeof wind === "number" && Number.isFinite(wind) && wind > 0) {
    return { meters: wind, reference: "unknown", estimated: true };
  }
  return { meters: ASSUMED_CLOUD_HEIGHT_M, reference: "unknown", estimated: true };
}

/**
 * Never subtract a sea-level cloud height from an ellipsoidal GPS height (Owner 3 handoff).
 * When datums differ or are unknown, both heights are taken relative to the viewer's ground
 * and alignment is reported as estimated.
 */
export function resolveHeights(pose: Pick<CameraPose, "heightM" | "heightReference">, cloudMeters: number, cloudRef: HeightReference) {
  const sameDatum = cloudRef !== "unknown" && cloudRef === pose.heightReference;
  return sameDatum
    ? { viewerM: pose.heightM, targetM: cloudMeters, estimated: false }
    : { viewerM: 0, targetM: cloudMeters, estimated: true };
}

/** Camera basis in local ENU for the given angles. */
export function cameraBasis(azimuthDeg: number, elevationDeg: number, rollDeg: number) {
  const az = azimuthDeg * DEG;
  const el = elevationDeg * DEG;
  const ro = rollDeg * DEG;
  const f: Vec3 = [Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el)];
  const r0: Vec3 = [Math.cos(az), -Math.sin(az), 0];
  const u0: Vec3 = [-Math.sin(az) * Math.sin(el), -Math.cos(az) * Math.sin(el), Math.cos(el)];
  const r = sub(scale(r0, Math.cos(ro)), scale(u0, Math.sin(ro)));
  const u = add(scale(r0, Math.sin(ro)), scale(u0, Math.cos(ro)));
  return { f, r, u };
}

/** Inverse of cameraBasis: angles from forward and screen-up vectors in ENU. */
export function anglesFromBasis(forward: Vec3, up: Vec3) {
  const f = unit(forward);
  const horizontal = Math.hypot(f[0], f[1]);
  const elevationDeg = Math.atan2(f[2], horizontal) / DEG;
  // Looking straight up the azimuth is undefined: take it from the screen-up vector instead.
  const azimuthRad = horizontal > 1e-6 ? Math.atan2(f[0], f[1]) : Math.atan2(-up[0], -up[1]);
  const azimuthDeg = ((azimuthRad / DEG) % 360 + 360) % 360;
  const { r: r0, u: u0 } = cameraBasis(azimuthDeg, elevationDeg, 0);
  const right = unit(cross(f, up));
  const rollDeg = horizontal > 1e-6 ? Math.atan2(-dot(right, u0), dot(right, r0)) / DEG : 0;
  return { azimuthDeg, elevationDeg, rollDeg };
}

export class SkyProjection {
  private readonly origin: Vec3;
  private readonly enu: { e: Vec3; n: Vec3; u: Vec3 };
  private readonly cam: { f: Vec3; r: Vec3; u: Vec3 };
  readonly focalPx: number;
  readonly cx: number;
  readonly cy: number;

  constructor(
    readonly pose: CameraPose,
    readonly viewport: Viewport,
    /** Height used as the viewer's origin; see resolveHeights. */
    private readonly viewerHeightM = 0,
  ) {
    this.origin = toEcef(pose.longitude, pose.latitude, viewerHeightM);
    this.enu = enuBasis(pose.longitude, pose.latitude);
    this.cam = cameraBasis(pose.azimuthDeg, pose.elevationDeg, pose.rollDeg);
    this.cx = viewport.width / 2;
    this.cy = viewport.height / 2;
    this.focalPx = this.cx / Math.tan((pose.hfovDeg * DEG) / 2);
  }

  get verticalFovDeg() {
    return (2 * Math.atan(this.cy / this.focalPx)) / DEG;
  }

  /** ENU offset of a geographic point from the viewer, meters. */
  private enuOf(anchor: Anchor, heightM: number): Vec3 {
    const d = sub(toEcef(anchor.longitude, anchor.latitude, heightM), this.origin);
    return [dot(d, this.enu.e), dot(d, this.enu.n), dot(d, this.enu.u)];
  }

  private cameraOf(enu: Vec3): Vec3 {
    return [dot(enu, this.cam.r), dot(enu, this.cam.u), dot(enu, this.cam.f)];
  }

  private toScreen([x, y, z]: Vec3, distanceM: number): ScreenPoint {
    return { x: this.cx + (this.focalPx * x) / z, y: this.cy - (this.focalPx * y) / z, distanceM };
  }

  /** Screen position, or null when behind the camera or outside the viewport (+ margin). */
  project(anchor: Anchor, heightM: number, marginPx = 0): ScreenPoint | null {
    const p = this.projectUnclipped(anchor, heightM);
    if (!p) return null;
    const { width, height } = this.viewport;
    if (p.x < -marginPx || p.y < -marginPx || p.x > width + marginPx || p.y > height + marginPx) return null;
    return p;
  }

  /** Screen position for any point in front of the camera (may be off screen). */
  projectUnclipped(anchor: Anchor, heightM: number): ScreenPoint | null {
    const enu = this.enuOf(anchor, heightM);
    const c = this.cameraOf(enu);
    if (c[2] < NEAR_M) return null;
    return this.toScreen(c, Math.hypot(enu[0], enu[1], enu[2]));
  }

  /** Elevation above the viewer's horizon, degrees. */
  elevationOf(anchor: Anchor, heightM: number): number {
    const [e, n, u] = this.enuOf(anchor, heightM);
    return Math.atan2(u, Math.hypot(e, n)) / DEG;
  }

  /**
   * Project a [lng, lat] ring at one height, clipped against the camera's near plane
   * so polygons that wrap behind the viewer still draw correctly. Empty when fully behind.
   */
  projectRing(ring: number[][], heightM: number): { x: number; y: number }[] {
    const pts = ring.map(([lng, lat]) => this.cameraOf(this.enuOf({ longitude: lng!, latitude: lat! }, heightM)));
    const out: Vec3[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      const aIn = a[2] >= NEAR_M;
      const bIn = b[2] >= NEAR_M;
      if (aIn) out.push(a);
      if (aIn !== bIn) {
        const t = (NEAR_M - a[2]) / (b[2] - a[2]);
        out.push(add(a, scale(sub(b, a), t)));
      }
    }
    // Points just in front of the near plane land millions of pixels away; canvas drops such
    // paths. Clip to a generous rectangle around the viewport so shapes stay exact on screen.
    const { width, height } = this.viewport;
    const m = Math.max(width, height);
    return clipToRect(out.map((c) => this.toScreen(c, 0)), -m, -m, width + m, height + m);
  }

  /** Unit ENU direction of the ray through a screen point. */
  rayAt(x: number, y: number): Vec3 {
    const { f, r, u } = this.cam;
    return unit(add(add(f, scale(r, (x - this.cx) / this.focalPx)), scale(u, (this.cy - y) / this.focalPx)));
  }

  /**
   * Geographic point where the ray through (x, y) meets the cloud surface at `heightM`
   * (same datum as the projection origin). Null when the ray never reaches that height
   * or lands beyond `maxRangeM` of ground distance.
   */
  unproject(x: number, y: number, heightM: number, maxRangeM = 60000): Anchor | null {
    if (x < 0 || y < 0 || x > this.viewport.width || y > this.viewport.height) return null;
    const d = this.rayAt(x, y);
    if (heightM > this.viewerHeightM && d[2] <= 0) return null;
    const { e, n, u } = this.enu;
    const dirEcef = unit(add(add(scale(e, d[0]), scale(n, d[1])), scale(u, d[2])));
    const heightAt = (t: number) => fromEcef(add(this.origin, scale(dirEcef, t))).height;
    const above = heightM > this.viewerHeightM;
    let lo = 0;
    let hi = 400000;
    if ((heightAt(hi) - heightM) * (above ? 1 : -1) < 0) return null;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if ((heightAt(mid) - heightM) * (above ? 1 : -1) < 0) lo = mid;
      else hi = mid;
    }
    const hit = fromEcef(add(this.origin, scale(dirEcef, hi)));
    const anchor = { longitude: hit.longitude, latitude: hit.latitude };
    if (groundDistanceM({ longitude: this.pose.longitude, latitude: this.pose.latitude }, anchor) > maxRangeM) {
      return null;
    }
    return anchor;
  }
}

/** Sutherland–Hodgman clip of a polygon against an axis-aligned rectangle. */
export function clipToRect(poly: { x: number; y: number }[], x0: number, y0: number, x1: number, y1: number) {
  type P = { x: number; y: number };
  const edges: [(p: P) => boolean, (a: P, b: P) => P][] = [
    [(p) => p.x >= x0, (a, b) => ({ x: x0, y: a.y + ((b.y - a.y) * (x0 - a.x)) / (b.x - a.x) })],
    [(p) => p.x <= x1, (a, b) => ({ x: x1, y: a.y + ((b.y - a.y) * (x1 - a.x)) / (b.x - a.x) })],
    [(p) => p.y >= y0, (a, b) => ({ x: a.x + ((b.x - a.x) * (y0 - a.y)) / (b.y - a.y), y: y0 })],
    [(p) => p.y <= y1, (a, b) => ({ x: a.x + ((b.x - a.x) * (y1 - a.y)) / (b.y - a.y), y: y1 })],
  ];
  let out = poly;
  for (const [inside, cut] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i]!;
      const b = input[(i + 1) % input.length]!;
      if (inside(a)) out.push(a);
      if (inside(a) !== inside(b)) out.push(cut(a, b));
    }
    if (!out.length) break;
  }
  return out;
}

/** Ray-casting point-in-polygon in screen space. */
export function screenPolygonContains(poly: { x: number; y: number }[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
