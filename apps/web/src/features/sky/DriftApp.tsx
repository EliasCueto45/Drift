"use client";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Cloud as CloudIcon,
  Compass,
  Map as MapIcon,
  Orbit,
  X,
} from "lucide-react";
import { isValidElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "@/lib/api/ApiProvider";
import { AccountButton, useDriftAuth } from "@/lib/auth/DriftAuth";
import { config } from "@/lib/config";
import type {
  Anchor,
  Cloud,
  CloudWithPreviews,
  Message,
} from "@/lib/contracts";
import { Composer } from "@/features/composer/Composer";
import { usePosts } from "@/features/composer/posts";
import { CloudPanel } from "./CloudPanel";
import { CloudSheet } from "./CloudSheet";
import { CloudCreator } from "./CloudCreator";
import { freshnessText } from "./describe";
import { DISCOVERY_RADIUS_M, placementInRange } from "./discovery";
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
import {
  SkyStage,
  type Draft,
  type RegistrationReport,
  type SceneSummary,
} from "./SkyStage";
import { useSky } from "./useSky";
import { nightOutdoorScore, outdoorScore, sunElevationDeg, VisibilityTracker, type CloudVisibility } from "./visibility";
import { classifyFrame, loadSceneModel, type SceneResult } from "./sceneClassifier";
import { useLatest, useMediaQuery } from "@/lib/useLatest";
import { DebugHud, type DebugSnapshot } from "@/features/debug/DebugHud";
import { setDeveloperMode, useDeveloperMode } from "@/features/debug/mode";
import { remoteLog, startRemoteLog, stopRemoteLog } from "@/features/debug/remoteLog";
import styles from "./sky.module.css";
import { PostingStreakBadge } from "@/features/composer/PostingStreakBadge";
import { SnapshotButton } from "./SnapshotButton";
import type { SnapshotCapture } from "./snapshot";
import { DriftLogo } from "@/features/brand/DriftLogo";

type View = "welcome" | "camera" | "simulated" | "map";

export function DriftApp({ datasetId, initialView, devParam = null }: { datasetId: string; initialView: View | null; devParam?: boolean | null }) {
  // User mode hides every debugging aid; developer mode is switched on by ?debug=1 or by
  // tapping the status pill five times, and off with the Developer chip or ?debug=0.
  useEffect(() => {
    if (devParam !== null) setDeveloperMode(devParam);
  }, [devParam]);
  const debug = useDeveloperMode();
  useEffect(() => {
    if (debug) {
      startRemoteLog();
      // Developer console hook: `await __driftSceneModel()` loads the scene classifier.
      (window as unknown as { __driftSceneModel?: typeof loadSceneModel }).__driftSceneModel = loadSceneModel;
    }
    else stopRemoteLog();
  }, [debug]);
  const devTaps = useRef<number[]>([]);
  function onStatusTap(e: React.MouseEvent) {
    const now = e.timeStamp;
    devTaps.current = [...devTaps.current.filter((t) => now - t < 2000), now];
    if (devTaps.current.length >= 5 && !debug) {
      devTaps.current = [];
      setDeveloperMode(true);
      notify("Developer mode on.");
    }
  }
  const api = useApi();
  const auth = useDriftAuth();
  const { notice, notify, addCreated, removed, removedClouds } = usePosts();
  const synthetic = config.isSyntheticDataset(datasetId);

  const [view, setView] = useState<View>(initialView ?? "welcome");
  const [capture, setCapture] = useState<SnapshotCapture | null>(null);
  const onCaptureReady = useCallback((next: SnapshotCapture | null) => setCapture(() => next), []);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [granted, setGranted] = useState<ViewerLocation | null>(null);
  const [locationOff, setLocationOff] = useState(false);
  const location = useWatchedLocation(Boolean(granted), granted);

  const viewer: Anchor = location ?? config.simulatedViewer;
  const viewerIsReal = Boolean(location);
  const {
    clouds: receivedClouds,
    status: skyStatus,
    freshness,
    asOf,
    refresh: refreshSky,
    patch: patchSky,
    lastKnown,
  } = useSky(api, viewer, datasetId);
  const staleSky = lastKnown || freshness === "stale";
  const clouds: CloudWithPreviews[] = receivedClouds
    .filter((c) => !removedClouds.has(c.cloud.id))
    .map((c) => ({
      ...c,
      previews: c.previews.filter(
        (m) => !removed.has(m.id),
      ) as CloudWithPreviews["previews"],
    }));
  const [creatingCloud, setCreatingCloud] = useState(false);
  function onCloudCreated(cloud: Cloud) {
    patchSky((items) => [
      { cloud, previews: [] },
      ...items.filter((c) => c.cloud.id !== cloud.id),
    ]);
    setCreatingCloud(false);
    setSelectedId(cloud.id);
    notify("Created cloud published. It expires in 24 hours in this sky.");
    refreshSky();
  }
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
    notify(
      "This device isn't reporting a compass heading, so here's the map instead.",
    );
  });
  const sim = useRef({
    az: 30,
    el: 24,
    aimed: false,
    lifted: false,
    liftDeg: 0,
  });
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
    const vfov =
      (2 * Math.atan(Math.tan((hfov * Math.PI) / 360) * (h / w)) * 180) /
      Math.PI;
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
        const centroid = ringCentroid(
          (c.cloud.geometry.coordinates[0]?.[0] ?? []) as number[][],
        );
        return { c, centroid, d: groundDistanceM(viewer, centroid) };
      })
      .sort(
        (a, b) =>
          Number(b.c.previews.length > 0 && b.d > 3000) -
            Number(a.c.previews.length > 0 && a.d > 3000) || a.d - b.d,
      );
    const target = ranked[0];
    if (!target) return;
    const dir = directionTo(
      { ...viewer, height: 0 },
      { ...target.centroid, height: target.c.cloud.wind.altitudeM || 2000 },
    );
    // The camera looks a little below the cloud so it sits in the upper third, clear of the panel.
    const t = tilts();
    const el = Math.min(70, Math.max(8, dir.elevationDeg)) - t.frame;
    const lifted = view === "welcome";
    sim.current = {
      az: dir.azimuthDeg,
      el: lifted ? el - t.welcome : el,
      aimed: true,
      lifted,
      liftDeg: lifted ? t.welcome : 0,
    };
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

  // Camera-to-satellite registration (docs/decisions/0004): a smoothed pose correction that
  // lays tracked outlines over the clouds the camera actually sees.
  const reg = useRef({
    az: 0,
    el: 0,
    last: null as RegistrationReport | null,
    matchedAt: 0,
  });
  const [matched, setMatched] = useState(false);
  const onRegister = useCallback((r: RegistrationReport) => {
    const g = reg.current;
    g.last = r;
    if (r.accepted) {
      g.az = Math.max(-20, Math.min(20, g.az + 0.35 * r.dAzDeg));
      g.el = Math.max(-6, Math.min(6, g.el + 0.35 * r.dElDeg));
    }
    const now = performance.now();
    if (r.state === "matched") g.matchedAt = now;
    setMatched(g.matchedAt > 0 && now - g.matchedAt < 5000);
  }, []);

  // ---- Can real clouds be seen? (night / indoors -> virtual clouds, no matching) ----
  // On-device scene classifier (sceneClassifier.ts): indoor vs. outdoor from the camera frame.
  // elevationDeg: where the phone pointed when the frame was taken (night darkness only counts pointing up).
  const sceneRef = useRef<{ result: SceneResult; at: number; elevationDeg: number | null } | null>(null);
  const reading = orientation.reading;
  const [tracker] = useState(() => new VisibilityTracker());
  const [visibility, setVisibility] = useState<CloudVisibility>({ state: "hidden", reason: "checking" });
  const [visOverride, setVisOverride] = useState<"auto" | "visible" | "hidden">("auto");
  const sunRef = useRef(0);
  const [isNight, setIsNight] = useState(false);
  const sensed = useLatest({ viewer });
  useEffect(() => {
    // Runs day and night: indoors hides everything at any hour (see nightOutdoorScore).
    if (view !== "camera") return;
    let busy = false;
    const id = window.setInterval(() => {
      const video = document.querySelector("video");
      if (busy || !video || document.visibilityState !== "visible") return;
      busy = true;
      const vectors = reading.current.vectors;
      const elevationDeg = vectors ? poseAngles(vectors, 0).elevationDeg : null;
      classifyFrame(video, { width: window.innerWidth, height: window.innerHeight })
        .then((result) => {
          if (result) sceneRef.current = { result, at: performance.now(), elevationDeg };
        })
        .catch((error: unknown) => console.warn("Scene classification failed", error))
        .finally(() => (busy = false));
    }, 1500);
    return () => window.clearInterval(id);
  }, [view, reading]);
  useEffect(() => {
    if (view !== "camera") return;
    const tick = () => {
      const { viewer: v } = sensed.current;
      const sun = sunElevationDeg(new Date(), v.latitude, v.longitude);
      sunRef.current = sun;
      setIsNight(sun < -6);
      const scene = sceneRef.current;
      // Only a recent classification counts (the phone may have moved since).
      const recent = scene && performance.now() - scene.at < 6000 ? scene : null;
      const score = !recent
        ? null
        : sun < -6
          ? nightOutdoorScore(recent.result.light, recent.result.pIndoor, recent.elevationDeg)
          : outdoorScore(recent.result.pIndoor);
      const next = tracker.update(performance.now(), sun, score);
      setVisibility((prev) => (prev.state === next.state && prev.reason === next.reason ? prev : next));
    };
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [view, sensed, tracker]);
  // Developer mode can force either state (e.g. to see real-cloud matching code paths at night).
  const effectiveVis: CloudVisibility =
    !debug || visOverride === "auto"
      ? visibility
      : visOverride === "visible"
        ? { state: "visible", reason: null }
        : { state: "hidden", reason: visibility.reason === "night" || isNight ? "night" : "indoors" };
  const cloudsHidden = view === "camera" && effectiveVis.state === "hidden";
  // Drift is meant to get people outside: in user mode the camera sky shows nothing indoors
  // (no clouds, no posts) and the dock asks the user to step out. Developer mode keeps the
  // virtual-cloud fallback so indoor testing still works.
  const indoorBlocked = cloudsHidden && effectiveVis.reason !== "night" && !debug;
  // The 2D map is a reward for being outside: on a phone in user mode it opens only from the
  // camera once the scene check says outdoors. Desktops have no camera to check, so keep it.
  // Outdoors means "visible" by day or "hidden: night" after dark (night is only reported outdoors).
  const mapAllowed = debug || !handheld || (view === "camera" && (effectiveVis.state === "visible" || effectiveVis.reason === "night"));
  const skyClouds = indoorBlocked ? [] : clouds;

  // Plain function: SkyStage reads the latest one through a ref each frame.
  const getCameraPose = (): Omit<CameraPose, "hfovDeg"> | null => {
    const vectors = orientation.reading.current.vectors;
    if (!vectors) return null;
    const { viewer: v, nudge: n, declination: d } = live.current;
    const a = poseAngles(vectors, (d ?? 0) + n + reg.current.az);
    a.elevationDeg = Math.max(
      -89,
      Math.min(89, a.elevationDeg + reg.current.el),
    );
    return {
      longitude: v.longitude,
      latitude: v.latitude,
      heightM: 0,
      heightReference: "unknown",
      ...a,
      source: "sensors",
    };
  };

  const panSim = useCallback((dAz: number, dEl: number) => {
    sim.current.az = (sim.current.az + dAz + 360) % 360;
    sim.current.el = Math.max(-5, Math.min(89, sim.current.el + dEl));
  }, []);

  // Welcome screen: slow drift of the simulated sky behind the sheet.
  useEffect(() => {
    if (
      view !== "welcome" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
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

  // ---- Debug readout (?debug=1) ----
  const perms = useRef<{ motion: string; camera: string; location: string }>({
    motion: "-",
    camera: "-",
    location: "-",
  });
  const rate = useRef({ count: 0, at: 0, hz: 0 });
  const debugSnapshot = (): DebugSnapshot => {
    const d = {
      view,
      location,
      skyStatus,
      clouds: clouds.length,
      summary,
      declination,
      nudge,
      stream,
    };
    const r = orientation.reading.current;
    const g = reg.current;
    const now = performance.now();
    if (now - rate.current.at >= 1000) {
      rate.current.hz = rate.current.at
        ? ((r.count - rate.current.count) * 1000) / (now - rate.current.at)
        : 0;
      rate.current = { count: r.count, at: now, hz: rate.current.hz };
    }
    const pose = d.view === "camera" ? getCameraPose() : null;
    const video = document.querySelector("video");
    const settings = d.stream?.getVideoTracks()[0]?.getSettings();
    const vw = video?.videoWidth ?? 0;
    const vh = video?.videoHeight ?? 0;
    return {
      view: d.view,
      perms: `cam ${perms.current.camera} · motion ${perms.current.motion} · loc ${perms.current.location}`,
      orient: orientation.status,
      src: r.raw?.source ?? null,
      hz: Math.round(rate.current.hz),
      heading: r.raw?.heading ?? null,
      compassAcc: r.accuracyDeg,
      alpha: r.raw?.alpha ?? null,
      beta: r.raw?.beta ?? null,
      gamma: r.raw?.gamma ?? null,
      scrAngle: r.raw?.screenAngle ?? null,
      az: pose?.azimuthDeg ?? null,
      el: pose?.elevationDeg ?? null,
      roll: pose?.rollDeg ?? null,
      decl: d.declination,
      nudge: d.nudge,
      gps: d.location
        ? `${d.location.latitude.toFixed(5)}, ${d.location.longitude.toFixed(5)}`
        : "simulated",
      gpsAcc: d.location ? Math.round(d.location.accuracyM) : null,
      video: vw ? `${vw}x${vh}` : null,
      track: settings
        ? `${settings.width}x${settings.height} ${settings.facingMode ?? ""} ${settings.frameRate ? Math.round(settings.frameRate) + "fps" : ""}`
        : null,
      viewport: `${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}`,
      hfov: visibleHfovDeg({ width: window.innerWidth, height: window.innerHeight }, vw ? { width: vw, height: vh } : null),
      sky: `${d.skyStatus} · ${d.clouds} clouds · ${d.summary?.visible ?? 0} in view`,
      clouds: `${effectiveVis.state}${effectiveVis.reason ? " (" + effectiveVis.reason + ")" : ""}${visOverride !== "auto" ? " [forced]" : ""}`,
      sunEl: sunRef.current,
      outdoor: tracker.score,
      scene: sceneRef.current
        ? `${Math.round(sceneRef.current.result.ms)}ms · indoor ${sceneRef.current.result.pIndoor?.toFixed(2) ?? "dark"} · luma ${Math.round(sceneRef.current.result.light.meanLuma)}/${Math.round(sceneRef.current.result.light.topLuma)} dark ${Math.round(sceneRef.current.result.light.darkFraction * 100)}% · el ${sceneRef.current.elevationDeg?.toFixed(0) ?? "-"} · ${sceneRef.current.result.top.map((t) => `${t.name} ${t.p.toFixed(2)}`).join(", ")}`
        : "loading…",
      reg: g.last ? `${g.last.state}${g.last.accepted ? " +" : ""} ${Math.round(g.last.ms)}ms` : null,
      regFix: `az ${g.az.toFixed(1)} el ${g.el.toFixed(1)}`,
      regScore:
        g.last?.score != null
          ? `${g.last.score.toFixed(2)} (base ${g.last.baseScore?.toFixed(2)})`
          : null,
      regMask: g.last
        ? `cloud ${Math.round(g.last.cloudFraction * 100)}% · sky ${Math.round(g.last.validFraction * 100)}%`
        : null,
    };
  };

  // ---- Entering the camera ----
  async function lookUp() {
    setBusy(true);
    setReason(null);
    // iOS: motion permission must be requested first, directly inside the tap.
    const motion = await requestOrientationPermission();
    const cam = await requestCamera();
    const loc = await requestLocationOnce();
    setBusy(false);
    perms.current = { motion, camera: cam.status, location: loc.status };
    remoteLog("permissions", {
      ...perms.current,
      track: cam.stream?.getVideoTracks()[0]?.getSettings() ?? null,
      location: loc.location,
    });
    if (loc.location) setGranted(loc.location);
    setLocationOff(loc.status !== "granted");
    // Only the camera is required for the camera view. Missing motion or location degrades
    // alignment (and says so); it doesn't take the user out of the sky.
    if (cam.status !== "granted") {
      stopStream(cam.stream);
      // User mode on a phone: no camera means no outdoor check, so no map either.
      const toMap = debug || !handheld;
      setReason(
        cam.status === "denied"
          ? `Drift needs the camera to show posts on the sky. Allow it with the aA button in Safari's address bar, then Website Settings.${toMap ? " The map has the same clouds and posts." : ""}`
          : toMap
            ? "This browser can't open the camera, so here's the map with the same clouds and posts."
            : "This browser can't open the camera. Try Safari or Chrome on your phone.",
      );
      if (toMap) setView("map");
      return;
    }
    setStream(cam.stream);
    setView("camera");
    if (motion !== "granted") {
      notify(
        "Motion access is off, so posts can't follow where the phone points. Allow Motion & Orientation in Safari settings.",
      );
    } else if (loc.status !== "granted") {
      notify(
        "Location is off, so positions assume you're in Troy, NY. Turn on Location Services for Safari Websites to fix.",
      );
    }
  }

  function leaveCamera(to: View) {
    stopStream(stream);
    setStream(null);
    setView(to);
  }

  // ---- Selection & posting ----
  // Derived, so a cloud that leaves the sky (expired, merged, out of range) simply deselects.
  // Indoors (user mode) nothing is selectable, so open panels and drafts hide until outside.
  const selected = skyClouds.find((c) => c.cloud.id === selectedId) ?? null;
  const draftCloud = draft ? (skyClouds.find((c) => c.cloud.id === draft.cloudId) ?? null) : null;
  const activeDraft = draft && draftCloud ? draft : null;
  // Placing: after the dock's cloud button, the next tap on any cloud picks the cloud and the spot.
  const placingNow = placing && view !== "welcome" && !indoorBlocked;
  const sheetItem = skyClouds.find((c) => c.cloud.id === sheetId) ?? null;
  const composing = Boolean(activeDraft) && !placingNow;

  function startPost() {
    setSheetId(null);
    setSelectedId(null);
    setPlacing(true);
  }
  function onTap(id: string | null) {
    if (draft) return;
    setSelectedId(id);
    const target =
      id && view === "simulated" ? clouds.find((c) => c.cloud.id === id) : null;
    if (target) {
      // Frame the tapped cloud in the upper third so its caption sheet doesn't cover it.
      const centroid = ringCentroid(
        (target.cloud.geometry.coordinates[0]?.[0] ?? []) as number[][],
      );
      const dir = directionTo(
        { ...viewer, height: 0 },
        { ...centroid, height: target.cloud.wind.altitudeM || 2000 },
      );
      const want = Math.max(-5, dir.elevationDeg - tilts().frame);
      const off = Math.abs(
        ((dir.azimuthDeg - sim.current.az + 540) % 360) - 180,
      );
      if (Math.abs(sim.current.el - want) > 4 || off > 12)
        panSimTo(dir.azimuthDeg, want);
    }
  }
  function onPlace(cloudId: string, anchor: Anchor) {
    if (clouds.find((c) => c.cloud.id === cloudId)?.cloud.status !== "active") {
      notify("That cloud isn't taking new posts right now. Pick another one.");
      return;
    }
    if (!placementInRange(viewer, anchor)) {
      notify(
        `Choose a spot within ${DISCOVERY_RADIUS_M / 1000} km so it appears in your nearby sky.`,
      );
      return;
    }
    setPlacing(false);
    setSelectedId(cloudId);
    if (view === "simulated") {
      // Bring the chosen spot above the composer so the words can be watched settling in.
      const target = clouds.find((c) => c.cloud.id === cloudId);
      const dir = directionTo(
        { ...viewer, height: 0 },
        { ...anchor, height: target?.cloud.wind.altitudeM || 2000 },
      );
      panSimTo(
        dir.azimuthDeg,
        Math.max(-5, dir.elevationDeg - tilts().frame * 1.4),
      );
    }
    setDraft((d) => ({
      cloudId,
      anchor,
      text: d?.cloudId === cloudId ? d.text : "",
    }));
  }
  function onPlaceMiss() {
    notify("Tap inside a cloud to place your post.");
  }
  function openCloud(id: string) {
    setSheetId(id);
  }
  const onDraftText = useCallback(
    (text: string) =>
      setDraft((d) => (d && d.text !== text ? { ...d, text } : d)),
    [],
  );
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

  const inView = summary?.visible ?? 0;
  const stageLabel = `${view === "simulated" ? "Simulated sky" : "Camera view of the sky"}. ${inView} tracked cloud${inView === 1 ? "" : "s"} in view. Posts are listed when you select a cloud.`;

  let hint: React.ReactNode = null;
  if (indoorBlocked && effectiveVis.reason === "checking") {
    hint = <>Point your camera at the sky…</>;
  } else if (indoorBlocked) {
    hint = <>Clouds and posts only appear outside. Step outdoors and point your camera at the sky.</>;
  } else if (staleSky && view !== "welcome" && !placingNow) {
    hint = <>Showing the last known sky. Retrying the connection…</>;
  } else if (view === "camera" || view === "simulated") {
    if (placingNow) {
      hint = (
        <>
          Tap a cloud where your post should stick
          <button type="button" onClick={() => setPlacing(false)}>
            Cancel
          </button>
        </>
      );
    } else if (skyStatus === "error" && !clouds.length)
      hint = <>Can&apos;t reach Drift right now. Retrying…</>;
    else if (skyStatus === "loading" || skyStatus === "idle")
      hint = <>Finding clouds near you…</>;
    else if (skyStatus === "ready" && !clouds.length)
      hint = (
        <>No tracked clouds within {DISCOVERY_RADIUS_M / 1000} km right now.</>
      );
    else if (calibrating && view === "camera") {
      hint = (
        <span className={styles.nudge}>
          Line posts up with the clouds
          <button
            type="button"
            aria-label="Turn overlay left 2 degrees"
            onClick={() => setNudge((n) => n - 2)}
          >
            <ArrowLeft size={18} aria-hidden="true" />
          </button>
          <span className="tabular" aria-live="polite">
            {nudge > 0 ? "+" : ""}
            {nudge}°
          </span>
          <button
            type="button"
            aria-label="Turn overlay right 2 degrees"
            onClick={() => setNudge((n) => n + 2)}
          >
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
          {t < 0 ? (
            <ArrowLeft size={18} aria-hidden="true" />
          ) : (
            <ArrowRight size={18} aria-hidden="true" />
          )}
          Nearest cloud: turn {t < 0 ? "left" : "right"} about{" "}
          {Math.max(5, Math.round(Math.abs(t) / 5) * 5)}°
        </>
      );
    } else if (summary && summary.visible === 0) hint = <>Look higher to find the clouds</>;
    else if (!selected) hint = <>Tap a cloud to read its posts</>;
  } else if (view === "map") {
    if (placingNow) {
      hint = (
        <>
          Tap a cloud where your post should stick
          <button type="button" onClick={() => setPlacing(false)}>
            Cancel
          </button>
        </>
      );
    } else if (skyStatus === "ready" && !clouds.length)
      hint = (
        <>No tracked clouds within {DISCOVERY_RADIUS_M / 1000} km right now.</>
      );
    else if (!selected)
      hint = <>Tap a cloud to read what&apos;s written on it</>;
  }

  return (
    <main className={styles.app}>
      {(view === "camera" || view === "simulated" || view === "welcome") && (
        <SkyStage
          onCaptureReady={onCaptureReady}
          snapshotLabel={synthetic ? "Synthetic cloud data" : staleSky ? "Last known sky" : view !== "camera" ? "Simulated sky" : undefined}
          mode={view === "camera" ? "camera" : "simulated"}
          stream={stream}
          getPose={view === "camera" ? getCameraPose : getSimPose}
          clouds={skyClouds}
          freshness={freshness}
          selectedId={view === "welcome" ? null : selectedId}
          placing={placingNow}
          draft={activeDraft}
          onTap={view === "welcome" ? noop : onTap}
          onOpen={view === "welcome" ? noop : openCloud}
          onPlace={onPlace}
          onPlaceMiss={onPlaceMiss}
          onPan={view === "simulated" ? panSim : undefined}
          onSummary={setSummary}
          label={stageLabel}
          interactive={view !== "welcome"}
          settle={settle}
          onRegister={view === "camera" ? onRegister : undefined}
          virtualClouds={cloudsHidden && !indoorBlocked ? (effectiveVis.reason === "night" || isNight ? "night" : "day") : "off"}
          debug={debug}
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
          onSelect={(id) => !draft && onTap(id)}
          onOpen={openCloud}
          onPlace={onPlace}
          onPlaceMiss={onPlaceMiss}
        />
      )}

      <header className={styles.topbar}>
        <div className={styles.pills}>
          {view !== "welcome" && view !== "camera" && <DriftLogo />}
          {view !== "welcome" && <PostingStreakBadge className={styles.pill} />}
          {/* Five quick taps switch on developer mode (hidden from users on purpose). */}
          <span className={styles.pill} data-tone={fresh.tone} role="status" onClick={onStatusTap}>
            <span className={styles.dot} aria-hidden="true" />
            {fresh.label}
          </span>
          {view === "simulated" && <span className={styles.pill}>Simulated view</span>}
          {cloudsHidden && !indoorBlocked && (
            <span className={styles.pill}>{effectiveVis.reason === "night" ? "Night" : "Indoors"} · clouds shown where they are</span>
          )}
          {debug && view === "camera" && (
            <button
              type="button"
              className={styles.signInButton}
              onClick={() => setVisOverride((o) => (o === "auto" ? "visible" : o === "visible" ? "hidden" : "auto"))}
              aria-label="Developer: force cloud visibility"
            >
              Clouds: {visOverride}
            </button>
          )}
          {debug && (
            <button type="button" className={styles.signInButton} onClick={() => setDeveloperMode(false)} aria-label="Developer mode is on. Switch to user mode">
              Developer
            </button>
          )}
          {view === "camera" && !indoorBlocked && (
            <button type="button" className={styles.signInButton} onClick={() => setCalibrating((c) => !c)} aria-pressed={calibrating}>
              <Compass size={16} aria-hidden="true" />
              {matched && !cloudsHidden
                ? "Matched to visible clouds"
                : declination === null
                  ? "Compass uncorrected"
                  : "Approximate positions"}
            </button>
          )}
          {view === "map" && !viewerIsReal && (
            <span className={styles.pill}>Showing Troy, NY</span>
          )}
          {view === "camera" && locationOff && !viewerIsReal && (
            <span className={styles.pill}>
              Location off · assuming Troy, NY
            </span>
          )}
          {view !== "welcome" && !indoorBlocked && !composing && !sheetItem && (
            <button
              type="button"
              className={styles.signInButton}
              onClick={() => setCreatingCloud(true)}
            >
              Draw a cloud
            </button>
          )}
        </div>
        {view !== "welcome" && (
          <AccountButton className={styles.signInButton} />
        )}
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
          onMap={mapAllowed ? () => setView("map") : undefined}
          onSimulated={debug ? () => setView("simulated") : undefined}
        />
      )}

      {view !== "welcome" && !showPanel && !composing && (
        <div className={styles.bottomDock}>
          <div className={styles.dockSide}>
          {view !== "map" && (
            <SnapshotButton capture={capture} className={styles.roundButton} iconOnly notify={notify} />
          )}
          {view === "map" ? (
            !handheld && !debug ? (
              <span />
            ) : (
            <button type="button" className={styles.roundButton} onClick={() => (handheld ? void lookUp() : setView("simulated"))} aria-label={handheld ? "Back to the camera sky" : "Simulated sky view"}>
              {handheld ? <Camera size={20} aria-hidden="true" /> : <Orbit size={20} aria-hidden="true" />}
            </button>
            )
          ) : mapAllowed ? (
            <button type="button" className={styles.roundButton} onClick={() => leaveCamera("map")} aria-label="Show the map">
              <MapIcon size={20} aria-hidden="true" />
            </button>
          ) : null}
          </div>
          {/* Keyed by its text: iOS Safari leaves stale glyphs behind a backdrop-filter when text changes in place. */}
          {hint ? <div key={nodeText(hint)} className={styles.hint}>{hint}</div> : <span className={styles.hintSpacer} />}
          {view === "simulated" && (
            <button
              type="button"
              className={styles.roundButton}
              onClick={() => setView("welcome")}
              aria-label="Leave the simulated sky"
            >
              <X size={20} aria-hidden="true" />
            </button>
          )}
          {!placingNow && !indoorBlocked && clouds.length > 0 ? (
            <button type="button" className={`${styles.roundButton} ${styles.postButton}`} onClick={startPost} aria-label="Write a post on a cloud">
              <CloudIcon size={40} strokeWidth={1.75} aria-hidden="true" />
            </button>
          ) : (
            <span className={styles.postButton} aria-hidden="true" style={{ visibility: "hidden" }} />
          )}
        </div>
      )}

      {showPanel && selected && (
        <CloudPanel
          item={selected}
          viewer={viewer}
          onClose={() => setSelectedId(null)}
          onOpen={() => setSheetId(selected.cloud.id)}
        />
      )}

      {activeDraft && draftCloud && (
        <div hidden={placingNow}>
          <Composer
            item={draftCloud}
            anchor={activeDraft.anchor}
            viewer={viewer}
            onCancel={cancelPost}
            onPublished={onPublished}
            onStale={onStale}
            onDraft={onDraftText}
            onMoveSpot={() => setPlacing(true)}
          />
        </div>
      )}

      {sheetItem && (
        <CloudSheet
          key={`${sheetItem.cloud.id}:${auth.userId ?? "anonymous"}`}
          item={sheetItem}
          viewer={viewer}
          onClose={() => setSheetId(null)}
        />
      )}
      {creatingCloud && !indoorBlocked && (
        <CloudCreator
          viewer={viewer}
          datasetId={datasetId}
          onCreated={onCloudCreated}
          onClose={() => setCreatingCloud(false)}
        />
      )}

      {debug && <DebugHud snapshot={debugSnapshot} />}
      {/* User mode: hide the Next.js dev error overlay and issue badge (dev server only). */}
      {!debug && <style>{"nextjs-portal{display:none!important}"}</style>}

      {/* Portrait only: the camera view's alignment and layout assume an upright phone. */}
      <div className={styles.rotate} role="alert">
        Turn your phone upright to use Drift.
      </div>
    </main>
  );
}

function noop() {}

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
}

/** Plain text of a small React node (for keys). */
function nodeText(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: React.ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}
