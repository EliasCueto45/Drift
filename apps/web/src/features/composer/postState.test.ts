import { describe, expect, it } from "vitest";
import type { Message } from "@/lib/contracts";
import { reconcileCreated } from "./postState";
const message = (id: string, cloudId = "origin") =>
  ({
    id,
    cloudId,
    expiredAt: null,
    anchor: { longitude: -73, latitude: 42 },
    version: 1,
  }) as Message;

describe("post lifecycle reconciliation", () => {
  it("moves a post once, removes expired/held omissions and keeps unrelated unqueried posts", () => {
    const a = message("moving"),
      b = message("held"),
      c = message("unqueried");
    const moved = {
      ...a,
      cloudId: "successor",
      version: 2,
      anchor: { longitude: -72.9, latitude: 42 },
    };
    const result = reconcileCreated(
      { origin: [a, b, c] },
      [moved],
      new Set(["moving", "held"]),
      {},
      10,
      new Set(),
      new Set(),
    );
    expect(result.origin).toEqual([c]);
    expect(result.successor).toEqual([moved]);
  });
  it("never restores deleted posts/clouds from late responses", () => {
    const post = message("deleted");
    expect(
      reconcileCreated(
        {},
        [post],
        new Set([post.id]),
        {},
        10,
        new Set([post.id]),
        new Set(),
      ),
    ).toEqual({});
    expect(
      reconcileCreated(
        {},
        [post],
        new Set([post.id]),
        {},
        10,
        new Set(),
        new Set([post.cloudId]),
      ),
    ).toEqual({});
  });
  it("does not erase a post created after the reconciliation request began", () => {
    const post = message("new");
    expect(
      reconcileCreated(
        { origin: [post] },
        [],
        new Set([post.id]),
        { new: 11 },
        10,
        new Set(),
        new Set(),
      ),
    ).toEqual({ origin: [post] });
  });
});
