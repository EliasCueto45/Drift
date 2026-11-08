"use client";
import { useCallback, useEffect, useState } from "react";
import { useLatest } from "@/lib/useLatest";
import { DriftApiError, type DriftApi } from "@/lib/api/client";
import type { Anchor, CloudWithPreviews, SkyData } from "@/lib/contracts";
import { DISCOVERY_RADIUS_M } from "./discovery";

export interface SkyState {
  clouds: CloudWithPreviews[];
  asOf: string | null;
  freshness: SkyData["freshness"] | null;
  status: "idle" | "loading" | "ready" | "error";
  error: DriftApiError | null;
  fetchedAt: number | null;
}

const EMPTY: SkyState = { clouds: [], asOf: null, freshness: null, status: "idle", error: null, fetchedAt: null };
const MAX_PAGES = 4;

/** Polls `GET /sky` around the viewer. Keeps the last good data visible when a refresh fails. */
export function useSky(api: DriftApi, at: Anchor | null, datasetId: string, intervalMs = 15000) {
  const [state, setState] = useState<SkyState>(EMPTY);
  const [tick, setTick] = useState(0);
  const atKey = at ? `${at.latitude.toFixed(4)},${at.longitude.toFixed(4)}` : null;
  const atRef = useLatest(at);

  useEffect(() => {
    const where = atRef.current;
    if (!where) return;
    const controller = new AbortController();
    setState((s) => ({ ...s, status: s.clouds.length ? s.status : "loading" }));
    (async () => {
      try {
        let cursor: string | null = null;
        const clouds: CloudWithPreviews[] = [];
        let first: SkyData | null = null;
        for (let page = 0; page < MAX_PAGES; page++) {
          const res = await api.sky({ at: where, radiusM: DISCOVERY_RADIUS_M, datasetId, cursor }, controller.signal);
          first ??= res.data;
          clouds.push(...res.data.clouds);
          cursor = res.nextCursor;
          if (!cursor) break;
        }
        setState({
          clouds,
          asOf: first?.asOf ?? null,
          freshness: first?.freshness ?? null,
          status: "ready",
          error: null,
          fetchedAt: Date.now(),
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        const e = error instanceof DriftApiError ? error : new DriftApiError(0, "UNKNOWN", "Couldn't load the sky");
        setState((s) => ({ ...s, status: "error", error: e }));
      }
    })();
    return () => controller.abort();
  }, [api, atKey, atRef, datasetId, tick]);

  useEffect(() => {
    if (!atKey) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") setTick((t) => t + 1);
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [atKey, intervalMs]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  /** Apply a local change (new post, vote) without waiting for the next poll. */
  const patch = useCallback((fn: (clouds: CloudWithPreviews[]) => CloudWithPreviews[]) => {
    setState((s) => ({ ...s, clouds: fn(s.clouds) }));
  }, []);
  return { ...state, refresh, patch };
}
