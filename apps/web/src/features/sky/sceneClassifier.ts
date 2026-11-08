"use client";
/**
 * On-device indoor/outdoor scene classifier: Places365 ResNet18 (MIT CSAIL, CC BY), int8,
 * run with onnxruntime-web on WASM. Each check copies one 224x224 camera frame into memory,
 * classifies it into 365 scene types and sums the indoor ones. Frames never leave the device.
 * Model and labels: public/models (built by scripts/build_scene_model.py).
 */

/** Brightness of the frame, 0-255 luma. Night evidence: a night sky is mostly dark, a lit room is not. */
export interface FrameLight {
  meanLuma: number;
  /** Mean luma of the top third (what sits highest in the view). */
  topLuma: number;
  /** Share of pixels darker than 50. */
  darkFraction: number;
}

export interface SceneResult {
  /** Probability that the camera sees an indoor scene, 0-1; null when too dark to classify. */
  pIndoor: number | null;
  top: { name: string; p: number }[];
  light: FrameLight;
  ms: number;
}

/** Luma statistics of an RGBA square image (side x side). */
export function frameLight(px: ArrayLike<number>, side: number): FrameLight {
  const n = side * side;
  const third = Math.floor(side / 3) * side;
  let sum = 0;
  let top = 0;
  let dark = 0;
  for (let i = 0; i < n; i++) {
    const l = 0.299 * px[i * 4]! + 0.587 * px[i * 4 + 1]! + 0.114 * px[i * 4 + 2]!;
    sum += l;
    if (i < third) top += l;
    if (l < 50) dark++;
  }
  return { meanLuma: sum / n, topLuma: third ? top / third : sum / n, darkFraction: dark / n };
}

export function softmax(logits: ArrayLike<number>): Float64Array {
  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) max = Math.max(max, logits[i]!);
  const out = new Float64Array(logits.length);
  let sum = 0;
  for (let i = 0; i < logits.length; i++) sum += out[i] = Math.exp(logits[i]! - max);
  for (let i = 0; i < out.length; i++) out[i]! /= sum;
  return out;
}

/** Sum of the probabilities of the indoor categories (indoor[i] = 1). */
export function indoorProbability(probs: ArrayLike<number>, indoor: ArrayLike<number>): number {
  let p = 0;
  for (let i = 0; i < probs.length; i++) if (indoor[i] === 1) p += probs[i]!;
  return p;
}

export function topScenes(probs: ArrayLike<number>, names: string[], k = 3) {
  return Array.from(probs, (p, i) => ({ name: names[i] ?? String(i), p }))
    .sort((a, b) => b.p - a.p)
    .slice(0, k);
}

const SIZE = 224;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
/** Mean brightness below this: too dark for the scene model (it was trained on lit scenes). */
const MIN_LUMA = 30;

type OrtModule = typeof import("onnxruntime-web/wasm");
interface Model {
  ort: OrtModule;
  session: import("onnxruntime-web/wasm").InferenceSession;
  indoor: number[];
  names: string[];
}

let loading: Promise<Model | null> | null = null;

/** Loads once (about 12 MB model + 15 MB runtime, cached by the browser afterwards). */
export function loadSceneModel(): Promise<Model | null> {
  loading ??= (async () => {
    const ort = await import("onnxruntime-web/wasm");
    ort.env.wasm.wasmPaths = "/ort/";
    // No cross-origin isolation on this site, so no WASM threads.
    ort.env.wasm.numThreads = 1;
    // Run inference in a worker: a check takes a few hundred ms and must not freeze the camera view.
    ort.env.wasm.proxy = true;
    const [session, labels] = await Promise.all([
      ort.InferenceSession.create("/models/places365-int8.onnx", { executionProviders: ["wasm"] }),
      fetch("/models/places365-io.json").then((r) => r.json() as Promise<{ indoor: number[]; names: string[] }>),
    ]);
    return { ort, session, indoor: labels.indoor, names: labels.names };
  })().catch((error: unknown) => {
    console.warn("Scene model failed to load; staying in daytime 'clouds visible' mode.", error);
    return null;
  });
  return loading;
}

let canvas: HTMLCanvasElement | null = null;

/**
 * Classify what the camera currently shows (the visible, cover-cropped part of the video,
 * centre square). Null when there is no frame yet or the model is missing. A frame too dark
 * for the model still returns its brightness (pIndoor null): darkness is night evidence.
 */
export async function classifyFrame(video: HTMLVideoElement, viewport: { width: number; height: number }): Promise<SceneResult | null> {
  const model = await loadSceneModel();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!model || !vw || !vh) return null;
  const t0 = performance.now();
  canvas ??= Object.assign(document.createElement("canvas"), { width: SIZE, height: SIZE });
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  // Visible region of an object-fit: cover video, then its centre square.
  const cover = Math.max(viewport.width / vw, viewport.height / vh);
  const visW = viewport.width / cover;
  const visH = viewport.height / cover;
  const side = Math.min(visW, visH);
  ctx.drawImage(video, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, SIZE, SIZE);
  const px = ctx.getImageData(0, 0, SIZE, SIZE).data;

  const n = SIZE * SIZE;
  const light = frameLight(px, SIZE);
  if (light.meanLuma < MIN_LUMA) return { pIndoor: null, top: [], light, ms: performance.now() - t0 };
  const input = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const r = px[i * 4]!, g = px[i * 4 + 1]!, b = px[i * 4 + 2]!;
    input[i] = (r / 255 - MEAN[0]!) / STD[0]!;
    input[n + i] = (g / 255 - MEAN[1]!) / STD[1]!;
    input[2 * n + i] = (b / 255 - MEAN[2]!) / STD[2]!;
  }

  const { ort, session } = model;
  const out = await session.run({ [session.inputNames[0]!]: new ort.Tensor("float32", input, [1, 3, SIZE, SIZE]) });
  const probs = softmax(out[session.outputNames[0]!]!.data as Float32Array);
  return { pIndoor: indoorProbability(probs, model.indoor), top: topScenes(probs, model.names), light, ms: performance.now() - t0 };
}
