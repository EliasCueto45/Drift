"""Turn photos of cumulus on blue sky into transparent cloud sprites for the virtual clouds.

Usage (repo .venv has OpenCV and numpy):
    .venv/Scripts/python apps/web/scripts/make_cloud_sprites.py <photo_dir>

<photo_dir> holds the photos plus sources.json:
    [{"file": "a.jpg", "title": "...", "author": "...", "license": "CC0", "url": "https://..."}]

Writes apps/web/public/clouds/cloud-N.webp, manifest.json (read by virtualClouds.ts) and
CREDITS.md. Alpha uses the same red/blue cloudiness ramp as features/sky/registration.ts,
gated by brightness and saturation so ground and trees drop out; the blue sky is then
un-mixed from the soft edges so sprites have no blue fringe on other backgrounds.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np

OUT = Path(__file__).resolve().parents[1] / "public" / "clouds"
SPRITE_W = 512


def smoothstep(lo: float, hi: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - lo) / (hi - lo), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def cutout(bgr: np.ndarray) -> np.ndarray | None:
    scale = 1600 / max(bgr.shape[:2])
    if scale < 1:
        bgr = cv2.resize(bgr, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    f = bgr.astype(np.float32)
    b, g, r = f[..., 0], f[..., 1], f[..., 2]
    mx = f.max(axis=2)
    mn = f.min(axis=2)
    luma = 0.299 * r + 0.587 * g + 0.114 * b
    del mx, mn
    # Blueness relative to this photo's own sky: pale and deep skies both key out cleanly.
    blueness = (b - r) / np.maximum(b, 1)
    lit = luma > 60
    if not lit.any():
        return None
    sky_blueness = float(np.percentile(blueness[lit], 90))
    if sky_blueness < 0.12:
        return None  # no clear blue sky to key against (overcast or sunset)
    whiteness = 1 - np.clip(blueness / sky_blueness, 0, 1)
    # Both keys must agree: the adaptive one rejects pale skies, the fixed red/blue ramp from
    # registration.ts rejects bright horizon haze.
    fixed = np.clip((r / np.maximum(b, 1) - 0.62) / 0.2, 0, 1)
    alpha = np.minimum(smoothstep(0.2, 0.8, whiteness), fixed) * smoothstep(80, 150, luma)
    alpha *= 1 - smoothstep(0.08, 0.2, -blueness)  # warm, saturated: ground, trees, sunset

    # Keep the largest cloud body.
    solid = (alpha > 0.5).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(solid, connectivity=8)
    if n <= 1:
        return None
    biggest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    keep = cv2.dilate((labels == biggest).astype(np.uint8), np.ones((25, 25), np.uint8))
    alpha *= keep
    alpha = cv2.GaussianBlur(alpha, (0, 0), 1.5)

    # Reject cut-outs that make poor sprites: cloud cut off by 2+ photo edges, a frame-filling
    # cloud deck, or a thin strip.
    ys, xs = np.where(alpha > 0.5)
    hgt, wid = alpha.shape
    edges = int(ys.min() <= 2) + int(xs.min() <= 2) + int(ys.max() >= hgt - 3) + int(xs.max() >= wid - 3)
    box = alpha[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    if edges >= 2 or box.mean() > 0.75 or box.shape[0] / box.shape[1] < 0.25:
        return None

    # Un-mix the sky from soft edges: colour = (observed - (1 - a) * sky) / a.
    sky_px = f[(alpha < 0.05) & (blueness > sky_blueness * 0.8) & lit]
    sky = np.median(sky_px, axis=0) if len(sky_px) else np.array([200, 150, 90], np.float32)
    a3 = np.maximum(alpha, 0.05)[..., None]
    color = np.clip((f - (1 - a3) * sky) / a3, 0, 255)
    # Clouds are near-neutral; pull colour casts (camera white balance, un-mix residue) toward grey.
    grey = (0.114 * color[..., 0] + 0.587 * color[..., 1] + 0.299 * color[..., 2])[..., None]
    color = 0.35 * color + 0.65 * grey

    ys, xs = np.where(alpha > 0.02)
    if len(xs) == 0:
        return None
    pad = 12
    y0, y1 = max(0, ys.min() - pad), min(alpha.shape[0], ys.max() + pad)
    x0, x1 = max(0, xs.min() - pad), min(alpha.shape[1], xs.max() + pad)
    bgra = np.dstack([color, alpha[..., None] * 255])[y0:y1, x0:x1].astype(np.uint8)
    h = round(bgra.shape[0] * SPRITE_W / bgra.shape[1])
    return cv2.resize(bgra, (SPRITE_W, h), interpolation=cv2.INTER_AREA)


def main() -> None:
    src = Path(sys.argv[1])
    sources = json.loads((src / "sources.json").read_text(encoding="utf8"))
    OUT.mkdir(parents=True, exist_ok=True)
    files: list[str] = []
    credits = ["# Cloud sprite credits", "", "Cut-outs made with `apps/web/scripts/make_cloud_sprites.py`.", ""]
    for entry in sources:
        bgr = cv2.imread(str(src / entry["file"]), cv2.IMREAD_COLOR)
        if bgr is None:
            print(f"skip {entry['file']}: unreadable")
            continue
        sprite = cutout(bgr)
        if sprite is None:
            print(f"skip {entry['file']}: no cloud found")
            continue
        name = f"cloud-{len(files) + 1}.webp"
        ok, buf = cv2.imencode(".webp", sprite, [cv2.IMWRITE_WEBP_QUALITY, 85])
        if not ok:
            raise SystemExit(f"could not encode {name}")
        (OUT / name).write_bytes(buf.tobytes())
        files.append(name)
        credits.append(f"- `{name}`: \"{entry['title']}\" by {entry['author']}, {entry['license']}, {entry['url']}")
        print(f"{name}: {sprite.shape[1]}x{sprite.shape[0]}, {len(buf) // 1024} KB")
    (OUT / "manifest.json").write_text(json.dumps({"files": files}, indent=2) + "\n", encoding="utf8")
    (OUT / "CREDITS.md").write_text("\n".join(credits) + "\n", encoding="utf8")


if __name__ == "__main__":
    main()
