import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const SCENARIOS_DIR = path.join(ROOT, "fixtures", "scenarios");
export const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

export function listScenarios() {
  if (!existsSync(SCENARIOS_DIR)) return [];
  return readdirSync(SCENARIOS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(SCENARIOS_DIR, d.name);
      const meta = readJson(path.join(dir, "scenario.json"));
      const batches = meta.batches.map((f) => ({ file: f, body: readJson(path.join(dir, f)) }));
      return { name: d.name, dir, meta, batches };
    });
}
