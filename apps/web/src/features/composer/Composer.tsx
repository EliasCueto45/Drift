"use client";
import { Link2, MapPin, Type, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useApi } from "@/lib/api/ApiProvider";
import { DriftApiError, isStaleCloudError } from "@/lib/api/client";
import { CreateAttempt } from "@/lib/api/createAttempt";
import { useDriftAuth } from "@/lib/auth/DriftAuth";
import type {
  Anchor,
  CloudWithPreviews,
  CreateMessageRequest,
  Message,
} from "@/lib/contracts";
import { LIMITS, LINK_HOSTS } from "@/lib/contracts";
import { linkLabel } from "./posts";
import { DISCOVERY_RADIUS_M, placementInRange } from "@/features/sky/discovery";
import styles from "./composer.module.css";

type Kind = "text" | "link";

export function validateLink(raw: string): string | null {
  const value = raw.trim();
  if (!value) return "Paste a link.";
  if (value.length > LIMITS.linkChars)
    return `Links can be up to ${LIMITS.linkChars.toLocaleString()} characters.`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "That doesn't look like a link. It should start with https://";
  }
  if (url.protocol !== "https:") return "Only https:// links can be posted.";
  if (url.username || url.password)
    return "Links can't include a username or password.";
  if (!(LINK_HOSTS as readonly string[]).includes(url.hostname)) {
    return "For now, links must be from Spotify, Apple Music, YouTube, SoundCloud or Bandcamp.";
  }
  return null;
}

export function validateText(raw: string): string | null {
  if (!raw.trim()) return "Write something first.";
  if (raw.length > LIMITS.textChars)
    return `Posts can be up to ${LIMITS.textChars.toLocaleString()} characters.`;
  return null;
}

/**
 * Write a post at a tapped spot on a cloud. The spot is the post's public geographic
 * anchor; the server derives the author from the Clerk session.
 */
export function Composer({
  item,
  anchor,
  viewer,
  onCancel,
  onPublished,
  onStale,
  onDraft,
  onMoveSpot,
}: {
  item: CloudWithPreviews;
  anchor: Anchor;
  viewer: Anchor;
  onCancel: () => void;
  onPublished: (m: Message) => void;
  onStale: (reason: string, final: boolean) => void;
  onDraft: (text: string) => void;
  onMoveSpot: () => void;
}) {
  const api = useApi();
  const auth = useDriftAuth();
  const [kind, setKind] = useState<Kind>("text");
  const [body, setBody] = useState("");
  const [link, setLink] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const attempt = useRef(new CreateAttempt());
  const submitting = useRef(false);
  const ids = { body: useId(), link: useId(), hint: useId(), title: useId() };

  useEffect(() => {
    onDraft(kind === "text" ? body : link ? linkLabel(link) : "");
  }, [kind, body, link, onDraft]);

  useEffect(() => {
    if (auth.signedIn) textRef.current?.focus({ preventScroll: true });
  }, [auth.signedIn, kind]);

  const problem = kind === "text" ? validateText(body) : validateLink(link);
  const showProblem = touched && problem;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (problem || busy || submitting.current) return;
    if (!auth.signedIn) return auth.signIn();
    if (!placementInRange(viewer, anchor)) {
      setError(
        `Choose a spot within ${DISCOVERY_RADIUS_M / 1000} km so you can find it again in your nearby sky.`,
      );
      return;
    }
    setBusy(true);
    submitting.current = true;
    setError(null);
    const request: CreateMessageRequest =
      kind === "text"
        ? {
            kind: "text",
            anchor,
            expectedCloudVersion: item.cloud.version,
            body,
          }
        : {
            kind: "song",
            anchor,
            expectedCloudVersion: item.cloud.version,
            songUrl: link.trim(),
          };
    try {
      const prepared = attempt.current.prepareMessage(item.cloud.id, request);
      const res = await api.createMessage(
        item.cloud.id,
        prepared.body,
        prepared.key,
      );
      attempt.current.complete();
      // The synthetic mock drops songUrl; keep what was sent so the post is not blank locally.
      onPublished({
        ...res.data,
        songUrl: res.data.songUrl ?? request.songUrl ?? null,
      });
    } catch (err) {
      setBusy(false);
      if (
        err instanceof DriftApiError &&
        ["VERSION_CONFLICT", "CLOUD_RETIRED", "CLOUD_UNAVAILABLE"].includes(err.code)
      )
        attempt.current.complete();
      if (err instanceof DriftApiError && err.code === "CONTENT_UNAVAILABLE") {
        setError("Your original post was received but is not currently visible. You can retry later, or cancel this draft to start a different post.");
        return;
      }
      if (isStaleCloudError(err)) {
        const reason =
          err.code === "CLOUD_RETIRED"
            ? "That cloud merged or split while you were writing. Pick the cloud again and tap your spot."
            : err.code === "CLOUD_EXPIRED"
              ? "That cloud has dissipated. Pick another cloud for your post."
              : "That cloud moved while you were writing. Tap your spot on it again; your words are kept.";
        onStale(
          reason,
          err.code === "CLOUD_RETIRED" || err.code === "CLOUD_EXPIRED",
        );
        return;
      }
      if (err instanceof DriftApiError) {
        if (err.status === 401) {
          setError("Your sign-in expired. Sign in again to post.");
          auth.signIn();
        } else if (err.code === "RATE_LIMIT")
          setError(
            "You've posted a lot this minute. Wait a moment, then try again.",
          );
        else if (err.status === 422 && /footprint/i.test(err.message)) {
          setError(
            "That spot has drifted off the cloud. Choose a new spot inside it.",
          );
        } else if (err.status === 422)
          setError(`The server didn't accept this post: ${err.message}.`);
        else if (err.status === 0)
          setError(
            "You're offline. Your post is still here; try again when you're connected.",
          );
        else
          setError(
            "Couldn't post right now. Your words are still here; try again.",
          );
      } else setError("Couldn't post right now. Try again.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const over = kind === "text" && body.length > LIMITS.textChars;

  return (
    <form
      className={styles.composer}
      onSubmit={submit}
      aria-labelledby={ids.title}
      noValidate
    >
      <h2 id={ids.title} className="visually-hidden">
        Write on this cloud
      </h2>
      <div className={styles.head}>
        <fieldset className={styles.kinds}>
          <legend className="visually-hidden">Post type</legend>
          <label className={styles.kind}>
            <input
              type="radio"
              name="kind"
              value="text"
              checked={kind === "text"}
              onChange={() => setKind("text")}
            />
            <Type size={16} strokeWidth={2.25} aria-hidden="true" /> Words
          </label>
          <label className={styles.kind}>
            <input
              type="radio"
              name="kind"
              value="link"
              checked={kind === "link"}
              onChange={() => setKind("link")}
            />
            <Link2 size={16} strokeWidth={2.25} aria-hidden="true" /> Song link
          </label>
        </fieldset>
        <button
          type="button"
          className={styles.close}
          onClick={onCancel}
          aria-label="Cancel post"
        >
          <X size={20} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      {kind === "text" ? (
        <div className={styles.field}>
          <label htmlFor={ids.body} className="visually-hidden">
            Your post
          </label>
          <textarea
            id={ids.body}
            ref={textRef}
            className={styles.textarea}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onBlur={() => setTouched(true)}
            placeholder="What should whoever finds this cloud read?"
            aria-invalid={Boolean(showProblem) || over}
            aria-describedby={ids.hint}
            rows={2}
            enterKeyHint="send"
          />
          <div
            id={ids.hint}
            className={styles.fieldFoot}
            data-over={over || undefined}
          >
            <span className={styles.fieldError}>
              {showProblem ? problem : ""}
            </span>
            <span className="tabular count">
              {body.length.toLocaleString()} /{" "}
              {LIMITS.textChars.toLocaleString()}
            </span>
          </div>
        </div>
      ) : (
        <div className={styles.field}>
          <label htmlFor={ids.link} className={styles.label}>
            Link to a song
          </label>
          <input
            id={ids.link}
            className={styles.input}
            type="url"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={link}
            onChange={(e) => setLink(e.target.value)}
            onBlur={() => setTouched(true)}
            placeholder="https://open.spotify.com/track/…"
            aria-invalid={Boolean(showProblem)}
            aria-describedby={ids.hint}
          />
          <div id={ids.hint} className={styles.fieldFoot}>
            <span className={showProblem ? styles.fieldError : undefined}>
              {showProblem
                ? problem
                : "Spotify, Apple Music, YouTube, SoundCloud or Bandcamp."}
            </span>
          </div>
        </div>
      )}

      <p className={styles.public}>
        <MapPin size={16} strokeWidth={2.25} aria-hidden="true" />
        <span>
          Your spot on the cloud is public; your own location never is.{" "}
          <button type="button" className="drift-textlink" onClick={onMoveSpot}>
            Move the spot
          </button>
        </span>
      </p>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {!auth.signedIn && (
        <div className={styles.signin}>
          {auth.mode === "none" ? (
            <p>
              Posting needs sign-in, and sign-in isn&apos;t set up on this build
              yet. You can still read and explore.
            </p>
          ) : (
            <p>
              Sign in to post. Your public profile name appears with your post.
              {auth.mode === "dev" && (
                <span className={styles.devNote}>
                  {" "}
                  Dev sign-in works with the synthetic mock API only.
                </span>
              )}
            </p>
          )}
        </div>
      )}

      <div className={styles.actions}>
        {auth.signedIn ? (
          <button
            type="submit"
            className="drift-primary"
            disabled={busy}
            aria-busy={busy}
          >
            {busy ? "Posting…" : "Post to the cloud"}
          </button>
        ) : (
          <button
            type="button"
            className="drift-primary"
            onClick={auth.signIn}
            disabled={auth.mode === "none"}
          >
            {auth.mode === "dev" ? "Dev sign-in" : "Sign in to post"}
          </button>
        )}
      </div>
    </form>
  );
}
