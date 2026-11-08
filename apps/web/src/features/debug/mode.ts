"use client";
/**
 * User mode vs. developer mode. User mode (the default) hides every debugging aid; developer
 * mode shows the sensor readout, registration thumbnail, phone log, simulated sky and the
 * Next.js error overlay. Remembered per device in localStorage.
 */
import { useSyncExternalStore } from "react";

const KEY = "drift.mode";
const EVENT = "drift:mode";

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "developer";
  } catch {
    return false;
  }
}

export function setDeveloperMode(on: boolean) {
  try {
    window.localStorage.setItem(KEY, on ? "developer" : "user");
  } catch {
    // Storage blocked (private mode): the switch still applies until reload.
    memory = on;
  }
  window.dispatchEvent(new Event(EVENT));
}

let memory: boolean | null = null;

function subscribe(onChange: () => void) {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function useDeveloperMode(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => memory ?? read(),
    () => false,
  );
}
