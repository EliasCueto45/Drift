"use client";
/**
 * Dev-only phone logging. With `?debug=1`, console output, uncaught errors and debug
 * snapshots are batched to /dev/log, which appends them to apps/web/.dev-logs/phone.log.
 * There is no Safari inspector without a Mac, so this is how phone errors reach the desk.
 */

type Entry = { t: string; kind: string; data: unknown };

let queue: Entry[] = [];
let started = false;
let session = "";

export function remoteLogEnabled() {
  return started;
}

export function remoteLog(kind: string, data: unknown) {
  if (!started) return;
  queue.push({ t: new Date().toISOString(), kind, data: safe(data) });
  if (queue.length > 200) queue = queue.slice(-200);
}

function safe(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return String(value);
  }
}

function flush(beacon = false) {
  if (!queue.length) return;
  const body = JSON.stringify({ session, entries: queue });
  queue = [];
  if (beacon && navigator.sendBeacon) {
    navigator.sendBeacon("/dev/log", new Blob([body], { type: "application/json" }));
    return;
  }
  void fetch("/dev/log", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => undefined);
}

export function startRemoteLog() {
  if (started || process.env.NODE_ENV === "production") return;
  started = true;
  session = Math.random().toString(36).slice(2, 8);

  for (const level of ["log", "info", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      remoteLog(`console.${level}`, args.map((a) => (typeof a === "string" ? a : safe(a))));
    };
  }
  window.addEventListener("error", (e) => remoteLog("error", { message: e.message, source: e.filename, line: e.lineno, col: e.colno, stack: e.error?.stack }));
  window.addEventListener("unhandledrejection", (e) => remoteLog("unhandledrejection", safe(e.reason)));
  document.addEventListener("visibilitychange", () => {
    remoteLog("visibility", document.visibilityState);
    if (document.visibilityState === "hidden") flush(true);
  });
  window.addEventListener("pagehide", () => flush(true));

  remoteLog("hello", {
    ua: navigator.userAgent,
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
    screen: { w: screen.width, h: screen.height, angle: screen.orientation?.angle ?? null },
    secure: window.isSecureContext,
    url: location.href,
  });
  window.setInterval(() => flush(), 1000);
}
