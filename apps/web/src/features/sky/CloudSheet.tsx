"use client";
import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "@/lib/api/ApiProvider";
import { DriftApiError } from "@/lib/api/client";
import type { Anchor, CloudWithPreviews, Message } from "@/lib/contracts";
import { DISCOVERY_RADIUS_M } from "./discovery";
import { PostItem } from "@/features/composer/PostItem";
import { usePosts } from "@/features/composer/posts";
import { heightText } from "./describe";
import { groundDistanceM } from "./geo";
import { useLatest } from "@/lib/useLatest";
import { DeleteCloudButton } from "./DeleteCloudButton";
import styles from "./sky.module.css";

type Scope = "nearby" | "all";

/** Expanded cloud: paginated Nearby (default) and All in cloud tabs. */
export function CloudSheet({
  item,
  viewer,
  onClose,
}: {
  item: CloudWithPreviews;
  viewer: Anchor;
  onClose: () => void;
}) {
  const api = useApi();
  const { created, removed, syncVotes } = usePosts();
  const [scope, setScope] = useState<Scope>("nearby");
  const [pages, setPages] = useState<
    Record<
      Scope,
      {
        items: Message[];
        cursor: string | null;
        done: boolean;
        error: string | null;
        loading: boolean;
      }
    >
  >({
    nearby: {
      items: [],
      cursor: null,
      done: false,
      error: null,
      loading: true,
    },
    all: { items: [], cursor: null, done: false, error: null, loading: false },
  });
  const ref = useRef<HTMLDivElement>(null);
  const cloudId = item.cloud.id;
  const pagesRef = useLatest(pages);
  const loads = useRef<Record<Scope, number>>({ nearby: 0, all: 0 });

  const load = useCallback(
    async (which: Scope, cursor: string | null, initial = false) => {
      const generation = ++loads.current[which],
        started = performance.now();
      if (!initial)
        setPages((p) => ({
          ...p,
          [which]: { ...p[which], loading: true, error: null },
        }));
      try {
        const res = await api.messages(cloudId, {
          scope: which,
          at: viewer,
          radiusM: DISCOVERY_RADIUS_M,
          cursor,
          limit: 20,
        });
        if (loads.current[which] !== generation) return;
        syncVotes(res.data, started);
        setPages((p) => {
          const seen = new Set(p[which].items.map((m) => m.id));
          return {
            ...p,
            [which]: {
              items: cursor
                ? [
                    ...p[which].items,
                    ...res.data.filter((m) => !seen.has(m.id)),
                  ]
                : res.data,
              cursor: res.nextCursor,
              done: !res.nextCursor,
              error: null,
              loading: false,
            },
          };
        });
      } catch (error) {
        if (loads.current[which] !== generation) return;
        if (error instanceof DriftApiError && error.code === "CURSOR_EXPIRED") {
          setPages((p) => ({
            ...p,
            [which]: {
              ...p[which],
              cursor: null,
              loading: false,
              done: false,
              error: "This list changed. Refresh the posts to continue.",
            },
          }));
          return;
        }
        const message =
          error instanceof DriftApiError && error.status === 410
            ? "This cloud has dissipated. Its posts are gone with it."
            : "Couldn't load posts. Check your connection and try again.";
        setPages((p) => ({
          ...p,
          [which]: { ...p[which], loading: false, error: message },
        }));
      }
    },
    [api, cloudId, viewer, syncVotes],
  );

  useEffect(() => {
    const generations = loads.current;
    // Nearby starts in its loading state, so the first page needs no synchronous state change.
    const id = window.setTimeout(() => void load("nearby", null, true), 0);
    return () => {
      window.clearTimeout(id);
      generations.nearby++;
      generations.all++;
    };
  }, [load]);

  useEffect(() => {
    const controller = new AbortController();
    let latestRefresh = 0;
    async function refreshLoaded() {
      const refresh = ++latestRefresh;
      const ids = [
        ...new Set(
          Object.values(pagesRef.current).flatMap((p) =>
            p.items.map((m) => m.id),
          ),
        ),
      ];
      if (!ids.length) return;
      const started = performance.now(),
        current: Message[] = [];
      const generations = { ...loads.current };
      try {
        for (let i = 0; i < ids.length; i += 50)
          current.push(
            ...(await api.messagesById(ids.slice(i, i + 50), controller.signal))
              .data,
          );
        if (controller.signal.aborted || refresh !== latestRefresh) return;
        syncVotes(current, started);
        const rows = new Map(current.map((m) => [m.id, m]));
        setPages((p) => {
          const result = { ...p };
          for (const scope of ["nearby", "all"] as const)
            if (generations[scope] === loads.current[scope])
              result[scope] = {
                ...p[scope],
                items: p[scope].items
                  .map((m) => {
                    const fresh = rows.get(m.id);
                    return fresh && fresh.version < m.version ? m : fresh;
                  })
                  .filter((m): m is Message =>
                    Boolean(
                      m &&
                      m.cloudId === cloudId &&
                      (scope === "all" ||
                        groundDistanceM(viewer, m.anchor) <=
                          DISCOVERY_RADIUS_M),
                    ),
                  ),
              };
          return result;
        });
      } catch {
        /* Keep last good rows while offline; the next poll retries. */
      }
    }
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshLoaded();
    }, 15000);
    void refreshLoaded();
    return () => {
      clearInterval(id);
      controller.abort();
    };
  }, [api, cloudId, item.cloud.version, pagesRef, syncVotes, viewer]);

  const choose = (next: Scope) => {
    setScope(next);
    const p = pages[next];
    if (!p.items.length && !p.done && !p.loading) void load(next, null);
  };

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const page = pages[scope];
  const mine = (created[cloudId] ?? []).filter(
    (m) =>
      !removed.has(m.id) &&
      (scope === "all" ||
        groundDistanceM(viewer, m.anchor) <= DISCOVERY_RADIUS_M) &&
      !page.items.some((x) => x.id === m.id),
  );
  const mineIds = new Set((created[cloudId] ?? []).map((m) => m.id));
  const list = [...mine, ...page.items.filter((m) => !removed.has(m.id))];

  return (
    <div className={styles.sheetBackdrop} onClick={onClose}>
      <div
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cloud-sheet-title"
        ref={ref}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.sheetHead}>
          <button
            type="button"
            className={styles.iconButton}
            onClick={onClose}
            aria-label="Back to the sky"
          >
            <ArrowLeft size={20} strokeWidth={2} aria-hidden="true" />
          </button>
          <div>
            <h2 id="cloud-sheet-title" className={styles.panelTitle}>
              Posts on this cloud
            </h2>
            <p className={styles.panelMeta}>{heightText(item.cloud)}</p>
          </div>
        </header>
        <DeleteCloudButton cloud={item.cloud} />
        <div className={styles.tabs} role="tablist" aria-label="Which posts">
          {(["nearby", "all"] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              id={`tab-${s}`}
              aria-controls="cloud-sheet-list"
              aria-selected={scope === s}
              className={styles.tab}
              onClick={() => choose(s)}
            >
              {s === "nearby" ? "Nearby" : "All in cloud"}
            </button>
          ))}
        </div>
        <div
          id="cloud-sheet-list"
          role="tabpanel"
          aria-labelledby={`tab-${scope}`}
          className={styles.sheetBody}
        >
          {scope === "nearby" && (
            <p className={styles.panelMeta}>
              Within {DISCOVERY_RADIUS_M / 1000} km of you, most upvoted first.
            </p>
          )}
          {list.length > 0 && (
            <ul className={styles.panelList}>
              {list.map((m) => (
                <PostItem key={m.id} message={m} mine={mineIds.has(m.id)} />
              ))}
            </ul>
          )}
          {page.loading && list.length === 0 && (
            <ul className={styles.panelList} aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <li key={i} className={styles.skeleton} />
              ))}
            </ul>
          )}
          {!page.loading && !page.error && page.done && list.length === 0 && (
            <p className={styles.panelEmpty}>
              {scope === "nearby"
                ? "No posts on this part of the cloud near you. Try All in cloud."
                : "No posts on this cloud yet. Be the first."}
            </p>
          )}
          {page.error && (
            <p className={styles.error} role="alert">
              {page.error}{" "}
              <button
                type="button"
                className="drift-textlink"
                onClick={() => void load(scope, page.cursor)}
              >
                Try again
              </button>
            </p>
          )}
          {!page.done && list.length > 0 && !page.error && (
            <button
              type="button"
              className="drift-secondary"
              onClick={() => void load(scope, page.cursor)}
              disabled={page.loading}
            >
              {page.loading ? "Loadingâ€¦" : "Show more"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
