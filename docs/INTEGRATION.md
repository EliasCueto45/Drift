# Integration playbook (Owner 4)

Principle: integrate the interfaces first, implementations later. Everyone builds against the same fixtures from hour 1.

## Cadence
| When | What must be true |
|---|---|
| Hour 0-1 | Contracts + fixtures reviewed by all four. `python -m drift_tools.cli check-contracts` green. |
| Hour 1-6 | **Walking skeleton**: sign in -> fixture cloud -> post text -> second browser sees it -> vote. Real DB + real Clerk. No media, no worker. |
| Every 2-3 h | Merge to `main`. `python -m drift_tools.cli smoke` stays green. Owner 4 watches CI. |
| Middle | Swap fakes for real, riskiest first: worker output -> same ingest endpoint. |
| Last 3-4 h | Hardening + clean-clone check + demo rehearsal. No first contact between components. |

## Build against what, before the real thing exists
- **Owner 1 (UI)**: `python -m drift_tools.cli mock` (synthetic fixture-backed API on :3000) or use `fixtures/scenarios/*`.
- **Owner 2 (API)**: `python -m drift_tools.cli replay --scenario scattered-advection` posts to the ingest route; `python -m drift_tools.cli smoke` is the acceptance test. Use an isolated seeded stack because replay advances its sequence.
- **Owner 3 (worker)**: write batches to disk, validate with `drift_contracts.validate("TrackingBatch", b)`, post through the same replay path.

## Ingest behavior (decided here so Owners 2 and 3 don't guess)
| Situation | Response |
|---|---|
| Wrong/missing worker secret | `401` |
| New valid batch, next sequence | `200 {data:{sequence}}` |
| Same `batchId` again | `200` with the original result, not re-applied |
| Sequence not exactly last+1 | `409 OUT_OF_ORDER` |
| Stale `expectedMessageVersion` | `409 VERSION_CONFLICT`, nothing written |
| Schema-invalid | `422` |

## Scenarios (`fixtures/scenarios/*`)
scattered-advection, overcast, merge, split, dissipation, outage, clear-sky, created-cloud. Each has a `scenario.json` with seeded messages and `expect` assertions, and its own `datasetId` (`fx-*`) so scenarios never collide with each other or with live data.

## Merging
Small PRs, rebase on main, never force-push main. A PR that breaks Python smoke or contract checks does not merge. If a conflict touches someone else's module, ask them. The Python runtime decision preserves canonical HTTP/JSON interfaces; scientific worker behavior is unchanged.
