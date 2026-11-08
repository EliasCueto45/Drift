"use client";
import { Camera, Map as MapIcon, Orbit } from "lucide-react";
import { DriftLogo } from "@/features/brand/DriftLogo";
import { Camera, Check, Copy, Map as MapIcon, Orbit, RotateCcw, Sun } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import styles from "./onboarding.module.css";

/** The permission currently being asked for while "Look up" is busy. */
export type PermissionStep = "motion" | "camera" | "location";

const STEP_LABEL: Record<PermissionStep, string> = {
  motion: "Allow motion",
  camera: "Allow the camera",
  location: "Allow location",
};
const STEP_ORDER: PermissionStep[] = ["motion", "camera", "location"];

/**
 * First screen. On a phone: what Drift is, that it works outside, which three permissions
 * come next and why, then one action. On a desktop: the map, plus the address to open on a
 * phone. A failed attempt shows its reason with a retry in place.
 */
export function Onboarding({
  busy,
  step,
  handheld,
  reason,
  onRetry,
  onLookUp,
  onMap,
  onSimulated,
}: {
  busy: boolean;
  step: PermissionStep | null;
  handheld: boolean;
  reason: string | null;
  /** Shown with a reason that a page reload can fix (a permission changed in settings). */
  onRetry?: () => void;
  onLookUp: () => void;
  /** Absent on a phone in user mode: the map opens only from the camera, once outdoors. */
  onMap?: () => void;
  /** Developer mode only. */
  onSimulated?: () => void;
}) {
  return (
    <section className={styles.sheet} aria-labelledby="onboarding-title">
      <h1 id="onboarding-title" className={styles.title}>
        <DriftLogo variant="welcome" preload />
      </h1>
      <p className={styles.lede}>
        Words written on real clouds. Look up to read them, leave one of your own, and let the wind carry it to whoever is under that cloud next.
      </p>

      {reason && (
        <div className={styles.reason} role="alert">
          <p>{reason}</p>
          {onRetry && (
            <button type="button" className={styles.retry} onClick={onRetry}>
              <RotateCcw size={16} strokeWidth={2.25} aria-hidden="true" />
              Try again
            </button>
          )}
        </div>
      )}

      {handheld ? (
        <>
          <ul className={styles.before} aria-label="Before you start">
            <li>
              <Sun size={18} strokeWidth={2} aria-hidden="true" />
              <span>
                <strong>Works outside,</strong> under open sky.
              </span>
            </li>
            <li>
              <Camera size={18} strokeWidth={2} aria-hidden="true" />
              <span>
                Next, your phone asks for <strong>motion, camera and location</strong> so posts line up with the sky.
              </span>
            </li>
          </ul>
          <div className={styles.actions}>
            <button type="button" className="drift-primary" onClick={onLookUp} disabled={busy} aria-busy={busy} data-busy={busy || undefined}>
              <Camera size={20} strokeWidth={2.25} aria-hidden="true" />
              {busy && step ? `${STEP_LABEL[step]} · ${STEP_ORDER.indexOf(step) + 1} of 3` : busy ? "Opening the camera…" : "Look up"}
            </button>
            {onMap && (
              <button type="button" className="drift-secondary" onClick={onMap} disabled={busy}>
                <MapIcon size={18} strokeWidth={2.25} aria-hidden="true" />
                Map
              </button>
            )}
          </div>
          {onSimulated && (
            <button type="button" className={`drift-textlink ${styles.sim}`} onClick={onSimulated}>
              Developer: simulated sky over Troy, NY
            </button>
          )}
          <p className={styles.privacy}>Video stays on your phone. Your location is never posted. No account needed to post.</p>
        </>
      ) : (
        <>
          <PhoneHandoff />
          <div className={styles.actions}>
            <button type="button" className="drift-primary" onClick={onMap}>
              <MapIcon size={20} strokeWidth={2.25} aria-hidden="true" />
              Open the map
            </button>
            {onSimulated && (
              <button type="button" className="drift-secondary" onClick={onSimulated}>
                <Orbit size={18} strokeWidth={2.25} aria-hidden="true" />
                Simulated sky
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** Desktop: the real experience is on a phone outside, so hand over this page's address. */
function PhoneHandoff() {
  // Client-only value (null during server render), read without an effect.
  const url = useSyncExternalStore(noSubscribe, () => window.location.origin, () => null);
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked: the address stays selectable on screen.
    }
  }
  return (
    <div className={styles.handoff}>
      <p>
        Drift is made for a phone held up to the sky. Open this address on your phone, step outside and tap <strong>Look up</strong>. Here, the map shows the same clouds and posts.
      </p>
      {url && (
        <button type="button" className={styles.address} onClick={() => void copy()} aria-label={`Copy ${url}`}>
          <span className={styles.addressText}>{url.replace(/^https?:\/\//, "")}</span>
          {copied ? <Check size={16} strokeWidth={2.25} aria-hidden="true" /> : <Copy size={16} strokeWidth={2.25} aria-hidden="true" />}
          <span className="visually-hidden" aria-live="polite">
            {copied ? "Copied" : ""}
          </span>
        </button>
      )}
    </div>
  );
}

const noSubscribe = () => () => {};
