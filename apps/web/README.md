# Drift web (Owner 1)

Next.js 16 + TypeScript frontend for the camera AR sky, map fallback, cloud panel/sheet and composer. Node is frontend tooling only; the API is the Python app in `src/server/` (Owner 2). The canonical schema stays `packages/contracts/schemas/drift.schema.json`; `npm run contracts:gen` regenerates `src/lib/contracts/generated.ts` from it and `contracts:check` fails when it is stale.

## Run it

```sh
# Terminal 1, repo root: API on :3000. Either the synthetic mock...
TRACKING_INGEST_SECRET=dev-only-change-me python -m drift_tools.cli mock
TRACKING_INGEST_SECRET=dev-only-change-me python -m drift_tools.cli replay   # seed fixture clouds
# ...or the real API (Atlas + Clerk), with DRIFT_APP_ORIGIN set to the browser origin:
python -m drift_api.cli serve

# Terminal 2, apps/web: app on :3001, /api/* forwarded to :3000 (same origin)
npm install
npm run dev          # http://localhost:3001 (map + simulated sky; no camera over plain http)
npm run dev:https    # https://localhost:3001 for camera/compass on this machine
```

Phones need HTTPS for camera and motion sensors: `cloudflared tunnel --url https://localhost:3001` (then set `DRIFT_APP_ORIGIN` to the tunnel URL for the real API, and add it to Clerk's allowed origins).

Environment (`apps/web/.env.local`, never committed): `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` enables Clerk sign-in. Optional: `NEXT_PUBLIC_DRIFT_DATASET_ID` (default `fx-scattered`), `NEXT_PUBLIC_DRIFT_DEV_AUTH=mock` (a visibly labeled dev sign-in only the mock accepts; ignored when Clerk is configured), `NEXT_PUBLIC_DRIFT_DECLINATION_DEG` (compass correction override), `DRIFT_API_ORIGIN` (proxy target, default `http://127.0.0.1:3000`).

Demo URLs: `/?view=simulated` (simulated sky over Troy, labeled), `/?view=map`, `/?dataset=fx-overcast` (any fixture scenario; always labeled synthetic).

## Checks

```sh
npm run typecheck && npm run lint && npm test && npm run contracts:check
```

## Layout

- `src/features/sky/` — `projection.ts` (the single `SkyProjection`, geo <-> screen both ways), `geo.ts` (WGS84/ECEF/ENU), `orientation.ts` + `sensors.ts` (camera pose, permissions), `scene.ts` (per-frame scene, hit testing), `render.ts` (vapor lettering, synthetic clouds), `SkyStage.tsx` (camera/simulated canvas), `MapStage.tsx` (2D fallback), `CloudPanel.tsx`, `CloudSheet.tsx`, `DriftApp.tsx` (flow).
- `src/features/composer/` — `Composer.tsx`, `PostItem.tsx`, `posts.tsx` (votes, local posts).
- `src/lib/` — API client, contract types, Clerk/dev auth bridge.

## Connected cloud and post flows

Draw a cloud opens a geographic outline editor from camera, simulated or map views. Tap outline points or pan with arrow keys and add a point at the crosshair; publishing closes the ring and validates it on the API. It targets the dataset currently displayed. Created-cloud deletion and post deletion show confirmation and are available to the current creator/author; the server enforces ownership.

The composer retains its request/key when a response is lost, including the original cloud version. Editing or receiving a definite rejection starts a new attempt. The API keeps transactional receipts for 24 hours without copying post bodies. Posts show public author names with a neutral fallback for older profiles. Polling revalidates local posts and loaded rows, preserving moved anchors and removing held/expired/deleted entries; the shared 50 km discovery policy remains in effect. Account changes clear local post/vote state. Read `docs/decisions/0004-connected-cloud-post-flows.md` for the additive contract fields and retry semantics.

## Third-party assets

- Indoor/outdoor scene model: Places365 ResNet18 (MIT CSAIL, CC BY), int8, run on the device with onnxruntime-web. Camera frames never leave the phone. Credits and build steps: `public/models/CREDITS.md`, `scripts/build_scene_model.py`. `npm run dev`/`build` copy the onnxruntime WASM into `public/ort/` (gitignored).
- Virtual cloud photos (CC0 / public domain): `public/clouds/CREDITS.md`, built with `scripts/make_cloud_sprites.py`.

## Anonymous posting and daily streaks

People can publish text/link posts and created clouds without registering; public labels say **Anonymous**. A server-issued HttpOnly cookie keeps ownership and the streak in the same browser for up to 180 days. Clearing cookies or changing domains loses that guest identity. Signing in uses a separate Clerk identity and does not attach old anonymous posts to the profile. Voting and image uploads require sign-in.

The header shows consecutive **posting** days, refreshed after a successful post and at the next local midnight. The browser sends its IANA time zone in `X-Drift-Time-Zone`; the server pins the initial zone, validates receipt time and credits each new message transactionally. Retries do not add credit. The tooltip shows the counting zone and best streak. The indoor/outdoor model affects rendering only; streaks do not claim verified outdoor activity. See `docs/decisions/0005-anonymous-posting-and-local-streaks.md` for API, cookie and travel policies.
