import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { indoorProbability, softmax, topScenes } from "./sceneClassifier";
import { isDaylight, outdoorScore, sunElevationDeg, VisibilityTracker } from "./visibility";

const TROY = { lat: 42.7302, lon: -73.6788 };

describe("sunElevationDeg", () => {
  it("is ~70° at solar noon on the June solstice in Troy", () => {
    // Solar noon in Troy is about 16:53 UTC in late June.
    const e = sunElevationDeg(new Date("2026-06-21T16:53:00Z"), TROY.lat, TROY.lon);
    expect(e).toBeGreaterThan(69.5);
    expect(e).toBeLessThan(71);
  });

  it("is well below the horizon at local midnight", () => {
    expect(sunElevationDeg(new Date("2026-11-08T05:00:00Z"), TROY.lat, TROY.lon)).toBeLessThan(-30);
  });

  it("is near zero around a known sunset (Troy, 2026-11-08 ~16:40 EST)", () => {
    expect(Math.abs(sunElevationDeg(new Date("2026-11-08T21:40:00Z"), TROY.lat, TROY.lon))).toBeLessThan(2);
  });
});

describe("isDaylight", () => {
  it("holds its state inside the dusk band", () => {
    expect(isDaylight(-6.5, true)).toBe(true);
    expect(isDaylight(-6.5, false)).toBe(false);
    expect(isDaylight(-8, true)).toBe(false);
    expect(isDaylight(-4, false)).toBe(true);
  });
});

describe("indoor/outdoor from the scene classifier", () => {
  it("sums the indoor categories of the softmax", () => {
    const probs = softmax([2, 0, 1, -1]);
    expect(probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    // Categories 0 and 2 indoor (classroom, kitchen), 1 and 3 outdoor (sky, beach).
    expect(indoorProbability(probs, [1, 0, 1, 0])).toBeCloseTo(probs[0]! + probs[2]!, 9);
    expect(topScenes(probs, ["classroom", "sky", "kitchen", "beach"], 2).map((t) => t.name)).toEqual(["classroom", "kitchen"]);
  });

  it("uses the official indoor/outdoor labels (public/models/places365-io.json)", () => {
    const labels = JSON.parse(readFileSync(join(__dirname, "../../../public/models/places365-io.json"), "utf8")) as { indoor: number[]; names: string[] };
    expect(labels.indoor).toHaveLength(365);
    const flag = (name: string) => labels.indoor[labels.names.indexOf(name)];
    expect(flag("classroom")).toBe(1);
    expect(flag("kitchen")).toBe(1);
    expect(flag("beach")).toBe(0);
    expect(flag("sky")).toBe(0);
  });

  it("maps P(indoor) to an outdoor score", () => {
    expect(outdoorScore(null)).toBeNull();
    expect(outdoorScore(0.96)).toBeCloseTo(-0.92, 9);
    expect(outdoorScore(0)).toBe(1);
  });
});

describe("VisibilityTracker", () => {
  const noon = 40;
  it("hides clouds immediately at night", () => {
    expect(new VisibilityTracker().update(0, -20, 0.8)).toEqual({ state: "hidden", reason: "night" });
  });

  it("switches indoors only after sustained evidence", () => {
    const t = new VisibilityTracker();
    let s = t.update(0, noon, null);
    expect(s.state).toBe("visible");
    // A one-second blip of indoor evidence does not switch.
    for (let ms = 500; ms <= 1500; ms += 500) s = t.update(ms, noon, -1);
    for (let ms = 2000; ms <= 8000; ms += 500) s = t.update(ms, noon, 0.8);
    expect(s.state).toBe("visible");
    // Sustained indoor evidence does.
    for (let ms = 8500; ms <= 20000; ms += 500) s = t.update(ms, noon, -1);
    expect(s).toEqual({ state: "hidden", reason: "indoors" });
  });
});
