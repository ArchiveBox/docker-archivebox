# ArchiveBox status on Cabbage

Gatus 5.37.0 runs at https://status.archivebox.io (also
https://archiveboxstatus.zervice.io), deployed in `/opt/archivebox.status`.
The stack follows the neighboring `/opt/archivebox.demo` layout: persistent
bind mounts, resource limits, restart policies, and a dedicated cloudflared tunnel.

All configured public URLs are checked every minute, following redirects and
requiring HTTP 200. API/admin/demo health additionally require `OK`; chat bot
requires JSON `ok: true`. TLSNotary uses `/health`. Image hosting checks a real
existing image because its directory index intentionally returns 403. Brittany
Sweeting, IRC, its web client, and Dunhamfamily are excluded.

Open a service to see native 24h, 7d, and 30d response-time charts. Gatus's SQLite
store retains 30 days of aggregated uptime and latency (hourly recent data,
daily older data), independently of the 100 recent raw check results. This
covers the requested two-week trend without a large dashboard payload. History
started October 12, 2026; no historical results have been fabricated.

The **Cabbage: deployed commit, branch heads & disk space** link opens
`/deployment.html`. It displays the exact running container's OCI revision,
version and image ID, links to the deployed/dev/main commits and comparisons,
and root filesystem available space. Behind/ahead counts are computed against
immutable GitHub commit IDs; a diverged main branch is identified explicitly.
The host collector runs every minute, caches GitHub comparisons for ten minutes,
and refreshes them immediately if the deployed revision changes. GitHub lookup
errors are shown as unknown. The page marks host metadata stale after three
minutes; a Gatus heartbeat also fails when the collector stops updating.

## Deployment

Requires Docker Compose, systemd, bash, curl, jq, and OpenSSL on Cabbage.
Copy this directory to `/opt/archivebox.status`, preserving `.env`, `data/`, and
`etc/cloudflared/`. Keep generated metadata, credentials, and SQLite out of Git.
Only nginx/Gatus bind to loopback; public access goes through Cloudflare.
The host collector uses Docker locally; no container mounts the Docker socket.

```bash
cd /opt/archivebox.status
mkdir -p data public etc/cloudflared
umask 077
test -f .env || printf 'COLLECTOR_TOKEN=%s\n' "$(openssl rand -hex 32)" > .env
install -m 600 -o 65532 -g 65532 \
  /opt/archivebox.demo/etc/cloudflared/cert.pem etc/cloudflared/cert.pem
chown 65532:65532 etc/cloudflared
```

For a new installation, create a named tunnel using the cloudflared Compose
image, then route `archiveboxstatus.zervice.io` to it. The live deployment uses
tunnel `5d662698-3ca7-4694-a22f-a9e800126d4d`. Its
`etc/cloudflared/config.yml` is:

```yaml
tunnel: 5d662698-3ca7-4694-a22f-a9e800126d4d
credentials-file: /etc/cloudflared/5d662698-3ca7-4694-a22f-a9e800126d4d.json
protocol: http2
ingress:
  - hostname: status.archivebox.io
    service: http://nginx:80
  - hostname: archiveboxstatus.zervice.io
    service: http://nginx:80
  - service: http_status:404
```

The `status.archivebox.io` DNS alias points to `archiveboxstatus.zervice.io`.
Do not recreate existing credentials or overwrite DNS routes during updates.

```bash
docker compose config --quiet
docker compose up -d
cp systemd/archivebox-status.* /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now archivebox-status.timer
systemctl start archivebox-status.service
curl -fsS http://127.0.0.1:18080/deployment.json
curl -fsS https://status.archivebox.io/api/v1/endpoints/statuses
```

After replacing a bind-mounted configuration file, restart its service so the
container sees the new inode (`docker compose restart gatus` for config.yaml,
`docker compose restart nginx` for nginx.conf). `public/` is a directory mount,
so the collector's atomic JSON replacement is visible immediately.

Back up `data/gatus.db*`, `.env`, and `etc/cloudflared/` securely. Monitor both
`systemctl status archivebox-status.timer` and `docker compose ps`. This status
page shares Cabbage's availability; it cannot report a total Cabbage outage while
the host is down. No alert destinations are configured.
