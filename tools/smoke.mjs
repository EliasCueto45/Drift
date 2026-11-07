// End-to-end smoke test against a RUNNING stack. Keep this green on main.
//   pnpm smoke            (needs: web on :3000, `pnpm db:seed` done, TRACKING_INGEST_SECRET set)
// Steps that need a signed-in user run only when SMOKE_AUTH_TOKEN is set; otherwise they SKIP (never silently pass).
import { listScenarios } from "./lib/fs.mjs";
import { validator } from "./lib/schema.mjs";
import { postBatch } from "./replay.mjs";
import { haversineM } from "../packages/contracts/src/geo.ts";

const base = process.env.DRIFT_API_BASE_URL ?? "http://localhost:3000";
const token = process.env.SMOKE_AUTH_TOKEN;
const secret = process.env.TRACKING_INGEST_SECRET;
if (!secret) { console.error("TRACKING_INGEST_SECRET not set"); process.exit(2); }

const results = [];
const run = async (name, fn) => {
  try { const r = await fn(); results.push({ name, status: r === "SKIP" ? "SKIP" : "PASS" }); }
  catch (e) { results.push({ name, status: "FAIL", detail: e.message }); }
};
const ok = (c, m) => { if (!c) throw new Error(m); };
const get = async (p, auth) => {
  const res = await fetch(`${base}${p}`, { headers: auth && token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const vSky = validator("SkyResponse");
const vMsgs = validator("MessagesResponse");
const scenarios = Object.fromEntries(listScenarios().map((s) => [s.name, s]));
const adv = scenarios["scattered-advection"];
const [b1, b2] = adv.batches.map((b) => b.body);
const center = adv.batches[0].body.snapshots[0].geometry.coordinates[0][0][0];
const skyQ = (ds) => `/api/v1/sky?lat=42.7284&lng=-73.6918&radiusM=50000&datasetId=${ds}`;

await run("ingest rejects missing/bad worker secret", async () => {
  const r = await postBatch(b1, base, "wrong-secret");
  ok([401, 403].includes(r.status), `expected 401/403, got ${r.status}`);
});
await run("ingest batch 1", async () => { const r = await postBatch(b1, base, secret); ok(r.status < 300, `status ${r.status} ${JSON.stringify(r.body)}`); });
await run("duplicate batch is acknowledged, not applied twice", async () => { const r = await postBatch(b1, base, secret); ok(r.status < 300, `status ${r.status}`); });
await run("out-of-order sequence is rejected", async () => {
  const skipped = { ...b2, batchId: "smoke-skip", sequence: b2.sequence + 5 };
  const r = await postBatch(skipped, base, secret); ok(r.status >= 400 && r.status < 500, `expected 4xx, got ${r.status}`);
});
await run("GET /sky matches contract and shows seeded clouds", async () => {
  const r = await get(skyQ(adv.meta.datasetId)); ok(r.status === 200, `status ${r.status}`);
  const v = vSky(r.body); ok(v.ok, v.errors.join("; "));
  const ids = r.body.data.clouds.map((c) => c.cloud.id);
  for (const id of adv.meta.expect.activeCloudIds) ok(ids.includes(id), `missing ${id}`);
});
await run("seed messages present (run `pnpm db:seed`)", async () => {
  const id = adv.meta.seed.messages[0].cloudId;
  const r = await get(`/api/v1/clouds/${id}/messages?scope=all`); ok(r.status === 200, `status ${r.status}`);
  ok(vMsgs(r.body).ok, "response violates contract");
  ok(r.body.data.some((m) => m.id === adv.meta.seed.messages[0].id), "seed message not found - Owner 2 db:seed must load fixtures/scenarios/*/scenario.json seed.messages");
});
await run("ingest batch 2 and notes move ~6 km east", async () => {
  const r = await postBatch(b2, base, secret); ok(r.status < 300, `status ${r.status} ${JSON.stringify(r.body)}`);
  const m0 = adv.meta.seed.messages[0];
  const res = await get(`/api/v1/clouds/${m0.cloudId}/messages?scope=all`);
  const m = res.body.data.find((x) => x.id === m0.id);
  const d = haversineM(m0.anchor, m.anchor);
  ok(Math.abs(d - 6000) < 100, `moved ${Math.round(d)} m, expected ~6000`);
});
await run("anonymous write is rejected (401)", async () => {
  const res = await fetch(`${base}/api/v1/clouds/${adv.meta.seed.messages[0].cloudId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "text", anchor: center && { longitude: -73.7, latitude: 42.7 }, expectedCloudVersion: 1, body: "x" }) });
  ok(res.status === 401, `expected 401, got ${res.status}`);
});
await run("signed-in: post text, vote, vote is idempotent", async () => {
  if (!token) return "SKIP";
  const cloud = b2.snapshots[0];
  const post = await fetch(`${base}/api/v1/clouds/${cloud.id}/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ kind: "text", body: "smoke test", anchor: { longitude: cloud.geometry.coordinates[0][0][0][0] + 0.005, latitude: cloud.geometry.coordinates[0][0][0][1] + 0.005 }, expectedCloudVersion: cloud.version }) });
  ok(post.status === 201 || post.status === 200, `post status ${post.status}`);
  const { data } = await post.json();
  const vote = () => fetch(`${base}/api/v1/messages/${data.id}/upvote`, { method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ active: true }) }).then((r) => r.json());
  const a = await vote(), b = await vote();
  ok(a.data.voteCount === 1 && b.data.voteCount === 1, `vote counts ${a.data.voteCount}/${b.data.voteCount}, expected 1/1`);
});

console.log("\nDrift smoke\n" + results.map((r) => `${{ PASS: "✓", FAIL: "✗", SKIP: "-" }[r.status]} ${r.name}${r.detail ? `\n    ${r.detail}` : ""}`).join("\n"));
const failed = results.filter((r) => r.status === "FAIL").length;
console.log(`\n${results.filter((r) => r.status === "PASS").length} passed, ${failed} failed, ${results.filter((r) => r.status === "SKIP").length} skipped`);
process.exit(failed ? 1 : 0);
