"use client";
import { useEffect, useState } from "react";
import { useApi } from "@/lib/api/ApiProvider";
import { useDriftAuth } from "@/lib/auth/DriftAuth";
import type { PostingStreak } from "@/lib/contracts/generated";
import { usePosts } from "./posts";

export function PostingStreakBadge({ className }: { className?: string }) {
  const api = useApi();
  const { ready, userId } = useDriftAuth();
  const { postingRevision } = usePosts();
  const [result, setResult] = useState<{ owner: string; data: PostingStreak } | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!ready || !userId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    void api.streak(controller.signal).then(({ data }) => {
      if (controller.signal.aborted) return;
      setResult({ owner: userId, data });
      timer = setTimeout(() => setRefresh((n) => n + 1), Math.max(1000, Math.min(86_400_000, Date.parse(data.nextResetAt) - Date.now() + 250)));
    }).catch(() => {
      if (!controller.signal.aborted) setResult(null);
    });
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, ready, userId, postingRevision, refresh]);
  const streak = result?.owner === userId ? result?.data : null;
  if (!ready) return null;
  return <span className={className} title={streak ? `Posting streak · best ${streak.longestDays} days · resets at midnight in ${streak.timeZone}` : "Post on consecutive local days to build a posting streak"}>
    {streak ? `${streak.currentDays}-day posting streak${streak.postedToday ? " ✓" : ""}` : userId ? "Streak unavailable" : "Start a posting streak"}
  </span>;
}
