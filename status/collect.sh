#!/usr/bin/env bash
# Run on the Docker host; only selected public metadata leaves this script.
set -euo pipefail
cd /opt/archivebox.status
# shellcheck source=/dev/null
source .env
mkdir -p public data
now=$(date +%s)
container=archiveboxdemo-archivebox-1
deployed=$(docker inspect "$container" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
[[ "$deployed" =~ ^[0-9a-f]{40}$ ]]
version=$(docker inspect "$container" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')
image=$(docker inspect "$container" --format '{{.Image}}')
read -r total available < <(df -B1 --output=size,avail / | tail -1)
branches='{}'
if [[ -f data/branches.json ]]; then branches=$(cat data/branches.json); fi
cached=$(jq -r '.checked_at // 0' <<< "$branches")
cached_commit=$(jq -r '.deployed // ""' <<< "$branches")
if (( now - cached >= 600 )) || [[ "$cached_commit" != "$deployed" ]]; then
    branches=$(jq -n --arg deployed "$deployed" --argjson now "$now" '{deployed:$deployed,checked_at:$now}')
    for branch in dev main; do
        # Resolve the head first, then compare exact immutable commits.
        if head_json=$(curl -fsS --max-time 20 "https://api.github.com/repos/ArchiveBox/ArchiveBox/commits/$branch") &&
           head=$(jq -er '.sha | select(test("^[0-9a-f]{40}$"))' <<< "$head_json") &&
           comparison=$(curl -fsS --max-time 20 "https://api.github.com/repos/ArchiveBox/ArchiveBox/compare/$deployed...$head"); then
            item=$(jq --arg head "$head" '{head:$head,status:.status,behind:.ahead_by,ahead:.behind_by}' <<< "$comparison")
        else
            item='{"error":"GitHub lookup unavailable; comparison unknown"}'
        fi
        branches=$(jq --arg branch "$branch" --argjson item "$item" '.[$branch]=$item' <<< "$branches")
    done
    printf '%s\n' "$branches" > data/branches.json.tmp
    mv data/branches.json.tmp data/branches.json
fi
jq -n --argjson now "$now" --arg deployed "$deployed" --arg version "$version" --arg image "$image" \
  --argjson total "$total" --argjson available "$available" --argjson branches "$branches" \
  '{updated_at:$now,host:"cabbage",deployed:$deployed,version:$version,image:$image,branches:$branches,
    disk:{path:"/",total_bytes:$total,available_bytes:$available,available_gib:(($available/1073741824*10|floor)/10),free_percent:(($available/$total*1000|floor)/10)}}' > public/deployment.json.tmp
chmod 644 public/deployment.json.tmp
mv public/deployment.json.tmp public/deployment.json
# A missed heartbeat is marked failed by Gatus after three minutes.
printf 'header = "Authorization: Bearer %s"\n' "$COLLECTOR_TOKEN" |
    curl --config - -fsS --max-time 15 -X POST \
    'http://127.0.0.1:18081/api/v1/endpoints/cabbage_deployment-collector/external?success=true' >/dev/null
