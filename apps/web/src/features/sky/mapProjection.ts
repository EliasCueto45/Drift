/**
 * Top-down map for the 2D fallback: local azimuthal-equidistant approximation around a
 * center (accurate to well under 0.1% inside the 50 km discovery radius). North is up.
 */
import type { Anchor } from "@/lib/contracts";
import { DEG } from "./geo";

const R = 6371008.8;

export class MapProjection {
  private readonly cosLat: number;
  constructor(
    readonly center: Anchor,
    /** CSS pixels per meter. */
    readonly scale: number,
    readonly viewport: { width: number; height: number },
  ) {
    this.cosLat = Math.cos(center.latitude * DEG);
  }

  toScreen(p: Anchor): { x: number; y: number } {
    const east = (p.longitude - this.center.longitude) * DEG * R * this.cosLat;
    const north = (p.latitude - this.center.latitude) * DEG * R;
    return { x: this.viewport.width / 2 + east * this.scale, y: this.viewport.height / 2 - north * this.scale };
  }

  toGeo(x: number, y: number): Anchor {
    const east = (x - this.viewport.width / 2) / this.scale;
    const north = (this.viewport.height / 2 - y) / this.scale;
    return {
      longitude: this.center.longitude + east / (R * this.cosLat) / DEG,
      latitude: this.center.latitude + north / R / DEG,
    };
  }

  ring(ring: number[][]) {
    return ring.map(([lng, lat]) => this.toScreen({ longitude: lng!, latitude: lat! }));
  }

  /** Move the center by a screen-space drag. */
  panned(dx: number, dy: number): MapProjection {
    const c = this.toGeo(this.viewport.width / 2 - dx, this.viewport.height / 2 - dy);
    return new MapProjection(c, this.scale, this.viewport);
  }

  zoomed(factor: number, minScale = 0.004, maxScale = 0.5): MapProjection {
    return new MapProjection(this.center, Math.min(maxScale, Math.max(minScale, this.scale * factor)), this.viewport);
  }
}
