import { describe, expect, it } from "vitest";
import { alphaFromCompassHeading, deviceVectors, poseAngles, smoothVectors, visibleHfovDeg } from "./orientation";

const angles = (a: number, b: number, g: number, screen = 0, offset = 0) => poseAngles(deviceVectors(a, b, g, screen), offset);

describe("device orientation -> camera pose", () => {
  it("upright portrait phone with alpha 0 looks north at the horizon", () => {
    const p = angles(0, 90, 0);
    expect(p.azimuthDeg).toBeCloseTo(0, 6);
    expect(p.elevationDeg).toBeCloseTo(0, 6);
    expect(p.rollDeg).toBeCloseTo(0, 6);
  });

  it("alpha is counterclockwise: alpha 90 faces west", () => {
    expect(angles(90, 90, 0).azimuthDeg).toBeCloseTo(270, 6);
  });

  it("tilting the top away (beta > 90) raises the camera toward the sky", () => {
    expect(angles(0, 120, 0).elevationDeg).toBeCloseTo(30, 6);
  });

  it("flat on a table, screen up, the camera looks at the ground", () => {
    expect(angles(0, 0, 0).elevationDeg).toBeCloseTo(-90, 6);
  });

  it("iOS compass heading maps onto the same frame", () => {
    const p = angles(alphaFromCompassHeading(75), 100, 0);
    expect(p.azimuthDeg).toBeCloseTo(75, 6);
    expect(p.elevationDeg).toBeCloseTo(10, 6);
  });

  it("landscape (screen angle 90) keeps the horizon level", () => {
    // Device turned counterclockwise, back camera facing north at the horizon.
    const p = angles(0, 0, -90, 90);
    expect(p.elevationDeg).toBeCloseTo(0, 6);
    expect(Math.abs(p.rollDeg)).toBeLessThan(1e-6);
  });

  it("applies declination and nudge as a heading offset", () => {
    expect(angles(0, 90, 0, 0, -13).azimuthDeg).toBeCloseTo(347, 6);
  });

  it("smoothing converges and resets on large jumps", () => {
    const a = deviceVectors(0, 90, 0);
    const b = deviceVectors(350, 95, 0);
    let s = a;
    for (let i = 0; i < 60; i++) s = smoothVectors(s, b, 0.2);
    const p = poseAngles(s, 0);
    expect(p.azimuthDeg).toBeCloseTo(10, 3);
    const far = deviceVectors(180, 90, 0);
    expect(smoothVectors(a, far, 0.2)).toBe(far);
  });
});

describe("field of view", () => {
  it("cropping a 3:4 stream into a tall phone narrows the visible width", () => {
    const tall = visibleHfovDeg({ width: 390, height: 844 }, { width: 1080, height: 1440 });
    const exact = visibleHfovDeg({ width: 300, height: 400 }, { width: 1080, height: 1440 });
    expect(tall).toBeLessThan(exact);
    expect(exact).toBeGreaterThan(45);
    expect(exact).toBeLessThan(60);
    expect(tall).toBeGreaterThan(20);
  });
});
