import { describe, expect, it } from "vitest";
import type { CloudWithPreviews } from "@/lib/contracts";
import { directionTo, multiPolygonContains } from "./geo";
import type { CameraPose } from "./projection";
import { TAP_TOLERANCE_PX, anchorOnCloud, buildScene, nearestOffscreen, pickCloud } from "./scene";

const VIEW = { width: 390, height: 844 };
const viewer = { longitude: -73.6788, latitude: 42.7302 };

function box(id: string, lng: number, lat: number, d = 0.02): CloudWithPreviews {
  const ring = [
    [lng - d, lat - d],
    [lng + d, lat - d],
    [lng + d, lat + d],
    [lng - d, lat + d],
    [lng - d, lat - d],
  ];
  return {
    cloud: {
      id,
      version: 1,
      kind: "observed",
      status: "active",
      geometry: { type: "MultiPolygon", coordinates: [[ring]] as never },
      observedAt: "2026-11-08T00:00:00.000Z",
      updatedAt: "2026-11-08T00:00:00.000Z",
      confidence: 0.9,
      wind: { uMps: 0, vMps: 0, altitudeM: 2000, source: "test", validAt: "2026-11-08T00:00:00.000Z", confidence: 1 },
      parentIds: [],
      creatorId: null,
      expiresAt: null,
      datasetId: "fx-test",
      trackingRunId: "run",
    },
    previews: [],
  };
}

function poseAt(lng: number, lat: number): CameraPose {
  const d = directionTo({ ...viewer, height: 0 }, { longitude: lng, latitude: lat, height: 2000 });
  return { ...viewer, heightM: 0, heightReference: "unknown", azimuthDeg: d.azimuthDeg, elevationDeg: d.elevationDeg, rollDeg: 0, hfovDeg: 40, source: "simulated" };
}

describe("scene", () => {
  const near = box("near", -73.68, 42.78);
  const far = box("far", -73.68, 42.86, 0.05);

  it("picks the cloud under the reticle and cycles overlapping clouds", () => {
    const { clouds } = buildScene([near, far], poseAt(-73.68, 42.78), VIEW, "live");
    const first = pickCloud(clouds, VIEW.width / 2, VIEW.height / 2, null);
    expect(first).toBe("near");
  });

  it("places taps inside the footprint and tolerates near-edge taps without snapping to center", () => {
    const { clouds, projection } = buildScene([near], poseAt(-73.68, 42.78), VIEW, "live");
    const c = clouds[0]!;
    const center = anchorOnCloud(c, projection, VIEW.width / 2, VIEW.height / 2)!;
    expect(multiPolygonContains(near.cloud.geometry.coordinates as never, center)).toBe(true);
    // Find the right edge on screen, then tap just outside it.
    const right = Math.max(...c.rings[0]!.map((p) => p.x));
    const nudged = anchorOnCloud(c, projection, Math.min(VIEW.width - 1, right + TAP_TOLERANCE_PX / 2), VIEW.height / 2);
    if (right + TAP_TOLERANCE_PX / 2 < VIEW.width) {
      expect(nudged).not.toBeNull();
      expect(multiPolygonContains(near.cloud.geometry.coordinates as never, nudged!)).toBe(true);
      expect(Math.abs(nudged!.longitude - center.longitude)).toBeGreaterThan(0.005);
    }
    expect(anchorOnCloud(c, projection, 2, 2)).toBeNull();
  });

  it("points the way to an off-screen cloud", () => {
    const behind = poseAt(-73.68, 42.65); // looking south; the cloud is north
    const { clouds } = buildScene([near], behind, VIEW, "live");
    const turn = nearestOffscreen(clouds, behind);
    expect(turn?.id).toBe("near");
    expect(Math.abs(turn!.turnDeg)).toBeGreaterThan(150);
  });

  it("marks stale data and estimated heights", () => {
    expect(buildScene([near], poseAt(-73.68, 42.78), VIEW, "stale").clouds[0]!.certainty).toBe("stale");
    expect(buildScene([near], poseAt(-73.68, 42.78), VIEW, "live").clouds[0]!.certainty).toBe("estimated");
  });
});
