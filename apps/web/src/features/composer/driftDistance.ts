/** Keep the estimate coarse: satellite tracking is not precise to individual meters. */
export function driftDistanceText(meters: number | null | undefined): string {
  if (meters == null || !Number.isFinite(meters) || meters < 0) return "drift unavailable";
  if (meters < 100) return "drifted <100 m";
  if (meters < 1000) return `drifted ~${Math.floor(meters / 100) * 100} m`;
  const km = meters / 1000;
  return `drifted ~${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}
