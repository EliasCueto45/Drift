import { expect, it } from "vitest";
import { driftDistanceText } from "./driftDistance";

it.each([
  [0, "drifted from 0 km away"], [99, "drifted from less than 0.1 km away"],
  [760, "drifted from 0.8 km away"], [999, "drifted from 1 km away"],
  [1000, "drifted from 1 km away"], [1234, "drifted from 1.2 km away"],
  [5000, "drifted from 5 km away"], [25000, "drifted from 25 km away"],
  [100000, "drifted from 100 km away"], [17300, "drifted from 17 km away"],
  [null, "drift distance unavailable"], [undefined, "drift distance unavailable"],
  [NaN, "drift distance unavailable"], [-1, "drift distance unavailable"],
])("formats tracked drift %s without implying satellite-level precision", (meters, label) => {
  expect(driftDistanceText(meters)).toBe(label);
});
