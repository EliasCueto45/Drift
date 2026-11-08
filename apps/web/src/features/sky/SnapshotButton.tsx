"use client";
import { Camera, Download, ScanLine, Share2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { canShareSnapshot, saveSnapshot, shareSnapshot, type SnapshotCapture } from "./snapshot";
import { captureSkyScreenshot } from "./screenshot";
import styles from "./snapshot.module.css";

export function SnapshotButton({ capture, className, iconOnly = false, notify }: {
  capture: SnapshotCapture | null;
  className?: string;
  iconOnly?: boolean;
  notify?: (text: string) => void;
}) {
  const [preview, setPreview] = useState<{ file: File; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!preview) return;
    dialog.current?.showModal();
    return () => { URL.revokeObjectURL(preview.url); };
  }, [preview]);

  async function take() {
    if (!capture || busy) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const file = await captureSkyScreenshot({ capture, notify });
      if (!mounted.current) return;
      setPreview({ file, url: URL.createObjectURL(file) });
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "Couldn't take a snapshot. Try again.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  function close() {
    if (sharing) return;
    dialog.current?.close();
    setPreview(null);
    setError(null);
    setStatus(null);
  }

  async function share() {
    if (!preview || sharing) return;
    setSharing(true);
    setError(null);
    setStatus(null);
    try {
      const result = await shareSnapshot(preview.file);
      if (result === "shared") setStatus("Shared.");
      if (result === "unsupported") setError("Sharing isn't available here. Use Save image instead.");
    } catch {
      setError("Couldn't open sharing. Try again or use Save image.");
    } finally {
      setSharing(false);
    }
  }

  return (
    <>
      <button type="button" className={className} onClick={() => void take()} disabled={!capture || busy} aria-label="Take a sky snapshot" aria-busy={busy}>
        {iconOnly ? <ScanLine size={20} aria-hidden="true" /> : <><Camera size={18} aria-hidden="true" /> {busy ? "Capturing…" : "Snapshot"}</>}
      </button>
      {!preview && error && <p className={styles.captureError} role="alert" onClick={() => setError(null)}>{error}</p>}
      <dialog ref={dialog} className={styles.dialog} aria-labelledby="snapshot-title" onCancel={(e) => { e.preventDefault(); close(); }}>
        {preview && <>
          <header className={styles.header}>
            <h2 id="snapshot-title">Your sky snapshot</h2>
            <button type="button" onClick={close} disabled={sharing} aria-label="Close snapshot preview"><X size={22} aria-hidden="true" /></button>
          </header>
          {/* A device-local blob cannot use the server image optimizer. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className={styles.image} src={preview.url} alt="Your captured sky and published sky notes, with controls hidden" />
          <p className={styles.hint}>{canShareSnapshot(preview.file) ? "Share to an app or choose a save option on your phone." : "Save the image, or touch and hold it for your phone's image options."}</p>
          <div className={styles.actions}>
            {canShareSnapshot(preview.file) && <button type="button" className="drift-primary" onClick={() => void share()} disabled={sharing}><Share2 size={18} aria-hidden="true" /> {sharing ? "Sharing…" : "Share"}</button>}
            <button type="button" className="drift-secondary" disabled={sharing} onClick={() => { saveSnapshot(preview.file); setStatus("Image download started."); }}><Download size={18} aria-hidden="true" /> Save image</button>
          </div>
          {error && <p className={styles.error} role="alert">{error}</p>}
          {status && <p className={styles.hint} role="status">{status}</p>}
        </>}
      </dialog>
    </>
  );
}
