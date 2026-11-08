"use client";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useApi } from "@/lib/api/ApiProvider";
import { CreateAttempt } from "@/lib/api/createAttempt";
import { DriftApiError } from "@/lib/api/client";
import { useDriftAuth } from "@/lib/auth/DriftAuth";
import type { Anchor, Cloud, CreateCloudRequest } from "@/lib/contracts";
import { groundDistanceM } from "./geo";
import { MapProjection } from "./mapProjection";
import styles from "./cloudCreator.module.css";

export function outlineProblem(vertices: Anchor[]): string | null {
  if (vertices.length < 3) return "Place at least three outline points.";
  if (vertices.length > 256) return "Use at most 256 points.";
  if (new Set(vertices.map((p) => JSON.stringify(p))).size !== vertices.length)
    return "Outline points must be distinct.";
  for (const a of vertices)
    for (const b of vertices)
      if (groundDistanceM(a, b) > 9950)
        return "Keep the outline under 10 km across.";
  return null;
}

/** Camera callers use the same existing geographic map projection for outline editing. */
export function CloudCreator({
  viewer,
  datasetId,
  onCreated,
  onClose,
}: {
  viewer: Anchor;
  datasetId: string;
  onCreated: (cloud: Cloud) => void;
  onClose: () => void;
}) {
  const api = useApi(),
    auth = useDriftAuth();
  const [vertices, setVertices] = useState<Anchor[]>([]);
  const [center, setCenter] = useState(viewer),
    [scale, setScale] = useState(0.08);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const attempt = useRef(new CreateAttempt()),
    submitting = useRef(false);
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  function dialogKeys(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && !busy) { event.preventDefault(); onClose(); }
    if (event.key !== "Tab") return;
    const items = dialog.current?.querySelectorAll<HTMLElement>("button:not([disabled]), [tabindex='0']");
    const first = items?.[0], last = items?.[items.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  const map = new MapProjection(center, scale, { width: 340, height: 300 });
  const addPoint = (point: Anchor) => {
    if (vertices.length < 256 && !busy) setVertices((v) => [...v, point]);
  };
  function keyDown(event: KeyboardEvent<SVGSVGElement>) {
    const shifts: Record<string, [number, number]> = {
      ArrowLeft: [35, 0],
      ArrowRight: [-35, 0],
      ArrowUp: [0, 35],
      ArrowDown: [0, -35],
    };
    if (shifts[event.key]) {
      event.preventDefault();
      setCenter(map.panned(...shifts[event.key]!).center);
    }
    if (event.key === "Enter") {
      event.preventDefault();
      addPoint(center);
    }
  }
  async function publish() {
    const problem = outlineProblem(vertices);
    if (problem) {
      setError(problem);
      return;
    }
    if (!auth.ready) {
      setError("Posting session is loading. Try again in a moment.");
      return;
    }
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    const ring = [...vertices, vertices[0]!].map((p) => [
      p.longitude,
      p.latitude,
    ]);
    const body: CreateCloudRequest = {
      outline: {
        type: "Polygon",
        coordinates: [ring as CreateCloudRequest["outline"]["coordinates"][0]],
      },
      assumedAltitudeM: 2000,
      datasetId,
    };
    try {
      const result = await api.createCloud(
        body,
        attempt.current.forRequest("clouds", body),
      );
      attempt.current.complete();
      onCreated(result.data);
    } catch (error) {
      setError(
        error instanceof DriftApiError
          ? error.message
          : "Could not create this cloud. Your outline is kept; try again.",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  const points = vertices
    .map((p) => {
      const s = map.toScreen(p);
      return `${s.x},${s.y}`;
    })
    .join(" ");
  return (
    <div className={styles.backdrop}>
      <section
        ref={dialog}
        tabIndex={-1}
        onKeyDown={dialogKeys}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-cloud-title"
      >
        <h2 id="create-cloud-title">Draw a cloud</h2>
        <p>
          Tap outline points on the map. The preview closes automatically. Your
          cloud lasts 24 hours in this sky.
        </p>
        <svg
          viewBox="0 0 340 300"
          className={styles.map}
          tabIndex={0}
          role="application"
          aria-label="Cloud outline map. Arrow keys pan; Enter adds a point at the crosshair."
          onKeyDown={keyDown}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            addPoint(
              map.toGeo(
                ((e.clientX - rect.left) * 340) / rect.width,
                ((e.clientY - rect.top) * 300) / rect.height,
              ),
            );
          }}
        >
          <path
            d="M170 0V300M0 150H340"
            stroke="#a9b7bf"
            strokeDasharray="4 5"
          />
          <polygon
            points={points}
            fill="#ffffffa8"
            stroke="#466976"
            strokeWidth="2"
          />
          {vertices.map((p, i) => {
            const s = map.toScreen(p);
            return <circle key={i} cx={s.x} cy={s.y} r="4" fill="#305c66" />;
          })}
          <circle cx="170" cy="150" r="6" fill="none" stroke="#224c56" />
        </svg>
        <p>
          {vertices.length}/256 points · map width {Math.round(340 / scale)} m ·
          altitude estimated at 2 km
        </p>
        <div className={styles.actions}>
          <button
            type="button"
            onClick={() => setScale((s) => Math.min(0.5, s * 1.5))}
            disabled={busy}
          >
            Zoom in
          </button>
          <button
            type="button"
            onClick={() => setScale((s) => Math.max(0.025, s / 1.5))}
            disabled={busy}
          >
            Zoom out
          </button>
          <button
            type="button"
            onClick={() => addPoint(center)}
            disabled={busy}
          >
            Add at crosshair
          </button>
          <button
            type="button"
            onClick={() => setVertices((v) => v.slice(0, -1))}
            disabled={busy || !vertices.length}
          >
            Undo point
          </button>
        </div>
        <p>
          The outline is public. Keep edges from crossing; the server checks the
          shape before publishing.
        </p>
        {!auth.signedIn && <p>Your created cloud will be labeled Anonymous. Keep this browser&apos;s cookies to manage it later.</p>}
        {error && <p role="alert">{error}</p>}
        <div className={styles.actions}>
          <button
            type="button"
            className="drift-secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="drift-primary"
            onClick={() => void publish()}
            disabled={busy || !auth.ready || vertices.length < 3}
          >
            {busy ? "Publishing…" : "Publish cloud"}
          </button>
        </div>
      </section>
    </div>
  );
}
