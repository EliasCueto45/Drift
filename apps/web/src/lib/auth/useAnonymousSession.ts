"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AnonymousSession } from "@/lib/contracts/generated";

export function browserTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** The credential stays in an HttpOnly cookie; React only holds the public ID. */
export function useAnonymousSession(enabled: boolean) {
  const [session, setSession] = useState<AnonymousSession | null>(null);
  const [ready, setReady] = useState(false);
  const pending = useRef<Promise<string> | null>(null);
  const revision = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const started = revision.current;
    void fetch("/api/v1/session/anonymous", {
      credentials: "same-origin", cache: "no-store", signal: controller.signal,
    }).then(async (r) => {
      if (!r.ok) throw new Error("Session unavailable");
      const payload = await r.json();
      if (!controller.signal.aborted && revision.current === started) setSession(payload.data);
    }).catch(() => {}).finally(() => {
      if (!controller.signal.aborted) setReady(true);
    });
    return () => controller.abort();
  }, [enabled]);
  const ensureAnonymous = useCallback((): Promise<string> => {
    if (pending.current) return pending.current;
    revision.current++;
    pending.current = (async () => {
      const response = await fetch("/api/v1/session/anonymous", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json", "X-Drift-Time-Zone": browserTimeZone() },
        body: "{}",
      });
      if (!response.ok) throw new Error("Can't start anonymous posting. Please try again.");
      const { data } = await response.json();
      if (!data?.isAnonymous || !data.id) throw new Error("Anonymous session unavailable");
      setSession(data);
      setReady(true);
      return data.id;
    })().finally(() => { pending.current = null; });
    return pending.current;
  }, []);
  return { session, ready, ensureAnonymous };
}
