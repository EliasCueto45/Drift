import { describe, expect, it } from "vitest";
import { DISCOVERY_RADIUS_M, placementInRange } from "./discovery";
import { groundDistanceM } from "./geo";

const campus = { longitude: -73.6788, latitude: 42.7302 };
const northOfCampus = (meters: number) => ({
  longitude: campus.longitude,
  latitude: campus.latitude + (meters / 6371008.8) * (180 / Math.PI),
});

describe("phone placement/discovery range", () => {
  it("includes a persisted post 25.41 km away in the phone discovery radius", () => {
    const anchor = northOfCampus(25410.85);
    expect(groundDistanceM(campus, anchor)).toBeGreaterThan(25000);
    expect(placementInRange(campus, anchor)).toBe(true);
    expect(groundDistanceM(campus, anchor)).toBeLessThan(DISCOVERY_RADIUS_M);
  });

  it("rejects distant taps on a broad overcast cloud, including after the viewer moves", () => {
    const anchor = northOfCampus(49999);
    expect(placementInRange(campus, anchor)).toBe(true);
    expect(placementInRange(northOfCampus(-10), anchor)).toBe(false);
    expect(placementInRange(campus, northOfCampus(50001))).toBe(false);
  });

  it("rejects an invalid location instead of publishing an undiscoverable anchor", () => {
    expect(placementInRange(campus, { longitude: NaN, latitude: 42 })).toBe(false);
  });
});
