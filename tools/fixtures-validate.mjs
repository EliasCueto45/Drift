// Validates every fixture against the contract AND checks cross-file invariants
// that JSON Schema can't express (lng/lat swaps, sequence order, unique IDs, closed rings).
import { validator } from "./lib/schema.mjs";
import { listScenarios } from "./lib/fs.mjs";

const vBatch = validator("TrackingBatch");
const vMsg = validator("Message");
const errs = [];
const fail = (where, msg) => errs.push(`${where}: ${msg}`);

const scenarios = listScenarios();
if (!scenarios.length) { console.error("no scenarios found - run `pnpm fixtures:gen`"); process.exit(1); }

// Troy region sanity box: catches [lat,lng] swaps, which still pass range checks.
const inTroyBox = ([lng, lat]) => lng > -75 && lng < -72 && lat > 42 && lat < 43.5;

const seenBatchIds = new Set(), seenEventIds = new Set();
for (const s of scenarios) {
  let prevSeq = 0;
  for (const { file, body } of s.batches) {
    const where = `${s.name}/${file}`;
    const r = vBatch(body);
    if (!r.ok) r.errors.forEach((e) => fail(where, e));
    if (body.sequence !== prevSeq + 1) fail(where, `sequence ${body.sequence} not contiguous after ${prevSeq}`);
    prevSeq = body.sequence;
    if (body.datasetId !== s.meta.datasetId) fail(where, "datasetId differs from scenario");
    if (seenBatchIds.has(body.batchId)) fail(where, `duplicate batchId ${body.batchId}`);
    seenBatchIds.add(body.batchId);
    for (const e of body.events) { if (seenEventIds.has(e.eventId)) fail(where, `duplicate eventId ${e.eventId}`); seenEventIds.add(e.eventId); }
    for (const c of body.snapshots) {
      if (c.datasetId !== body.datasetId || c.trackingRunId !== body.trackingRunId) fail(where, `${c.id} dataset/run mismatch`);
      for (const poly of c.geometry.coordinates) for (const ring of poly) {
        const f = ring[0], l = ring[ring.length - 1];
        if (f[0] !== l[0] || f[1] !== l[1]) fail(where, `${c.id} ring not closed`);
        if (!ring.every(inTroyBox)) fail(where, `${c.id} has coordinates outside Troy box (lng/lat swapped?)`);
      }
    }
  }
  for (const m of s.meta.seed.messages) {
    const r = vMsg(m);
    if (!r.ok) r.errors.forEach((e) => fail(`${s.name}/seed ${m.id}`, e));
    if (!inTroyBox([m.anchor.longitude, m.anchor.latitude])) fail(`${s.name}/seed ${m.id}`, "anchor outside Troy box (swap?)");
  }
}

// Negative tests: these MUST be rejected, or the schema is too loose.
const bad = [
  ["Message", "text without body", { ...scenarios[0].meta.seed.messages[0], body: null }],
  ["Message", "song with http url", { ...scenarios[0].meta.seed.messages[0], kind: "song", body: null, songUrl: "http://x.test/a" }],
  ["Message", "png without artworkTransform", { ...scenarios[0].meta.seed.messages[0], kind: "png", body: null, assetId: "a1" }],
  ["TrackingBatch", "wrong schemaVersion", { ...scenarios[0].batches[0].body, schemaVersion: 2 }],
  ["TrackingBatch", "sequence 0", { ...scenarios[0].batches[0].body, sequence: 0 }],
  ["AnchorUpdate", "move without target", { messageId: "m", expectedMessageVersion: 1, targetCloudId: null, anchor: { longitude: -73, latitude: 42 }, action: "move" }],
  ["Cloud", "created without expiry", { ...scenarios.find((x) => x.name === "created-cloud").batches[0].body.snapshots[0], expiresAt: null }],
  ["CreateMessageRequest", "client-supplied authorId", { kind: "text", anchor: { longitude: -73, latitude: 42 }, expectedCloudVersion: 1, body: "x", authorId: "forged" }],
  ["Asset", "leaks objectKey", { id: "a", ownerId: "u", kind: "png", mimeType: "image/png", sizeBytes: 1, state: "ready", createdAt: "2026-01-01T00:00:00Z", objectKey: "secret/path" }],
];
for (const [def, name, value] of bad) {
  if (validator(def)(value).ok) fail("negative", `${def} "${name}" was accepted but must be rejected`);
}

if (errs.length) { console.error(`FAIL (${errs.length})\n` + errs.map((e) => " - " + e).join("\n")); process.exit(1); }
console.log(`ok: ${scenarios.length} scenarios, ${seenBatchIds.size} batches, ${bad.length} negative cases`);
