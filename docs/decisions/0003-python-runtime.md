# Python application runtime

The application and repository tooling now use Python at the project team's request. This supersedes the earlier Next.js/TypeScript runtime choice and generated TypeScript-binding workflow. It does not change contract v1 JSON payloads, paths, IDs, units, timestamps or tracking acknowledgement semantics.

- FastAPI replaces the Node API and Next route adapter on port 3000.
- PyMongo replaces the JavaScript MongoDB driver. Existing Atlas collections, string IDs, history keys, indexes, transactions and replay clocks remain compatible. No data export or destructive migration is required.
- PyJWT and Clerk JWKS verify session tokens. Public profile fields come from Clerk's backend API. Anonymous reads and the separate worker bearer credential retain their existing behavior.
- Boto3, Pillow, PyAV, Shapely and PyProj replace JavaScript storage/media/geometry packages. PNG output may be encoded differently while preserving decoded pixels and transparency; ready media remains separate from pending uploads.
- Python commands replace pnpm scripts, fixture generation/validation, replay, mock API, smoke checks and worker test harnesses. JSON Schema remains the only wire-contract source of truth. The existing Python validator remains available to the worker.
- Dissipation fixtures now expect message versions 2 and 3 after successive holds, matching transactional worker reconciliation.

Scope includes shared tooling and worker integration test launchers. Scientific tracking behavior is unchanged. Existing JavaScript source and Node lockfiles are removed after the Python replacement is exercised. Historical git commits remain available for reference.

There is no frontend implementation in this checkout. Removing Node does not implement the sky/composer UI. Owners 1/4 still need to choose and build that browser layer; interactive canvas and Clerk browser widgets may use browser JavaScript even with a Python server. Keep the canonical JSON contracts compatible with that frontend.

Configuration still loads ignored root `.env` and `apps/web/.env.local`, with explicit process variables taking precedence. Both `CLERK_PUBLISHABLE_KEY` and the existing `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` are accepted. Deployment must route `/api/*` to FastAPI and use a configured `DRIFT_APP_ORIGIN` when the browser origin differs from the internal API host. Secrets remain server-only.

Verification on Windows/Python 3.12: 81 backend/contract/worker tests pass with warnings treated as errors, including all eight synthetic lifecycle scenarios, camera-AR payload compatibility, real replica-set transactions, concurrent votes, rollback, cleanup retry, JWT rejection and real HTTP smoke. Ruff, mypy, fixture reproducibility, dependency consistency and documented editable installs pass. Existing local Atlas and Clerk settings were checked through Python; five HTTP checks pass against configured persistence without creating user content. Linux/GitHub CI and real browser/private-media acceptance remain pending.

Integration baseline: main `cccea87` includes Owner 1's `77f98ad` camera-AR README and proposal, with no frontend code or schema change. This branch includes that main revision and preserves its camera-first experience, map fallback, sensor/privacy requirements and text/link/image MVP. Backend kinds remain `text`, `song` (existing HTTPS allowlist), and `png`; legacy audio/drawing API compatibility is retained outside the MVP UI. Any generic-link rename needs a reviewed compatibility plan. Python API hosting does not supply browser camera/sensor/canvas behavior.
