# ArchiveBox Docker deployments

Deployment examples for the current [ArchiveBox](https://github.com/ArchiveBox/ArchiveBox) `dev` image. The image includes the web server, crawl orchestrator, Sonic, and extraction dependencies. One server container manages each collection, including scheduled crawls and jobs submitted through the UI/API.

- [Docker Compose](docker-compose.yml) — recommended single-host deployment
- [Kubernetes](archivebox.yml) — single-replica example
- [Image Dockerfile](https://github.com/ArchiveBox/ArchiveBox/blob/dev/Dockerfile) and [upstream Compose](https://github.com/ArchiveBox/ArchiveBox/blob/dev/docker-compose.yml)
- [Docker documentation](https://github.com/ArchiveBox/ArchiveBox/wiki/Docker), [configuration](https://github.com/ArchiveBox/ArchiveBox/wiki/Configuration), and [releases](https://github.com/ArchiveBox/ArchiveBox/releases)

## Quickstart

Requires Docker Engine or Docker Desktop with Docker Compose v2. Images support `linux/amd64` and `linux/arm64` (including Apple Silicon); 32-bit ARM/x86 are unsupported.

```bash
mkdir -p ~/archivebox/data && cd ~/archivebox
curl -fsSL https://raw.githubusercontent.com/ArchiveBox/docker-archivebox/main/docker-compose.yml -o docker-compose.yml
docker compose pull
docker compose up -d --wait
```

Open [the admin setup wizard](http://admin.archivebox.localhost:5797/admin/). For a remote server, use its hostname or IP and `/admin/`. The wizard configures the canonical URL and security mode; `BASE_URL` and `SERVER_SECURITY_MODE` can override them. Optional `ADMIN_USERNAME` and `ADMIN_PASSWORD` create an administrator without the interactive wizard.

The image's default command is `archivebox server --init 0.0.0.0:5797`; initialization is automatic. It also supplies the `/health/` healthcheck. Set `ARCHIVEBOX_PORT` in `.env` to change the host port; the container still listens on 5797.

```bash
docker compose exec archivebox archivebox version
docker compose exec archivebox archivebox add --depth=1 'https://example.com'
docker compose exec -T archivebox archivebox add < ~/Downloads/bookmarks.txt
docker compose exec archivebox archivebox status
docker compose logs -f archivebox
```

Use `exec archivebox archivebox ...` with a running server, or `run --rm archivebox ...` for a one-off container. The Compose `tmp` volume shares supervisor sockets between these containers. Only run one server/orchestrator per collection.

Without Compose:

```bash
mkdir -p ~/archivebox/data && cd ~/archivebox
docker run -d --name archivebox --restart unless-stopped \
    --pids-limit 2048 --shm-size 1g \
    -p 5797:5797 -v "$PWD/data:/data" \
    archivebox/archivebox:dev
docker exec -it archivebox archivebox status
```

## Persistent data and configuration

The single `./data:/data` bind mount includes:

| Path | Contents |
| --- | --- |
| `data/index.sqlite3` | Collection database and scheduled crawls |
| `data/ArchiveBox.conf` | Collection configuration |
| `data/archive/` | Saved snapshot files |
| `data/personas/` | Persona configuration, cookies, and browser profiles |
| `data/sonic/` | Local Sonic search index and generated configuration |
| `data/logs/` | Application and worker logs |

Personas always live under `data/personas`; no separate profile volume is needed. `/tmp/archivebox` is runtime state, not a backup of your collection. Keep the database, personas, logs, and search index on reliable local storage. Only `data/archive` may be mounted remotely.

The entrypoint uses the collection owner's numeric UID/GID, falling back to 911. Set `PUID` and `PGID` when the mounted filesystem requires specific IDs, and make both local data and remote archive storage writable by those IDs.

Use the admin Personas UI or `ArchiveBox.conf` for capture configuration. Environment settings override collection configuration; `PUBLIC_ADD_VIEW=False` keeps anonymous submission disabled. Configure access and sharing through the setup wizard rather than copying old wildcard host/CSRF settings. For HTTPS, place your preferred reverse proxy in front of port 5797 and set the externally reachable `BASE_URL`.

## Scheduling and search

```bash
docker compose exec archivebox archivebox schedule --add --every=day --depth=1 'https://example.com/feed.xml'
docker compose exec archivebox archivebox schedule --show
```

The running server picks up database-backed schedules automatically. There is no separate scheduler container or cron restart step.

Sonic is included and managed inside the main container by default, listening on loopback. No separate Sonic service, published 1491 port, or downloaded `sonic.cfg` is needed. Its current configuration keys are `SEARCH_BACKEND_SONIC_*`; remove old overrides pointing at a `sonic` sidecar. `SEARCH_BACKEND_SONIC_ENABLED` controls the plugin, and `SEARCH_BACKEND_ENGINE` chooses the query backend.

To rebuild indexes from existing saved content:

```bash
docker compose exec archivebox archivebox update --index-only
```

## S3, B2, R2, and other remote archive storage

Mount remote storage at **`/data/archive` only**. SQLite and browser profiles must remain local. The snapshot tree contains `users/<user>/snapshots/...` plus legacy timestamp symlinks: Rclone mounts need `--vfs-links`, and file transfers need `--links` to preserve those links.

### Host-mounted storage

On a Linux Docker host, configure a remote with `rclone config`, install FUSE, and enable `user_allow_other` in `/etc/fuse.conf`. For example, mount an S3 remote named `archivebox-s3` at an existing, empty host directory:

```bash
mkdir -p /mnt/archivebox-archive
rclone mount archivebox-s3:BUCKET/archive /mnt/archivebox-archive \
    --allow-other --uid 911 --gid 911 \
    --vfs-cache-mode full --vfs-links
```

Run this under a service manager with a persistent local VFS cache; match UID/GID to your collection. Start the mount before ArchiveBox and verify it is mounted after host restarts. Docker Desktop runs its daemon in a VM, so a host FUSE mount is not automatically equivalent to a Linux Docker-host mount.

Add this entry alongside the existing `/data` and `/tmp/archivebox` volumes:

```yaml
            - type: bind
              source: /mnt/archivebox-archive
              target: /data/archive
              bind:
                  create_host_path: false
```

`create_host_path: false` catches a missing directory; it does not detect an unmounted filesystem. Stop ArchiveBox if the mount fails, and recreate its container after remounting. The same nested bind-mount layout works for host-mounted NFS/SMB storage.

See [Rclone mount/cache options](https://rclone.org/commands/rclone_mount/) and [ArchiveBox storage setup](https://github.com/ArchiveBox/ArchiveBox/wiki/Setting-up-Storage) for provider configuration and service setup.

### Rclone Docker volume plugin

Alternatively, on Linux Docker Engine, install the [Rclone volume plugin](https://rclone.org/docker/) for your architecture (`amd64` or `arm64`). Install FUSE on the Docker host and place your provider credentials in its protected config file:

```bash
sudo mkdir -p /var/lib/docker-plugins/rclone/config /var/lib/docker-plugins/rclone/cache
sudo install -m 600 ~/.config/rclone/rclone.conf /var/lib/docker-plugins/rclone/config/rclone.conf
docker plugin install rclone/docker-volume-rclone:amd64 --grant-all-permissions --alias rclone
```

Add `- archive:/data/archive` to `services.archivebox.volumes`, and add `archive` alongside the existing `tmp` entry in the top-level `volumes` mapping:

```yaml
volumes:
    tmp:
    archive:
        driver: rclone
        driver_opts:
            remote: 'archivebox-s3:BUCKET/archive'
            allow_other: 'true'
            vfs_cache_mode: full
            vfs_links: 'true'
            uid: '911'
            gid: '911'
```

Use a plugin version that supports `vfs_links`. This is a storage mount; S3 credentials are configured in Rclone, not passed as an ArchiveBox upload backend.

For existing archives, stop writers, back up the collection, copy payloads with `rclone copy --links`, and verify with `rclone check --links` before switching mounts. Keep the original payloads until captures, replay, search, and restart behavior work against the new mount. Mounting an empty bucket over an existing archive hides the local files; it does not migrate them.

## Optional browser access

Uncomment `novnc` and the matching `depends_on` section in Compose. The image detects `novnc:0.0` and opens the selected persona's browser; `ARCHIVEBOX_VNC_PERSONA` chooses a persona (otherwise `DEFAULT_PERSONA`). Visit [noVNC](http://127.0.0.1:8080/vnc.html) to log into sites or watch captures. The browser profile persists in `data/personas`.

The noVNC port is bound to localhost because it has no authentication. For a remote host, use an SSH tunnel. Without noVNC the browser runs headlessly.

## Upgrading an older deployment

1. Back up the entire collection and your old Compose/config files with ArchiveBox stopped. Keep any separate persona volume until its contents are copied into `data/personas` and verified.
2. Stop the old stack, including its scheduler and Sonic services. Replace the Compose file, retaining your data path, port, and intentional configuration overrides.
3. Remove the old Sonic hostname override (`SEARCH_BACKEND_HOST_NAME=sonic` or `SEARCH_BACKEND_SONIC_HOST_NAME=sonic`) from both environment and saved config. The bundled service uses loopback. Keep the old Sonic index backup; rebuild the current index with `update --index-only` if needed.
4. Pull and start the current image. Check health, login, existing snapshots, and a new capture. Recreate legacy cron schedules using `schedule --add`; inspect `schedule --show` to avoid duplicates.

```bash
docker compose pull
docker compose up -d --wait --remove-orphans
docker compose exec archivebox archivebox version
docker compose exec archivebox archivebox schedule --show
```

Do not use `down -v` during an upgrade. Review [collection upgrade guidance](https://github.com/ArchiveBox/ArchiveBox/wiki/Upgrading-or-Merging-Archives) before upgrading older data; retain a pre-upgrade backup for rollback.

## Image versions and development

These examples target `archivebox/archivebox:dev`, matching the current server architecture. `latest` follows the stable release and may lag these features. Set `ARCHIVEBOX_IMAGE` in `.env` to a compatible published version, `sha-<commit>` tag, or digest to pin deployments. Check the [published tags](https://hub.docker.com/r/archivebox/archivebox/tags); arbitrary branch aliases are not guaranteed. Images are also published to `ghcr.io/archivebox/archivebox`.

The production Dockerfile lives in the main ArchiveBox repository and extends the `abx-dl` runtime image. To customize it, extend the complete image rather than installing only the Python package into a bare Python container:

```dockerfile
FROM archivebox/archivebox:dev
# Add your deployment-specific files/configuration here.
```

To build the server image from its canonical checkout:

```bash
cd ../archivebox
./bin/build_docker.sh dev
```

Image publication is handled by the main repository's release workflow after CI; this repository contains deployment definitions only.

## Kubernetes

[archivebox.yml](archivebox.yml) provides a namespace, PVC, single-replica Deployment with `Recreate`, and a ClusterIP Service. Choose a reliable block-backed storage class and sufficient PVC capacity before applying it. SQLite requires filesystem locking/fsync semantics; do not use an NFS/SMB PVC for all of `/data`. Do not scale replicas against one collection.

```bash
kubectl apply -f archivebox.yml
kubectl -n archivebox rollout status deployment/archivebox
kubectl -n archivebox port-forward service/archivebox 5797:5797
```

Open the admin setup wizard as above. For remote access, configure your own Ingress or change the Service to `LoadBalancer`. The image initializes the collection itself; no init container or scheduler/Sonic sidecar is needed. Kubernetes does not use Docker image healthchecks, so the manifest includes startup and readiness probes and a memory-backed `/dev/shm` for Chromium. This example is not part of ArchiveBox's release acceptance matrix; validate it with your storage class and cluster.
