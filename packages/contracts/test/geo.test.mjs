import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { windToUV, displaceMeters, haversineM } from "../src/geo.ts";

const cases = JSON.parse(readFileSync(new URL("../../../fixtures/wind-cases.json", import.meta.url)));

for (const c of cases.cases) {
  test(`wind ${c.name}`, () => {
    const { uMps, vMps } = windToUV(c.speedMps, c.fromDeg);
    assert.ok(Math.abs(uMps - c.expected.uMps) < 1e-9, `u ${uMps} != ${c.expected.uMps}`);
    assert.ok(Math.abs(vMps - c.expected.vMps) < 1e-9, `v ${vMps} != ${c.expected.vMps}`);
  });
}

test("west wind 10 m/s moves ~6 km east in 10 min", () => {
  const { uMps, vMps } = windToUV(10, 270);
  const start = { longitude: -73.69, latitude: 42.73 };
  const end = displaceMeters(start, uMps * 600, vMps * 600);
  assert.ok(end.longitude > start.longitude, "must move east");
  assert.ok(Math.abs(end.latitude - start.latitude) < 1e-9, "no north/south drift");
  const d = haversineM(start, end);
  assert.ok(Math.abs(d - 6000) < 10, `distance ${d}`);
});
