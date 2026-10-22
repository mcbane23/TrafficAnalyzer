# Belgrade Camera Registry

This folder contains the camera registry that TrafficAnalyzer uses as its source of live Belgrade
camera feeds for congestion/incident detection and vehicle counting.

## Files

- **`belgrade.json`** — the registry itself: an array of camera entries.
- **`belgrade.schema.json`** — the JSON Schema contract for `belgrade.json`. Every load/save through
  `CameraRegistryStore` validates against this schema, so the file can never silently drift from its
  documented shape.

## Camera entry shape

```jsonc
{
  "id": "brankov-most",              // stable slug, unique per camera
  "name": "Brankov Most (Branko's Bridge)",
  "location": { "address": "Brankov most, Belgrade" }, // or { "lat": ..., "lon": ... }
  "resolution": null,                // "1920x1080" once known, else null
  "source": "Kamere Beograd (KBCnet / Naxi Radio network)",
  "url": "https://streamer.devnet.rs/hls/brankov.m3u8",
  "protocol": "HLS",                 // one of RTSP | HTTP | MJPEG | HLS
  "status": "active",                // "active" | "inactive"
  "lastVerifiedAt": "2026-07-24T10:27:14.375Z", // ISO-8601, or null if never validated
  "lastError": null,                 // reason the last validation failed, if inactive
  "alternateUrl": null,              // optional backup stream covering the same location
  "alternateSource": null,           // provider of alternateUrl, e.g. "Informer.rs (Srbija na dlanu network)"
  "alternateHeaders": null           // extra headers alternateUrl needs, if any (mirrors "headers" for url)
}
```

Both `url` and `alternateUrl` can optionally have a matching `headers`/`alternateHeaders` object listing extra
HTTP request headers a provider requires to serve the stream (e.g. a `Referer` some hotlink-protected relays
enforce) - see `naxi.uzivokamere.com` entries in `belgrade.json` for an example. The frontend `StreamPlayer` and
`CameraCard` preview automatically retry with `alternateUrl` once if `url` fails to load, and the web API
transparently proxies through `/api/cameras/:id/stream(-alt)/:file` for whichever of the two needs special
headers.


## Where the seed data comes from

The initial 23 cameras were curated from public Belgrade traffic webcam networks — primarily the
**KBCnet / Naxi Radio** camera network (syndicated via kamerebeograd.rs) and **OK Radio**'s camera
network — which publish real-time HLS streams from major Belgrade bridges, squares, and
interchanges. A 23rd entry (Zrenjaninski put – Borča) was kept as `status: "inactive"` while its
stream returned HTTP 404, and was removed in October 2026 once it was clearly gone; an existing data
volume keeps its own copy, so delete it there from the Admin page's camera list.

Streams were verified reachable (HTTP 200 + valid HLS playlist) at curation time, but **not yet**
run through the full ffprobe-based deep validation described below. Run `npm run cameras:revalidate`
to get a true first pass.

## Re-validating the registry

Validation is deep: it doesn't just check that a URL responds, it uses `ffprobe` to pull real stream
metadata and confirm the camera is genuinely serving decodable video right now.

### Prerequisites

None. `ffprobe` is bundled as a prebuilt binary via the `@ffprobe-installer/ffprobe` npm package (a
regular `dependencies` entry), so `npm install` is all that's needed — no system-wide ffmpeg install
or `PATH` setup required. If you'd rather use your own ffmpeg install (e.g. a newer version), pass
`--ffprobe-path <path>` to override the bundled binary.

### Running it

```bash
npm run cameras:revalidate
```

This loads `belgrade.json`, probes every camera with `ffprobe`, and writes back updated `status`,
`lastVerifiedAt`, `resolution`, and `lastError` fields for each entry. Cameras that fail validation
are kept in the file with `status: "inactive"` rather than removed, so they can be reconsidered later.

### Options

| Flag | Default | Description |
|---|---|---|
| `-r, --registry <path>` | `data/cameras/belgrade.json` | Registry file to validate |
| `-s, --schema <path>` | `data/cameras/belgrade.schema.json` | Schema to validate against |
| `-t, --timeout <ms>` | `15000` | Per-camera probe timeout |
| `--ffprobe-path <path>` | bundled `@ffprobe-installer/ffprobe` binary | Path to a different ffprobe executable to use instead |

Example with a longer timeout:

```bash
npm run cameras:revalidate -- --timeout 30000
```

### Scheduling

The CLI has no built-in scheduler — it's a plain one-shot command, so it can be wired into cron
(Linux/macOS) or Windows Task Scheduler to re-run periodically, e.g. daily:

```cron
0 6 * * * cd /path/to/TrafficAnalyzer && npm run cameras:revalidate >> logs/cameras-revalidate.log 2>&1
```
