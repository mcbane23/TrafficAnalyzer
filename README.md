# TrafficAnalyzer

Detects traffic congestion and vehicle counts from live Belgrade camera feeds, with a web dashboard
for browsing and watching cameras. See [AGENTS.md](AGENTS.md) for architecture and development notes.

## Run with Docker

Every merge to `main` publishes an image to GitHub Container Registry:

- `ghcr.io/mcbane23/trafficanalyzer:latest` — latest `main`
- `ghcr.io/mcbane23/trafficanalyzer:<commit sha>` — a specific commit (full 40-character SHA)

The image is multi-arch: `linux/amd64` and `linux/arm64` (Docker picks the right one). The Intel GPU
runtime (`OVERLAY_DEVICE=GPU`) is in the amd64 image only; on arm64 YOLO runs on the CPU.

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
mounts `./data` into the container.

### Oracle Cloud (Always Free, ARM)

An Always Free `VM.Standard.A1.Flex` instance (Ampere, arm64) runs the arm64 image. Render's free plan
(0.1 CPU, 512 MB) is too small: all cameras run out of memory within a minute, three already use the
whole CPU, and it sleeps after 15 minutes without visitors and has no persistent disk.

1. Create the instance: image **Ubuntu 24.04** (or 22.04), shape **VM.Standard.A1.Flex** with as many
   OCPUs and GB of memory as the free allowance leaves (2 OCPU / 12 GB is plenty for a few cameras
   with YOLO on the CPU). Add your SSH key.
2. In the instance's subnet → **Security List** → add an ingress rule: source `0.0.0.0/0`, TCP,
   destination port `3001`. (Or skip this and reach it through Cloudflare Tunnel / Tailscale.)
3. SSH in (`ssh ubuntu@<public IP>`) and run:

```sh
sudo iptables -I INPUT 6 -p tcp --dport 3001 -j ACCEPT
sudo netfilter-persistent save
curl -fsSL https://get.docker.com | sudo sh
sudo docker run -d --name trafficanalyzer -p 3001:3001 \
  -v trafficanalyzer-data:/app/data \
  --restart unless-stopped \
  ghcr.io/mcbane23/trafficanalyzer:latest
```

Oracle's Ubuntu images reject incoming traffic in iptables except SSH, hence the first two lines.

On an **Oracle Linux** image the user is `opc` (not `ubuntu`), the firewall is firewalld and
get.docker.com doesn't support it, so instead of the first three commands run:

```sh
sudo firewall-cmd --permanent --add-port=3001/tcp
sudo firewall-cmd --reload
sudo dnf install -y dnf-plugins-core
sudo dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
sudo dnf install -y --allowerasing docker-ce docker-ce-cli containerd.io
sudo systemctl enable --now docker
```

If SSH hangs, the subnet's route table is missing a `0.0.0.0/0` rule to an Internet Gateway (or the
instance is on a private subnet). Without SSH, Cloud Shell in the Oracle console works too: upload the
private key there and `ssh` from it.
Then open `http://<public IP>:3001`, go to **Admin** and switch on the cameras to analyze (none is by
default). Start with a few and watch CPU and memory on the same page before adding more.

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
