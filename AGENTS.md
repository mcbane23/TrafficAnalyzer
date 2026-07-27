# AGENTS.md

TrafficAnalyzer detects traffic congestion, incidents, and vehicle counts from live Belgrade
camera feeds. Currently implemented: a validated camera registry, CLI revalidation tooling, and a
read-only web dashboard for browsing/watching cameras. The analysis engine itself is not yet built.

Background/requirements: [docs/prd/belgrade-camera-registry.md](docs/prd/belgrade-camera-registry.md)
(registry + validator) and [docs/prd/camera-dashboard-web-app.md](docs/prd/camera-dashboard-web-app.md)
(web app). Registry data format: [data/cameras/README.md](data/cameras/README.md).

## Commands

- `npm test` — Jest (`ts-jest`), tests colocated as `*.test.ts` next to the module under test.
- `npm run dev` — runs backend (`tsx watch`, port 3001) and Vite dev server (port 5173) together via `concurrently`. Vite proxies `/api/*` to Express.
- `npm run build` — `tsc` (backend to `dist/`) + Vite build (frontend to `dist/web/`).
- `npm start` — runs the built server (`dist/server/index.js`), serving both the API and built frontend on one port.
- `npm run cameras:revalidate` — re-probes every camera in the registry with `ffprobe` and updates `status`/`lastVerifiedAt`/`lastError` in place.

## Architecture

Deep-module-per-concern pattern; each has one thin wiring layer and (where it has real logic) a
colocated `*.test.ts`:

| Module | Path | Tested? |
|---|---|---|
| `CameraRegistryStore` | [src/registry/cameraRegistryStore.ts](src/registry/cameraRegistryStore.ts) | No — thin file I/O + schema validation |
| `CameraValidator` | [src/validator/cameraValidator.ts](src/validator/cameraValidator.ts) | Yes — mocks `ProbeRunner` (see [probeRunner.ts](src/validator/probeRunner.ts)) |
| `CameraService` | [src/server/cameraService.ts](src/server/cameraService.ts) | Yes — mocks the `CameraSource` seam (`CameraRegistryStore`) |
| Express app / routes | [src/server/app.ts](src/server/app.ts) | No — thin wiring around `CameraService` |
| Revalidate CLI | [src/cli/revalidate.ts](src/cli/revalidate.ts) | No — thin orchestrator |

Rule of thumb: new logic worth testing goes in a deep module with an injectable seam (constructor
option, e.g. `probeRunner`/`now`/`source`); route handlers and CLI entrypoints stay thin wiring and
don't get tests. Follow [src/validator/cameraValidator.test.ts](src/validator/cameraValidator.test.ts)
as the reference pattern for new tests (inject a fake for the single external dependency, assert on
the returned result shape).

Data flow: `data/cameras/belgrade.json` (validated against `belgrade.schema.json`) is the single
source of truth, loaded exclusively through `CameraRegistryStore` by both the CLI and
`CameraService` — never read directly elsewhere.

`src/web/` (Vue 3 + Vite + Tailwind) is a separate frontend project with its own
[tsconfig.json](src/web/tsconfig.json) and [vite.config.ts](src/web/vite.config.ts); it is excluded
from the root `tsconfig.json` and from Jest coverage. It talks to the backend only via
[src/web/services/api.ts](src/web/services/api.ts) (`fetch` against `/api/cameras...`), never the
filesystem.

## Conventions / gotchas

- JSON Schema is draft 2020-12 (`$schema": ".../2020-12/schema"`) — must use `Ajv2020` from
  `ajv/dist/2020`, not the default `Ajv` (draft-07 only). `ajv-formats` is registered for `format`
  keywords like `date-time`.
- Pin `typescript` to `^5.x` — `ts-jest` requires `typescript@>=4.3 <7`; newer majors break it.
- `ffprobe` is bundled via `@ffprobe-installer/ffprobe` (a regular dependency) — no system ffmpeg
  install needed. `CameraValidator` accepts an optional `ffprobePath` override.
- Failed camera validation sets `status: "inactive"` and records `lastError`; entries are never
  deleted from the registry.
- The API is read-only by design (no create/update/delete routes) — `CameraRegistryStore` is the
  only writer, invoked only from the revalidate CLI.
