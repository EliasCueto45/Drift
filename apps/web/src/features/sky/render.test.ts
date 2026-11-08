import { describe, expect, it } from "vitest";
import type { Message } from "@/lib/contracts";
import { layoutPosts } from "./render";
import type { SceneCloud } from "./scene";

// Minimal 2D context: layout only measures text (10px per character).
const ctx = { font: "", measureText: (t: string) => ({ width: t.length * 10 }) } as unknown as CanvasRenderingContext2D;
const VIEW = { width: 390, height: 844 };

function msg(id: string, body: string, votes = 0): Message {
  return {
    id, version: 1, cloudId: "c", authorId: "u", kind: "text", anchor: { longitude: 0, latitude: 0 },
    createdAt: "2026-11-08T00:00:00.000Z", updatedAt: "2026-11-08T00:00:00.000Z", expiredAt: null,
    voteCount: votes, viewerHasUpvoted: false, body, assetId: null, songUrl: null, artworkTransform: null,
  };
}

function cloud(posts: { m: Message; x: number; y: number }[]): SceneCloud {
  return {
    id: "c", item: {} as SceneCloud["item"], heightM: 2000, certainty: "measured", rings: [], top: null,
    distanceM: 5000, azimuthDeg: 0, elevationDeg: 20, visible: true,
    posts: posts.map((p) => ({ message: p.m, x: p.x, y: p.y, onScreen: true })),
  };
}

const opts = { selectedId: null, viewport: VIEW, votes: (_: string, v: number) => v };

describe("layoutPosts", () => {
  it("drops posts that would cover the draft being written", () => {
    const c = cloud([{ m: msg("a", "existing post"), x: 200, y: 300 }]);
    expect(layoutPosts(ctx, [c], opts).map((p) => p.id)).toEqual(["a"]);
    const reserved = [{ x: 205, y: 305, width: 120, height: 30 }];
    expect(layoutPosts(ctx, [c], { ...opts, reserved })).toEqual([]);
  });

  it("keeps the higher-voted of two overlapping posts, and a just-published one wins", () => {
    const c = cloud([
      { m: msg("low", "hello there", 0), x: 200, y: 300 },
      { m: msg("high", "hello again", 5), x: 210, y: 305 },
    ]);
    expect(layoutPosts(ctx, [c], opts).map((p) => p.id)).toEqual(["high"]);
    expect(layoutPosts(ctx, [c], { ...opts, priorityId: "low" }).map((p) => p.id)).toEqual(["low"]);
  });

  it("leaves a label out of the sky rather than sliding it far off its spot", () => {
    const near = cloud([{ m: msg("edge", "short"), x: 30, y: 300 }]);
    expect(layoutPosts(ctx, [near], opts)).toHaveLength(1);
    const far = cloud([{ m: msg("edge", "a much longer post that would need sliding"), x: 4, y: 300 }]);
    expect(layoutPosts(ctx, [far], opts)).toHaveLength(0);
  });
});
