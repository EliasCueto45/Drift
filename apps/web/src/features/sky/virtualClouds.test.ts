import { describe, expect, it } from "vitest";
import type { CloudWithPreviews, Message } from "@/lib/contracts";
import { directionTo } from "./geo";
import type { CameraPose } from "./projection";
import { buildScene } from "./scene";
import { hashSeed, layoutVirtualClouds, spriteChoice } from "./virtualClouds";

const VIEW = { width: 390, height: 844 };
const viewer = { longitude: -73.6788, latitude: 42.7302 };

function box(id: string, lng: number, lat: number, d: number, posts: { id: string; lng: number; lat: number }[] = []): CloudWithPreviews {
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
    previews: posts.map((p) => ({ id: p.id, cloudId: id, anchor: { longitude: p.lng, latitude: p.lat }, voteCount: 0 }) as unknown as Message) as CloudWithPreviews["previews"],
  };
}

function lookAt(lng: number, lat: number): CameraPose {
  const d = directionTo({ ...viewer, height: 0 }, { longitude: lng, latitude: lat, height: 2000 });
  return { ...viewer, heightM: 0, heightReference: "unknown", azimuthDeg: d.azimuthDeg, elevationDeg: d.elevationDeg, rollDeg: 0, hfovDeg: 60, source: "simulated" };
}

describe("layoutVirtualClouds", () => {
  it("draws one cloud per tracked cloud, centred on its footprint", () => {
    const c = box("cld_a", -73.68, 42.78, 0.01);
    const scene = buildScene([c], lookAt(-73.68, 42.78), VIEW, "live");
    const v = layoutVirtualClouds(scene.clouds, scene.projection, VIEW);
    expect(v).toHaveLength(1);
    expect(v[0]!.x).toBeCloseTo(VIEW.width / 2, -1);
    expect(v[0]!.seed).toBe(hashSeed("cld_a"));
  });

  it("adds a small cloud under a post that falls outside the photo", () => {
    // A long footprint (clamped photo size): three posts near the centre and an outlier far east.
    const c = box("cld_b", -73.68, 42.82, 0.08, [
      { id: "near1", lng: -73.68, lat: 42.82 },
      { id: "near2", lng: -73.681, lat: 42.821 },
      { id: "near3", lng: -73.679, lat: 42.819 },
      { id: "far", lng: -73.61, lat: 42.82 },
    ]);
    const scene = buildScene([c], lookAt(-73.68, 42.82), { width: 2000, height: 844 }, "live");
    const v = layoutVirtualClouds(scene.clouds, scene.projection, { width: 2000, height: 844 });
    expect(v.map((x) => x.seed)).toEqual([hashSeed("cld_b"), hashSeed("far")]);
  });
});

describe("spriteChoice", () => {
  it("is stable for the same cloud", () => {
    expect(spriteChoice(hashSeed("cld_a"), 2)).toEqual(spriteChoice(hashSeed("cld_a"), 2));
    expect(spriteChoice(123, 0).index).toBe(0);
  });
});
