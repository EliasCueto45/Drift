"use client";
import { Camera, Map as MapIcon, Orbit } from "lucide-react";
import styles from "./onboarding.module.css";

/** First screen: what Drift is, and the three ways in. Shown over the live simulated sky. */
export function Onboarding({
  busy,
  handheld,
  reason,
  onLookUp,
  onMap,
  onSimulated,
}: {
  busy: boolean;
  handheld: boolean;
  reason: string | null;
  onLookUp: () => void;
  onMap: () => void;
  /** Developer mode only; absent in user mode, which hides the simulated sky. */
  onSimulated?: () => void;
}) {
  return (
    <section className={styles.sheet} aria-labelledby="onboarding-title">
      <h1 id="onboarding-title" className={styles.title}>
        Drift
      </h1>
      <p className={styles.lede}>Words written on real clouds. Look up to read them, leave one of your own, and let the wind carry it to whoever is under that cloud next.</p>
      {reason && (
        <p className={styles.reason} role="status">
          {reason}
        </p>
      )}
      <div className={styles.actions}>
        {handheld ? (
          <>
            <button type="button" className="drift-primary" onClick={onLookUp} disabled={busy} aria-busy={busy}>
              <Camera size={20} strokeWidth={2.25} aria-hidden="true" />
              {busy ? "Waiting for permission…" : "Look up"}
            </button>
            <button type="button" className="drift-secondary" onClick={onMap} disabled={busy}>
              <MapIcon size={18} strokeWidth={2.25} aria-hidden="true" />
              Map
            </button>
          </>
        ) : (
          <>
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
          </>
        )}
      </div>
      {handheld && onSimulated && (
        <button type="button" className={`drift-textlink ${styles.sim}`} onClick={onSimulated}>
          No clouds where you are? Try the simulated sky over Troy, NY
        </button>
      )}
      <p className={styles.privacy}>
        {handheld
          ? "Drift asks for your camera, location and compass so it can line posts up with the sky. Video stays on your phone. Your location is never posted."
          : `On a phone, Drift uses the camera and compass to show posts in the real sky. Here, explore the same clouds on a map${onSimulated ? " or in a simulated sky over Troy, NY" : ""}.`}
      </p>
    </section>
  );
}
