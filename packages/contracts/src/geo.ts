// Shared geo + wind conventions. Owner 3 mirrors these in Python; both are checked
// against fixtures/wind-cases.json so the two languages cannot drift apart.
const R = 6371008.8; // mean Earth radius, meters
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Meteorological wind: `fromDeg` is where wind comes FROM, clockwise from true north. */
export function windToUV(speedMps: number, fromDeg: number): { uMps: number; vMps: number } {
  const t = rad(fromDeg);
  return { uMps: -speedMps * Math.sin(t), vMps: -speedMps * Math.cos(t) };
}

/** Small-displacement move on a sphere. Meters never get added to degrees directly. */
export function displaceMeters(
  p: { longitude: number; latitude: number },
  eastM: number,
  northM: number,
): { longitude: number; latitude: number } {
  const dLat = northM / R;
  const dLon = eastM / (R * Math.cos(rad(p.latitude)));
  return { longitude: p.longitude + deg(dLon), latitude: p.latitude + deg(dLat) };
}

/** Great-circle (haversine) distance in meters. */
export function haversineM(
  a: { longitude: number; latitude: number },
  b: { longitude: number; latitude: number },
): number {
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
