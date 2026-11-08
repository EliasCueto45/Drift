import { describe, expect, it } from "vitest";
import { MAX_ZOOM, MIN_ZOOM, focusTransform, ringsRect } from "./focusGeometry";

const view = { width: 400, height: 800 };

describe("focusTransform", () => {
  it("scales a small cloud up until it covers the screen", () => {
    const t = focusTransform(view, { x: 150, y: 300, width: 200, height: 250 });
    expect(t.scale).toBeCloseTo(3.2);
  });

  it("keeps the zoom between the limits", () => {
    expect(focusTransform(view, { x: 0, y: 0, width: 400, height: 800 }).scale).toBe(MIN_ZOOM);
    expect(focusTransform(view, { x: 200, y: 400, width: 10, height: 10 }).scale).toBe(MAX_ZOOM);
  });

  it("never shows an edge of the frozen frame", () => {
    const t = focusTransform(view, { x: 0, y: 0, width: 60, height: 60 });
    expect(t.tx).toBeLessThanOrEqual(0);
    expect(t.ty).toBeLessThanOrEqual(0);
    expect(t.tx + t.scale * view.width).toBeGreaterThanOrEqual(view.width);
    expect(t.ty + t.scale * view.height).toBeGreaterThanOrEqual(view.height);
  });

  it("centres on the tapped point when given one", () => {
    const t = focusTransform(view, { x: 100, y: 200, width: 200, height: 200 }, { x: 200, y: 400 });
    expect(t.tx + t.scale * 200).toBeCloseTo(200);
    expect(t.ty + t.scale * 400).toBeCloseTo(400);
  });
});

describe("ringsRect", () => {
  it("bounds the rings, clipped to the view", () => {
    expect(ringsRect([[{ x: -20, y: 100 }, { x: 120, y: 50 }, { x: 60, y: 900 }]], view)).toEqual({ x: 0, y: 50, width: 120, height: 750 });
  });
  it("is null off screen", () => {
    expect(ringsRect([[{ x: -50, y: -50 }, { x: -10, y: -10 }]], view)).toBeNull();
  });
});
