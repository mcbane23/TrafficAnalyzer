# TrafficAnalyzer

Detects traffic congestion and vehicle counts from live Belgrade camera feeds, with a web dashboard
for browsing and watching cameras. See [AGENTS.md](AGENTS.md) for architecture and development notes.

## Run with Docker

Every merge to `main` publishes an image to GitHub Container Registry:

- `ghcr.io/mcbane23/trafficanalyzer:latest` — latest `main`
- `ghcr.io/mcbane23/trafficanalyzer:<commit sha>` — a specific commit (full 40-character SHA)

The image is `linux/amd64`.

### Log in (private package)

While the package is private, log in once with a GitHub
[personal access token (classic)](https://github.com/settings/tokens) that has the `read:packages`
scope:

```sh
echo <TOKEN> | docker login ghcr.io -u mcbane23 --password-stdin
```

Skip this if you make the package public (GitHub → your profile → Packages → `trafficanalyzer` →
Package settings → Change visibility).

### Pull and run

```sh
docker pull ghcr.io/mcbane23/trafficanalyzer:latest
docker run -d --name trafficanalyzer -p 3001:3001 \
  -v trafficanalyzer-data:/app/data \
  --restart unless-stopped \
  ghcr.io/mcbane23/trafficanalyzer:latest
```

Then open <http://localhost:3001>.

The `/app/data` volume holds the camera registry (`cameras/belgrade.json`) and the traffic history
database (`traffic-history.db`), so both survive container upgrades. A new named volume is seeded with
the registry baked into the image. To use the registry from a local checkout instead, mount it:
`-v "$PWD/data:/app/data"`.

To upgrade: `docker pull` the new tag, then `docker rm -f trafficanalyzer` and run the command above
again.

Re-probe every camera and update the registry inside the running container:

```sh
docker exec trafficanalyzer node dist/cli/revalidate.js
```

### Docker Compose

From a checkout of this repository:

```sh
docker compose pull   # use the published image
docker compose up -d
```

Use `docker compose up -d --build` instead to build the image locally from the Dockerfile. Compose
keeps `/app/data` in the named volume `trafficanalyzer-data`. A bind mount such as `./data:/app/data`
works too: when it is empty the server copies the default camera registry into it on start.

The image has a `HEALTHCHECK` against `GET /api/health`, so `docker ps` (and TrueNAS) show the
container as unhealthy when the server stops answering. Docker itself does not restart an unhealthy
container.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | HTTP port the server listens on inside the container |

## Development

Requires Node.js 22.12 or newer.

```sh
npm ci
npm run dev     # backend on :3001, Vite dev server on :5173
npm test
npm run build
```

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs tests, the production build and a Docker
image build on every branch and pull request, without uploading artifacts, caches or images. Only a
push to `main` (a merged PR) publishes the image to GHCR.
