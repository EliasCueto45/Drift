import { describe, expect, it } from "vitest";
import { directionTo, groundDistanceM, multiPolygonContains } from "./geo";
import {
  SkyProjection,
  anglesFromBasis,
  cameraBasis,
  cloudHeight,
  resolveHeights,
  screenPolygonContains,
  type CameraPose,
} from "./projection";

// Expected values computed with Owner 3's reference implementation
// services/cloud-worker/cloud_worker/altitude.py::direction_to_cloud (pyproj ECEF/ENU).
const REFERENCE = [
  { viewer: [-73.68, 42.73, 100], cloud: [-73.67, 42.73, 2100], az: 89.99660727814461, el: 67.72448154973331, d: 2161.2367602031986 },
  { viewer: [-73.6788, 42.7302, 0], cloud: [-73.765256, 42.7284, 2000], az: 268.41171103303367, el: 15.732934498437784, d: 7361.400491548508 },
  { viewer: [-73.6788, 42.7302, 0], cloud: [-73.667315, 42.773366, 2000], az: 11.090038304729127, el: 22.2335479255988, d: 5280.693701424164 },
  { viewer: [-73.6788, 42.7302, 30], cloud: [-73.2, 43.1, 9000], az: 43.41815236939683, el: 8.726926109443616, d: 57455.37064046161 },
] as const;

const at = ([longitude, latitude, height]: readonly number[]) => ({
  longitude: longitude!,
  latitude: latitude!,
  height: height!,
});

const TROY = { longitude: -73.6788, latitude: 42.7302 };
const VIEW = { width: 390, height: 844 };

function pose(overrides: Partial<CameraPose> = {}): CameraPose {
  return {
    ...TROY,
    heightM: 0,
    heightReference: "unknown",
    azimuthDeg: 0,
    elevationDeg: 20,
    rollDeg: 0,
    hfovDeg: 40,
    source: "simulated",
    ...overrides,
  };
}

describe("directionTo matches cloud_worker.altitude reference cases", () => {
  it("overhead cloud is at 90 degrees elevation, 2000 m away", () => {
    const r = directionTo(at([-73.68, 42.73, 100]), at([-73.68, 42.73, 2100]));
    expect(r.elevationDeg).toBeCloseTo(90, 6);
    expect(r.distanceM).toBeCloseTo(2000, 3);
  });

  it.each(REFERENCE)("azimuth/elevation/distance for $cloud", ({ viewer, cloud, az, el, d }) => {
    const r = directionTo(at(viewer), at(cloud));
    expect(r.azimuthDeg).toBeCloseTo(az, 6);
    expect(r.elevationDeg).toBeCloseTo(el, 6);
    expect(r.distanceM).toBeCloseTo(d, 2);
  });
});

describe("SkyProjection", () => {
  it("puts a cloud the camera points at in the screen center", () => {
    const target = { longitude: -73.667315, latitude: 42.773366 };
    const dir = directionTo({ ...TROY, height: 0 }, { ...target, height: 2000 });
    const p = new SkyProjection(pose({ azimuthDeg: dir.azimuthDeg, elevationDeg: dir.elevationDeg }), VIEW);
    const s = p.project(target, 2000)!;
    expect(s.x).toBeCloseTo(VIEW.width / 2, 6);
    expect(s.y).toBeCloseTo(VIEW.height / 2, 6);
    expect(s.distanceM).toBeCloseTo(dir.distanceM, 3);
  });

  it("returns null behind the camera and off screen, but projectUnclipped keeps off-screen points", () => {
    const north = { longitude: TROY.longitude, latitude: TROY.latitude + 0.05 };
    const facingSouth = new SkyProjection(pose({ azimuthDeg: 180 }), VIEW);
    expect(facingSouth.project(north, 2000)).toBeNull();
    expect(facingSouth.projectUnclipped(north, 2000)).toBeNull();

    const facingEast = new SkyProjection(pose({ azimuthDeg: 70 }), VIEW);
    expect(facingEast.project(north, 2000)).toBeNull();
    const loose = facingEast.projectUnclipped(north, 2000)!;
    expect(loose.x).toBeLessThan(0);
  });

  it("east of center appears right; higher appears up", () => {
    const p = new SkyProjection(pose({ azimuthDeg: 0, elevationDeg: 20 }), VIEW);
    const ne = p.project({ longitude: TROY.longitude + 0.01, latitude: TROY.latitude + 0.05 }, 2000)!;
    expect(ne.x).toBeGreaterThan(VIEW.width / 2);
    const high = p.project({ longitude: TROY.longitude, latitude: TROY.latitude + 0.03 }, 2000)!;
    const low = p.project({ longitude: TROY.longitude, latitude: TROY.latitude + 0.08 }, 2000)!;
    expect(high.y).toBeLessThan(low.y);
  });

  it("rolling the phone clockwise rotates the sky counterclockwise on screen", () => {
    const target = { longitude: TROY.longitude, latitude: TROY.latitude + 0.03 };
    const level = new SkyProjection(pose({ elevationDeg: 10 }), VIEW).project(target, 2000)!;
    expect(level.y).toBeLessThan(VIEW.height / 2);
    const rolled = new SkyProjection(pose({ elevationDeg: 10, rollDeg: 90 }), VIEW).projectUnclipped(target, 2000)!;
    expect(rolled.x).toBeLessThan(VIEW.width / 2);
    expect(rolled.y).toBeCloseTo(VIEW.height / 2, 6);
  });

  it("unproject inverts project at the cloud height (tap -> anchor)", () => {
    // el 40 keeps the bottom edge (~27 degrees below center) above the horizon.
    const p = new SkyProjection(pose({ azimuthDeg: 300, elevationDeg: 40, rollDeg: -7 }), VIEW);
    for (const [x, y] of [[195, 422], [40, 100], [350, 700], [10, 400]] as const) {
      const anchor = p.unproject(x, y, 2000);
      expect(anchor).not.toBeNull();
      const back = p.project(anchor!, 2000)!;
      expect(back.x).toBeCloseTo(x, 3);
      expect(back.y).toBeCloseTo(y, 3);
    }
  });

  it("unproject returns null below the horizon, beyond range, and off canvas", () => {
    const p = new SkyProjection(pose({ elevationDeg: 0 }), VIEW);
    expect(p.unproject(195, 800, 2000)).toBeNull(); // below horizon
    expect(p.unproject(195, 423, 2000)).toBeNull(); // grazing the horizon: far beyond range
    expect(p.unproject(-1, 10, 2000)).toBeNull();
  });

  it("works looking straight up (zenith)", () => {
    const p = new SkyProjection(pose({ elevationDeg: 90 }), VIEW);
    const overhead = p.project(TROY, 2000)!;
    expect(overhead.x).toBeCloseTo(VIEW.width / 2, 6);
    expect(overhead.y).toBeCloseTo(VIEW.height / 2, 6);
    const anchor = p.unproject(VIEW.width / 2, VIEW.height / 2, 2000)!;
    expect(groundDistanceM(anchor, TROY)).toBeLessThan(0.01);
  });

  it("clips rings that wrap behind the viewer", () => {
    const p = new SkyProjection(pose({ azimuthDeg: 0, elevationDeg: 30 }), VIEW);
    // The center ray meets the 2 km plane ~3.5 km north, so the ring must reach past that.
    const d = 0.05;
    const around = [
      [TROY.longitude - d, TROY.latitude - d],
      [TROY.longitude + d, TROY.latitude - d],
      [TROY.longitude + d, TROY.latitude + d],
      [TROY.longitude - d, TROY.latitude + d],
      [TROY.longitude - d, TROY.latitude - d],
    ];
    const screen = p.projectRing(around, 2000);
    expect(screen.length).toBeGreaterThanOrEqual(3);
    expect(screen.every((s) => Number.isFinite(s.x) && Number.isFinite(s.y))).toBe(true);
    expect(screenPolygonContains(screen, VIEW.width / 2, VIEW.height / 2)).toBe(true);
  });
});

describe("pose angles", () => {
  it.each([
    [0, 0, 0],
    [123, 35, 12],
    [300, 70, -40],
    [45, -10, 170],
  ])("cameraBasis -> anglesFromBasis round trip az=%d el=%d roll=%d", (az, el, roll) => {
    const { f, u } = cameraBasis(az, el, roll);
    const back = anglesFromBasis(f, u);
    expect(back.azimuthDeg).toBeCloseTo(az, 6);
    expect(back.elevationDeg).toBeCloseTo(el, 6);
    expect(back.rollDeg).toBeCloseTo(roll, 6);
  });
});

describe("cloud heights", () => {
  const wind = { uMps: 10, vMps: 0, altitudeM: 3500, source: "x", validAt: "2026-01-01T00:00:00Z", confidence: 1 };

  it("prefers canonical altitude, then wind layer, then 2000 m", () => {
    const measured = { meters: 1800, reference: "wgs84_ellipsoid", source: "s", estimated: false, measuredFraction: 1, parallaxCorrected: true } as const;
    expect(cloudHeight({ wind, altitude: measured })).toEqual({ meters: 1800, reference: "wgs84_ellipsoid", estimated: false });
    expect(cloudHeight({ wind })).toEqual({ meters: 3500, reference: "unknown", estimated: true });
    expect(cloudHeight({ wind: { ...wind, altitudeM: Number.NaN } })).toEqual({ meters: 2000, reference: "unknown", estimated: true });
  });

  it("never mixes datums", () => {
    expect(resolveHeights({ heightM: 120, heightReference: "wgs84_ellipsoid" }, 2000, "mean_sea_level")).toEqual({ viewerM: 0, targetM: 2000, estimated: true });
    expect(resolveHeights({ heightM: 120, heightReference: "wgs84_ellipsoid" }, 2000, "wgs84_ellipsoid")).toEqual({ viewerM: 120, targetM: 2000, estimated: false });
    expect(resolveHeights({ heightM: 0, heightReference: "unknown" }, 2000, "unknown").estimated).toBe(true);
  });
});

describe("geo containment", () => {
  it("handles holes", () => {
    const outer = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    const hole = [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]];
    expect(multiPolygonContains([[outer, hole]], { longitude: 2, latitude: 2 })).toBe(true);
    expect(multiPolygonContains([[outer, hole]], { longitude: 5, latitude: 5 })).toBe(false);
  });
});
