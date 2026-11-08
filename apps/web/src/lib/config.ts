/** Public runtime configuration. Live and replay datasets never share an ID. */
export const config = {
  datasetId: process.env.NEXT_PUBLIC_DRIFT_DATASET_ID ?? "fx-scattered",
  /** Fixture/replay datasets start with fx- or end with -demo; they are always labeled synthetic. */
  isSyntheticDataset(id: string) {
    return id.startsWith("fx-") || id.endsWith("-demo");
  },
  /** Simulated viewer for fixture clouds around Troy (RPI campus). */
  simulatedViewer: { longitude: -73.6788, latitude: 42.7302 },
} as const;
