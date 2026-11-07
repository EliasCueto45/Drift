// DEV-ONLY fixture-backed API (in-memory). Lets Owner 1 build UI and Owner 3 test posting
// before the real backend exists, and lets us test the smoke script itself.
// Not a fallback: never ship it, and the real API must replace it behind the same routes.
//   pnpm --filter @drift/tools mock     (PORT=3000, TRACKING_INGEST_SECRET=dev-only-change-me)
import http from "node:http";
import { listScenarios } from "./lib/fs.mjs";

const PORT = Number(process.env.PORT ?? 3000);
const SECRET = process.env.TRACKING_INGEST_SECRET ?? "dev-only-change-me";
const clouds = new Map(), messages = new Map(), lastSeq = new Map(), batches = new Map(), votes = new Map();
for (const s of listScenarios()) for (const m of s.meta.seed.messages) messages.set(m.id, structuredClone(m));

const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const err = (res, status, code, message) => send(res, status, { error: { code, message, requestId: "mock" } });
const readBody = (req) => new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d ? JSON.parse(d) : {})); });
const rank = (a, b) => b.voteCount - a.voteCount || (a.createdAt < b.createdAt ? 1 : -1) || (a.id < b.id ? -1 : 1);

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x"); const p = url.pathname; const auth = req.headers.authorization ?? "";
  if (req.method === "POST" && p === "/api/internal/tracking/batches") {
    if (auth !== `Bearer ${SECRET}`) return err(res, 401, "UNAUTHENTICATED", "bad worker secret");
    const b = await readBody(req);
    if (batches.has(b.batchId)) return send(res, 200, { data: { duplicate: true, ...batches.get(b.batchId) } });
    const expect = (lastSeq.get(b.datasetId) ?? 0) + 1;
    if (b.sequence !== expect) return err(res, 409, "OUT_OF_ORDER", `expected sequence ${expect}, got ${b.sequence}`);
    for (const c of b.snapshots) clouds.set(c.id, c);
    for (const u of b.anchorUpdates) {
      const m = messages.get(u.messageId); if (!m) continue;
      if (m.version !== u.expectedMessageVersion) return err(res, 409, "VERSION_CONFLICT", u.messageId);
      if (u.action === "move") { m.anchor = u.anchor; m.cloudId = u.targetCloudId; }
      if (u.action === "expire") m.expiredAt = b.observedAt;
    }
    lastSeq.set(b.datasetId, b.sequence); const ack = { sequence: b.sequence }; batches.set(b.batchId, ack);
    return send(res, 200, { data: ack });
  }
  if (req.method === "GET" && p === "/api/v1/sky") {
    const ds = url.searchParams.get("datasetId");
    const list = [...clouds.values()].filter((c) => c.datasetId === ds && c.status !== "expired").map((cloud) => ({
      cloud, previews: [...messages.values()].filter((m) => m.cloudId === cloud.id && !m.expiredAt).sort(rank).slice(0, 3),
    }));
    return send(res, 200, { data: { clouds: list, asOf: new Date().toISOString(), weather: null, freshness: "replay" }, nextCursor: null });
  }
  let m;
  if ((m = p.match(/^\/api\/v1\/clouds\/([^/]+)\/messages$/))) {
    if (req.method === "GET") return send(res, 200, { data: [...messages.values()].filter((x) => x.cloudId === m[1] && !x.expiredAt).sort(rank), nextCursor: null });
    if (req.method === "POST") {
      if (!auth.startsWith("Bearer ")) return err(res, 401, "UNAUTHENTICATED", "sign in");
      const b = await readBody(req); if ("authorId" in b) return err(res, 422, "INVALID", "authorId is server-derived");
      const id = `msg_mock_${messages.size + 1}`; const now = new Date().toISOString();
      const msg = { id, version: 1, cloudId: m[1], authorId: "user_mock", kind: b.kind, anchor: b.anchor, createdAt: now, updatedAt: now, expiredAt: null, voteCount: 0, viewerHasUpvoted: false, body: b.body ?? null, assetId: null, songUrl: null, artworkTransform: null };
      messages.set(id, msg); return send(res, 201, { data: msg });
    }
  }
  if (req.method === "PUT" && (m = p.match(/^\/api\/v1\/messages\/([^/]+)\/upvote$/))) {
    if (!auth.startsWith("Bearer ")) return err(res, 401, "UNAUTHENTICATED", "sign in");
    const msg = messages.get(m[1]); if (!msg) return err(res, 404, "NOT_FOUND", m[1]);
    const { active } = await readBody(req); const set = votes.get(m[1]) ?? new Set(); votes.set(m[1], set);
    active ? set.add("user_mock") : set.delete("user_mock"); msg.voteCount = set.size; msg.viewerHasUpvoted = set.size > 0;
    return send(res, 200, { data: { voteCount: msg.voteCount, viewerHasUpvoted: msg.viewerHasUpvoted } });
  }
  err(res, 404, "NOT_FOUND", `${req.method} ${p}`);
}).listen(PORT, () => console.log(`mock Drift API (DEV ONLY) on :${PORT}`));
