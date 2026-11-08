"use client";
import { ArrowLeft, ArrowRight, Camera, Compass, Map as MapIcon, Orbit, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "@/lib/api/ApiProvider";
import { AccountButton } from "@/lib/auth/DriftAuth";
import { config } from "@/lib/config";
import type { Anchor, Message } from "@/lib/contracts";
import { Composer } from "@/features/composer/Composer";
import { usePosts } from "@/features/composer/posts";
import { CloudPanel } from "./CloudPanel";
import { CloudSheet } from "./CloudSheet";
import { freshnessText } from "./describe";
import { directionTo, groundDistanceM, ringCentroid } from "./geo";
import { MapStage } from "./MapStage";
import { Onboarding } from "./Onboarding";
import { declinationDeg, poseAngles, visibleHfovDeg } from "./orientation";
import type { CameraPose } from "./projection";
import {
  requestCamera,
  requestLocationOnce,
  requestOrientationPermission,
  useOrientation,
  useWatchedLocation,
  type ViewerLocation,
} from "./sensors";
import { SkyStage, type Draft, type SceneSummary } from "./SkyStage";
import { useSky } from "./useSky";
import { useLatest, useMediaQuery } from "@/lib/useLatest";
import styles from "./sky.module.css";

type View = "welcome" | "camera" | "simulated" | "map";

export function DriftApp({ datasetId, initialView }: { datasetId: string; initialView: View | null }) {
  const api = useApi();
  const { notice, notify, addCreated } = usePosts();
  const synthetic = config.isSyntheticDataset(datasetId);

  const [view, setView] = useState<View>(initialView ?? "welcome");
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [granted, setGranted] = useState<ViewerLocation | null>(null);
  const location = useWatchedLocation(Boolean(granted), granted);

  const viewer: Anchor = location ?? config.simulatedViewer;
  const viewerIsReal = Boolean(location);
  const { clouds, status: skyStatus, freshness, asOf, refresh: refreshSky } = useSky(api, viewer, datasetId);
  const handheld = useMediaQuery("(pointer: coarse)", true);

  // Selection, placement and composing.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [summary, setSummary] = useState<SceneSummary | null>(null);
  const [nudge, setNudge] = useState(0);
  const [calibrating, setCalibrating] = useState(false);
  const [settle, setSettle] = useState<{ id: string; at: number } | null>(null);

  // ---- Poses ----
  const streamRef = useLatest(stream);
  const orientation = useOrientation(view === "camera", () => {
    // Motion permission granted but no heading ever arrives (most desktops): use the map.
    stopStream(streamRef.current);
    setStream(null);
    setView("map");
    notify("This device isn't reporting a compass heading, so here's the map instead.");
  });
  const sim = useRef({ az: 30, el: 24, aimed: false, lifted: false, liftDeg: 0 });
  // Behind the welcome sheet the camera tilts down a little so the cloud sits above the sheet;
  // entering the sky view recenters it on the reticle.
  /**
   * Degrees to look below a cloud so it sits in the upper third: a fraction of the vertical
   * field of view, so phones (tall) and desktops (wide) frame alike. The welcome sheet on a
   * phone covers more, so it adds a little.
   */
  const tilts = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const hfov = visibleHfovDeg({ width: w, height: h }, null);
    const vfov = (2 * Math.atan(Math.tan((hfov * Math.PI) / 360) * (h / w)) * 180) / Math.PI;
    return { frame: vfov * 0.11, welcome: w < 700 ? vfov * 0.12 : 0 };
  };
  const tween = useRef(0);
  /** Smoothly re-aim the simulated camera (instant under reduced motion). */
  const panSimTo = useCallback((az: number, el: number) => {
    cancelAnimationFrame(tween.current);
    const from = { az: sim.current.az, el: sim.current.el };
    const dAz = ((az - from.az + 540) % 360) - 180;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      sim.current.az = (az + 360) % 360;
      sim.current.el = el;
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 450);
      const e = 1 - Math.pow(1 - t, 3);
      sim.current.az = (from.az + dAz * e + 360) % 360;
      sim.current.el = from.el + (el - from.el) * e;
      if (t < 1) tween.current = requestAnimationFrame(step);
    };
    tween.current = requestAnimationFrame(step);
  }, []);
  useEffect(() => {
    const s = sim.current;
    if (view === "welcome" && s.aimed && !s.lifted) {
      s.liftDeg = tilts().welcome;
      s.el -= s.liftDeg;
      s.lifted = true;
    } else if (view !== "welcome" && s.lifted) {
      s.el += s.liftDeg;
      s.lifted = false;
    }
  }, [view]);
  const declination = declinationDeg(viewer.latitude, viewer.longitude);
  const live = useLatest({ viewer, nudge, declination });

  // Aim the simulated camera at the nearest cloud with posts once data arrives.
  useEffect(() => {
    if (sim.current.aimed || !clouds.length) return;
    // Prefer a cloud with posts that is far enough away to be seen as a cloud, not fog overhead.
    const ranked = clouds
      .map((c) => {
        const centroid = ringCentroid((c.cloud.geometry.coordinates[0]?.[0] ?? []) as number[][]);
        return { c, centroid, d: groundDistanceM(viewer, centroid) };
      })
      .sort((a, b) => Number(b.c.previews.length > 0 && b.d > 3000) - Number(a.c.previews.length > 0 && a.d > 3000) || a.d - b.d);
    const target = ranked[0];
    if (!target) return;
    const dir = directionTo({ ...viewer, height: 0 }, { ...target.centroid, height: target.c.cloud.wind.altitudeM || 2000 });
    // The camera looks a little below the cloud so it sits in the upper third, clear of the panel.
    const t = tilts();
    const el = Math.min(70, Math.max(8, dir.elevationDeg)) - t.frame;
    const lifted = view === "welcome";
    sim.current = { az: dir.azimuthDeg, el: lifted ? el - t.welcome : el, aimed: true, lifted, liftDeg: lifted ? t.welcome : 0 };
  }, [clouds, viewer, view]);

  const getSimPose = useCallback((): Omit<CameraPose, "hfovDeg"> => {
    const v = live.current.viewer;
    return {
      longitude: v.longitude,
      latitude: v.latitude,
      heightM: 0,
      heightReference: "unknown",
      azimuthDeg: sim.current.az,
      elevationDeg: sim.current.el,
      rollDeg: 0,
      source: "simulated",
    };
  }, [live]);

  const getCameraPose = useCallback((): Omit<CameraPose, "hfovDeg"> | null => {
    const vectors = orientation.reading.current.vectors;
    if (!vectors) return null;
    const { viewer: v, nudge: n, declination: d } = live.current;
    const a = poseAngles(vectors, (d ?? 0) + n);
    return { longitude: v.longitude, latitude: v.latitude, heightM: 0, heightReference: "unknown", ...a, source: "sensors" };
  }, [orientation.reading, live]);

  const panSim = useCallback((dAz: number, dEl: number) => {
    sim.current.az = (sim.current.az + dAz + 360) % 360;
    sim.current.el = Math.max(-5, Math.min(89, sim.current.el + dEl));
  }, []);

  // Welcome screen: slow drift of the simulated sky behind the sheet.
  useEffect(() => {
    if (view !== "welcome" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      sim.current.az = (sim.current.az + ((now - last) / 1000) * 1.2) % 360;
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [view]);

  useEffect(() => () => stopStream(stream), [stream]);

  // ---- Entering the camera ----
  async function lookUp() {
    setBusy(true);
    setReason(null);
    // iOS: motion permission must be requested first, directly inside the tap.
    const motion = await requestOrientationPermission();
    const cam = await requestCamera();
    const loc = await requestLocationOnce();
    setBusy(false);
    const missing: string[] = [];
    if (cam.status !== "granted") missing.push("camera");
    if (motion !== "granted") missing.push("motion sensors");
    if (loc.status !== "granted") missing.push("location");
    if (loc.location) setGranted(loc.location);
    if (missing.length) {
      stopStream(cam.stream);
      const list = missing.join(" and ").replace(/ and (?=.* and )/, ", ");
      const denied = [cam.status, motion, loc.status].includes("denied");
      setReason(
        `${denied ? "Without" : "This browser can't give Drift"} ${list}, ${denied ? "Drift can't line posts up with the sky" : "access, so the camera view isn't available"}. The map has the same clouds and posts${
          loc.status === "granted" ? "" : " (around Troy, NY until location is allowed)"
        }.`,
      );
      setView("map");
      return;
    }
    setStream(cam.stream);
    setView("camera");
  }

  function leaveCamera(to: View) {
    stopStream(stream);
    setStream(null);
    setView(to);
  }

  // ---- Selection & posting ----
  // Derived, so a cloud that leaves the sky (expired, merged, out of range) simply deselects.
  const selected = clouds.find((c) => c.cloud.id === selectedId) ?? null;
  const draftCloud = draft ? (clouds.find((c) => c.cloud.id === draft.cloudId) ?? null) : null;
  const activeDraft = draft && draftCloud ? draft : null;
  const placingNow = placing && Boolean(selected);
  const sheetItem = clouds.find((c) => c.cloud.id === sheetId) ?? null;
  const composing = Boolean(activeDraft) && !placingNow;

  function onAim(id: string | null) {
    if (id && !placing && !draft && !sheetId) setSelectedId(id);
  }
  function onTap(id: string | null) {
    if (draft) return;
    setSelectedId(id);
    const target = id && view === "simulated" ? clouds.find((c) => c.cloud.id === id) : null;
    if (target) {
      // Frame the tapped cloud in the upper third so its caption sheet doesn't cover it.
      const centroid = ringCentroid((target.cloud.geometry.coordinates[0]?.[0] ?? []) as number[][]);
      const dir = directionTo({ ...viewer, height: 0 }, { ...centroid, height: target.cloud.wind.altitudeM || 2000 });
      const want = Math.max(-5, dir.elevationDeg - tilts().frame);
      const off = Math.abs(((dir.azimuthDeg - sim.current.az + 540) % 360) - 180);
      if (Math.abs(sim.current.el - want) > 4 || off > 12) panSimTo(dir.azimuthDeg, want);
    }
  }
  function onPlace(cloudId: string, anchor: Anchor) {
    setPlacing(false);
    if (view === "simulated") {
      // Bring the chosen spot above the composer so the words can be watched settling in.
      const target = clouds.find((c) => c.cloud.id === cloudId);
      const dir = directionTo({ ...viewer, height: 0 }, { ...anchor, height: target?.cloud.wind.altitudeM || 2000 });
      panSimTo(dir.azimuthDeg, Math.max(-5, dir.elevationDeg - tilts().frame * 1.4));
    }
    setDraft((d) => ({ cloudId, anchor, text: d?.cloudId === cloudId ? d.text : "" }));
  }
  function onPlaceMiss() {
    notify("Tap inside the cloud you picked.");
  }
  const onDraftText = useCallback((text: string) => setDraft((d) => (d && d.text !== text ? { ...d, text } : d)), []);
  function onPublished(m: Message) {
    addCreated(m);
    setSettle({ id: m.id, at: performance.now() });
    setDraft(null);
    setSelectedId(m.cloudId);
    notify("Posted. It travels with this cloud now.");
    refreshSky();
  }
  /** `final`: the cloud is gone (merged, split, dissipated); otherwise re-place on the refreshed cloud. */
  function onStale(reasonText: string, final: boolean) {
    notify(reasonText);
    refreshSky();
    if (final) {
      setDraft(null);
      setSelectedId(null);
    } else setPlacing(true);
  }
  function cancelPost() {
    setDraft(null);
    setPlacing(false);
  }

  // ---- Chrome ----
  const fresh = freshnessText(freshness, asOf, synthetic);
  const showPanel = selected && !placingNow && !activeDraft && !sheetId && view !== "welcome";
  const canPost = selected?.cloud.status === "active";

  const inView = summary?.visible ?? 0;
  const stageLabel = `${view === "simulated" ? "Simulated sky" : "Camera view of the sky"}. ${inView} tracked cloud${inView === 1 ? "" : "s"} in view. Posts are listed when you select a cloud.`;

  let hint: React.ReactNode = null;
  if (view === "camera" || view === "simulated") {
    if (placingNow) {
      hint = (
        <>
          Tap the spot on the cloud where your post goes
          <button type="button" onClick={() => setPlacing(false)}>
            Cancel
          </button>
        </>
      );
    } else if (skyStatus === "error" && !clouds.length) hint = <>Can&apos;t reach Drift right now. Retrying…</>;
    else if (skyStatus === "loading" || skyStatus === "idle") hint = <>Finding clouds near you…</>;
    else if (skyStatus === "ready" && !clouds.length) hint = <>No tracked clouds within 25 km right now.</>;
    else if (calibrating && view === "camera") {
      hint = (
        <span className={styles.nudge}>
          Line posts up with the clouds
          <button type="button" aria-label="Turn overlay left 2 degrees" onClick={() => setNudge((n) => n - 2)}>
            <ArrowLeft size={18} aria-hidden="true" />
          </button>
          <span className="tabular" aria-live="polite">
            {nudge > 0 ? "+" : ""}
            {nudge}°
          </span>
          <button type="button" aria-label="Turn overlay right 2 degrees" onClick={() => setNudge((n) => n + 2)}>
            <ArrowRight size={18} aria-hidden="true" />
          </button>
          <button type="button" onClick={() => setCalibrating(false)}>
            Done
          </button>
        </span>
      );
    } else if (summary && summary.visible === 0 && summary.turn) {
      const t = summary.turn.turnDeg;
      hint = (
        <>
          {t < 0 ? <ArrowLeft size={18} aria-hidden="true" /> : <ArrowRight size={18} aria-hidden="true" />}
          Nearest cloud: turn {t < 0 ? "left" : "right"} about {Math.max(5, Math.round(Math.abs(t) / 5) * 5)}°
        </>
      );
    } else if (summary && summary.visible === 0) hint = <>Look higher to find the clouds</>;
    else if (!selected) hint = <>Aim at a cloud or tap one</>;
  } else if (view === "map") {
    if (placingNow) {
      hint = (
        <>
          Tap inside the cloud, or move the map and place at the crosshair
          <button type="button" onClick={() => setPlacing(false)}>
            Cancel
          </button>
        </>
      );
    } else if (skyStatus === "ready" && !clouds.length) hint = <>No tracked clouds within 25 km right now.</>;
    else if (!selected) hint = <>Tap a cloud to read what&apos;s written on it</>;
  }

  return (
    <main className={styles.app}>
      {(view === "camera" || view === "simulated" || view === "welcome") && (
        <SkyStage
          mode={view === "camera" ? "camera" : "simulated"}
          stream={stream}
          getPose={view === "camera" ? getCameraPose : getSimPose}
          clouds={clouds}
          freshness={freshness}
          selectedId={view === "welcome" ? null : selectedId}
          placing={placingNow}
          draft={activeDraft}
          onAim={view === "welcome" ? noop : onAim}
          onTap={view === "welcome" ? noop : onTap}
          onOpen={view === "welcome" ? noop : setSheetId}
          onPlace={onPlace}
          onPlaceMiss={onPlaceMiss}
          onPan={view === "simulated" ? panSim : undefined}
          onSummary={setSummary}
          label={stageLabel}
          interactive={view !== "welcome"}
          settle={settle}
        />
      )}
      {view === "map" && (
        <MapStage
          clouds={clouds}
          viewer={viewer}
          viewerIsReal={viewerIsReal}
          selectedId={selectedId}
          placing={placingNow}
          draft={activeDraft}
          onSelect={(id) => !draft && setSelectedId(id)}
          onOpen={setSheetId}
          onPlace={onPlace}
          onPlaceMiss={onPlaceMiss}
        />
      )}

      <header className={styles.topbar}>
        <div className={styles.pills}>
          <span className={styles.pill} data-tone={fresh.tone} role="status">
            <span className={styles.dot} aria-hidden="true" />
            {fresh.label}
          </span>
          {view === "simulated" && <span className={styles.pill}>Simulated view</span>}
          {view === "camera" && (
            <button type="button" className={styles.signInButton} onClick={() => setCalibrating((c) => !c)} aria-pressed={calibrating}>
              <Compass size={16} aria-hidden="true" />
              {declination === null ? "Compass uncorrected" : "Estimated positions"}
            </button>
          )}
          {view === "map" && !viewerIsReal && <span className={styles.pill}>Showing Troy, NY</span>}
        </div>
        {view !== "welcome" && <AccountButton className={styles.signInButton} />}
      </header>

      {notice && (
        <p className={styles.toast} role="status" aria-live="polite">
          {notice}
        </p>
      )}

      {view === "welcome" && (
        <Onboarding
          busy={busy}
          handheld={handheld}
          reason={reason}
          onLookUp={lookUp}
          onMap={() => setView("map")}
          onSimulated={() => setView("simulated")}
        />
      )}

      {view !== "welcome" && !showPanel && !composing && (
        <div className={styles.bottomDock}>
          {view === "map" ? (
            <button type="button" className={styles.roundButton} onClick={() => (handheld ? void lookUp() : setView("simulated"))} aria-label={handheld ? "Back to the camera sky" : "Simulated sky view"}>
              {handheld ? <Camera size={20} aria-hidden="true" /> : <Orbit size={20} aria-hidden="true" />}
            </button>
          ) : (
            <button type="button" className={styles.roundButton} onClick={() => leaveCamera("map")} aria-label="Show the map">
              <MapIcon size={20} aria-hidden="true" />
            </button>
          )}
          {hint ? <div className={styles.hint}>{hint}</div> : <span />}
          {view === "simulated" && (
            <button type="button" className={styles.roundButton} onClick={() => setView("welcome")} aria-label="Leave the simulated sky">
              <X size={20} aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      {showPanel && selected && (
        <CloudPanel
          item={selected}
          viewer={viewer}
          canPost={canPost}
          onClose={() => setSelectedId(null)}
          onPost={() => setPlacing(true)}
          onOpen={() => setSheetId(selected.cloud.id)}
        />
      )}

      {activeDraft && draftCloud && (
        <div hidden={placingNow}>
          <Composer
            item={draftCloud}
            anchor={activeDraft.anchor}
            onCancel={cancelPost}
            onPublished={onPublished}
            onStale={onStale}
            onDraft={onDraftText}
            onMoveSpot={() => setPlacing(true)}
          />
        </div>
      )}

      {sheetItem && <CloudSheet item={sheetItem} viewer={viewer} onClose={() => setSheetId(null)} />}
    </main>
  );
}

function noop() {}

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
}
