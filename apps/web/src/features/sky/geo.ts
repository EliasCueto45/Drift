/**
 * WGS84 geodesy for the AR projection. Mirrors cloud_worker.altitude.direction_to_cloud
 * (ECEF -> local East/North/Up). Positions use [longitude, latitude] and meters.
 */
import type { Anchor } from "@/lib/contracts";

export type Vec3 = [number, number, number];

const A = 6378137; // WGS84 semi-major axis
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
export const DEG = Math.PI / 180;

export function toEcef(longitude: number, latitude: number, height: number): Vec3 {
  const lon = longitude * DEG;
  const lat = latitude * DEG;
  const sinLat = Math.sin(lat);
  const n = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  return [
    (n + height) * Math.cos(lat) * Math.cos(lon),
    (n + height) * Math.cos(lat) * Math.sin(lon),
    (n * (1 - E2) + height) * sinLat,
  ];
}

/** Bowring's method; sub-millimeter for heights used here. */
export function fromEcef([x, y, z]: Vec3): { longitude: number; latitude: number; height: number } {
  const b = A * (1 - F);
  const ep2 = (A * A - b * b) / (b * b);
  const p = Math.hypot(x, y);
  const th = Math.atan2(z * A, p * b);
  const lat = Math.atan2(z + ep2 * b * Math.sin(th) ** 3, p - E2 * A * Math.cos(th) ** 3);
  const sinLat = Math.sin(lat);
  const n = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  const height = p / Math.cos(lat) - n;
  return { longitude: Math.atan2(y, x) / DEG, latitude: lat / DEG, height };
}

/** Rotation from ECEF deltas to local ENU at the given origin. */
export function enuBasis(longitude: number, latitude: number): { e: Vec3; n: Vec3; u: Vec3 } {
  const lon = longitude * DEG;
  const lat = latitude * DEG;
  return {
    e: [-Math.sin(lon), Math.cos(lon), 0],
    n: [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)],
    u: [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)],
  };
}

export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const unit = (a: Vec3): Vec3 => scale(a, 1 / (norm(a) || 1));
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Same output as the Python reference: azimuth from true north, elevation, slant distance. */
export function directionTo(
  viewer: { longitude: number; latitude: number; height: number },
  target: { longitude: number; latitude: number; height: number },
) {
  const o = toEcef(viewer.longitude, viewer.latitude, viewer.height);
  const t = toEcef(target.longitude, target.latitude, target.height);
  const d = sub(t, o);
  const { e, n, u } = enuBasis(viewer.longitude, viewer.latitude);
  const east = dot(d, e);
  const north = dot(d, n);
  const up = dot(d, u);
  const distanceM = Math.hypot(east, north, up);
  return {
    azimuthDeg: ((Math.atan2(east, north) / DEG) % 360 + 360) % 360,
    elevationDeg: Math.atan2(up, Math.hypot(east, north)) / DEG,
    distanceM,
  };
}

/** Great-circle ground distance (haversine, mean radius). */
export function groundDistanceM(a: Anchor, b: Anchor): number {
  const R = 6371008.8;
  const dLat = (b.latitude - a.latitude) * DEG;
  const dLon = (b.longitude - a.longitude) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * DEG) * Math.cos(b.latitude * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Ray-casting point-in-polygon on [lng, lat] rings (first ring outer, rest holes). */
export function polygonContains(rings: number[][][], p: Anchor): boolean {
  let inside = false;
  rings.forEach((ring, index) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i] as [number, number];
      const [xj, yj] = ring[j] as [number, number];
      if (yi > p.latitude !== yj > p.latitude && p.longitude < ((xj - xi) * (p.latitude - yi)) / (yj - yi) + xi) {
        hit = !hit;
      }
    }
    if (index === 0) inside = hit;
    else if (hit) inside = false;
  });
  return inside;
}

export function multiPolygonContains(coordinates: number[][][][], p: Anchor): boolean {
  return coordinates.some((polygon) => polygonContains(polygon, p));
}

export function ringCentroid(ring: number[][]): Anchor {
  let lng = 0;
  let lat = 0;
  const pts = ring.length > 1 ? ring.slice(0, -1) : ring;
  for (const [x, y] of pts as [number, number][]) {
    lng += x;
    lat += y;
  }
  return { longitude: lng / pts.length, latitude: lat / pts.length };
}
