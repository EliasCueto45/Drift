"""Local image-motion corrections with conservative confidence fusion."""
from dataclasses import replace
import math

import cv2
import numpy as np

from .models import Frame
from .wind import GEOD, Wind


def fuse(prior: Wind, measured: Wind) -> Wind:
    if measured.confidence <= 0:
        return prior
    if prior.confidence <= 0:
        return measured
    disagreement = math.hypot(prior.u-measured.u, prior.v-measured.v)
    a, b = prior.confidence**2, measured.confidence**2
    # Correlated DMW/image evidence must not increase certainty.
    confidence = min(prior.confidence, measured.confidence) if prior.correlated else max(prior.confidence, measured.confidence)
    confidence /= 1 + disagreement / 15
    return replace(measured, u=(a*prior.u+b*measured.u)/(a+b),
                   v=(a*prior.v+b*measured.v)/(a+b), confidence=confidence,
                   source=f"{prior.source}+image-flow", correlated=prior.correlated)


class MotionField:
    def __init__(self, winds, previous: Frame | None, current: Frame):
        self.winds, self.previous, self.current = winds, previous, current
        self.flow = self.quality = None
        if previous is None or previous.grid != current.grid:
            return
        self.dt = (current.observed_at-previous.observed_at).total_seconds()
        if not 0 < self.dt <= 1800 or previous.image is None or current.image is None:
            return
        good = previous.valid & current.valid
        if good.sum() < 16:
            return
        low, high = np.percentile(np.concatenate((previous.image[good], current.image[good])), [2, 98])
        if not np.isfinite(high-low) or high-low < 1e-6:
            return
        def normalize(image):
            return np.clip((image-low)/(high-low)*255, 0, 255).astype(np.uint8)
        a, b = normalize(previous.image), normalize(current.image)
        self.flow = cv2.calcOpticalFlowFarneback(a, b, None, .5, 4, 21, 4, 7, 1.5, 0)
        back = cv2.calcOpticalFlowFarneback(b, a, None, .5, 4, 21, 4, 7, 1.5, 0)
        yy, xx = np.indices(current.grid.shape, dtype=np.float32)
        destx, desty = xx+self.flow[..., 0], yy+self.flow[..., 1]
        backward = cv2.remap(back, destx, desty, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
        destgood = cv2.remap(current.valid.astype(np.uint8), destx, desty, cv2.INTER_NEAREST)
        residual = np.linalg.norm(self.flow+backward, axis=2)
        # Low-texture and missing-edge vectors are not measurements.
        texture = cv2.GaussianBlur(cv2.Laplacian(a, cv2.CV_32F)**2, (5, 5), 0)
        self.quality = np.where(good & (destgood == 1) & (texture > 4), .8/(1+residual), 0)

    def at(self, lon, lat, altitude, at):
        prior = self.winds.at(lon, lat, altitude, at)
        if self.flow is None:
            return prior
        grid = self.current.grid
        x, y = grid.transformer().transform(lon, lat)
        cell = grid.cell(x, y)
        if cell is None:
            return prior
        row, col = cell
        confidence = float(self.quality[row, col])
        dx, dy = self.flow[row, col] * grid.cell_m
        lon2, lat2 = grid.transformer(True).transform(x+float(dx), y+float(dy))
        azimuth, _, distance = GEOD.inv(lon, lat, lon2, lat2)
        speed = distance / self.dt
        if speed > 120 or confidence < .15:
            return prior
        angle = math.radians(azimuth)
        measured = Wind(speed*math.sin(angle), speed*math.cos(angle), confidence,
                        altitude, "image-flow", self.current.observed_at)
        return fuse(prior, measured)
