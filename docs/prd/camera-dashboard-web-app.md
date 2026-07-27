# PRD: Camera Dashboard Web App (Traffic Analysis Scaffolding)

## Problem Statement

Today the Belgrade camera registry only exists as a JSON file and a CLI (`cameras:revalidate`) that prints results to the console. There is no visual way to browse the registry, see which cameras are active/inactive at a glance, or actually watch a camera's live stream in a browser. There is also no place in the application for the future traffic-analysis features (congestion detection, incident detection, vehicle counting) to eventually be surfaced to a user — everything so far is backend/CLI tooling only.

## Solution

Build a simple full-stack web application, living in the same repository, that turns the existing registry into something browsable and watchable:

- A **Node.js/Express backend** that exposes a small, read-only REST API over the existing `data/cameras/belgrade.json` registry (reusing `CameraRegistryStore` — no database, no new data store).
- A **Vue 3 + Tailwind CSS frontend** with two views: a **dashboard** showing all cameras as a grid of cards (name, source, status, resolution), and a **camera detail** page (routed by camera id) that plays the camera's live stream using `hls.js` and reserves an empty **Analysis panel** placeholder for future traffic-analysis output.
- In production, Express serves both the API and the built Vue static assets from a single process/port. In development, the Vite dev server runs separately and proxies `/api` calls to Express, with a single `npm run dev` command starting both.

This PRD is explicitly scaffolding: it makes the registry visible and watchable, and it shapes the architecture (a dedicated per-camera panel, a clean API boundary) so that a future PRD can drop real traffic-analysis output into the reserved panel without re-architecting the app.

## User Stories

1. As a user, I want to open a dashboard page and see every camera in the registry as a card, so that I can browse the full set of Belgrade cameras at a glance.
2. As a user, I want each camera card to show its name, location/address, source, protocol, and current status (active/inactive), so that I know what I'm looking at before opening the stream.
3. As a user, I want inactive cameras to be visually distinguished (e.g. greyed out / badge), so that I don't waste time trying to open a stream that's known to be down.
4. As a user, I want to see the `lastVerifiedAt` timestamp on a camera card, so that I know how fresh the status information is.
5. As a user, I want to click a camera card and navigate to a dedicated page for that camera (`/cameras/:id`), so that I can view its stream in a focused, larger view.
6. As a user, I want the camera detail page to actually play the live video stream, not just show a static thumbnail, so that I can see real-time footage.
7. As a user, I want HLS streams (the current registry's only proven-working protocol) to play correctly in Chrome, Firefox, and Edge, not just Safari, so that the app works regardless of which browser I use.
8. As a user, I want a clear error/empty state on the detail page if a camera's stream fails to load or the camera is inactive, so that I understand why nothing is playing instead of seeing a blank player.
9. As a user, I want a way to navigate back from a camera's detail page to the dashboard, so that I can browse and check other cameras without using the browser back button.
10. As a user, I want the camera detail page to reserve a visible "Analysis" panel/section next to the stream player (even if empty/disabled for now), so that I can see where future traffic-analysis results (congestion, incidents, vehicle counts) will appear once that feature is built.
11. As a developer, I want the frontend to fetch camera data from a small REST API rather than reading the JSON file directly, so that the frontend has no filesystem access and the backend remains the single source of truth.
12. As a developer, I want a `GET /api/cameras` endpoint returning the full camera list, so that the dashboard can render all cameras in one request.
13. As a developer, I want a `GET /api/cameras/:id` endpoint returning a single camera (or a 404 if the id doesn't exist), so that the detail page can fetch exactly the camera it needs.
14. As a developer, I want the backend's camera-serving logic (`CameraService`) decoupled from Express routing, so that I can unit test "given a registry, does the API layer return/shape the right data and handle not-found correctly" without spinning up an HTTP server.
15. As a developer, I want the backend to reuse the existing `CameraRegistryStore` to load `data/cameras/belgrade.json`, so that there is exactly one code path for reading the registry across the CLI and the web app.
16. As a developer, I want a single `npm run dev` command to start both the Express API and the Vite dev server together, so that local development doesn't require juggling two terminals manually.
17. As an operator, I want a single `npm run build` + one running Node process to serve both the API and the built frontend in production, so that deploying this app doesn't require managing two separate servers/ports.
18. As a developer, I want the frontend and backend source kept in clearly separated folders within the existing `src/` tree (`src/web/` and `src/server/`), so that the existing CLI/validator/registry code isn't disturbed and the new code has an obvious home.
19. As a developer, I want the dashboard and detail views to show a loading state while fetching from the API, so that the UI doesn't flash empty/broken content before data arrives.
20. As a developer, I want the layout to be reasonably responsive (usable on both a wide desktop window and a narrower laptop window), so that the dashboard isn't unusable outside of one fixed screen size.
21. As a maintainer, I want this app to remain read-only with respect to the registry (no create/edit/delete of cameras from the UI), so that the CLI/`CameraRegistryStore` remain the only place the registry file is written.

## Implementation Decisions

- **Repository layout**: everything stays inside the existing single Node project (one root `package.json`, one repo) rather than a separate frontend package. New code is split by concern under `src/`:
  - `src/server/` — Express backend: route definitions, `CameraService`, and the server entrypoint.
  - `src/web/` — Vue 3 + Vite frontend: views, components, router, and its own `vite.config.ts`.
- **CameraService (deep module, backend)**: wraps `CameraRegistryStore` (unchanged) and exposes two operations to the API layer: list all cameras, and get a single camera by id (returning `undefined`/`null` when not found so the route layer can turn that into a 404). This is the one new backend module with real logic worth testing in isolation — everything else in the backend is thin wiring around it and `CameraRegistryStore`/`Express`.
- **API contract**:
  - `GET /api/cameras` → `200` with a JSON array of camera entries (same shape as the registry's `CameraEntry`).
  - `GET /api/cameras/:id` → `200` with a single `CameraEntry` if found, `404` with a JSON error body if not.
  - The API is read-only; no write/update/delete endpoints are introduced.
- **Backend framework**: Express, used both to serve the two API routes and, in production, to serve the Vue app's built static assets (`src/web`'s Vite build output) from the same process/port — no separate static file host needed.
- **Frontend stack**: Vue 3 (Composition API, TypeScript, consistent with the rest of the codebase), Vite as the build tool/dev server, Vue Router for the two routes (`/` dashboard, `/cameras/:id` detail), Tailwind CSS for styling, and `hls.js` for cross-browser HLS playback (attached to a plain `<video>` element; native HLS support in Safari is used directly, `hls.js` is used to feed the same element everywhere else).
- **Frontend structure**:
  - `views/DashboardView.vue` — fetches `GET /api/cameras`, renders a responsive grid of camera cards.
  - `views/CameraDetailView.vue` — fetches `GET /api/cameras/:id`, renders the `StreamPlayer` and the placeholder `AnalysisPanel` side by side (or stacked on narrow screens).
  - `components/CameraCard.vue` — presentational card for the dashboard grid (name, location, source, protocol, status badge, last-verified timestamp).
  - `components/StreamPlayer.vue` — given a camera's `url`/`protocol`, attaches `hls.js` (or native playback where supported) to a `<video>` element; surfaces a load/playback error state rather than throwing.
  - `components/AnalysisPanel.vue` — static placeholder (e.g. "Traffic analysis coming soon" empty state) with no backend calls; exists purely to reserve the future traffic-analysis UI slot.
  - `services/api.ts` — small fetch wrapper for the two `/api/cameras...` endpoints, used by both views.
- **Dev workflow**: a `concurrently`-based `npm run dev` script starts the Express API (e.g. on port 3001) and the Vite dev server (default 5173) together; Vite's dev server proxies `/api/*` requests to the Express port so the frontend can always call relative `/api/...` URLs in both dev and production.
- **Production workflow**: `npm run build` builds the Vue app's static assets; the Express server (unchanged entrypoint logic, just an additional static-file middleware) serves those assets plus the two API routes from one process/port.
- **Data source**: the existing `data/cameras/belgrade.json`, loaded exclusively through the existing `CameraRegistryStore` — no new data store, no schema changes, no modifications to `CameraRegistryStore`, `CameraValidator`, or the `cameras:revalidate` CLI.
- **Status freshness**: the dashboard/detail views only display the `status`/`lastVerifiedAt`/`lastError` values already present in the registry file as of the last `cameras:revalidate` run. There is no "revalidate from the UI" action in this PRD.

## Testing Decisions

- Good tests here exercise observable behavior only: given a registry (or a fake `CameraRegistryStore`), does `CameraService` return the full list correctly, and does the single-camera lookup return the right camera or the correct "not found" signal — not implementation details of how Express wires the routes.
- **Module tested**: `CameraService` only, following the same project convention already established for `CameraValidator` (deep modules get unit tests; thin wiring does not).
- **Not tested in this PRD**: Express route wiring (thin HTTP wiring around `CameraService`), and the Vue frontend (views/components) — this PRD is scaffolding/UI-focused and the frontend has no non-trivial logic yet beyond basic fetch-and-render and `hls.js` attachment. Automated frontend tests can be introduced in a later PRD once there's real interactive/analysis behavior worth testing.
- **Framework**: Jest, consistent with the rest of the project (`ts-jest`, tests colocated as `*.test.ts` next to the module under test).
- **Prior art**: `src/validator/cameraValidator.test.ts` — mocks the module's single external dependency (there, `ProbeRunner`; here, `CameraRegistryStore`) and asserts on the returned data shape for success/not-found cases.

## Out of Scope

- Any real traffic-analysis logic (congestion detection, incident detection, vehicle counting) — the `AnalysisPanel` is an empty placeholder only; this PRD does not implement or stub any analysis computation or API.
- Triggering `CameraValidator` re-validation from the UI — the dashboard is read-only against the last CLI-produced registry state.
- Authentication/authorization of any kind — the app is assumed to run in a trusted/local context for now.
- A database or any persistence layer beyond the existing `data/cameras/belgrade.json` file.
- Automated tests for the Express route layer or any Vue component in this PRD.
- Deployment/hosting infrastructure (containers, CI/CD, reverse proxy config) — this PRD only covers `npm run dev` / `npm run build` + running the Node process locally.
- Editing, adding, or deleting camera entries from the UI.
- Non-HLS stream protocols are not actively exercised (the current seed registry is entirely HLS), though `StreamPlayer`'s design should not assume HLS-only forever — genuinely wiring up MJPEG/HTTP/RTSP playback is deferred until a camera using those protocols actually needs it.

## Further Notes

- No GitHub remote is currently configured for this repository (same situation as the prior PRD), so this PRD is tracked as a local markdown file (`docs/prd/camera-dashboard-web-app.md`) rather than a GitHub issue. It can be copied into a GitHub issue once a remote repository is set up.
- All 23 cameras currently in the registry use the `HLS` protocol, so `hls.js` integration is the only playback path that will be exercised/verified by this PRD in practice.
- This PRD builds on top of the existing registry/validator tooling (`CameraRegistryStore`, `CameraValidator`, the `cameras:revalidate` CLI) without modifying any of it — those remain the only writers of `data/cameras/belgrade.json`.
