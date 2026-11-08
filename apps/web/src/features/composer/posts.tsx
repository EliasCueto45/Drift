"use client";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useApi } from "@/lib/api/ApiProvider";
import { DriftApiError } from "@/lib/api/client";
import { useDriftAuth } from "@/lib/auth/DriftAuth";
import { useLatest } from "@/lib/useLatest";
import type { CloudWithPreviews, Message, VoteState } from "@/lib/contracts";
import { reconcileCreated } from "./postState";

type Override = VoteState & { pending: boolean; settledAt: number };
interface Store {
  account: string | null;
  epoch: number;
  created: Record<string, Message[]>;
  born: Record<string, number>;
  overrides: Record<string, Override>;
  removed: Set<string>;
  removedClouds: Set<string>;
}
const empty = (account: string | null, epoch = 0): Store => ({
  account,
  epoch,
  created: {},
  born: {},
  overrides: {},
  removed: new Set(),
  removedClouds: new Set(),
});
interface PostStore {
  vote: (m: Message) => VoteState & { pending: boolean };
  toggleVote: (m: Message) => Promise<void>;
  created: Record<string, Message[]>;
  addCreated: (m: Message) => void;
  removed: ReadonlySet<string>;
  removedClouds: ReadonlySet<string>;
  deletePost: (id: string) => Promise<void>;
  deleteCloud: (id: string) => Promise<void>;
  reconcile: (
    clouds: CloudWithPreviews[],
    signal?: AbortSignal,
  ) => Promise<void>;
  syncVotes: (messages: Message[], started: number) => void;
  notice: string | null;
  notify: (text: string | null) => void;
}
const Ctx = createContext<PostStore | null>(null);
export function usePosts() {
  const value = useContext(Ctx);
  if (!value) throw new Error("usePosts outside PostProvider");
  return value;
}

export function PostProvider({ children }: { children: ReactNode }) {
  const api = useApi(),
    auth = useDriftAuth();
  const [store, setStore] = useState(() => empty(auth.userId));
  // Reset only this store on account changes; keep camera and draft components mounted.
  if (store.account !== auth.userId)
    setStore(empty(auth.userId, store.epoch + 1));
  const latest = useLatest(store);
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef(new Set<string>());
  const notify = useCallback((text: string | null) => {
    setNotice(text);
    if (timer.current) clearTimeout(timer.current);
    if (text) timer.current = setTimeout(() => setNotice(null), 5000);
  }, []);
  const vote = useCallback(
    (m: Message) =>
      store.overrides[m.id] ?? {
        voteCount: m.voteCount,
        viewerHasUpvoted: m.viewerHasUpvoted,
        pending: false,
      },
    [store.overrides],
  );

  const toggleVote = useCallback(
    async (message: Message) => {
      if (!auth.signedIn) {
        auth.signIn();
        return;
      }
      const epoch = latest.current.epoch,
        lock = `${epoch}:${message.id}`;
      // Serialize toggles: response ordering alone cannot enforce the last intent.
      if (pending.current.has(lock)) return;
      pending.current.add(lock);
      const current = latest.current.overrides[message.id] ?? {
        voteCount: message.voteCount,
        viewerHasUpvoted: message.viewerHasUpvoted,
        pending: false,
        settledAt: 0,
      };
      const active = !current.viewerHasUpvoted;
      setStore((s) => ({
        ...s,
        overrides: {
          ...s.overrides,
          [message.id]: {
            voteCount: Math.max(0, current.voteCount + (active ? 1 : -1)),
            viewerHasUpvoted: active,
            pending: true,
            settledAt: Infinity,
          },
        },
      }));
      try {
        const result = await api.setUpvote(message.id, active);
        setStore((s) =>
          s.epoch !== epoch
            ? s
            : {
                ...s,
                overrides: {
                  ...s.overrides,
                  [message.id]: {
                    ...result.data,
                    pending: false,
                    settledAt: performance.now(),
                  },
                },
              },
        );
      } catch (error) {
        if (latest.current.epoch !== epoch) return;
        setStore((s) =>
          s.epoch !== epoch
            ? s
            : {
                ...s,
                overrides: {
                  ...s.overrides,
                  [message.id]: {
                    ...current,
                    pending: false,
                    settledAt: performance.now(),
                  },
                },
              },
        );
        if (error instanceof DriftApiError && error.status === 401)
          auth.signIn();
        else
          notify(
            error instanceof DriftApiError && error.status === 410
              ? "That post is no longer available."
              : "Your vote did not go through. Try again.",
          );
      } finally {
        pending.current.delete(lock);
      }
    },
    [api, auth, latest, notify],
  );

  const addCreated = useCallback((message: Message) => {
    setStore((s) =>
      s.account !== message.authorId
        ? s
        : {
            ...s,
            born: { ...s.born, [message.id]: performance.now() },
            created: {
              ...s.created,
              [message.cloudId]: [
                message,
                ...(s.created[message.cloudId] ?? []).filter(
                  (m) => m.id !== message.id,
                ),
              ],
            },
          },
    );
  }, []);
  const syncVotes = useCallback(
    (messages: Message[], started: number) => {
      setStore((s) => {
        if (s.epoch !== store.epoch) return s;
        const overrides = { ...s.overrides };
        for (const m of messages) {
          const override = overrides[m.id];
          if (override && !override.pending && override.settledAt <= started)
            delete overrides[m.id];
        }
        return { ...s, overrides };
      });
    },
    [store.epoch],
  );

  const reconcile = useCallback(
    async (clouds: CloudWithPreviews[], signal?: AbortSignal) => {
      const start = performance.now(),
        snapshot = latest.current,
        epoch = snapshot.epoch;
      const ids = [
        ...new Set(
          Object.values(snapshot.created)
            .flat()
            .map((m) => m.id),
        ),
      ];
      const authoritative: Message[] = [];
      for (let i = 0; i < ids.length; i += 50) {
        const response = await api.messagesById(ids.slice(i, i + 50), signal);
        authoritative.push(...response.data);
      }
      if (signal?.aborted || latest.current.epoch !== epoch) return;
      const refreshed = new Set([
        ...ids,
        ...clouds.flatMap((c) => c.previews.map((m) => m.id)),
      ]);
      setStore((s) => {
        if (s.epoch !== epoch) return s;
        const overrides = { ...s.overrides };
        for (const id of refreshed)
          if (
            overrides[id] &&
            !overrides[id].pending &&
            overrides[id].settledAt <= start
          )
            delete overrides[id];
        return {
          ...s,
          overrides,
          created: reconcileCreated(
            s.created,
            authoritative,
            new Set(ids),
            s.born,
            start,
            s.removed,
            s.removedClouds,
          ),
        };
      });
    },
    [api, latest],
  );

  const deletePost = useCallback(
    async (id: string) => {
      const epoch = latest.current.epoch;
      try {
        await api.deleteMessage(id);
      } catch (error) {
        if (
          !(error instanceof DriftApiError) ||
          ![404, 410].includes(error.status)
        )
          throw error;
      }
      setStore((s) =>
        s.epoch !== epoch
          ? s
          : {
              ...s,
              removed: new Set([...s.removed, id]),
              created: reconcileCreated(
                s.created,
                [],
                new Set([id]),
                s.born,
                Infinity,
                new Set([...s.removed, id]),
                s.removedClouds,
              ),
            },
      );
      if (latest.current.epoch === epoch) notify("Post deleted.");
    },
    [api, latest, notify],
  );
  const deleteCloud = useCallback(
    async (id: string) => {
      const epoch = latest.current.epoch;
      await api.deleteCloud(id);
      setStore((s) =>
        s.epoch !== epoch
          ? s
          : {
              ...s,
              removedClouds: new Set([...s.removedClouds, id]),
              created: reconcileCreated(
                s.created,
                [],
                new Set(),
                s.born,
                Infinity,
                s.removed,
                new Set([...s.removedClouds, id]),
              ),
            },
      );
      if (latest.current.epoch === epoch)
        notify("Cloud and its posts deleted.");
    },
    [api, latest, notify],
  );
  const value = useMemo(
    () => ({
      vote,
      toggleVote,
      created: store.created,
      addCreated,
      removed: store.removed,
      removedClouds: store.removedClouds,
      deletePost,
      deleteCloud,
      reconcile,
      syncVotes,
      notice,
      notify,
    }),
    [
      vote,
      toggleVote,
      store.created,
      addCreated,
      store.removed,
      store.removedClouds,
      deletePost,
      deleteCloud,
      reconcile,
      syncVotes,
      notice,
      notify,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

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
