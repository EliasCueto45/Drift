/**
 * Zoom geometry for focusing on one cloud: the frozen sky frame scales up around the cloud
 * until the cloud fills the screen, without ever showing an edge of the frame.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FocusTransform {
  scale: number;
  tx: number;
  ty: number;
}

/** Never less than a clear zoom, never so much that the frozen frame turns to mush. */
export const MIN_ZOOM = 1.6;
export const MAX_ZOOM = 4;

/**
 * Scale and translate (transform-origin 0 0) that make `rect` cover the view, centred on
 * `center` (defaults to the rect's centre), clamped so the frame always covers the view.
 */
export function focusTransform(view: { width: number; height: number }, rect: Rect, center?: { x: number; y: number }): FocusTransform {
  const fill = Math.max(view.width / Math.max(rect.width, 1), view.height / Math.max(rect.height, 1));
  const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, fill));
  const cx = center?.x ?? rect.x + rect.width / 2;
  const cy = center?.y ?? rect.y + rect.height / 2;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return {
    scale,
    tx: clamp(view.width / 2 - scale * cx, view.width - scale * view.width, 0),
    ty: clamp(view.height / 2 - scale * cy, view.height - scale * view.height, 0),
  };
}

/** Screen bounding box of a cloud's projected rings, clipped to the view. Null when off screen. */
export function ringsRect(rings: { x: number; y: number }[][], view: { width: number; height: number }): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ring of rings)
    for (const p of ring) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(view.width, x1);
  y1 = Math.min(view.height, y1);
  if (!(x1 > x0 && y1 > y0)) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
