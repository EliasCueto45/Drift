# Owner 4 handoff

**Milestone:** 1 (bootstrap) - contracts, fixtures, CI, smoke tooling. **Branch:** `owner-4/integration`.

## Delivered
- `packages/contracts`: JSON Schema v1 (24 defs), generated TS types, shared geo/wind helpers, Python validator (`drift_contracts.py`).
- `fixtures/`: 8 deterministic scenarios + `wind-cases.json` shared by TS and Python tests.
- `tools/`: `fixtures-gen`, `fixtures-validate` (schema + invariants + 9 negative cases), `replay`, `smoke`, `mock-api` (dev only).
- Root: pnpm workspace, `.env.example`, `docker-compose.yml` (PostGIS + MinIO, optional), CI, `AGENTS.md`, `docs/INTEGRATION.md`.

## Verified (run locally)
- `pnpm contracts:gen && pnpm fixtures:gen && pnpm fixtures:validate` -> 8 scenarios, 17 batches, 9 negative cases OK
- `pnpm --filter @drift/contracts test` -> 6 pass; `typecheck` clean
- `pytest packages/contracts/python` -> 3 pass
- `pnpm smoke` against `mock-api`: 9/9 with `SMOKE_AUTH_TOKEN`; 8 pass + 1 skip without
- **Not verified:** real API/DB (not built yet), CI on GitHub, Docker Compose.

## Exact requests to other owners
- **Owner 2:** (a) `pnpm db:seed` loads users + messages from every `fixtures/scenarios/*/scenario.json` `seed`; (b) ingest status codes per `docs/INTEGRATION.md`; (c) make `pnpm smoke` pass on the real stack; (d) never return `objectKey` (the Asset schema forbids it).
- **Owner 3:** validate every batch with `drift_contracts.validate`; match `fixtures/wind-cases.json`; dissipation needs 3 clear observations spanning >=10 min (see the `dissipation` scenario).
- **Owner 1:** develop against `pnpm mock`; GeoJSON is `[lng, lat]`, anchors are `{longitude, latitude}`.

## Next
1. Commit the lockfile, enable CI, confirm green on GitHub.
2. Walking-skeleton integration with Owners 1 and 2; swap the mock for the real API in the smoke CI job.
3. Decide `docs/decisions/0001`.
4. Deployment config once Owner 2 picks hosting/storage.
