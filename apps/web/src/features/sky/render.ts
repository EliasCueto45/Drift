/**
 * Canvas drawing for the sky. Posts are written into the cloud as vapor: white letterforms
 * lit from above with a blue-grey shaded underside, so they read on bright cloud and on blue
 * sky without any card, outline or background. Only canvas shadows are used (no ctx.filter)
 * so Safari renders the same as Chrome.
 */
import type { Certainty, SceneCloud } from "./scene";

export interface PlacedPost {
  id: string;
  cloudId: string;
  lines: string[];
  x: number;
  y: number;
  size: number;
  width: number;
  height: number;
  alpha: number;
  certainty: Certainty;
  draft?: boolean;
  /** Extra softening (1 = none); the publish settle eases it back to 1. */
  soften?: number;
}

/** Canvas shadows ignore the transform; scale them by the device-pixel ratio in use. */
const px = (ctx: CanvasRenderingContext2D) => ctx.getTransform().a || 1;

/**
 * next/font registers the face under a generated family name, so the canvas must use the
 * resolved stack from the `--font-ui` variable (set by SkyStage once fonts load).
 */
let FONT_STACK = "system-ui, sans-serif";
export function setVaporFont(stack: string) {
  if (stack) FONT_STACK = `${stack}, system-ui, sans-serif`;
}
export function vaporFont(size: number) {
  return `600 ${size}px ${FONT_STACK}`;
}
const SKY_CHARS = 64;

/** Words shown in the sky; the full text lives in the panel. */
export function skyExcerpt(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > SKY_CHARS ? clean.slice(0, SKY_CHARS - 1).trimEnd() + "…" : clean;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines = 3) {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const test = line ? line + " " + word : word;
    if (ctx.measureText(test).width <= maxWidth || !line) line = test;
    else {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[maxLines - 1] = lines[maxLines - 1]!.replace(/\s*\S*$/, "") + "…";
  }
  return lines;
}

/** Size by distance (perspective) and by votes (popularity reads as larger letters). */
export function postSize(distanceM: number, votes: number) {
  // Subtle: small lettering that sits in the cloud rather than headlining it.
  const base = 19 * Math.sqrt(5000 / Math.max(800, distanceM));
  const boost = 1 + 0.05 * Math.min(votes, 6);
  return Math.max(12, Math.min(24, base * boost));
}

/**
 * Greedy layout: highest-ranked posts first; a post that would collide with one already
 * placed is dropped from the sky (it still lists in the panel). Returns what to draw.
 */
export function layoutPosts(
  ctx: CanvasRenderingContext2D,
  clouds: SceneCloud[],
  opts: {
    selectedId: string | null;
    viewport: { width: number; height: number };
    votes: (id: string, fallback: number) => number;
    /** Already-claimed areas (the draft being written) that posts must not cover. */
    reserved?: { x: number; y: number; width: number; height: number }[];
    /** A post that must win collisions (the one just published). */
    priorityId?: string | null;
  },
): PlacedPost[] {
  const candidates: (PlacedPost & { rank: number })[] = [];
  for (const cloud of clouds) {
    const dimmed = opts.selectedId && cloud.id !== opts.selectedId;
    cloud.posts.forEach((post, index) => {
      if (!post.onScreen) return;
      const m = post.message;
      const text = m.kind === "song" ? linkWord(m.songUrl) : m.body ?? "";
      if (!text) return;
      const votes = opts.votes(m.id, m.voteCount);
      const size = postSize(cloud.distanceM, votes);
      ctx.font = vaporFont(size);
      const lines = wrap(ctx, skyExcerpt(text), Math.min(opts.viewport.width * 0.62, size * 11));
      const width = Math.max(...lines.map((l) => ctx.measureText(l).width));
      const height = lines.length * size * 1.08;
      const stateAlpha = cloud.certainty === "stale" ? 0.55 : cloud.certainty === "estimated" ? 0.9 : 1;
      // Keep the whole label on screen near its spot; if that would slide it more than a
      // quarter of its width off the spot (onto open sky), leave it out of the sky instead.
      const half = width / 2 + 8;
      const x = Math.min(opts.viewport.width - half, Math.max(half, post.x));
      if (width + 16 > opts.viewport.width || Math.abs(x - post.x) > width * 0.25) return;
      candidates.push({
        id: m.id,
        cloudId: cloud.id,
        lines,
        x,
        y: post.y,
        size,
        width,
        height,
        alpha: stateAlpha * (dimmed ? 0.6 : 1),
        certainty: cloud.certainty,
        rank: (m.id === opts.priorityId ? 1e6 : 0) + (cloud.id === opts.selectedId ? 1000 : 0) + votes * 10 - index,
      });
    });
  }
  candidates.sort((a, b) => b.rank - a.rank);
  const placed: PlacedPost[] = [];
  const blocked = [...(opts.reserved ?? [])];
  for (const c of candidates) {
    const box = { l: c.x - c.width / 2 - 6, r: c.x + c.width / 2 + 6, t: c.y - c.height / 2 - 4, b: c.y + c.height / 2 + 4 };
    const hit = [...blocked, ...placed].some(
      (p) => box.l < p.x + p.width / 2 && box.r > p.x - p.width / 2 && box.t < p.y + p.height / 2 && box.b > p.y - p.height / 2,
    );
    if (!hit) placed.push(c);
  }
  return placed;
}

function linkWord(url: string | null) {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "").replace(/^open\./, "");
  } catch {
    return "";
  }
}

/** Post text colour: a cool mid-gray, like shading inside the cloud rather than ink on top. */
export const POST_INK = "rgb(92, 100, 112)";

/**
 * Gray lettering embedded in the cloud: no halo, slightly translucent and softly blurred so
 * it reads as part of the vapor at a distance. Less certain placements are drawn softer.
 */
export function drawVaporText(ctx: CanvasRenderingContext2D, p: PlacedPost) {
  ctx.save();
  ctx.font = vaporFont(p.size);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  const k = px(ctx);
  const lineH = p.size * 1.08;
  const top = p.y - ((p.lines.length - 1) * lineH) / 2;
  const soft = (p.certainty === "measured" ? 1 : p.certainty === "estimated" ? 1.5 : 2.4) * (p.soften ?? 1);
  const each = (draw: (line: string, y: number) => void) => p.lines.forEach((line, i) => draw(line, top + i * lineH));
  ctx.globalAlpha = p.alpha * 0.82;
  // Distance haze: a faint same-colour blur softens every edge; uncertainty adds more.
  ctx.shadowColor = "rgba(92, 100, 112, 0.6)";
  ctx.shadowBlur = (0.6 + Math.max(0, soft - 1)) * p.size * 0.08 * k;
  ctx.fillStyle = POST_INK;
  each((line, y) => ctx.fillText(line, p.x, y));
  ctx.restore();
}

/** Trace a projected cloud footprint as a path (all rings). */
function tracePath(ctx: CanvasRenderingContext2D, rings: { x: number; y: number }[][], dx = 0) {
  ctx.beginPath();
  for (const ring of rings) {
    ring.forEach((p, i) => (i ? ctx.lineTo(p.x + dx, p.y) : ctx.moveTo(p.x + dx, p.y)));
    ctx.closePath();
  }
}

/**
 * Feathered brightening of a footprint with no edge line: the selected or aimed cloud
 * glows slightly. Uses the off-canvas shadow trick so the blur works in every browser.
 */
export function drawFootprintGlow(ctx: CanvasRenderingContext2D, rings: { x: number; y: number }[][], strength: number) {
  if (!rings.length || strength <= 0) return;
  const off = 20000;
  ctx.save();
  ctx.shadowColor = `rgba(255, 255, 255, ${0.28 * strength})`;
  ctx.shadowBlur = (36) * px(ctx);
  ctx.shadowOffsetX = off * px(ctx);
  tracePath(ctx, rings, -off);
  ctx.fillStyle = "#000";
  ctx.fill("evenodd");
  ctx.restore();
}

export interface Puff {
  anchor: { longitude: number; latitude: number };
  radiusM: number;
  liftM: number;
}

const puffCache = new Map<string, Puff[]>();

function rng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

/**
 * Simulated view only: deterministic cumulus puffs scattered inside a footprint, fixed in
 * geographic space so the synthetic cloud holds still as the view pans. Always labeled synthetic.
 */
export function cloudPuffs(
  id: string,
  version: number,
  coordinates: number[][][][],
  contains: (p: { longitude: number; latitude: number }) => boolean,
  postAnchors: { longitude: number; latitude: number }[] = [],
): Puff[] {
  const key = `${id}@${version}:${postAnchors.map((a) => `${a.longitude.toFixed(5)},${a.latitude.toFixed(5)}`).join(";")}`;
  const hit = puffCache.get(key);
  if (hit) return hit;
  const ring = coordinates[0]?.[0] ?? [];
  const lngs = ring.map((p) => p[0]!);
  const lats = ring.map((p) => p[1]!);
  const [x0, x1, y0, y1] = [Math.min(...lngs), Math.max(...lngs), Math.min(...lats), Math.max(...lats)];
  const kmX = (x1 - x0) * 111.32 * Math.cos(((y0 + y1) / 2) * (Math.PI / 180));
  const kmY = (y1 - y0) * 110.57;
  const count = Math.round(Math.min(110, Math.max(14, kmX * kmY * 4)));
  const rand = rng(id);
  const puffs: Puff[] = [];
  for (let tries = 0; puffs.length < count && tries < count * 20; tries++) {
    const anchor = { longitude: x0 + rand() * (x1 - x0), latitude: y0 + rand() * (y1 - y0) };
    if (!contains(anchor)) continue;
    // Centered on the footprint plane so the body you see is where taps land.
    puffs.push({ anchor, radiusM: 300 + rand() * 360, liftM: -140 + rand() * 300 });
  }
  // A full puff (with a flanking pair) under every post, so words always sit in cloud, never sky.
  const mPerDegLng = 111320 * Math.cos(((y0 + y1) / 2) * (Math.PI / 180));
  for (const a of postAnchors) {
    puffs.push({ anchor: a, radiusM: 700, liftM: 0 });
    for (const dx of [-650, 650]) {
      const side = { longitude: a.longitude + dx / mPerDegLng, latitude: a.latitude };
      puffs.push({ anchor: contains(side) ? side : a, radiusM: 520, liftM: 60 });
    }
  }
  puffCache.set(key, puffs);
  return puffs;
}

/** Draw projected puffs far to near: grey shaded base, then lit white body. */
export function drawPuffs(ctx: CanvasRenderingContext2D, puffs: { x: number; y: number; r: number; d: number }[]) {
  puffs.sort((a, b) => b.d - a.d);
  ctx.save();
  for (const p of puffs) {
    if (p.r < 1.5) continue;
    const shade = ctx.createRadialGradient(p.x, p.y + p.r * 0.3, 0, p.x, p.y + p.r * 0.3, p.r * 1.05);
    shade.addColorStop(0, "rgba(150, 166, 186, 0.55)");
    shade.addColorStop(1, "rgba(150, 166, 186, 0)");
    ctx.fillStyle = shade;
    ctx.fillRect(p.x - p.r * 1.1, p.y - p.r * 0.8, p.r * 2.2, p.r * 2.2);
    const lit = ctx.createRadialGradient(p.x, p.y - p.r * 0.15, 0, p.x, p.y - p.r * 0.15, p.r);
    lit.addColorStop(0, "rgba(255, 255, 255, 0.95)");
    lit.addColorStop(0.55, "rgba(250, 252, 254, 0.75)");
    lit.addColorStop(1, "rgba(245, 248, 251, 0)");
    ctx.fillStyle = lit;
    ctx.fillRect(p.x - p.r, p.y - p.r * 1.15, p.r * 2, p.r * 2);
  }
  ctx.restore();
}

/** Sky backdrop for the simulated view (no camera): horizon haze up to deeper blue. */
export function drawSimulatedSky(ctx: CanvasRenderingContext2D, width: number, height: number, horizonY: number) {
  const g = ctx.createLinearGradient(0, horizonY - height * 1.6, 0, horizonY);
  g.addColorStop(0, "#2f6db3");
  g.addColorStop(0.65, "#78abdc");
  g.addColorStop(1, "#cfe0ee");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);
  if (horizonY < height) {
    // Distant tree line in atmospheric haze, then darker near ground: reads as a horizon, not a slab.
    const ground = ctx.createLinearGradient(0, horizonY, 0, height);
    ground.addColorStop(0, "#9fb0aa");
    ground.addColorStop(0.08, "#6e7f72");
    ground.addColorStop(1, "#33402f");
    ctx.fillStyle = ground;
    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let x = 0; x <= width + 8; x += 8) {
      const ridge = 3 * Math.sin(x / 61) + 2.5 * Math.sin(x / 17 + 1.7) + 1.5 * Math.sin(x / 6.1);
      ctx.lineTo(x, horizonY - 5 - Math.max(0, ridge));
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fill();
    const haze = ctx.createLinearGradient(0, horizonY - 40, 0, horizonY + 24);
    haze.addColorStop(0, "rgba(214, 228, 238, 0)");
    haze.addColorStop(0.6, "rgba(214, 228, 238, 0.55)");
    haze.addColorStop(1, "rgba(214, 228, 238, 0)");
    ctx.fillStyle = haze;
    ctx.fillRect(0, horizonY - 40, width, 64);
  }
}
