"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLatest } from "@/lib/useLatest";
import { DriftApiError, type DriftApi } from "@/lib/api/client";
import type { Anchor, CloudWithPreviews, SkyData } from "@/lib/contracts";
import { DISCOVERY_RADIUS_M } from "./discovery";
import { usePosts } from "@/features/composer/posts";

export interface SkyState {
  clouds: CloudWithPreviews[];
  asOf: string | null;
  freshness: SkyData["freshness"] | null;
  status: "idle" | "loading" | "ready" | "error";
  error: DriftApiError | null;
  fetchedAt: number | null;
  lastKnown: boolean;
}

const EMPTY: SkyState = {
  clouds: [],
  asOf: null,
  freshness: null,
  status: "idle",
  error: null,
  fetchedAt: null,
  lastKnown: false,
};
const MAX_PAGES = 4;

/** Polls `GET /sky` around the viewer. Keeps the last good data visible when a refresh fails. */
export function useSky(
  api: DriftApi,
  at: Anchor | null,
  datasetId: string,
  intervalMs = 15000,
) {
  const { reconcile } = usePosts();
  const [state, setState] = useState<SkyState>(EMPTY);
  const [tick, setTick] = useState(0);
  const atKey = at
    ? `${at.latitude.toFixed(4)},${at.longitude.toFixed(4)}`
    : null;
  const atRef = useLatest(at);
  const stateRef = useLatest(state);
  const contextRef = useRef<string | null>(null);

  useEffect(() => {
    const where = atRef.current;
    if (!where) return;
    const controller = new AbortController();
    let timedOut = false;
    let disposed = false;
    const timeout = window.setTimeout(() => {
      if (disposed) return;
      timedOut = true;
      controller.abort();
      setState((s) => ({ ...s, status: "error", error: new DriftApiError(0, "TIMEOUT", "Sky refresh timed out"),
        freshness: s.asOf ? (s.freshness === "replay" ? "replay" : "stale") : null, lastKnown: Boolean(s.asOf),
      }));
    }, 10000);
    const context = `${datasetId}:${where.latitude.toFixed(2)},${where.longitude.toFixed(2)}`;
    const changed = contextRef.current !== context;
    contextRef.current = context;
    if (changed) setState({ ...EMPTY, status: "loading" });
    setState((s) => ({ ...s, status: s.clouds.length ? s.status : "loading" }));
    (async () => {
      try {
        if (changed || !stateRef.current.asOf || stateRef.current.status === "error" || stateRef.current.lastKnown) {
          try {
            const cached = await api.sky({ at: where, radiusM: DISCOVERY_RADIUS_M, datasetId, lastKnown: true }, controller.signal);
            if (!disposed && !controller.signal.aborted) setState({
              clouds: cached.data.clouds, asOf: cached.data.asOf,
              freshness: cached.data.freshness === "replay" ? "replay" : "stale",
              status: "ready", error: null, fetchedAt: Date.now(), lastKnown: true,
            });
          } catch {
            // Missing local fallback must not prevent the normal Atlas request.
          }
          if (timedOut) throw new DriftApiError(0, "TIMEOUT", "Sky refresh timed out");
          if (controller.signal.aborted) return;
        }
        let cursor: string | null = null;
        const clouds: CloudWithPreviews[] = [];
        let first: SkyData | null = null;
        let fromCache = false;
        for (let page = 0; page < MAX_PAGES; page++) {
          const res = await api.sky(
            { at: where, radiusM: DISCOVERY_RADIUS_M, datasetId, cursor },
            controller.signal,
          );
          first ??= res.data;
          fromCache ||= Boolean(res.lastKnown);
          clouds.push(...res.data.clouds);
          cursor = res.nextCursor;
          if (!cursor) break;
        }
        if (!fromCache) await reconcile(clouds, controller.signal);
        if (controller.signal.aborted) return;
        setState({
          clouds,
          asOf: first?.asOf ?? null,
          freshness: first?.freshness ?? null,
          status: "ready",
          error: null,
          fetchedAt: Date.now(),
          lastKnown: fromCache,
        });
      } catch (error) {
        if (disposed || (controller.signal.aborted && !timedOut)) return;
        const e =
          error instanceof DriftApiError
            ? error
            : new DriftApiError(0, "UNKNOWN", "Couldn't load the sky");
        setState((s) => ({ ...s, status: "error", error: e,
          freshness: s.asOf ? (s.freshness === "replay" ? "replay" : "stale") : null,
          lastKnown: Boolean(s.asOf),
        }));
      } finally {
        window.clearTimeout(timeout);
      }
    })();
    return () => { disposed = true; window.clearTimeout(timeout); controller.abort(); };
  }, [api, atKey, atRef, datasetId, tick, reconcile, stateRef]);

  useEffect(() => {
    if (!atKey) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") setTick((t) => t + 1);
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [atKey, intervalMs]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  /** Apply a local change (new post, vote) without waiting for the next poll. */
  const patch = useCallback(
    (fn: (clouds: CloudWithPreviews[]) => CloudWithPreviews[]) => {
      setState((s) => ({ ...s, clouds: fn(s.clouds) }));
    },
    [],
  );
  return { ...state, refresh, patch };
}
