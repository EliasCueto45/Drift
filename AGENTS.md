# Drift development coordination

Read README.md before implementing. It defines product behavior, ownership, shared contracts, tracking algorithm and integration gates. This checkout starts as a specification; do not report a working app without code and verification.

On every continuation, inspect git status, recent changes, contracts and handoffs. Identify the assigned Owner 1–4 and next milestone. If no owner was assigned, follow the requested scope and state assumptions. Use a separate branch/checkout per person and preserve others' work.

- Owner 1: entire frontend, UI layouts/pages, sky/projection, discovery, composer, drawings, uploads, voting UI and Clerk client UI/provider.
- Owner 2: API routes, server, database/migrations, server-side Clerk verification, authorization, votes, storage, tracking ingestion, expiry and cleanup.
- Owner 3: Python tracking/weather worker and atmospheric fixture inputs.
- Owner 4: contracts/generated types/shared API client, root tooling, fixture infrastructure, local setup, CI, end-to-end checks, deployment and final integration.

Owner 1 retains frontend design and integration accountability. Owner 4 may help with isolated UI components after agreeing files/interfaces with Owner 1. API route files belong to Owner 2 even inside the app directory. Every owner supplies subsystem tests and environment requirements; Owner 4 assembles shared checks and setup.

Propose cross-owner changes in docs/decisions and the owner's handoff. Owner 4 integrates schema changes after affected-owner review. Never duplicate contracts, create a second coordinate system, silently bypass authentication, or hide fixture substitutions.

Maintain docs/handoffs/owner-N.md with branch/commit, files/interfaces, actual verification commands/results, blockers, next task and exact contract requests. Do not record secrets. Run relevant checks and distinguish planned commands from executed checks.

Core invariants: altitude-aware winds predict motion; satellite navigation geolocates observations. Preserve local anchors under overcast. Merge/split transfers content once. Missing data is not dissipation. Created clouds are labeled, expire after 24 hours and never automatically merge with observed clouds. Verify Clerk identity server-side. Votes are unique/idempotent. Expiry immediately excludes content from reads and new media authorizations.
