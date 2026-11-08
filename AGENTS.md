# AGENTS.md - rules for every assistant/owner working on Drift

1. Read README.md, `docs/INTEGRATION.md`, `packages/contracts/`, and `docs/handoffs/` before changing anything.
2. `packages/contracts/schemas/drift.schema.json` is the only source of truth. Python validators read it directly. The Python runtime decision supersedes the former generated TypeScript binding workflow.
3. Fixtures are generated: edit `tools/drift_tools/fixtures_gen.py` and metadata in `tools/drift_tools/scenarios.json`, run `python -m drift_tools.cli fixtures-gen`, commit the output.
4. Do not change contracts silently. Additive optional fields: announce in team chat. Breaking: `docs/decisions/` proposal.
5. Stay in your owned paths (see README). Cross-owner needs go in your handoff as an exact request.
6. Before opening a PR: `python -m drift_tools.cli check-contracts`, `python -m ruff check .`, `python -m mypy`, `python -W error -m pytest`, and the worker suite with `DRIFT_TEST_BACKEND=1`. Run `python -m drift_tools.cli smoke` for API/ingest changes against an isolated seeded stack.
7. Conventions that bite: GeoJSON is `[longitude, latitude]`; wind is stored as u/v m/s (convert "from" degrees only at adapter edges); timestamps UTC ISO; observation time != download time; live and replay never share datasets.
8. Fixtures and the mock API are labeled synthetic. Never present them as live data.
