"use client";
import { ChevronRight, PenLine, X } from "lucide-react";
import { useMemo } from "react";
import type { Anchor, CloudWithPreviews } from "@/lib/contracts";
import { PostItem } from "@/features/composer/PostItem";
import { usePosts } from "@/features/composer/posts";
import { ago, cloudTitle, heightText, statusNote } from "./describe";

/** Previews are capped at three by the API, so "3+" is the honest count beyond that. */
function postCount(shown: number, previews: number) {
  if (!shown) return "no posts nearby";
  return previews >= 3 ? "3+ posts nearby" : `${shown} post${shown === 1 ? "" : "s"} nearby`;
}
import { directionTo, groundDistanceM, ringCentroid } from "./geo";
import styles from "./sky.module.css";

/** Shown only while a cloud is selected: its facts, up to three nearby posts, and actions. */
export function CloudPanel({
  item,
  viewer,
  onClose,
  onPost,
  onOpen,
  canPost,
}: {
  item: CloudWithPreviews;
  viewer: Anchor;
  onClose: () => void;
  onPost: () => void;
  onOpen: () => void;
  canPost: boolean;
}) {
  const { created } = usePosts();
  const cloud = item.cloud;
  const centroid = ringCentroid((cloud.geometry.coordinates[0]?.[0] ?? []) as number[][]);
  const ground = groundDistanceM(viewer, centroid);
  const az = directionTo({ ...viewer, height: 0 }, { ...centroid, height: 0 }).azimuthDeg;
  const note = statusNote(cloud);
  const mine = useMemo(() => created[cloud.id] ?? [], [created, cloud.id]);
  const posts = useMemo(() => {
    const seen = new Set(mine.map((m) => m.id));
    return [...mine, ...item.previews.filter((m) => !seen.has(m.id))].slice(0, 3);
  }, [mine, item.previews]);
  const mineIds = new Set(mine.map((m) => m.id));

  return (
    <section className={styles.panel} aria-labelledby="cloud-panel-title">
      <header className={styles.panelHead}>
        <div>
          <h2 id="cloud-panel-title" className={styles.panelTitle}>
            {cloudTitle(ground, az)}
          </h2>
          <p className={styles.panelMeta}>
            {heightText(cloud)} · seen {ago(cloud.observedAt) ?? "recently"} · {postCount(posts.length, item.previews.length)}
            {note ? ` · ${note}` : ""}
          </p>
        </div>
        <button type="button" className={styles.iconButton} onClick={onClose} aria-label="Close cloud details">
          <X size={20} strokeWidth={2} aria-hidden="true" />
        </button>
      </header>

      {posts.length ? (
        <ul className={styles.panelList}>
          {posts.map((m) => (
            <PostItem key={m.id} message={m} mine={mineIds.has(m.id)} />
          ))}
        </ul>
      ) : (
        <p className={styles.panelEmpty}>Nothing written on this cloud yet. The first post will travel wherever it drifts.</p>
      )}

      <div className={styles.panelActions}>
        <button type="button" className="drift-primary" onClick={onPost} disabled={!canPost}>
          <PenLine size={18} strokeWidth={2.25} aria-hidden="true" />
          Post on this cloud
        </button>
        <button type="button" className="drift-secondary" onClick={onOpen}>
          All posts
          <ChevronRight size={18} strokeWidth={2.25} aria-hidden="true" />
        </button>
      </div>
      {!canPost && <p className={styles.panelHint}>This cloud isn&apos;t taking new posts right now.</p>}
    </section>
  );
}
