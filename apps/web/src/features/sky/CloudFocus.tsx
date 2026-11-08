"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { focusTransform, type Rect } from "./focusGeometry";
import styles from "./sky.module.css";

export interface FocusFrame {
  /** The sky as it looked at the tap: camera frame plus the post lettering, no controls. */
  image: HTMLCanvasElement;
  /** The chosen cloud's screen box at the tap. */
  rect: Rect;
  /** Where to centre the zoom (a new post's spot); defaults to the cloud's centre. */
  center?: { x: number; y: number };
}

const IN_MS = 640;
const OUT_MS = 380;

/**
 * The focal moment: the sky freezes at the tap and zooms into the chosen cloud until it fills
 * the screen; the cloud then becomes the backdrop for its posts or for a new one. Freezing
 * keeps the backdrop steady while reading at 2-4x zoom, where hand shake would blur a live
 * feed. Children appear once the zoom lands; `closing` plays it back out.
 */
export function CloudFocus({
  frame,
  closing,
  onArrived,
  onClosed,
  children,
}: {
  frame: FocusFrame;
  closing: boolean;
  onArrived: () => void;
  onClosed: () => void;
  children?: React.ReactNode;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoomed, setZoomed] = useState(false);
  const callbacks = useRef({ onArrived, onClosed });
  useEffect(() => {
    callbacks.current = { onArrived, onClosed };
  });

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = frame.image.width;
    canvas.height = frame.image.height;
    canvas.getContext("2d")?.drawImage(frame.image, 0, 0);
  }, [frame.image]);

  // Start at the untouched sky, then zoom on the next frame so the transition runs.
  useEffect(() => {
    if (closing) return;
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setZoomed(true)));
    const done = window.setTimeout(() => callbacks.current.onArrived(), reduced() ? 0 : IN_MS * 0.7);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(done);
    };
  }, [closing]);

  useEffect(() => {
    if (!closing) return;
    const raf = requestAnimationFrame(() => setZoomed(false));
    const done = window.setTimeout(() => callbacks.current.onClosed(), reduced() ? 160 : OUT_MS);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(done);
    };
  }, [closing]);

  const view = { width: window.innerWidth, height: window.innerHeight };
  const t = focusTransform(view, frame.rect, frame.center);
  const transform = zoomed ? `translate3d(${t.tx}px, ${t.ty}px, 0) scale(${t.scale})` : "translate3d(0, 0, 0) scale(1)";

  return (
    <div className={styles.focus} data-zoomed={zoomed || undefined} data-closing={closing || undefined} style={{ "--focus-in": `${IN_MS}ms`, "--focus-out": `${OUT_MS}ms` } as React.CSSProperties}>
      <canvas ref={canvasRef} className={styles.focusFrame} style={{ transform }} aria-hidden="true" />
      <div className={styles.focusVeil} aria-hidden="true" />
      {children}
    </div>
  );
}

function reduced() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
