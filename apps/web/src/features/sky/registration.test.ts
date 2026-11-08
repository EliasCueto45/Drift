import { describe, expect, it } from "vitest";
import { SkyProjection, type CameraPose } from "./projection";
import { acceptShift, bestShift, cloudiness, correctionFromShift, frameUsable, rasterize, segmentFrame } from "./registration";

const SKY: [number, number, number] = [90, 140, 220];
const CLOUD: [number, number, number] = [225, 228, 232];

function frame(w: number, h: number, isCloud: (x: number, y: number) => boolean, dark = false) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = dark ? [10, 12, 20] : isCloud(x, y) ? CLOUD : SKY;
      px.set([c[0]!, c[1]!, c[2]!, 255], (y * w + x) * 4);
    }
  return px;
}

const square = (x0: number, y0: number, s: number) => [
  [
    { x: x0, y: y0 },
    { x: x0 + s, y: y0 },
    { x: x0 + s, y: y0 + s },
    { x: x0, y: y0 + s },
  ],
];

describe("cloudiness", () => {
  it("separates blue sky, cloud, night and glare", () => {
    expect(cloudiness(...SKY)).toBe(0);
    expect(cloudiness(...CLOUD)).toBe(1);
    expect(cloudiness(10, 12, 20)).toBeNull();
    expect(cloudiness(255, 255, 255)).toBeNull();
  });
});

describe("registration", () => {
  const w = 80;
  const h = 100;
  // Real cloud: a 20 px square at (40, 30).
  const mask = segmentFrame(frame(w, h, (x, y) => x >= 40 && x < 60 && y >= 30 && y < 50), w, h);

  it("measures sky and cloud fractions", () => {
    expect(mask.validFraction).toBe(1);
    expect(mask.cloudFraction).toBeCloseTo(400 / 8000, 3);
    expect(frameUsable(mask)).toBeNull();
  });

  it("finds the shift that moves the tracked outline onto the visible cloud", () => {
    // Tracked outline drawn 7 px left and 4 px below the real cloud.
    const model = rasterize(square(33, 34, 20), w, h);
    const r = bestShift(mask, model, 15, 10)!;
    expect(r.dx).toBe(7);
    expect(r.dy).toBe(-4);
    expect(r.score).toBeGreaterThan(0.9);
    expect(acceptShift(r)).toBe(true);
  });

  it("does not move when the outline already matches", () => {
    const r = bestShift(mask, rasterize(square(40, 30, 20), w, h), 15, 10)!;
    expect([r.dx, r.dy]).toEqual([0, 0]);
    expect(acceptShift(r)).toBe(false); // no gain over the current pose
  });

  it("switches off at night and in overcast", () => {
    expect(frameUsable(segmentFrame(frame(w, h, () => false, true), w, h))).toBe("no-sky");
    expect(frameUsable(segmentFrame(frame(w, h, () => true), w, h))).toBe("no-contrast");
  });
});

describe("correctionFromShift", () => {
  it("turns the camera left when the overlay must move right", () => {
    const pose: CameraPose = { longitude: -73.68, latitude: 42.73, heightM: 0, heightReference: "unknown", azimuthDeg: 90, elevationDeg: 30, rollDeg: 0, hfovDeg: 60, source: "simulated" };
    const p = new SkyProjection(pose, { width: 400, height: 600 }, 0);
    const shift = p.focalPx * Math.tan(5 * (Math.PI / 180));
    const c = correctionFromShift((x, y) => p.rayAt(x, y), { x: 200, y: 300 }, { x: 200 + shift, y: 300 });
    // Moving content right on screen = the true heading is further left than the compass says.
    expect(c.dAzDeg).toBeLessThan(0);
    expect(Math.abs(c.dAzDeg)).toBeGreaterThan(4);
    expect(Math.abs(c.dElDeg)).toBeLessThan(1.5);
  });
});
