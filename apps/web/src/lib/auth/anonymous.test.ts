// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAnonymousSession } from "./useAnonymousSession";
import { DriftApi } from "@/lib/api/client";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const guest = { id: "anon_browser", displayName: "Anonymous", avatarUrl: null, isAnonymous: true };
const reply = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

it("restores a guest without creating one during browsing and deduplicates simultaneous bootstraps", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply(null)).mockResolvedValue(reply(guest));
  vi.stubGlobal("fetch", fetcher);
  const hook = renderHook(() => useAnonymousSession(true));
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]![1]!.method).toBeUndefined();
  await act(async () => {
    const [a, b] = await Promise.all([hook.result.current.ensureAnonymous(), hook.result.current.ensureAnonymous()]);
    expect(a).toBe(guest.id); expect(b).toBe(guest.id);
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1]![1]!).toMatchObject({ method: "POST", credentials: "same-origin", body: "{}" });
  expect(fetcher.mock.calls[1]![1]!.headers["X-Drift-Time-Zone"]).toBeTruthy();
  expect(hook.result.current.session).toEqual(guest);
});

it("does not replace a newly created guest with a late restore response", async () => {
  let restore!: (value: Response) => void;
  const fetcher = vi.fn().mockReturnValueOnce(new Promise<Response>((resolve) => { restore = resolve; })).mockResolvedValue(reply(guest));
  vi.stubGlobal("fetch", fetcher);
  const hook = renderHook(() => useAnonymousSession(true));
  await act(async () => { await hook.result.current.ensureAnonymous(); restore(reply(null)); });
  expect(hook.result.current.session?.id).toBe(guest.id);
});

it("uses a guest cookie for posting and deletion while preserving account-only voting", async () => {
  const fetcher = vi.fn().mockImplementation(async () => reply({ id: "post" }));
  vi.stubGlobal("fetch", fetcher);
  const ensure = vi.fn().mockResolvedValue(guest.id);
  const api = new DriftApi(async () => null, "/api/v1", ensure);
  await api.createMessage("cloud", { kind: "text", body: "Hello", expectedCloudVersion: 1, anchor: { longitude: -73, latitude: 42 } });
  await api.deleteMessage("post");
  expect(ensure).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]![1]!.credentials).toBe("same-origin");
  expect(fetcher.mock.calls[0]![1]!.headers.has("authorization")).toBe(false);
  await expect(api.setUpvote("post", true)).rejects.toMatchObject({ status: 401 });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
