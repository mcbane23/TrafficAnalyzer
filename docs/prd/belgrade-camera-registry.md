# PRD: Belgrade Traffic Camera Registry & Validation Tooling

## Problem Statement

TrafficAnalyzer is being built to detect traffic congestion, incidents, and to count traffic by analyzing live camera feeds in Belgrade. Before any analysis can happen, the application needs a trustworthy, machine-readable list of Belgrade traffic/webcam feeds that are actually online and streaming usable video — not a list of dead links or snapshot pages that never update. Today there is no such list, no defined data format for it, and no way to know whether a camera that worked yesterday still works today.

## Solution

Create an initial curated registry of ~20-30 working Belgrade cameras, stored as a JSON file with an accompanying JSON Schema contract, sourced from a mix of official Belgrade traffic authority feeds and public webcam aggregators. Build a small Node.js/TypeScript toolset that can:

- Read/write the registry file safely against its schema.
- Validate a single camera by actually pulling a real frame/snapshot via `ffmpeg`/`ffprobe` (not just a network reachability check), confirming it is genuinely streaming video.
- Re-validate the entire registry on demand (CLI) or on a schedule (cron / Task Scheduler), updating each camera's `status` and `lastVerifiedAt`, marking dead cameras `inactive` rather than deleting them.

This registry becomes the durable, referenceable data source that the future traffic-analysis engine (congestion/incident detection, vehicle counting) will consume — but building that analysis engine itself is out of scope for this PRD.

## User Stories

1. As a developer building the traffic analysis engine, I want a well-defined JSON schema for camera entries, so that I can reliably consume the registry without guessing field names or types.
2. As a developer, I want each camera entry to include name, location, resolution, source/provider, stream URL, protocol, status, and last-verified timestamp, so that I have enough context to decide whether/how to use a given feed.
3. As a developer, I want the initial registry to contain 20-30 real, currently-working Belgrade camera feeds, so that I have real data to prototype the analysis engine against instead of placeholders.
4. As a developer, I want cameras sourced from both official Belgrade traffic authority feeds and public webcam aggregators, so that coverage isn't limited to a single provider's uptime or licensing terms.
5. As a developer, I want only live video streams (RTSP/HTTP/MJPEG) included — not static refreshing images — so that the analysis engine always has motion data to work with.
6. As an operator, I want a CLI command that re-validates every camera in the registry, so that I can refresh the list's accuracy whenever I choose.
7. As an operator, I want the same re-validation CLI to be schedulable via cron or Windows Task Scheduler, so that the registry stays fresh without manual intervention.
8. As an operator, I want validation to actually attempt to pull a real frame/snapshot from the stream (via ffmpeg/ffprobe), so that a camera reporting HTTP 200 but serving a broken/blank stream is correctly flagged as not working.
9. As an operator, I want a camera that fails validation to be marked `inactive` in place rather than deleted, so that historical entries and metadata aren't lost and the camera can be reconsidered later.
10. As an operator, I want each validation run to update `lastVerifiedAt` and `status` for every camera it checks, so that I can see at a glance how stale any entry is.
11. As an operator, I want validation failures to include an error reason, so that I can distinguish between "network unreachable," "stream timeout," "no valid frame decoded," etc.
12. As a developer, I want the `CameraValidator` logic decoupled from file I/O, so that I can unit test validation behavior without touching the filesystem or a real network/ffmpeg process.
13. As a developer, I want the registry read/write logic (`CameraRegistryStore`) separated from the validator, so that each module has a single, clear responsibility and can evolve independently.
14. As a maintainer, I want a README in the registry's folder explaining the file format, schema, and how to run the validation CLI, so that new contributors can use the tooling without digging through source code.
15. As a maintainer, I want the registry file stored at a predictable path (`data/cameras/belgrade.json`), so that both the validation tooling and the future analysis engine can locate it consistently.
16. As a maintainer, I want a schema file (`data/cameras/belgrade.schema.json`) alongside the data file, so that the data format is self-documenting and can be validated in CI later.
17. As a developer, I want unit tests for the `CameraValidator` module using Jest, so that its core "does this camera actually work" logic is regression-proof.
18. As a future analysis-engine developer, I want the registry to be the single source of truth for "which cameras exist and are they usable," so that the analysis engine never needs its own separate camera-discovery logic.

## Implementation Decisions

- **CameraRegistry (data contract)**: A JSON file at `data/cameras/belgrade.json` containing an array of camera entries, plus a companion `data/cameras/belgrade.schema.json` JSON Schema describing the contract. Each entry includes: `id`, `name`, `location` (address and/or lat/lon), `resolution`, `source`/provider, `url` (stream URL), `protocol` (RTSP/HTTP/MJPEG), `status` (`active` | `inactive`), and `lastVerifiedAt` (ISO timestamp). Errors from the most recent validation attempt are retained on the entry (e.g. `lastError`) so operators can see why a camera is inactive.
- **CameraValidator (deep module)**: Given a single camera entry, invokes `ffmpeg`/`ffprobe` against the stream URL to attempt to pull a real frame/snapshot, confirming actual decodable video data rather than just HTTP/RTSP reachability. Returns a `ValidationResult` containing status, checked-at timestamp, resolution (if detected), latency, and an error reason on failure. This module has no direct file I/O — it operates purely on a camera entry in, a result out — making it straightforward to unit test by mocking the underlying process invocation.
- **CameraRegistryStore (shallow module)**: Responsible for loading the registry JSON file, validating it against the schema, and writing updates back. Keeps file-system and schema-validation concerns out of the `CameraValidator`.
- **Revalidation CLI (shallow orchestrator)**: A CLI entrypoint that loads the registry via `CameraRegistryStore`, runs `CameraValidator` against each entry, updates `status`/`lastVerifiedAt`/`lastError`, and writes the registry back. Designed to be run manually (`npm run cameras:revalidate` or similar) and to be equally invokable from an external scheduler (cron, Windows Task Scheduler) without any built-in scheduling logic of its own.
- **Dead camera handling**: Cameras that fail validation are kept in the registry with `status: "inactive"` rather than removed, preserving history and allowing them to be re-checked and potentially reactivated later.
- **Initial seed data**: The agent researches and compiles the first 20-30 working Belgrade camera entries, drawing from a mix of official Belgrade traffic authority sources and public webcam aggregators, restricted to live video streams (RTSP/HTTP/MJPEG) — static/refreshing snapshot-only sources are excluded.
- **Documentation**: A `README.md` in `data/cameras/` explains the file format/schema and how to run the validation CLI (manual invocation and scheduling guidance).
- **Tech stack**: Node.js/TypeScript for all tooling (validator, registry store, CLI).

## Testing Decisions

- Good tests here exercise observable behavior only: given a camera entry and a mocked stream/process result, does `CameraValidator` return the correct `status`, error reason, and metadata — not internal implementation details of how `ffmpeg` is invoked.
- **Module tested**: `CameraValidator` only, per project decision. `CameraRegistryStore` and the CLI orchestrator are intentionally left untested for now since they are thin wiring around well-understood file I/O and process orchestration.
- **Framework**: Jest, as the default for Node/TypeScript projects.
- **Approach**: Mock the underlying `ffmpeg`/`ffprobe` process invocation (e.g. via `child_process` mocking) to simulate success, timeout, unreachable, and invalid-stream scenarios, and assert the resulting `ValidationResult` in each case.

## Out of Scope

- The actual congestion detection, incident detection, and vehicle-counting analysis engine that will eventually consume this registry — that is a separate, future PRD.
- Automatic discovery/scraping of new camera sources beyond the initial curated seed list (the initial list is manually/agent-curated research, not an automated discovery pipeline).
- A UI or dashboard for browsing/managing the camera registry.
- Built-in scheduling (the CLI is schedule-agnostic; wiring it to cron/Task Scheduler is an operational/deployment concern, not part of this PRD's code).
- Authentication/licensing negotiation with camera providers — sourced cameras must already be publicly accessible.
- CI-based schema validation (mentioned as a future possibility, not part of this delivery).

## Further Notes

- No GitHub remote is currently configured for this repository, so this PRD is being tracked as a local markdown file (`docs/prd/belgrade-camera-registry.md`) rather than a GitHub issue. It can be copied into a GitHub issue once a remote repository is set up.
- Camera resolution and other stream metadata may not always be reliably detectable via `ffprobe` depending on provider; the schema should treat these fields as optional where a value can't be determined.
- Since sources are a mix of official and public aggregator feeds, some entries may have differing terms of use; if any camera's usage terms are ambiguous or restrictive, flag it during curation rather than silently including it.
