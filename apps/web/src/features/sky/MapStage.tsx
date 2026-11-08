"use client";
import { Minus, Plus, LocateFixed } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import type { Anchor, CloudWithPreviews, Message } from "@/lib/contracts";
import { linkLabel, usePosts } from "@/features/composer/posts";
import { cloudTitle } from "./describe";
import { directionTo, groundDistanceM, multiPolygonContains, ringCentroid } from "./geo";
import { MapProjection } from "./mapProjection";
import { cloudPuffs, skyExcerpt } from "./render";
import styles from "./map.module.css";

/**
 * 2D fallback: the same clouds seen from above, as satellite imagery would show them.
 * Every action from the camera view works here, including from the keyboard.
 */
export function MapStage({
  clouds,
  viewer,
  viewerIsReal,
  selectedId,
  placing,
  draft,
  onSelect,
  onOpen,
  onPlace,
  onPlaceMiss,
}: {
  clouds: CloudWithPreviews[];
  viewer: Anchor;
  viewerIsReal: boolean;
  selectedId: string | null;
  placing: boolean;
  draft: { cloudId: string; anchor: Anchor; text: string } | null;
  onSelect: (id: string | null) => void;
  onOpen: (id: string) => void;
  onPlace: (cloudId: string, anchor: Anchor) => void;
  onPlaceMiss: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 390, height: 844 });
  const [view, setView] = useState({ center: viewer, scale: 0.02 });
  const { created, vote } = usePosts();

  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Fit the scale so the nearest clouds and the viewer fit on first show.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || !clouds.length || size.width < 10) return;
    fitted.current = true;
    const far = Math.max(
      3000,
      ...clouds.slice(0, 6).map((c) => groundDistanceM(viewer, ringCentroid((c.cloud.geometry.coordinates[0]?.[0] ?? []) as number[][])) + 3000),
    );
    setView({ center: viewer, scale: Math.min(size.width, size.height) / 2 / Math.min(far, 30000) });
  }, [clouds, size, viewer]);

  const map = useMemo(() => new MapProjection(view.center, view.scale, size), [view, size]);

  const drag = useRef<{ x: number; y: number; moved: boolean; id: number } | null>(null);
  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    drag.current = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId };
  };
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 6) return;
    if (!d.moved) e.currentTarget.setPointerCapture(e.pointerId);
    d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    setView((v) => {
      const next = new MapProjection(v.center, v.scale, size).panned(dx, dy);
      return { center: next.center, scale: v.scale };
    });
  };
  const onPointerUp = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const at = map.toGeo(e.clientX - rect.left, e.clientY - rect.top);
    placeOrSelect(at);
  };

  function hitCloud(at: Anchor) {
    const hits = clouds.filter((c) => multiPolygonContains(c.cloud.geometry.coordinates as number[][][][], at));
    if (!hits.length) return null;
    const i = hits.findIndex((c) => c.cloud.id === selectedId);
    return hits[(i + 1) % hits.length]!.cloud.id;
  }

  function placeOrSelect(at: Anchor) {
    if (placing) {
      const target = clouds.find((c) => c.cloud.id === selectedId);
      if (target && multiPolygonContains(target.cloud.geometry.coordinates as number[][][][], at)) onPlace(target.cloud.id, at);
      else onPlaceMiss();
      return;
    }
    onSelect(hitCloud(at));
  }

  const zoom = (f: number) => setView((v) => ({ center: v.center, scale: new MapProjection(v.center, v.scale, size).zoomed(f).scale }));
  const onWheel = (e: WheelEvent<SVGSVGElement>) => zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15);
  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    const step = e.shiftKey ? 120 : 40;
    const pan: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (pan[e.key]) {
      e.preventDefault();
      const [dx, dy] = pan[e.key]!;
      setView((v) => ({ center: new MapProjection(v.center, v.scale, size).panned(dx, dy).center, scale: v.scale }));
    } else if (e.key === "+" || e.key === "=") zoom(1.25);
    else if (e.key === "-") zoom(0.8);
    else if (e.key === "Enter" && placing) placeOrSelect(view.center);
  };

  const ring25 = 25000 * view.scale;
  const me = map.toScreen(viewer);
  // Low afternoon sun from the southwest: cloud shadows fall a little to the northeast.
  const shadowDx = 2000 * view.scale * 0.6;
  const shadowDy = -2000 * view.scale * 0.6;

  return (
    <div ref={wrapRef} className={styles.wrap}>
      <svg
        className={styles.svg}
        width={size.width}
        height={size.height}
        role="application"
        aria-roledescription="map"
        aria-label={`Map of clouds near ${viewerIsReal ? "you" : "Troy, NY"}. Arrow keys pan, plus and minus zoom.${placing ? " Press Enter to place your post at the crosshair." : ""}`}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (drag.current = null)}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
      >
        <defs>
          <radialGradient id="puff-lit">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.95" />
            <stop offset="0.45" stopColor="#f6f8fa" stopOpacity="0.7" />
            <stop offset="1" stopColor="#eef2f5" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="puff-shade">
            <stop offset="0" stopColor="#0b1210" stopOpacity="0.28" />
            <stop offset="1" stopColor="#05090b" stopOpacity="0" />
          </radialGradient>
          <filter id="vapor" x="-20%" y="-50%" width="140%" height="200%">
            <feDropShadow dx="0" dy="1.5" stdDeviation="1.4" floodColor="#2e4666" floodOpacity="0.7" />
          </filter>
        </defs>
        <circle cx={me.x} cy={me.y} r={ring25} className={styles.radius} />
        {clouds.map((c) => {
          const polys = c.cloud.geometry.coordinates as number[][][][];
          const d = polys.map((poly) => poly.map((ring) => "M" + map.ring(ring).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("L") + "Z").join("")).join("");
          const selected = c.cloud.id === selectedId;
          const centroid = ringCentroid((polys[0]?.[0] ?? []) as number[][]);
          const dir = directionTo({ ...viewer, height: 0 }, { ...centroid, height: 0 });
          const title = cloudTitle(groundDistanceM(viewer, centroid), dir.azimuthDeg);
          const count = c.previews.length + (created[c.cloud.id]?.length ?? 0);
          return (
            <g
              key={c.cloud.id}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              aria-label={`${title}${c.cloud.kind === "created" ? ", created cloud" : ""}, ${count ? `${count} post${count > 1 ? "s" : ""} nearby` : "no posts yet"}. Press Enter to select, twice to see all posts.`}
              className={styles.cloud}
              data-selected={selected || undefined}
              data-state={c.cloud.status}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  if (placing) return;
                  if (selected) onOpen(c.cloud.id);
                  else onSelect(c.cloud.id);
                }
              }}
              onDoubleClick={() => onOpen(c.cloud.id)}
            >
              {/* Seen from above: the same synthetic cumulus puffs as the sky view, with ground shadow. */}
              <g className={styles.cloudShade} transform={`translate(${shadowDx} ${shadowDy})`}>
                {puffsFor(c).map((p, i) => {
                  const q = map.toScreen(p.anchor);
                  return <circle key={i} cx={q.x} cy={q.y} r={p.radiusM * view.scale * 1.4} fill="url(#puff-shade)" />;
                })}
              </g>
              <g className={styles.cloudBody}>
                {puffsFor(c).map((p, i) => {
                  const q = map.toScreen(p.anchor);
                  return <circle key={i} cx={q.x} cy={q.y} r={p.radiusM * view.scale * 1.7} fill="url(#puff-lit)" />;
                })}
              </g>
              <path d={d} className={styles.cloudHit} fillRule="evenodd" />
            </g>
          );
        })}
        {layoutLabels(clouds.flatMap((c) => mapPosts(c, created[c.cloud.id] ?? [], selectedId, vote)), map, me, size.width).map((p) => {
          const s = p.at;
          return (
            <text key={p.id} x={s.x} y={s.y} className={styles.post} data-dim={p.dim || undefined} fontSize={p.size} filter="url(#vapor)">
              {p.text}
            </text>
          );
        })}
        {draft && (
          <circle cx={map.toScreen(draft.anchor).x} cy={map.toScreen(draft.anchor).y} r={8} className={styles.draft} />
        )}
        <g aria-hidden="true">
          <circle cx={me.x} cy={me.y} r={9} className={styles.meHalo} />
          <circle cx={me.x} cy={me.y} r={5} className={styles.me} />
        </g>
        {placing && (
          <g aria-hidden="true" className={styles.crosshair}>
            <line x1={size.width / 2 - 14} y1={size.height / 2} x2={size.width / 2 + 14} y2={size.height / 2} />
            <line x1={size.width / 2} y1={size.height / 2 - 14} x2={size.width / 2} y2={size.height / 2 + 14} />
          </g>
        )}
      </svg>
      <div className={styles.controls}>
        <button type="button" className={styles.ctl} onClick={() => zoom(1.25)} aria-label="Zoom in">
          <Plus size={20} strokeWidth={2.25} aria-hidden="true" />
        </button>
        <button type="button" className={styles.ctl} onClick={() => zoom(0.8)} aria-label="Zoom out">
          <Minus size={20} strokeWidth={2.25} aria-hidden="true" />
        </button>
        <button type="button" className={styles.ctl} onClick={() => setView((v) => ({ ...v, center: viewer }))} aria-label="Center on your position">
          <LocateFixed size={20} strokeWidth={2.25} aria-hidden="true" />
        </button>
      </div>
      <p className={styles.north} aria-hidden="true">
        N
      </p>
      {placing && (
        <button type="button" className={`drift-primary ${styles.placeHere}`} onClick={() => placeOrSelect(view.center)}>
          Place at the crosshair
        </button>
      )}
    </div>
  );
}

function puffsFor(c: CloudWithPreviews) {
  const geo = c.cloud.geometry.coordinates as number[][][][];
  return cloudPuffs(c.cloud.id, c.cloud.version, geo, (p) => multiPolygonContains(geo, p));
}

/** Highest-voted labels first; drop any that would overlap one already placed or the viewer dot. */
function layoutLabels<T extends { anchor: Anchor; text: string; size: number; votes: number }>(
  posts: T[],
  map: MapProjection,
  me: { x: number; y: number },
  width: number,
) {
  const placed: (T & { at: { x: number; y: number }; w: number; h: number })[] = [];
  for (const p of [...posts].sort((a, b) => b.votes - a.votes)) {
    const raw = map.toScreen(p.anchor);
    const w = p.text.length * p.size * 0.56;
    // Stay clear of the zoom controls on the right edge.
    const at = { x: Math.min(width - 68 - w / 2, Math.max(w / 2 + 8, raw.x)), y: raw.y };
    const h = p.size * 1.2;
    const clash =
      (Math.abs(at.x - me.x) < w / 2 + 10 && Math.abs(at.y - me.y) < h / 2 + 10) ||
      placed.some((q) => Math.abs(at.x - q.at.x) < (w + q.w) / 2 + 4 && Math.abs(at.y - q.at.y) < (h + q.h) / 2 + 2);
    if (!clash) placed.push({ ...p, at, w, h });
  }
  return placed;
}

/** Truncate at a word boundary, like the sky's wrapping. */
const short = (s: string) => {
  if (s.length <= 28) return s;
  const cut = s.slice(0, 28);
  const space = cut.lastIndexOf(" ");
  return (space > 12 ? cut.slice(0, space) : cut.slice(0, 27)).replace(/[\s,.;:]+$/, "") + "…";
};

function mapPosts(
  c: CloudWithPreviews,
  mine: Message[],
  selectedId: string | null,
  vote: (m: Message) => { voteCount: number },
) {
  const seen = new Set(mine.map((m) => m.id));
  return [...mine, ...c.previews.filter((m) => !seen.has(m.id))].map((m) => ({
    id: m.id,
    anchor: m.anchor,
    text: short(m.kind === "song" ? (m.songUrl ? linkLabel(m.songUrl) : "") : skyExcerpt(m.body ?? "")),
    size: Math.min(20, 14 + vote(m).voteCount),
    votes: vote(m).voteCount,
    dim: Boolean(selectedId && c.cloud.id !== selectedId),
  }));
}
