import { expect, it } from "vitest";
import { driftDistanceText } from "./driftDistance";

it.each([
  [0, "drifted <100 m"], [99, "drifted <100 m"],
  [760, "drifted ~700 m"], [999, "drifted ~900 m"],
  [1000, "drifted ~1.0 km"], [1234, "drifted ~1.2 km"],
  [17300, "drifted ~17 km"],
  [null, "drift unavailable"], [undefined, "drift unavailable"],
  [NaN, "drift unavailable"], [-1, "drift unavailable"],
])("formats tracked drift %s without implying satellite-level precision", (meters, label) => {
  expect(driftDistanceText(meters)).toBe(label);
});
