import type { Anchor } from "@/lib/contracts";
import { LIMITS } from "@/lib/contracts";
import { groundDistanceM } from "./geo";

// A spot accepted by the phone composer must also be discoverable after reload.
// Keep sky previews and expanded Nearby reads on the same supported radius.
export const DISCOVERY_RADIUS_M = LIMITS.maxRadiusM;

export function placementInRange(viewer: Anchor, anchor: Anchor): boolean {
  const distance = groundDistanceM(viewer, anchor);
  return Number.isFinite(distance) && distance <= DISCOVERY_RADIUS_M;
}
