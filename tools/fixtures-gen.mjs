// Deterministic fixture generator. Re-run with `pnpm fixtures:gen`; CI fails if output drifts.
// All scenarios are SYNTHETIC and must be labeled as such in any demo UI.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { SCENARIOS_DIR } from "./lib/fs.mjs";
import { windToUV, displaceMeters } from "../packages/contracts/src/geo.ts";

const T0 = Date.UTC(2026, 9, 24, 15, 0, 0); // fixed, never Date.now()
const iso = (min) => new Date(T0 + min * 60_000).toISOString();
const TROY = { longitude: -73.6918, latitude: 42.7284 };
const WEST_10 = windToUV(10, 270); // west wind 10 m/s => moves east
const EAST_M_10MIN = WEST_10.uMps * 600; // ~6000 m
const round = (n) => Math.round(n * 1e6) / 1e6;

const at = (east, north) => displaceMeters(TROY, east, north);
const pos = (p) => [round(p.longitude), round(p.latitude)];

function square(center, halfM) {
  const c = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([x, y]) => pos(displaceMeters(center, x * halfM, y * halfM)));
  return { type: "MultiPolygon", coordinates: [[c]] };
}
const wind = (min, conf = 0.8) => ({ uMps: round(WEST_10.uMps), vMps: round(WEST_10.vMps), altitudeM: 2000, source: "fixture:synthetic", validAt: iso(min), confidence: conf });

function cloud(o) {
  return {
    id: o.id, version: o.version ?? 1, kind: o.kind ?? "observed", status: o.status ?? "active",
    geometry: square(o.center, o.halfM ?? 2000), observedAt: iso(o.min), updatedAt: iso(o.min),
    confidence: o.confidence ?? 0.85, wind: wind(o.min, o.windConf), parentIds: o.parentIds ?? [],
    creatorId: o.creatorId ?? null, expiresAt: o.expiresAt ?? null, datasetId: o.datasetId, trackingRunId: o.run,
  };
}
const message = (id, cloudId, anchor, body, extra = {}) => ({
  id, version: 1, cloudId, authorId: "user_fixture_alice", kind: "text", anchor: { longitude: round(anchor.longitude), latitude: round(anchor.latitude) },
  createdAt: iso(-5), updatedAt: iso(-5), expiredAt: null, voteCount: 0, viewerHasUpvoted: false,
  body, assetId: null, songUrl: null, artworkTransform: null, ...extra,
});
const mv = (a, east, north = 0) => displaceMeters(a, east, north);

function batch(ds, run, seq, min, snapshots, events = [], anchorUpdates = []) {
  return { schemaVersion: 1, batchId: `${ds}-b${String(seq).padStart(3, "0")}`, datasetId: ds, trackingRunId: run, sequence: seq, observedAt: iso(min), snapshots, events, anchorUpdates };
}
const ev = (ds, n, type, src, tgt, min) => ({ eventId: `${ds}-e${n}`, type, sourceCloudIds: src, targetCloudIds: tgt, effectiveAt: iso(min) });
const up = (m, action, targetCloudId, anchor) => ({ messageId: m.id, expectedMessageVersion: m.version, targetCloudId, anchor: { longitude: round(anchor.longitude), latitude: round(anchor.latitude) }, action });

const scenarios = [];
function add(name, description, batches, seedMessages, expect) {
  scenarios.push({ name, description, batches, seedMessages, expect });
}

// 1. scattered-advection: two clouds drift 6 km east in 10 minutes
{
  const ds = "fx-scattered", run = `${ds}-run1`;
  const A = at(-6000, 0), B = at(2000, 5000);
  const mA = message("msg_scat_a1", "cld_scat_a", A, "hello from cloud A"), mB = message("msg_scat_b1", "cld_scat_b", B, "hello from cloud B");
  add("scattered-advection", "Two clouds; west wind 10 m/s moves everything ~6 km east over 10 min.", [
    batch(ds, run, 1, 0, [cloud({ id: "cld_scat_a", center: A, min: 0, datasetId: ds, run }), cloud({ id: "cld_scat_b", center: B, min: 0, datasetId: ds, run })], [ev(ds, 1, "created", [], ["cld_scat_a"], 0), ev(ds, 2, "created", [], ["cld_scat_b"], 0)]),
    batch(ds, run, 2, 10, [cloud({ id: "cld_scat_a", version: 2, center: mv(A, EAST_M_10MIN), min: 10, datasetId: ds, run }), cloud({ id: "cld_scat_b", version: 2, center: mv(B, EAST_M_10MIN), min: 10, datasetId: ds, run })], [ev(ds, 3, "updated", ["cld_scat_a"], ["cld_scat_a"], 10), ev(ds, 4, "updated", ["cld_scat_b"], ["cld_scat_b"], 10)],
      [up(mA, "move", "cld_scat_a", mv(A, EAST_M_10MIN)), up(mB, "move", "cld_scat_b", mv(B, EAST_M_10MIN))]),
  ], [mA, mB], { activeCloudIds: ["cld_scat_a", "cld_scat_b"], movedMessages: { msg_scat_a1: { eastM: EAST_M_10MIN }, msg_scat_b1: { eastM: EAST_M_10MIN } } });
}

// 2. overcast: one huge cloud; two notes 20 km apart stay distinct while the footprint changes
{
  const ds = "fx-overcast", run = `${ds}-run1`;
  const W = at(-10000, 0), E = at(10000, 0);
  const mW = message("msg_oc_w", "cld_overcast", W, "far west note"), mE = message("msg_oc_e", "cld_overcast", E, "far east note");
  add("overcast", "Broad cover; footprint shrinks on the east side but notes keep distinct anchors (no bbox rescale).", [
    batch(ds, run, 1, 0, [cloud({ id: "cld_overcast", center: at(0, 0), halfM: 25000, min: 0, datasetId: ds, run })], [ev(ds, 1, "created", [], ["cld_overcast"], 0)]),
    batch(ds, run, 2, 10, [cloud({ id: "cld_overcast", version: 2, center: at(EAST_M_10MIN - 3000, 0), halfM: 22000, min: 10, datasetId: ds, run })], [ev(ds, 2, "updated", ["cld_overcast"], ["cld_overcast"], 10)],
      [up(mW, "move", "cld_overcast", mv(W, EAST_M_10MIN)), up(mE, "move", "cld_overcast", mv(E, EAST_M_10MIN))]),
  ], [mW, mE], { activeCloudIds: ["cld_overcast"], minAnchorSeparationM: 19000 });
}

// 3. merge
{
  const ds = "fx-merge", run = `${ds}-run1`;
  const A = at(-3000, 0), B = at(3000, 0);
  const mA = message("msg_mg_a", "cld_mg_a", A, "note on A"), mB = message("msg_mg_b", "cld_mg_b", B, "note on B");
  add("merge", "A and B merge into M; both notes transfer exactly once, predecessors retire.", [
    batch(ds, run, 1, 0, [cloud({ id: "cld_mg_a", center: A, min: 0, datasetId: ds, run }), cloud({ id: "cld_mg_b", center: B, min: 0, datasetId: ds, run })], [ev(ds, 1, "created", [], ["cld_mg_a"], 0), ev(ds, 2, "created", [], ["cld_mg_b"], 0)]),
    batch(ds, run, 2, 10, [cloud({ id: "cld_mg_a", version: 2, status: "expired", center: A, min: 10, datasetId: ds, run }), cloud({ id: "cld_mg_b", version: 2, status: "expired", center: B, min: 10, datasetId: ds, run }), cloud({ id: "cld_mg_m", center: at(0, 0), halfM: 6000, min: 10, parentIds: ["cld_mg_a", "cld_mg_b"], datasetId: ds, run })],
      [ev(ds, 3, "merged", ["cld_mg_a", "cld_mg_b"], ["cld_mg_m"], 10)], [up(mA, "move", "cld_mg_m", mv(A, 500)), up(mB, "move", "cld_mg_m", mv(B, -500))]),
  ], [mA, mB], { activeCloudIds: ["cld_mg_m"], expiredCloudIds: ["cld_mg_a", "cld_mg_b"], messageCloud: { msg_mg_a: "cld_mg_m", msg_mg_b: "cld_mg_m" } });
}

// 4. split
{
  const ds = "fx-split", run = `${ds}-run1`;
  const L = at(-4000, 0), R = at(4000, 0);
  const mL = message("msg_sp_l", "cld_sp_m", L, "west half note"), mR = message("msg_sp_r", "cld_sp_m", R, "east half note");
  add("split", "M splits into S1 (west) and S2 (east); each note goes to exactly one child by containment.", [
    batch(ds, run, 1, 0, [cloud({ id: "cld_sp_m", center: at(0, 0), halfM: 7000, min: 0, datasetId: ds, run })], [ev(ds, 1, "created", [], ["cld_sp_m"], 0)]),
    batch(ds, run, 2, 10, [cloud({ id: "cld_sp_m", version: 2, status: "expired", center: at(0, 0), halfM: 7000, min: 10, datasetId: ds, run }), cloud({ id: "cld_sp_s1", center: at(-5000, 0), halfM: 3000, min: 10, parentIds: ["cld_sp_m"], datasetId: ds, run }), cloud({ id: "cld_sp_s2", center: at(5000, 0), halfM: 3000, min: 10, parentIds: ["cld_sp_m"], datasetId: ds, run })],
      [ev(ds, 2, "split", ["cld_sp_m"], ["cld_sp_s1", "cld_sp_s2"], 10)], [up(mL, "move", "cld_sp_s1", mv(L, -1000)), up(mR, "move", "cld_sp_s2", mv(R, 1000))]),
  ], [mL, mR], { activeCloudIds: ["cld_sp_s1", "cld_sp_s2"], expiredCloudIds: ["cld_sp_m"], messageCloud: { msg_sp_l: "cld_sp_s1", msg_sp_r: "cld_sp_s2" } });
}

// 5. dissipation: needs 3 consecutive clear observations spanning >= 10 min before expiry
{
  const ds = "fx-dissipation", run = `${ds}-run1`;
  const C = at(0, 0);
  const m = message("msg_ds_1", "cld_ds", C, "this one will clear");
  const snap = (v, min, status) => cloud({ id: "cld_ds", version: v, status, center: C, min, datasetId: ds, run, confidence: 0.6 });
  add("dissipation", "Clear obs #1 (t+5), #2 (t+10), #3 (t+16): only after #3 does the cloud dissipate and the note expire.", [
    batch(ds, run, 1, 0, [snap(1, 0, "active")], [ev(ds, 1, "created", [], ["cld_ds"], 0)]),
    batch(ds, run, 2, 5, [snap(2, 5, "active")], [], [up({ ...m }, "hold", null, C)]),
    batch(ds, run, 3, 10, [snap(3, 10, "active")], [], [up({ ...m, version: m.version }, "hold", null, C)]),
    batch(ds, run, 4, 16, [snap(4, 16, "expired")], [ev(ds, 2, "dissipated", ["cld_ds"], [], 16)], [up({ ...m }, "expire", null, C)]),
  ], [m], { expiredCloudIds: ["cld_ds"], expiredMessageIds: ["msg_ds_1"], notExpiredAfterSequence: { 3: ["msg_ds_1"] } });
}

// 6. outage: 45 minutes without usable imagery must NOT delete anything
{
  const ds = "fx-outage", run = `${ds}-run1`;
  const C = at(0, 0);
  const m = message("msg_out_1", "cld_out", C, "survives the outage");
  add("outage", "Data gap > 30 min: cloud goes uncertain, content is held, nothing is deleted.", [
    batch(ds, run, 1, 0, [cloud({ id: "cld_out", center: C, min: 0, datasetId: ds, run })], [ev(ds, 1, "created", [], ["cld_out"], 0)]),
    batch(ds, run, 2, 45, [cloud({ id: "cld_out", version: 2, status: "uncertain", center: mv(C, 6000 * 3), min: 45, confidence: 0.2, windConf: 0.3, datasetId: ds, run })], [ev(ds, 2, "uncertain", ["cld_out"], ["cld_out"], 45)], [up(m, "hold", "cld_out", C)]),
  ], [m], { uncertainCloudIds: ["cld_out"], notExpiredMessageIds: ["msg_out_1"] });
}

// 7. clear-sky: nothing observed; UI must offer "Draw a cloud"
{
  const ds = "fx-clear", run = `${ds}-run1`;
  add("clear-sky", "No observed clouds. UI shows Draw a cloud.", [batch(ds, run, 1, 0, [], [])], [], { activeCloudIds: [] });
}

// 8. created-cloud: user-drawn, 24h expiry, advected by wind
{
  const ds = "fx-created", run = `${ds}-run1`;
  const C = at(0, 3000);
  const exp = iso(24 * 60);
  const m = message("msg_cr_1", "cld_created", C, "my own cloud");
  add("created-cloud", "Created cloud (creator + 24h expiry) advects with wind; never merges with observed clouds.", [
    batch(ds, run, 1, 0, [cloud({ id: "cld_created", kind: "created", center: C, halfM: 2500, min: 0, creatorId: "user_fixture_alice", expiresAt: exp, datasetId: ds, run }), cloud({ id: "cld_created_neighbor", center: mv(C, 1500), halfM: 3000, min: 0, datasetId: ds, run })], [ev(ds, 1, "created", [], ["cld_created"], 0)]),
    batch(ds, run, 2, 10, [cloud({ id: "cld_created", version: 2, kind: "created", center: mv(C, EAST_M_10MIN), halfM: 2500, min: 10, creatorId: "user_fixture_alice", expiresAt: exp, datasetId: ds, run }), cloud({ id: "cld_created_neighbor", version: 2, center: mv(C, 1500 + EAST_M_10MIN), halfM: 3000, min: 10, datasetId: ds, run })], [ev(ds, 2, "updated", ["cld_created"], ["cld_created"], 10)], [up(m, "move", "cld_created", mv(C, EAST_M_10MIN))]),
  ], [m], { activeCloudIds: ["cld_created", "cld_created_neighbor"] });
}

rmSync(SCENARIOS_DIR, { recursive: true, force: true });
for (const s of scenarios) {
  const dir = path.join(SCENARIOS_DIR, s.name);
  mkdirSync(dir, { recursive: true });
  const files = s.batches.map((b) => `batch-${String(b.sequence).padStart(3, "0")}.json`);
  s.batches.forEach((b, i) => writeFileSync(path.join(dir, files[i]), JSON.stringify(b, null, 2) + "\n"));
  const meta = { name: s.name, description: s.description, datasetId: s.batches[0].datasetId, synthetic: true, batches: files, seed: { users: [{ id: "user_fixture_alice", displayName: "Alice (fixture)", avatarUrl: null }], messages: s.seedMessages }, expect: s.expect };
  writeFileSync(path.join(dir, "scenario.json"), JSON.stringify(meta, null, 2) + "\n");
}
console.log(`wrote ${scenarios.length} scenarios to fixtures/scenarios`);
