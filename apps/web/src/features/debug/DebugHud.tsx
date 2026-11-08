"use client";
import { useEffect, useState } from "react";
import { useLatest } from "@/lib/useLatest";
import { remoteLog } from "./remoteLog";
import styles from "./debug.module.css";

export type DebugSnapshot = Record<string, string | number | boolean | null>;

/**
 * On-screen sensor readout for phone testing (`?debug=1`). Refreshes at 4 Hz and sends a
 * snapshot to the dev log every 2 s. Tap to collapse.
 */
export function DebugHud({ snapshot }: { snapshot: () => DebugSnapshot }) {
  const [data, setData] = useState<DebugSnapshot>({});
  const [open, setOpen] = useState(true);
  const snapRef = useLatest(snapshot);

  useEffect(() => {
    let tick = 0;
    const id = window.setInterval(() => {
      const s = snapRef.current();
      setData(s);
      if (tick++ % 8 === 0) remoteLog("hud", s);
    }, 250);
    return () => window.clearInterval(id);
  }, [snapRef]);

  return (
    <button type="button" className={styles.hud} data-open={open} onClick={() => setOpen((o) => !o)} aria-label="Debug readout, tap to collapse">
      {open ? (
        <dl>
          {Object.entries(data).map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{format(v)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        "debug"
      )}
    </button>
  );
}

function format(v: DebugSnapshot[string]) {
  if (v === null) return "–";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 10 ? 2 : 1);
  return String(v);
}
