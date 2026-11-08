"use client";
import { useState } from "react";
import { useDriftAuth } from "@/lib/auth/DriftAuth";
import type { Cloud } from "@/lib/contracts";
import { usePosts } from "@/features/composer/posts";

export function DeleteCloudButton({ cloud }: { cloud: Cloud }) {
  const auth = useDriftAuth(),
    { deleteCloud, notify } = usePosts();
  const [confirming, setConfirming] = useState(false),
    [busy, setBusy] = useState(false);
  if (cloud.kind !== "created" || cloud.creatorId !== auth.userId) return null;
  async function remove() {
    setBusy(true);
    try {
      await deleteCloud(cloud.id);
    } catch {
      notify("Could not delete this cloud. Try again.");
      setBusy(false);
    }
  }
  if (!confirming)
    return (
      <button
        type="button"
        className="drift-textlink"
        onClick={() => setConfirming(true)}
      >
        Delete your cloud
      </button>
    );
  return (
    <span>
      Delete this cloud and all its posts?{" "}
      <button
        type="button"
        className="drift-textlink"
        disabled={busy}
        onClick={() => void remove()}
      >
        {busy ? "Deleting…" : "Delete cloud"}
      </button>{" "}
      <button
        type="button"
        className="drift-textlink"
        disabled={busy}
        onClick={() => setConfirming(false)}
      >
        Keep it
      </button>
    </span>
  );
}
