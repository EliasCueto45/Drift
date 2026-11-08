import { afterEach, expect, it, vi } from "vitest";
import { DriftApi } from "./client";

afterEach(() => vi.unstubAllGlobals());

it("loads public last-known geometry even when the sign-in token source is unavailable", async () => {
  const getToken = vi.fn().mockRejectedValue(new Error("identity service unavailable"));
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    data: { clouds: [], asOf: "2026-11-08T11:51:18.300Z", freshness: "stale" },
  }), { headers: { "content-type": "application/json", "x-drift-sky-source": "last-known" } }));
  vi.stubGlobal("fetch", fetch);
  const api = new DriftApi(getToken);
  const result = await api.sky({ at: { longitude: -73.68, latitude: 42.73 }, radiusM: 50000, datasetId: "troy-live", lastKnown: true });
  expect(getToken).not.toHaveBeenCalled();
  expect(fetch.mock.calls[0]![0]).toContain("lastKnown=1");
  expect(result.lastKnown).toBe(true);
});
