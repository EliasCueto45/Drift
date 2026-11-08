/** Plain-language facts about a cloud, shared by the panel, sheet and map. */
import type { Cloud, Freshness } from "@/lib/contracts";
import { cloudHeight } from "./projection";

const DIRS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];

export function compassWord(azimuthDeg: number) {
  return DIRS[Math.round((((azimuthDeg % 360) + 360) % 360) / 45) % 8]!;
}

export function distanceText(m: number) {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

export function cloudTitle(groundDistanceM: number, azimuthDeg: number) {
  if (groundDistanceM < 600) return "Cloud overhead";
  return `Cloud ${distanceText(groundDistanceM)} ${compassWord(azimuthDeg)}`;
}

export function heightText(cloud: Cloud) {
  const h = cloudHeight(cloud);
  const rounded = Math.round(h.meters / 100) * 100;
  return `${h.estimated ? "About " : ""}${rounded.toLocaleString("en-US")} m up${h.estimated ? ", estimated" : ""}`;
}

export function ago(iso: string | null, now = Date.now()) {
  if (!iso) return null;
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export function freshnessText(freshness: Freshness | null, asOf: string | null, synthetic: boolean) {
  const when = ago(asOf);
  switch (freshness) {
    case "live":
      return { label: `Live · seen ${when}`, tone: "live" as const };
    case "estimated":
      return { label: `Estimated · seen ${when}`, tone: "estimated" as const };
    case "stale":
      return { label: when ? `Stale · last seen ${when}` : "No recent observations", tone: "stale" as const };
    case "replay":
      return { label: synthetic ? "Replay · synthetic clouds" : "Replay", tone: "replay" as const };
    default:
      return { label: synthetic ? "Synthetic clouds" : "Loading sky…", tone: "replay" as const };
  }
}

export function statusNote(cloud: Cloud): string | null {
  if (cloud.kind === "created") {
    const left = cloud.expiresAt ? Math.max(0, (Date.parse(cloud.expiresAt) - Date.now()) / 3600000) : null;
    return `Created cloud${cloud.creatorId?.startsWith("anon_") ? " · Anonymous" : ""}${left !== null ? ` · fades in ${left < 1 ? "under an hour" : `${Math.round(left)} h`}` : ""}`;
  }
  if (cloud.status === "uncertain") return "Position uncertain: tracking lost sight of it";
  if (cloud.confidence < 0.5) return "Low-confidence match";
  return null;
}
