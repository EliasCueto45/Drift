"use client";
import { ArrowUp, ExternalLink } from "lucide-react";
import type { Message } from "@/lib/contracts";
import { linkLabel, timeAgo, usePosts } from "./posts";
import styles from "./composer.module.css";

/** One post in a list: its words, link if any, age, and the upvote toggle. */
export function PostItem({ message, mine = false }: { message: Message; mine?: boolean }) {
  const { vote, toggleVote } = usePosts();
  const v = vote(message);
  const isLink = message.kind === "song" && message.songUrl;
  return (
    <li className={styles.item}>
      <div className={styles.itemBody}>
        {message.body && <p className={styles.itemText}>{message.body}</p>}
        {isLink && (
          <a className={styles.itemLink} href={message.songUrl!} target="_blank" rel="noopener noreferrer nofollow">
            <ExternalLink size={16} strokeWidth={2} aria-hidden="true" />
            {linkLabel(message.songUrl!)}
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        )}
        <p className={styles.itemMeta}>
          {mine ? "Your post · " : ""}
          {timeAgo(message.createdAt)}
        </p>
      </div>
      <button
        type="button"
        className={styles.vote}
        aria-pressed={v.viewerHasUpvoted}
        aria-label={`${v.viewerHasUpvoted ? "Remove upvote" : "Upvote"}, ${v.voteCount} ${v.voteCount === 1 ? "upvote" : "upvotes"}`}
        data-pending={v.pending || undefined}
        onClick={() => void toggleVote(message)}
      >
        <ArrowUp size={18} strokeWidth={2.25} aria-hidden="true" />
        <span className="tabular">{v.voteCount}</span>
      </button>
    </li>
  );
}
