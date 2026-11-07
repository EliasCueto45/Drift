# AGENTS.md - rules for every assistant/owner working on Drift

1. Read README.md, `docs/INTEGRATION.md`, `packages/contracts/`, and `docs/handoffs/` before changing anything.
2. `packages/contracts/schemas/drift.schema.json` is the only source of truth. Never hand-edit `src/generated/`; run `pnpm contracts:gen`.
3. Fixtures are generated: edit `tools/fixtures-gen.mjs`, run `pnpm fixtures:gen`, commit the output.
4. Do not change contracts silently. Additive optional fields: announce in team chat. Breaking: `docs/decisions/` proposal.
5. Stay in your owned paths (see README). Cross-owner needs go in your handoff as an exact request.
6. Before opening a PR: `pnpm check:contracts && pnpm lint && pnpm typecheck && pnpm test` (+ `pnpm smoke` if you touched API/ingest).
7. Conventions that bite: GeoJSON is `[longitude, latitude]`; wind is stored as u/v m/s (convert "from" degrees only at adapter edges); timestamps UTC ISO; observation time != download time; live and replay never share datasets.
8. Fixtures and the mock API are labeled synthetic. Never present them as live data.
