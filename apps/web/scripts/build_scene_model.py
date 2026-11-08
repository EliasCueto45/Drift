"""Build the on-device indoor/outdoor scene model (Places365 ResNet18, int8).

Run in a throwaway venv with onnx, onnxruntime, numpy, opencv-python-headless:
    python apps/web/scripts/build_scene_model.py <src_dir> [check_image ...]

<src_dir> holds, from the sources in public/models/CREDITS.md:
    places_fp16.onnx           (Hugging Face mlboydaisuke/Places365-ResNet18-OpenVINO)
    IO_places365.txt           (CSAILVision/places365; 1 = indoor, 2 = outdoor)
    categories_places365.txt   (CSAILVision/places365)

Writes apps/web/public/models/places365-int8.onnx and places365-io.json, then prints the
top-3 scenes and P(indoor) for each check image with both models, to confirm that
quantization did not change the answer.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
from onnxruntime.quantization import QuantType, quantize_dynamic

OUT = Path(__file__).resolve().parents[1] / "public" / "models"
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)


def preprocess(path: Path) -> np.ndarray:
    bgr = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if bgr is None:
        raise SystemExit(f"cannot read {path}")
    h, w = bgr.shape[:2]
    s = min(h, w)
    crop = bgr[(h - s) // 2 : (h + s) // 2, (w - s) // 2 : (w + s) // 2]
    rgb = cv2.cvtColor(cv2.resize(crop, (224, 224), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
    x = (rgb.astype(np.float32) / 255 - MEAN) / STD
    return x.transpose(2, 0, 1)[None]


def main() -> None:
    src = Path(sys.argv[1])
    checks = [Path(p) for p in sys.argv[2:]]
    names = [line.split()[0][3:] for line in (src / "categories_places365.txt").read_text().splitlines() if line.strip()]
    io = [int(line.split()[1]) for line in (src / "IO_places365.txt").read_text().splitlines() if line.strip()]
    if len(names) != 365 or len(io) != 365:
        raise SystemExit(f"expected 365 categories, got {len(names)} names and {len(io)} io flags")

    OUT.mkdir(parents=True, exist_ok=True)
    fp = src / "places_fp16.onnx"
    q = OUT / "places365-int8.onnx"
    quantize_dynamic(str(fp), str(q), weight_type=QuantType.QUInt8)
    (OUT / "places365-io.json").write_text(
        json.dumps({"indoor": [1 if v == 1 else 0 for v in io], "names": names}) + "\n", encoding="utf8"
    )
    print(f"{q.name}: {q.stat().st_size / 1e6:.1f} MB")

    indoor = np.array([v == 1 for v in io])
    for label, model in (("float", fp), ("int8", q)):
        sess = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])
        name = sess.get_inputs()[0].name
        for img in checks:
            logits = sess.run(None, {name: preprocess(img)})[0][0]
            p = np.exp(logits - logits.max())
            p /= p.sum()
            top = np.argsort(-p)[:3]
            tops = ", ".join(f"{names[i]} {p[i]:.2f}" for i in top)
            print(f"{label:5} {img.name}: P(indoor) {p[indoor].sum():.2f} | {tops}")


if __name__ == "__main__":
    main()
