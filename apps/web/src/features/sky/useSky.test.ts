// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DriftApi } from "@/lib/api/client";
import { useSky } from "./useSky";

const reconcile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/features/composer/posts", () => ({ usePosts: () => ({ reconcile }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });
const viewer = { longitude: -73.68, latitude: 42.73 };
const asOf = "2026-11-08T11:51:18.300Z";
const cached = { data: { clouds: [], asOf, freshness: "stale", weather: null }, nextCursor: null };

describe("last-known sky fallback", () => {
  it("keeps the read-only source when the normal API itself returns cached geometry", async () => {
    const sky = vi.fn().mockResolvedValue({ ...cached, lastKnown: true });
    const api = { sky } as unknown as DriftApi;
    const { result } = renderHook(() => useSky(api, viewer, "troy-live"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.lastKnown).toBe(true);
    expect(reconcile).not.toHaveBeenCalled();
  });
  it("restores saved observations after reload and marks them stale when the live read fails", async () => {
    const sky = vi.fn().mockImplementation(async (p) => {
      if (p.lastKnown) return cached;
      throw new Error("Atlas unavailable");
    });
    const api = { sky } as unknown as DriftApi;
    const first = renderHook(() => useSky(api, viewer, "troy-live"));
    await waitFor(() => expect(first.result.current.status).toBe("error"));
    expect(first.result.current.asOf).toBe(asOf);
    expect(first.result.current.freshness).toBe("stale");
    expect(first.result.current.lastKnown).toBe(true);
    first.unmount();
    const reloaded = renderHook(() => useSky(api, viewer, "troy-live"));
    await waitFor(() => expect(reloaded.result.current.asOf).toBe(asOf));
    expect(reloaded.result.current.lastKnown).toBe(true);
  });

  it("replaces the fallback with an authoritative empty live sky once service recovers", async () => {
    const sky = vi.fn().mockImplementation(async (p) => p.lastKnown ? cached : {
      data: { clouds: [], asOf: "2026-11-08T15:30:00Z", freshness: "live", weather: null }, nextCursor: null,
    });
    const api = { sky } as unknown as DriftApi;
    const { result } = renderHook(() => useSky(api, viewer, "troy-live"));
    await waitFor(() => expect(result.current.lastKnown).toBe(false));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.asOf).toBe("2026-11-08T15:30:00Z");
    expect(result.current.clouds).toEqual([]);
  });

  it("times out a hung live request before the next poll while retaining the fallback", async () => {
    vi.useFakeTimers();
    const sky = vi.fn().mockImplementation((p, signal: AbortSignal) => p.lastKnown ? Promise.resolve(cached) : new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Timeout", "AbortError")));
    }));
    const api = { sky } as unknown as DriftApi;
    const { result } = renderHook(() => useSky(api, viewer, "troy-live"));
    await act(async () => { await vi.advanceTimersByTimeAsync(10001); });
    expect(result.current.status).toBe("error");
    expect(result.current.asOf).toBe(asOf);
    expect(result.current.lastKnown).toBe(true);
  });
});
