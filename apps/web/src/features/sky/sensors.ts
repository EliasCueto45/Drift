"use client";
/**
 * Browser sensor access for the camera AR view. Camera frames stay on the device:
 * the stream is attached to a <video> element only, never recorded or uploaded.
 */
import { useEffect, useRef, useState } from "react";
import { useLatest } from "@/lib/useLatest";
import type { Vec3 } from "./geo";
import { alphaFromCompassHeading, deviceVectors, smoothVectors } from "./orientation";

export type Permission = "idle" | "requesting" | "granted" | "denied" | "unsupported" | "error";

interface IOSOrientationEvent extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
  webkitCompassAccuracy?: number;
}

type OrientationCtor = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<"granted" | "denied"> };

export function orientationSupported() {
  return typeof window !== "undefined" && "DeviceOrientationEvent" in window;
}

/** iOS needs this inside a user gesture, before any await. Elsewhere it resolves granted. */
export async function requestOrientationPermission(): Promise<Permission> {
  if (!orientationSupported()) return "unsupported";
  const ctor = window.DeviceOrientationEvent as OrientationCtor;
  if (typeof ctor.requestPermission !== "function") return "granted";
  try {
    return (await ctor.requestPermission()) === "granted" ? "granted" : "denied";
  } catch {
    return "denied";
  }
}

export async function requestCamera(): Promise<{ status: Permission; stream: MediaStream | null }> {
  if (!navigator.mediaDevices?.getUserMedia) return { status: "unsupported", stream: null };
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, aspectRatio: { ideal: 4 / 3 }, width: { ideal: 1440 } },
    });
    return { status: "granted", stream };
  } catch (error) {
    const name = (error as DOMException)?.name;
    return { status: name === "NotAllowedError" || name === "SecurityError" ? "denied" : "error", stream: null };
  }
}

export interface ViewerLocation {
  longitude: number;
  latitude: number;
  accuracyM: number;
}

export function requestLocationOnce(): Promise<{ status: Permission; location: ViewerLocation | null }> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ status: "unsupported", location: null });
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          status: "granted",
          location: { longitude: p.coords.longitude, latitude: p.coords.latitude, accuracyM: p.coords.accuracy },
        }),
      (e) => resolve({ status: e.code === e.PERMISSION_DENIED ? "denied" : "error", location: null }),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  });
}

/** Keeps the location fresh after permission was granted. */
export function useWatchedLocation(enabled: boolean, initial: ViewerLocation | null) {
  const [location, setLocation] = useState<ViewerLocation | null>(initial);
  useEffect(() => {
    if (!enabled || !navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (p) =>
        setLocation((prev) => {
          const next = { longitude: p.coords.longitude, latitude: p.coords.latitude, accuracyM: p.coords.accuracy };
          // Ignore jitter under ~15 m so the sky query and projection origin stay stable.
          if (prev && Math.abs(prev.latitude - next.latitude) < 1.5e-4 && Math.abs(prev.longitude - next.longitude) < 2e-4) {
            return prev;
          }
          return next;
        }),
      () => undefined,
      { enableHighAccuracy: true, maximumAge: 10000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [enabled]);
  return location;
}

export interface OrientationReading {
  vectors: { forward: Vec3; up: Vec3 } | null;
  /** True once readings are referenced to (magnetic) north. */
  absolute: boolean;
  /** iOS compass accuracy in degrees, when reported. */
  accuracyDeg: number | null;
  lastAt: number;
  /** Raw values from the last event, for the debug overlay. */
  raw: { alpha: number | null; beta: number; gamma: number; heading: number | null; source: "absolute" | "ios-compass" | "relative"; screenAngle: number } | null;
  /** Events applied since the hook started (debug: sensor rate). */
  count: number;
}

function screenAngle() {
  if (typeof screen !== "undefined" && screen.orientation && typeof screen.orientation.angle === "number") {
    return screen.orientation.angle;
  }
  const legacy = (window as unknown as { orientation?: number }).orientation;
  return typeof legacy === "number" ? legacy : 0;
}

/**
 * Smoothed device orientation in a ref (updated at sensor rate without React renders).
 * Android: `deviceorientationabsolute`. iOS: relative alpha replaced by webkitCompassHeading.
 */
export function useOrientation(enabled: boolean, onSilent?: () => void) {
  const reading = useRef<OrientationReading>({ vectors: null, absolute: false, accuracyDeg: null, lastAt: 0, raw: null, count: 0 });
  const [status, setStatus] = useState<"waiting" | "live" | "relative" | "silent">("waiting");
  const silentRef = useLatest(onSilent);

  useEffect(() => {
    if (!enabled) return;
    let gotAbsolute = false;
    const apply = (
      alpha: number,
      beta: number,
      gamma: number,
      absolute: boolean,
      accuracy: number | null,
      raw: NonNullable<OrientationReading["raw"]>,
    ) => {
      const angle = screenAngle();
      const next = deviceVectors(alpha, beta, gamma, angle);
      const r = reading.current;
      r.vectors = smoothVectors(r.vectors, next, 0.22);
      r.absolute = absolute;
      r.accuracyDeg = accuracy;
      r.lastAt = performance.now();
      r.raw = { ...raw, screenAngle: angle };
      r.count += 1;
    };
    const onAbsolute = (e: DeviceOrientationEvent) => {
      if (e.alpha == null || e.beta == null || e.gamma == null) return;
      gotAbsolute = true;
      apply(e.alpha, e.beta, e.gamma, true, null, { alpha: e.alpha, beta: e.beta, gamma: e.gamma, heading: null, source: "absolute", screenAngle: 0 });
    };
    const onRelative = (e: DeviceOrientationEvent) => {
      const ios = e as IOSOrientationEvent;
      if (e.beta == null || e.gamma == null) return;
      if (typeof ios.webkitCompassHeading === "number" && ios.webkitCompassHeading >= 0) {
        const acc = typeof ios.webkitCompassAccuracy === "number" && ios.webkitCompassAccuracy >= 0 ? ios.webkitCompassAccuracy : null;
        apply(alphaFromCompassHeading(ios.webkitCompassHeading), e.beta, e.gamma, true, acc, {
          alpha: e.alpha,
          beta: e.beta,
          gamma: e.gamma,
          heading: ios.webkitCompassHeading,
          source: "ios-compass",
          screenAngle: 0,
        });
      } else if (!gotAbsolute && e.alpha != null) {
        apply(e.alpha, e.beta, e.gamma, e.absolute === true, null, { alpha: e.alpha, beta: e.beta, gamma: e.gamma, heading: null, source: "relative", screenAngle: 0 });
      }
    };
    window.addEventListener("deviceorientationabsolute", onAbsolute as EventListener);
    window.addEventListener("deviceorientation", onRelative);
    const check = window.setInterval(() => {
      const r = reading.current;
      if (!r.vectors || performance.now() - r.lastAt > 3000) setStatus(r.vectors ? "silent" : "waiting");
      else setStatus(r.absolute ? "live" : "relative");
    }, 1000);
    const silence = window.setTimeout(() => {
      if (!reading.current.vectors) {
        setStatus("silent");
        silentRef.current?.();
      }
    }, 2500);
    return () => {
      window.removeEventListener("deviceorientationabsolute", onAbsolute as EventListener);
      window.removeEventListener("deviceorientation", onRelative);
      window.clearInterval(check);
      window.clearTimeout(silence);
    };
  }, [enabled, silentRef]);

  return { reading, status };
}
