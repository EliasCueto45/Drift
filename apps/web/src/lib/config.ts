/** Public runtime configuration. Live and replay datasets never share an ID. */
export const config = {
  /** Default: the live GOES satellite dataset. Fixtures stay reachable with ?dataset=fx-... */
  datasetId: process.env.NEXT_PUBLIC_DRIFT_DATASET_ID ?? "troy-live",
  /** Fixture/replay datasets start with fx- or end with -demo; they are always labeled synthetic. */
  isSyntheticDataset(id: string) {
    return id.startsWith("fx-") || id.endsWith("-demo");
  },
  /** Simulated viewer for fixture clouds around Troy (RPI campus). */
  simulatedViewer: { longitude: -73.6788, latitude: 42.7302 },
} as const;
