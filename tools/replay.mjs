// Posts a scenario's batches to the ingest endpoint in order.
//   pnpm replay -- --scenario scattered-advection [--base http://localhost:3000] [--repeat] [--through 2]
// Reads TRACKING_INGEST_SECRET from env. Replay uses the SAME endpoint the real worker uses.
import { listScenarios } from "./lib/fs.mjs";

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a !== "--").reduce((acc, a, i, arr) => {
  if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true]);
  return acc;
}, []));
const base = args.base ?? process.env.DRIFT_API_BASE_URL ?? "http://localhost:3000";
const secret = process.env.TRACKING_INGEST_SECRET;
if (!secret) { console.error("TRACKING_INGEST_SECRET not set"); process.exit(2); }

export async function postBatch(batch, baseUrl = base, token = secret) {
  const res = await fetch(`${baseUrl}/api/internal/tracking/batches`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(batch),
  });
  let body = null; try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const all = listScenarios();
  const names = args.scenario === "all" || !args.scenario ? all.map((s) => s.name) : [args.scenario];
  for (const name of names) {
    const s = all.find((x) => x.name === name);
    if (!s) { console.error(`unknown scenario ${name}; have: ${all.map((x) => x.name).join(", ")}`); process.exit(2); }
    const limit = args.through ? Number(args.through) : Infinity;
    for (const { file, body } of s.batches) {
      if (body.sequence > limit) break;
      const r = await postBatch(body);
      console.log(`${name}/${file} seq=${body.sequence} -> ${r.status}`);
      if (r.status >= 300) { console.error(JSON.stringify(r.body)); process.exit(1); }
      if (args.repeat) console.log(`  repeat -> ${(await postBatch(body)).status} (should be a duplicate ack, not an error)`);
    }
  }
}
