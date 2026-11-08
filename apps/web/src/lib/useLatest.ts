import { useLayoutEffect, useRef, useSyncExternalStore } from "react";

/** A ref that always holds the latest value, for animation loops and event handlers. */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/** Media query state that is SSR-safe (server assumes `serverDefault`). */
export function useMediaQuery(query: string, serverDefault: boolean) {
  return useSyncExternalStore(
    (notify) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", notify);
      return () => mq.removeEventListener("change", notify);
    },
    () => window.matchMedia(query).matches,
    () => serverDefault,
  );
}
