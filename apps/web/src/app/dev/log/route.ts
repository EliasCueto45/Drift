import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * Dev-only sink for phone logs (see features/debug/remoteLog.ts). Absent in production.
 * Appends one JSON line per entry to apps/web/.dev-logs/phone.log.
 */
const dir = path.join(process.cwd(), ".dev-logs");
const file = path.join(dir, "phone.log");
const MAX_BODY = 64 * 1024;

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const text = await request.text();
  if (text.length > MAX_BODY) return new Response(null, { status: 413 });
  let parsed: { session?: unknown; entries?: unknown };
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }
  const session = typeof parsed.session === "string" ? parsed.session.slice(0, 16) : "?";
  const entries = Array.isArray(parsed.entries) ? parsed.entries.slice(0, 200) : [];
  if (!entries.length) return new Response(null, { status: 204 });
  const lines = entries.map((e) => JSON.stringify({ s: session, ...(e as object) })).join("\n") + "\n";
  await mkdir(dir, { recursive: true });
  await appendFile(file, lines, "utf8");
  return new Response(null, { status: 204 });
}
