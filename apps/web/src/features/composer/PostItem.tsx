"use client";
import { ExternalLink, Wind } from "lucide-react";
import { useState } from "react";
import { useDriftAuth } from "@/lib/auth/DriftAuth";
import type { Message } from "@/lib/contracts";
import { linkLabel, timeAgo, usePosts } from "./posts";
import styles from "./composer.module.css";
import { driftDistanceText } from "./driftDistance";

/** One post in a list: its words, link if any, age, and the upvote toggle. */
export function PostItem({ message }: { message: Message; mine?: boolean }) {
  const { vote, toggleVote, removed, deletePost, notify } = usePosts();
  const auth = useDriftAuth();
  const [confirming, setConfirming] = useState(false),
    [deleting, setDeleting] = useState(false);
  const v = vote(message);
  if (removed.has(message.id)) return null;
  const owned = auth.userId === message.authorId;
  async function remove() {
    setDeleting(true);
    try {
      await deletePost(message.id);
    } catch {
      notify("Could not delete this post. Try again.");
      setDeleting(false);
    }
  }
  const isLink = message.kind === "song" && message.songUrl;
  return (
    <li className={styles.item}>
      <div className={styles.itemBody}>
        {message.body && <p className={styles.itemText}>{message.body}</p>}
        {isLink && (
          <a
            className={styles.itemLink}
            href={message.songUrl!}
            target="_blank"
            rel="noopener noreferrer nofollow"
          >
            <ExternalLink size={16} strokeWidth={2} aria-hidden="true" />
            {linkLabel(message.songUrl!)}
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        )}
        <p className={styles.itemMeta}>
          {owned ? message.authorId.startsWith("anon_") ? "Your anonymous post" : "Your post" : message.author?.displayName || "Drift user"} ·{" "}
          {timeAgo(message.createdAt)}
          {" · "}
          <span title="Estimated distance from the original posting spot to the latest tracked position, not the total path traveled. Updates with tracking; stale observations do not add movement.">
            {driftDistanceText(message.driftDistanceM)}
          </span>
        </p>
        {owned &&
          (!confirming ? (
            <button
              type="button"
              className="drift-textlink"
              onClick={() => setConfirming(true)}
            >
              Delete post
            </button>
          ) : (
            <span>
              Delete this post?{" "}
              <button
                type="button"
                className="drift-textlink"
                disabled={deleting}
                onClick={() => void remove()}
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>{" "}
              <button
                type="button"
                className="drift-textlink"
                disabled={deleting}
                onClick={() => setConfirming(false)}
              >
                Keep it
              </button>
            </span>
          ))}
      </div>
      <button
        type="button"
        className={styles.vote}
        aria-pressed={v.viewerHasUpvoted}
        aria-label={`${v.viewerHasUpvoted ? "Take back your puff" : "Give a puff"}, ${v.voteCount} ${v.voteCount === 1 ? "puff" : "puffs"}`}
        data-pending={v.pending || undefined}
        disabled={v.pending || deleting}
        onClick={() => void toggleVote(message)}
      >
        <Wind size={18} strokeWidth={2.25} aria-hidden="true" />
        <span className="tabular">{v.voteCount}</span>
      </button>
    </li>
  );
}
