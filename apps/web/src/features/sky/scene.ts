/** Per-frame scene: where each cloud and post sits on screen for the current pose. */
import type { Anchor, CloudWithPreviews, Freshness, Message } from "@/lib/contracts";
import { directionTo, multiPolygonContains, ringCentroid } from "./geo";
import { cloudHeight, resolveHeights, screenPolygonContains, SkyProjection, type CameraPose, type Viewport } from "./projection";

/** How sure we are about a cloud's placement; drives the fill pattern. */
export type Certainty = "measured" | "estimated" | "stale";

export interface ScenePost {
  message: Message;
  x: number;
  y: number;
  onScreen: boolean;
}

export interface SceneCloud {
  id: string;
  item: CloudWithPreviews;
  heightM: number;
  certainty: Certainty;
  /** Projected outer rings (one per polygon), near-plane clipped. Empty when behind the viewer. */
  rings: { x: number; y: number }[][];
  /** Screen point of the outline's highest vertex; caption hangs from here. */
  top: { x: number; y: number } | null;
  distanceM: number;
  azimuthDeg: number;
  elevationDeg: number;
  /** Any part of the outline is inside the viewport. */
  visible: boolean;
  posts: ScenePost[];
}

export function certaintyOf(item: CloudWithPreviews, freshness: Freshness | null, poseEstimated: boolean): Certainty {
  if (freshness === "stale") return "stale";
  const h = cloudHeight(item.cloud);
  if (h.estimated || poseEstimated || item.cloud.status !== "active" || freshness === "estimated") return "estimated";
  return "measured";
}

export function buildScene(
  clouds: CloudWithPreviews[],
  pose: CameraPose,
  viewport: Viewport,
  freshness: Freshness | null,
  extraPosts: Record<string, Message[]> = {},
): { projection: SkyProjection; clouds: SceneCloud[] } {
  const projection = new SkyProjection(pose, viewport, 0);
  const viewer = { longitude: pose.longitude, latitude: pose.latitude, height: 0 };
  const out: SceneCloud[] = [];
  for (const item of clouds) {
    const h = cloudHeight(item.cloud);
    const heights = resolveHeights(pose, h.meters, h.reference);
    const heightM = heights.targetM - heights.viewerM;
    const outer = item.cloud.geometry.coordinates.map((poly) => (poly[0] ?? []) as number[][]);
    const rings = outer.map((ring) => projection.projectRing(ring, heightM)).filter((r) => r.length >= 3);
    const centroid = ringCentroid(outer[0] ?? []);
    const dir = directionTo(viewer, { ...centroid, height: heightM });
    let top: { x: number; y: number } | null = null;
    let visible = false;
    for (const ring of rings) {
      for (const p of ring) {
        if (p.x >= 0 && p.x <= viewport.width && p.y >= 0 && p.y <= viewport.height) visible = true;
        if (!top || p.y < top.y) top = p;
      }
      if (!visible && screenPolygonContains(ring, viewport.width / 2, viewport.height / 2)) visible = true;
    }
    const messages = mergeMessages(item.previews, extraPosts[item.cloud.id] ?? []);
    const posts: ScenePost[] = [];
    for (const message of messages) {
      const p = projection.projectUnclipped(message.anchor, heightM);
      if (!p) continue;
      posts.push({ message, x: p.x, y: p.y, onScreen: p.x >= 0 && p.x <= viewport.width && p.y >= 0 && p.y <= viewport.height });
    }
    out.push({
      id: item.cloud.id,
      item,
      heightM,
      certainty: certaintyOf(item, freshness, heights.estimated),
      rings,
      top: top && visible ? { x: clamp(top.x, 12, viewport.width - 12), y: Math.max(top.y, 56) } : null,
      distanceM: dir.distanceM,
      azimuthDeg: dir.azimuthDeg,
      elevationDeg: dir.elevationDeg,
      visible,
      posts,
    });
  }
  return { projection, clouds: out };
}

function mergeMessages(previews: Message[], extra: Message[]) {
  const seen = new Set(previews.map((m) => m.id));
  return [...previews, ...extra.filter((m) => !seen.has(m.id))];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Cloud under a screen point. Overlapping clouds are all selectable: repeated taps on the
 * same spot cycle nearest -> farthest starting after the current selection.
 */
export function pickCloud(scene: SceneCloud[], x: number, y: number, currentId: string | null = null, tolerancePx = 0): string | null {
  const hits = scene
    .filter((c) => c.rings.some((ring) => screenPolygonContains(ring, x, y) || (tolerancePx > 0 && edgeDistance(ring, x, y).d <= tolerancePx)))
    .sort((a, b) => a.distanceM - b.distanceM);
  if (!hits.length) return null;
  const index = hits.findIndex((c) => c.id === currentId);
  return hits[(index + 1) % hits.length]!.id;
}

/** Nearest cloud by angle when nothing is on screen, for a "turn this way" hint. */
export function nearestOffscreen(scene: SceneCloud[], pose: CameraPose) {
  let best: { id: string; turnDeg: number; elevationDeg: number } | null = null;
  for (const c of scene) {
    if (c.visible || c.elevationDeg < 0) continue;
    const turn = ((c.azimuthDeg - pose.azimuthDeg + 540) % 360) - 180;
    if (!best || Math.abs(turn) < Math.abs(best.turnDeg)) best = { id: c.id, turnDeg: turn, elevationDeg: c.elevationDeg };
  }
  return best;
}

/** Distance from a point to a screen polygon's edges, and the nearest edge point. */
function edgeDistance(ring: { x: number; y: number }[], x: number, y: number) {
  let best = { d: Infinity, x, y };
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    const px = a.x + t * dx;
    const py = a.y + t * dy;
    const d = Math.hypot(x - px, y - py);
    if (d < best.d) best = { d, x: px, y: py };
  }
  return best;
}

/** Finger tolerance for taps near a cloud's edge, in CSS pixels. */
export const TAP_TOLERANCE_PX = 24;

/**
 * Tap -> anchor on a specific cloud. A tap just outside the footprint (within finger
 * tolerance) moves to just inside the nearest edge; it never snaps to the cloud's center.
 */
export function anchorOnCloud(scene: SceneCloud, projection: SkyProjection, x: number, y: number): Anchor | null {
  if (!scene.rings.some((ring) => screenPolygonContains(ring, x, y))) {
    let near: { d: number; x: number; y: number; ring: { x: number; y: number }[] } | null = null;
    for (const ring of scene.rings) {
      const e = edgeDistance(ring, x, y);
      if (!near || e.d < near.d) near = { ...e, ring };
    }
    if (!near || near.d > TAP_TOLERANCE_PX) return null;
    // Step a few pixels from the edge point toward the inside along the tap direction.
    const len = Math.hypot(near.x - x, near.y - y) || 1;
    x = near.x + ((near.x - x) / len) * 4;
    y = near.y + ((near.y - y) / len) * 4;
    if (!screenPolygonContains(near.ring, x, y)) return null;
  }
  const anchor = projection.unproject(x, y, scene.heightM);
  // The server rejects anchors outside the footprint; check geographically, holes included.
  return anchor && multiPolygonContains(scene.item.cloud.geometry.coordinates as number[][][][], anchor) ? anchor : null;
}
