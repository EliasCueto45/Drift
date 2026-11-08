"use client";
import { useEffect, useRef, type KeyboardEvent, type MutableRefObject, type PointerEvent } from "react";
import { ringsRect, type Rect } from "./focusGeometry";
import type { Anchor, CloudWithPreviews, Freshness, Message } from "@/lib/contracts";
import { usePosts } from "@/features/composer/posts";
import { DEG } from "./geo";
import { visibleHfovDeg } from "./orientation";
import type { CameraPose } from "./projection";
import { drawFootprintGlow, drawSimulatedSky, drawVaporText, layoutPosts, setVaporFont, skyExcerpt, vaporFont, type PlacedPost } from "./render";
import { acceptShift, bestShift, correctionFromShift, frameUsable, rasterize, segmentFrame, type RegistrationState } from "./registration";
import { TAP_TOLERANCE_PX, anchorOnCloud, buildScene, nearestOffscreen, pickCloud, type SceneCloud } from "./scene";
import type { SkyProjection } from "./projection";
import { drawVirtualClouds, layoutVirtualClouds } from "./virtualClouds";
import { useLatest } from "@/lib/useLatest";
import { captureSkyImage, type SnapshotCapture } from "./snapshot";
import styles from "./sky.module.css";

export interface SceneSummary {
  visible: number;
  total: number;
  aimId: string | null;
  turn: { id: string; turnDeg: number } | null;
}

/** Result of one camera-to-satellite registration pass (docs/decisions/0004). */
export interface RegistrationReport {
  state: RegistrationState;
  /** Incremental pose correction to apply; zero unless `accepted`. */
  dAzDeg: number;
  dElDeg: number;
  accepted: boolean;
  score: number | null;
  baseScore: number | null;
  cloudFraction: number;
  validFraction: number;
  ms: number;
}

/** Freeze-frame access for the cloud focus zoom (CloudFocus). */
export interface SkyCapture {
  /** Camera frame (cover-cropped as shown) with the sky canvas on top; no DOM controls. */
  snapshot: () => HTMLCanvasElement | null;
  /** The cloud's screen box right now, or null when it is off screen. */
  cloudRect: (id: string) => Rect | null;
}

export interface Draft {
  cloudId: string;
  anchor: Anchor;
  text: string;
}

interface Props {
  onCaptureReady?: (capture: SnapshotCapture | null) => void;
  snapshotLabel?: string;
  mode: "camera" | "simulated";
  stream: MediaStream | null;
  getPose: () => Omit<CameraPose, "hfovDeg"> | null;
  clouds: CloudWithPreviews[];
  freshness: Freshness | null;
  selectedId: string | null;
  placing: boolean;
  draft: Draft | null;
  onTap: (id: string | null) => void;
  onOpen: (id: string) => void;
  /** `at`: the tapped screen point, for zooming into the chosen spot. */
  onPlace: (cloudId: string, anchor: Anchor, at?: { x: number; y: number }) => void;
  onPlaceMiss: () => void;
  onPan?: (dAzDeg: number, dElDeg: number) => void;
  onSummary: (s: SceneSummary) => void;
  label: string;
  /** False behind the welcome sheet: the sky drifts but nothing is selectable. */
  interactive: boolean;
  /** The post just published: it settles into the cloud from its draft state. */
  settle: { id: string; at: number } | null;
  /** Camera mode: called a few times a second with the registration result. */
  onRegister?: (r: RegistrationReport) => void;
  /** Draw the cloud mask thumbnail (debug). */
  debug?: boolean;
  /**
   * Camera mode when real clouds can't be seen (night, indoors): draw photo cut-out clouds at
   * the tracked footprints, tinted for day or night, and stop camera cloud matching.
   */
  virtualClouds?: "off" | "day" | "night";
  captureRef?: MutableRefObject<SkyCapture | null>;
}

const SETTLE_MS = 600;
const VIRTUAL_FADE_MS = 600;

const REGISTER_EVERY_MS = 333;
/** Mask width in pixels; enough for cloud-scale shapes, cheap enough for a phone. */
const MASK_W = 120;
const MAX_TURN_DEG = 15;
const MAX_TILT_DEG = 6;
/** Below this elevation the camera sees trees and buildings, not sky. */
const MIN_SKY_ELEVATION_SIN = Math.sin(4 * DEG);

export function SkyStage(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const propsRef = useLatest(props);
  const { created, vote } = usePosts();
  const postsRef = useLatest({ created, vote });
  const sceneRef = useRef<{ clouds: SceneCloud[]; projection: SkyProjection } | null>(null);
  const captureFrameRef = useRef<SnapshotCapture | null>(null);
  const onCaptureReady = props.onCaptureReady;

  useEffect(() => {
    onCaptureReady?.(() => {
      if (!captureFrameRef.current) throw new Error("Wait for the sky to appear, then try again.");
      return captureFrameRef.current();
    });
    return () => { onCaptureReady?.(null); };
  }, [onCaptureReady]);

  // Freeze-frame for the focus zoom: what the person sees, minus every control.
  const { captureRef } = props;
  useEffect(() => {
    if (!captureRef) return;
    captureRef.current = {
      snapshot() {
        const canvas = canvasRef.current;
        if (!canvas || !canvas.width) return null;
        const out = document.createElement("canvas");
        out.width = canvas.width;
        out.height = canvas.height;
        const ctx = out.getContext("2d");
        if (!ctx) return null;
        const video = videoRef.current;
        if (video && video.videoWidth && propsRef.current.mode === "camera") {
          // Same crop as the video's object-fit: cover.
          const cover = Math.max(out.width / video.videoWidth, out.height / video.videoHeight);
          const sw = out.width / cover;
          const sh = out.height / cover;
          ctx.drawImage(video, (video.videoWidth - sw) / 2, (video.videoHeight - sh) / 2, sw, sh, 0, 0, out.width, out.height);
        }
        ctx.drawImage(canvas, 0, 0);
        return out;
      },
      cloudRect(id) {
        const scene = sceneRef.current;
        const canvas = canvasRef.current;
        const cloud = scene?.clouds.find((c) => c.id === id);
        if (!cloud || !canvas) return null;
        const box = canvas.getBoundingClientRect();
        return ringsRect(cloud.rings, { width: box.width, height: box.height });
      },
    };
    return () => {
      captureRef.current = null;
    };
  }, [captureRef, propsRef]);

  // Canvas text needs the resolved next/font family; re-read once the face has loaded.
  useEffect(() => {
    const apply = () => setVaporFont(getComputedStyle(document.documentElement).getPropertyValue("--font-ui").trim());
    apply();
    void document.fonts?.load(vaporFont(24)).then(apply, () => undefined);
    document.fonts?.addEventListener("loadingdone", apply);
    return () => document.fonts?.removeEventListener("loadingdone", apply);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = props.stream;
    if (props.stream) void video.play().catch(() => undefined);
  }, [props.stream]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;
    let size = { width: 0, height: 0, dpr: 1 };
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      size = { width: rect.width, height: rect.height, dpr };
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    let lastSummary = 0;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let lastRegister = 0;
    const grab = document.createElement("canvas");
    const grabCtx = grab.getContext("2d", { willReadFrequently: true });
    const thumb = document.createElement("canvas");
    const thumbCtx = thumb.getContext("2d");
    let fade = 0;
    let fadeTint: "day" | "night" = "day";
    let lastFrameAt = 0;


    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const p = propsRef.current;
      const base = p.getPose();
      const { width, height, dpr } = size;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (!base || width === 0) return;
      const video = videoRef.current;
      const stream = video && video.videoWidth ? { width: video.videoWidth, height: video.videoHeight } : null;
      const pose: CameraPose = { ...base, hfovDeg: visibleHfovDeg({ width, height }, p.mode === "camera" ? stream : null) };
      const extra: Record<string, Message[]> = postsRef.current.created;
      const scene = buildScene(p.clouds, pose, { width, height }, p.freshness, extra);
      sceneRef.current = scene;

      const virtual = p.mode === "camera" ? (p.virtualClouds ?? "off") : "off";
      const matching = virtual === "off" && Boolean(p.onRegister);
      let pixels: Uint8ClampedArray | null = null;
      let t0 = 0;
      if (p.mode === "camera" && video && stream && grabCtx && matching && now - lastRegister > REGISTER_EVERY_MS) {
        lastRegister = now;
        t0 = performance.now();
        // Same crop as the object-fit: cover video, downscaled.
        const mw = MASK_W;
        const mh = Math.round((MASK_W * height) / width);
        const cover = Math.max(width / stream.width, height / stream.height);
        const sw = width / cover;
        const sh = height / cover;
        if (grab.width !== mw || grab.height !== mh) {
          grab.width = mw;
          grab.height = mh;
        }
        grabCtx.drawImage(video, (stream.width - sw) / 2, (stream.height - sh) / 2, sw, sh, 0, 0, mw, mh);
        pixels = grabCtx.getImageData(0, 0, mw, mh).data;
      }
      if (matching && p.onRegister && pixels) {
        const mw = grab.width;
        const mh = grab.height;
        const k = width / mw;
        const proj = scene.projection;
        const mask = segmentFrame(pixels, mw, mh, (x, y) => proj.rayAt((x + 0.5) * k, (y + 0.5) * k)[2] > MIN_SKY_ELEVATION_SIN);
        const rings = scene.clouds.flatMap((c) => c.rings.map((r) => r.map((pt) => ({ x: pt.x / k, y: pt.y / k }))));
        const model = rasterize(rings, mw, mh);
        const unusable = frameUsable(mask);
        const fPx = proj.focalPx / k;
        const r = unusable ? null : bestShift(mask, model, Math.ceil(fPx * Math.tan(MAX_TURN_DEG * DEG)), Math.ceil(fPx * Math.tan(MAX_TILT_DEG * DEG)));
        const accepted = Boolean(r && acceptShift(r));
        const c =
          r && accepted
            ? correctionFromShift((x, y) => proj.rayAt(x, y), { x: width / 2, y: height / 2 }, { x: width / 2 + r.dx * k, y: height / 2 + r.dy * k })
            : { dAzDeg: 0, dElDeg: 0 };
        const state: RegistrationState = unusable ?? (!r ? "no-clouds" : accepted || (r.baseScore > 0.35 && r.coverage > 0.5) ? "matched" : "searching");
        p.onRegister({
          state,
          ...c,
          accepted,
          score: r?.score ?? null,
          baseScore: r?.baseScore ?? null,
          cloudFraction: mask.cloudFraction,
          validFraction: mask.validFraction,
          ms: performance.now() - t0,
        });
        if (p.debug && thumbCtx) {
          // Thumbnail: cloud white, sky blue, unusable black, tracked outlines tinted red.
          thumb.width = mw;
          thumb.height = mh;
          const img = thumbCtx.createImageData(mw, mh);
          for (let i = 0; i < mw * mh; i++) {
            const v = mask.cloud[i]! * 255;
            const on = model[i] ? 1 : 0;
            img.data.set(mask.valid[i] ? [Math.min(255, v + on * 120), v * (1 - on * 0.5), on ? v * 0.5 : 255, 255] : [on * 160, 0, 0, 255], i * 4);
          }
          thumbCtx.putImageData(img, 0, 0);
        }
      }

      // Virtual clouds fade in and out as real clouds stop or start being visible.
      const dt = lastFrameAt ? now - lastFrameAt : 0;
      lastFrameAt = now;
      if (virtual !== "off") fadeTint = virtual;
      const target = virtual !== "off" ? 1 : 0;
      fade = reducedMotion.matches ? target : target > fade ? Math.min(target, fade + dt / VIRTUAL_FADE_MS) : Math.max(target, fade - dt / VIRTUAL_FADE_MS);

      if (p.mode === "simulated") {
        const horizonY = height / 2 + scene.projection.focalPx * Math.tan(pose.elevationDeg * DEG);
        drawSimulatedSky(ctx, width, height, horizonY);
        drawVirtualClouds(ctx, layoutVirtualClouds(scene.clouds, scene.projection, { width, height }), "day", 1);
      } else if (fade > 0) {
        drawVirtualClouds(ctx, layoutVirtualClouds(scene.clouds, scene.projection, { width, height }), fadeTint, fade);
      }

      // No aiming: clouds are chosen by tapping them. The selected one glows.
      for (const c of scene.clouds) if (c.id === p.selectedId) drawFootprintGlow(ctx, c.rings, 1);

      const votes = (id: string, fallback: number) => {
        const msg = { id, voteCount: fallback, viewerHasUpvoted: false } as Message;
        return postsRef.current.vote(msg).voteCount;
      };
      const draftPost = p.draft ? draftLayout(ctx, scene, p.draft, now) : null;
      const placed = layoutPosts(ctx, scene.clouds, {
        selectedId: p.selectedId,
        viewport: { width, height },
        votes,
        reserved: draftPost ? [draftPost] : [],
        priorityId: p.settle?.id ?? null,
      });
      const capturedFade = fade;
      const capturedTint = fadeTint;
      // Paint a separate clean frame, not a screenshot of DOM controls or the debug canvas.
      captureFrameRef.current = () => {
        if (p.mode === "camera" && !videoRef.current) throw new Error("Wait for the camera, then try again.");
        return captureSkyImage({
        width, height, pixelRatio: dpr,
        video: p.mode === "camera" ? videoRef.current : null,
        draw: (photo) => {
          if (p.mode === "simulated") {
            const horizonY = height / 2 + scene.projection.focalPx * Math.tan(pose.elevationDeg * DEG);
            drawSimulatedSky(photo, width, height, horizonY);
            drawVirtualClouds(photo, layoutVirtualClouds(scene.clouds, scene.projection, { width, height }), "day", 1);
          } else if (capturedFade > 0) {
            drawVirtualClouds(photo, layoutVirtualClouds(scene.clouds, scene.projection, { width, height }), capturedTint, capturedFade);
          }
          const notes = layoutPosts(photo, scene.clouds, { selectedId: null, viewport: { width, height }, votes });
          for (const note of notes) drawVaporText(photo, note);
          const label = p.snapshotLabel ?? (capturedFade > 0 ? "Illustrated clouds" : null);
          if (label) {
            photo.save();
            photo.font = "12px system-ui, sans-serif";
            photo.fillStyle = "#fff";
            photo.shadowColor = "#000";
            photo.shadowBlur = 4;
            photo.fillText(label, 12, height - 14);
            photo.restore();
          }
        },
        });
      };
      const reduce = reducedMotion.matches;
      for (const post of placed) {
        const t = p.settle && post.id === p.settle.id && !reduce ? (now - p.settle.at) / SETTLE_MS : 1;
        if (t < 1) {
          // Settle: the draft's soft, pulsing words firm up and ease to their final size.
          const e = 1 - Math.pow(1 - Math.max(0, t), 3);
          drawVaporText(ctx, { ...post, size: 24 + (post.size - 24) * e, alpha: 0.85 + (post.alpha - 0.85) * e, soften: 1 + 1.6 * (1 - e) });
        } else drawVaporText(ctx, post);
      }
      drawDraft(ctx, draftPost);
      if (p.debug && p.mode === "camera" && thumb.width) {
        const tw = 120;
        const th = (tw * thumb.height) / thumb.width;
        ctx.globalAlpha = 0.9;
        ctx.drawImage(thumb, width - tw - 8, height - th - 96, tw, th);
        ctx.globalAlpha = 1;
      }

      if (now - lastSummary > 400) {
        lastSummary = now;
        const turn = nearestOffscreen(scene.clouds, pose);
        p.onSummary({
          visible: scene.clouds.filter((c) => c.visible).length,
          total: scene.clouds.length,
          aimId: null,
          turn: turn ? { id: turn.id, turnDeg: turn.turnDeg } : null,
        });
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      captureFrameRef.current = null;
    };
  }, [propsRef, postsRef]);

  // Pointer: tap selects / places, double tap opens, drag pans the simulated view.
  const gesture = useRef<{ x: number; y: number; id: number; dragged: boolean } | null>(null);
  const lastTap = useRef<{ id: string; at: number } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    gesture.current = { x: e.clientX, y: e.clientY, id: e.pointerId, dragged: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId || props.mode !== "simulated" || !props.onPan) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.dragged && Math.hypot(dx, dy) < 6) return;
    g.dragged = true;
    const scene = sceneRef.current;
    const degPerPx = scene ? 1 / (scene.projection.focalPx * DEG) : 0.1;
    props.onPan(-dx * degPerPx, dy * degPerPx);
    g.x = e.clientX;
    g.y = e.clientY;
  };
  const onPointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g || g.dragged) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const scene = sceneRef.current;
    if (!scene) return;
    if (props.placing) {
      // Choosing where a new post goes: any cloud under the finger, at the exact tap spot.
      const hit = pickCloud(scene.clouds, x, y, null, TAP_TOLERANCE_PX);
      const target = hit ? scene.clouds.find((c) => c.id === hit) : undefined;
      const anchor = target ? anchorOnCloud(target, scene.projection, x, y) : null;
      if (target && anchor) props.onPlace(target.id, anchor, { x, y });
      else props.onPlaceMiss();
      return;
    }
    const id = pickCloud(scene.clouds, x, y, props.selectedId, TAP_TOLERANCE_PX);
    const now = performance.now();
    const prev = lastTap.current;
    const hitSame = id && prev && now - prev.at < 340 && (prev.id === id || props.selectedId === prev.id);
    if (hitSame && prev) {
      lastTap.current = null;
      props.onOpen(prev.id);
      return;
    }
    lastTap.current = id ? { id, at: now } : null;
    props.onTap(id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLCanvasElement>) => {
    if (props.mode !== "simulated" || !props.onPan) return;
    const step = e.shiftKey ? 10 : 3;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const m = moves[e.key];
    if (m) {
      e.preventDefault();
      props.onPan(m[0], m[1]);
    }
  };

  return (
    <div className={styles.stage}>
      {props.mode === "camera" && <video ref={videoRef} className={styles.video} playsInline muted autoPlay aria-hidden="true" />}
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        role="img"
        aria-label={props.label}
        tabIndex={props.mode === "simulated" ? 0 : -1}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (gesture.current = null)}
        onKeyDown={onKeyDown}
        data-placing={props.placing || undefined}
      />
    </div>
  );
}

/** The draft's own label, laid out first so existing posts make room for it. */
function draftLayout(ctx: CanvasRenderingContext2D, scene: { clouds: SceneCloud[]; projection: SkyProjection }, draft: Draft, now: number): PlacedPost | null {
  const cloud = scene.clouds.find((c) => c.id === draft.cloudId);
  if (!cloud) return null;
  const p = scene.projection.projectUnclipped(draft.anchor, cloud.heightM);
  if (!p) return null;
  const size = 24;
  ctx.font = vaporFont(size);
  const lines = draft.text.trim() ? wrapSimple(ctx, skyExcerpt(draft.text), 240) : [];
  const width = lines.length ? Math.max(...lines.map((l) => ctx.measureText(l).width)) : 24;
  return {
    id: "draft",
    cloudId: cloud.id,
    lines,
    x: p.x,
    y: p.y,
    size,
    width,
    height: Math.max(1, lines.length) * size * 1.08,
    alpha: 0.82 + 0.18 * Math.sin(now / 420),
    certainty: "measured",
    draft: true,
  };
}

function drawDraft(ctx: CanvasRenderingContext2D, post: PlacedPost | null) {
  if (!post) return;
  const p = post;
  const breathe = post.alpha;
  if (post.lines.length) {
    drawVaporText(ctx, post);
  } else {
    ctx.save();
    ctx.globalAlpha = breathe;
    ctx.shadowColor = "rgba(46, 70, 102, 0.6)";
    ctx.shadowBlur = 4 * (ctx.getTransform().a || 1);
    ctx.shadowOffsetY = 1.5 * (ctx.getTransform().a || 1);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function wrapSimple(ctx: CanvasRenderingContext2D, text: string, max: number) {
  const out: string[] = [];
  let line = "";
  for (const w of text.split(" ")) {
    const t = line ? line + " " + w : w;
    if (ctx.measureText(t).width > max && line) {
      out.push(line);
      line = w;
    } else line = t;
  }
  if (line) out.push(line);
  return out.slice(0, 3);
}
