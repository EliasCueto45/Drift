/** Keep the estimate coarse: satellite tracking is not precise to individual meters. */
export function driftDistanceText(meters: number | null | undefined): string {
  if (meters == null || !Number.isFinite(meters) || meters < 0) return "drift distance unavailable";
  if (meters === 0) return "drifted from 0 km away";
  if (meters < 100) return "drifted from less than 0.1 km away";
  const km = meters / 1000;
  return `drifted from ${km < 10 ? Number(km.toFixed(1)) : Math.round(km)} km away`;
}
