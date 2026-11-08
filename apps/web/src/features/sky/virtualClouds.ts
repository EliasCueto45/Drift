"use client";
/**
 * Virtual clouds for when real ones can't be seen (night, indoors). Each tracked cloud is
 * drawn as one large photo cut-out of a real cumulus, centred on its footprint and sized to
 * it, so it holds still in the sky and frames the posts. The photo's outline does not follow
 * the satellite outline. A post that falls outside the photo gets a smaller cloud of its own.
 * Sprites come from public/clouds (see scripts/make_cloud_sprites.py); until they load, a
 * soft procedural puff is drawn instead.
 */
import { ringCentroid } from "./geo";
import type { SkyProjection, Viewport } from "./projection";
import { drawPuffs } from "./render";
import type { SceneCloud } from "./scene";

export interface VirtualCloud {
  /** Screen centre, px. */
  x: number;
  y: number;
  /** Drawn width, px. */
  width: number;
  /** Distance from the viewer, m (far-to-near ordering). */
  d: number;
  /** Stable per cloud or post: picks the photo and its mirroring. */
  seed: number;
}

interface Sprite {
  day: CanvasImageSource;
  night: CanvasImageSource;
  /** Height / width. */
  aspect: number;
}

/** Physical size of the drawn cloud, clamped so tiny or huge footprints still read as a cloud. */
const MIN_CLOUD_M = 1800;
const MAX_CLOUD_M = 9000;
/** Size of the extra cloud under a post that falls outside its cloud's photo. */
const POST_CLOUD_M = 1600;
/** Rough height/width of the photos; used to decide whether a post sits on the photo. */
const TYPICAL_ASPECT = 0.45;
/** A cloud carrying posts is drawn at least this wide so a wrapped post fits inside it. */
const MIN_POST_CLOUD_PX = 360;

let sprites: Sprite[] = [];
let started = false;

/** Starts loading on first use; returns whatever has loaded so far. */
export function cloudSprites(): Sprite[] {
  if (!started && typeof window !== "undefined") {
    started = true;
    void load();
  }
  return sprites;
}

async function load() {
  try {
    const res = await fetch("/clouds/manifest.json", { cache: "force-cache" });
    if (!res.ok) return;
    const { files } = (await res.json()) as { files: string[] };
    const images = await Promise.all(files.map((f) => loadImage(`/clouds/${f}`)));
    sprites = images.filter((i): i is HTMLImageElement => Boolean(i)).map((img) => ({ day: img, night: moonlit(img), aspect: img.naturalHeight / img.naturalWidth }));
  } catch {
    // No sprites: the procedural fallback keeps working.
  }
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Night variant: blue-grey and dimmer, but light enough that dark post text still reads. */
function moonlit(img: HTMLImageElement): CanvasImageSource {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d");
  if (!ctx) return img;
  ctx.drawImage(img, 0, 0);
  ctx.globalCompositeOperation = "source-atop";
  ctx.fillStyle = "rgba(58, 72, 104, 0.4)";
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

/** FNV-1a: the same cloud or post always gets the same photo. */
export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Photo index and mirroring for a seed. */
export function spriteChoice(seed: number, count: number) {
  return { index: count ? seed % count : 0, flip: ((seed >>> 8) & 1) === 1 };
}

/** One large cloud per tracked cloud, plus a small one under any post that falls off it. */
export function layoutVirtualClouds(clouds: SceneCloud[], projection: SkyProjection, viewport: Viewport): VirtualCloud[] {
  const out: VirtualCloud[] = [];
  const onScreen = (v: VirtualCloud) => v.x + v.width / 2 > 0 && v.x - v.width / 2 < viewport.width && v.y + v.width / 3 > 0 && v.y - v.width / 3 < viewport.height;
  for (const c of clouds) {
    const ring = (c.item.cloud.geometry.coordinates[0]?.[0] ?? []) as number[][];
    if (ring.length < 3) continue;
    const centroid = ringCentroid(ring);
    const lngs = ring.map((p) => p[0]!);
    const lats = ring.map((p) => p[1]!);
    const spanM = Math.max(
      (Math.max(...lngs) - Math.min(...lngs)) * 111320 * Math.cos(centroid.latitude * (Math.PI / 180)),
      (Math.max(...lats) - Math.min(...lats)) * 110574,
    );
    const sizeM = Math.min(MAX_CLOUD_M, Math.max(MIN_CLOUD_M, spanM));
    // Centre the photo on the cloud's posts (still a fixed geographic point), so the words sit
    // in the photo; a cloud without posts is centred on its footprint.
    const anchors = c.posts.map((p) => p.message.anchor);
    const centre = anchors.length
      ? { longitude: anchors.reduce((a, p) => a + p.longitude, 0) / anchors.length, latitude: anchors.reduce((a, p) => a + p.latitude, 0) / anchors.length }
      : centroid;
    const s = projection.projectUnclipped(centre, c.heightM);
    if (!s || s.distanceM < 300) continue;
    const geoWidth = (projection.focalPx * sizeM) / s.distanceM;
    const width = Math.min(Math.max(geoWidth, anchors.length ? MIN_POST_CLOUD_PX : 0), viewport.width * 4);
    const main: VirtualCloud = { x: s.x, y: s.y, width, d: s.distanceM, seed: hashSeed(c.id) };
    if (onScreen(main)) out.push(main);
    for (const post of c.posts) {
      const onPhoto = Math.abs(post.x - main.x) < main.width * 0.4 && Math.abs(post.y - main.y) < main.width * TYPICAL_ASPECT * 0.35;
      if (onPhoto) continue;
      const p = projection.projectUnclipped(post.message.anchor, c.heightM);
      if (!p || p.distanceM < 300) continue;
      const extra: VirtualCloud = { x: p.x, y: p.y, width: Math.max((projection.focalPx * POST_CLOUD_M) / p.distanceM, MIN_POST_CLOUD_PX * 0.85), d: p.distanceM, seed: hashSeed(post.message.id) };
      if (onScreen(extra)) out.push(extra);
    }
  }
  return out;
}

export function drawVirtualClouds(ctx: CanvasRenderingContext2D, clouds: VirtualCloud[], tint: "day" | "night", alpha: number) {
  if (alpha <= 0 || !clouds.length) return;
  const set = cloudSprites();
  const ordered = [...clouds].sort((a, b) => b.d - a.d);
  ctx.save();
  ctx.globalAlpha = alpha;
  if (!set.length) {
    drawPuffs(
      ctx,
      ordered.map((c) => ({ x: c.x, y: c.y, r: c.width / 2.6, d: c.d })),
    );
    ctx.restore();
    return;
  }
  for (const c of ordered) {
    if (c.width < 4) continue;
    const { index, flip } = spriteChoice(c.seed, set.length);
    const s = set[index]!;
    const h = c.width * s.aspect;
    const img = tint === "night" ? s.night : s.day;
    if (flip) {
      ctx.save();
      ctx.translate(c.x, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(img, -c.width / 2, c.y - h / 2, c.width, h);
      ctx.restore();
    } else ctx.drawImage(img, c.x - c.width / 2, c.y - h / 2, c.width, h);
  }
  ctx.restore();
}
