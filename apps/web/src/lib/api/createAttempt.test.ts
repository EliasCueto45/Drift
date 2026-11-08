import { describe, expect, it, vi, afterEach } from "vitest";
import { CreateAttempt } from "./createAttempt";
import { DriftApi } from "./client";
afterEach(() => vi.unstubAllGlobals());

describe("create retries", () => {
  it("freezes the request version until a definitive response, even when tracking advances", () => {
    const attempt = new CreateAttempt();
    const body = {
      kind: "text" as const,
      body: "hello",
      anchor: { longitude: -73, latitude: 42 },
      expectedCloudVersion: 1,
    };
    const first = attempt.prepareMessage("cloud", body);
    const retry = attempt.prepareMessage("cloud", {
      ...body,
      expectedCloudVersion: 2,
    });
    expect(retry.key).toBe(first.key);
    expect(retry.body.expectedCloudVersion).toBe(1);
    attempt.complete();
    expect(
      attempt.prepareMessage("cloud", { ...body, expectedCloudVersion: 2 }).body
        .expectedCloudVersion,
    ).toBe(2);
  });
  it("retains keys for an unchanged failed draft and rotates for edits or a new post", () => {
    const attempt = new CreateAttempt();
    const first = attempt.forRequest("a", { body: "hello" });
    expect(attempt.forRequest("a", { body: "hello" })).toBe(first);
    expect(attempt.forRequest("a", { body: "edited" })).not.toBe(first);
    const edited = attempt.forRequest("a", { body: "edited" });
    attempt.complete();
    expect(attempt.forRequest("a", { body: "edited" })).not.toBe(edited);
  });
  it("sends auth on reads, preserves retry headers, and exposes cloud methods", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { id: "result" } }), {
          status: 201,
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const api = new DriftApi(async () => "session-test");
    await api.messagesById(["post,with,commas", "second"]);
    const [path, init] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(path).toContain("id=post%2Cwith%2Ccommas");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer session-test",
    );
    await api.createCloud(
      {
        assumedAltitudeM: 2000,
        datasetId: "chosen",
        outline: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [0, 1],
              [1, 0],
              [0, 0],
            ],
          ],
        },
      },
      "same-retry",
    );
    const create = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(new Headers(create[1].headers).get("idempotency-key")).toBe(
      "same-retry",
    );
    expect(JSON.parse(create[1].body as string).datasetId).toBe("chosen");
    await api.deleteCloud("cloud/id");
    expect((fetch.mock.calls[2] as unknown as [string])[0]).toBe(
      "/api/v1/clouds/cloud%2Fid",
    );
  });
});
