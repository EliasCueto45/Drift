import type { Message } from "@/lib/contracts";

/** Revalidated IDs may move to another cloud or disappear; unqueried IDs stay untouched. */
export function reconcileCreated(
  current: Record<string, Message[]>,
  authoritative: Message[],
  checked: Set<string>,
  born: Record<string, number>,
  started: number,
  removed: ReadonlySet<string>,
  removedClouds: ReadonlySet<string>,
) {
  const byId = new Map(
    Object.values(current)
      .flat()
      .map((m) => [m.id, m]),
  );
  for (const id of checked) if ((born[id] ?? 0) <= started) byId.delete(id);
  for (const message of authoritative) {
    if ((born[message.id] ?? 0) <= started) byId.set(message.id, message);
  }
  const grouped: Record<string, Message[]> = {};
  for (const message of byId.values()) {
    if (
      message.expiredAt ||
      removed.has(message.id) ||
      removedClouds.has(message.cloudId)
    )
      continue;
    (grouped[message.cloudId] ??= []).push(message);
  }
  return grouped;
}
