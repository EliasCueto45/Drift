"use client";
/** Post state shared by the sky, previews and the cloud sheet: votes and locally created posts. */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useApi } from "@/lib/api/ApiProvider";
import { DriftApiError } from "@/lib/api/client";
import { useDriftAuth } from "@/lib/auth/DriftAuth";
import type { Message, VoteState } from "@/lib/contracts";

interface PostStore {
  vote: (m: Message) => VoteState & { pending: boolean };
  toggleVote: (m: Message) => Promise<void>;
  created: Record<string, Message[]>;
  addCreated: (m: Message) => void;
  notice: string | null;
  notify: (text: string | null) => void;
}

const Ctx = createContext<PostStore | null>(null);

export function usePosts() {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePosts outside PostProvider");
  return v;
}

export function PostProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const auth = useDriftAuth();
  const [overrides, setOverrides] = useState<Record<string, VoteState & { pending: boolean }>>({});
  const [created, setCreated] = useState<Record<string, Message[]>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const inflight = useRef(new Map<string, number>());

  const notify = useCallback((text: string | null) => {
    setNotice(text);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    if (text) noticeTimer.current = window.setTimeout(() => setNotice(null), 5000);
  }, []);

  const vote = useCallback(
    (m: Message) => overrides[m.id] ?? { voteCount: m.voteCount, viewerHasUpvoted: m.viewerHasUpvoted, pending: false },
    [overrides],
  );

  const toggleVote = useCallback(
    async (m: Message) => {
      if (!auth.signedIn) {
        if (auth.mode === "none") notify("Voting needs sign-in, which isn't configured on this build.");
        else auth.signIn();
        return;
      }
      const current = overrides[m.id] ?? { voteCount: m.voteCount, viewerHasUpvoted: m.viewerHasUpvoted, pending: false };
      const active = !current.viewerHasUpvoted;
      const seq = (inflight.current.get(m.id) ?? 0) + 1;
      inflight.current.set(m.id, seq);
      // Optimistic: flip now, then take the server's count as authoritative or roll back.
      setOverrides((o) => ({
        ...o,
        [m.id]: { voteCount: Math.max(0, current.voteCount + (active ? 1 : -1)), viewerHasUpvoted: active, pending: true },
      }));
      try {
        const res = await api.setUpvote(m.id, active);
        if (inflight.current.get(m.id) !== seq) return;
        setOverrides((o) => ({ ...o, [m.id]: { ...res.data, pending: false } }));
      } catch (error) {
        if (inflight.current.get(m.id) !== seq) return;
        setOverrides((o) => ({ ...o, [m.id]: { ...current, pending: false } }));
        const e = error instanceof DriftApiError ? error : null;
        if (e?.status === 401) auth.signIn();
        else if (e?.code === "RATE_LIMIT") notify("Too many votes this minute. Try again shortly.");
        else if (e?.status === 410) notify("That post has drifted out of reach.");
        else notify("Your vote didn't go through. It's back to how it was.");
      }
    },
    [api, auth, overrides, notify],
  );

  const addCreated = useCallback((m: Message) => {
    setCreated((c) => ({ ...c, [m.cloudId]: [m, ...(c[m.cloudId] ?? []).filter((x) => x.id !== m.id)] }));
  }, []);

  const value = useMemo(
    () => ({ vote, toggleVote, created, addCreated, notice, notify }),
    [vote, toggleVote, created, addCreated, notice, notify],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Display host for link posts, e.g. "open.spotify.com" -> "Spotify". */
export function linkLabel(url: string) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const names: Record<string, string> = {
      "open.spotify.com": "Spotify",
      "music.apple.com": "Apple Music",
      "youtube.com": "YouTube",
      "youtu.be": "YouTube",
      "music.youtube.com": "YouTube Music",
      "soundcloud.com": "SoundCloud",
      "bandcamp.com": "Bandcamp",
    };
    return names[host] ?? host;
  } catch {
    return "Link";
  }
}

export function timeAgo(iso: string, now = Date.now()) {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
