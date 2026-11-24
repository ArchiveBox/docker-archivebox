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
github=https://api.github.com/repos/ArchiveBox/ArchiveBox

github_actions() {
    curl -fsS --max-time 5 "$github/actions/$1"
}

github_ci_jobs() {
    local run=$1 page=1 page_size=100 total=1 batch jobs='[]'
    while (( (page - 1) * page_size < total )); do
        batch=$(github_actions "runs/$run/jobs?per_page=$page_size&page=$page" | jq -ce '
            select(.total_count | numbers) | {total_count, jobs:[.jobs[]
                | select(.name == "All required CI lanes" or .name == "Publish early dev image"
                    or (.name | startswith("Tested Docker images")))
                | {id,name,status,conclusion}]}
        ') || return 1
        total=$(jq -r '.total_count' <<< "$batch")
        jobs=$(jq -c --argjson batch "$batch" '. + $batch.jobs' <<< "$jobs")
        page=$((page + 1))
    done
    printf '%s\n' "$jobs"
}

collect_builds() {
    local ci jobs run revision release release_run stages tags tag image_info
    stages='{}'
    if ci=$(github_actions 'workflows/ci.yml/runs?branch=dev&event=push&per_page=1' | jq -ce '.workflow_runs[0]'); then
        run=$(jq -r '.id' <<< "$ci")
        revision=$(jq -r '.head_sha' <<< "$ci")
        jobs=$(github_ci_jobs "$run") || jobs=null
        stages=$(jq -n --argjson ci "$ci" --argjson jobs "$jobs" '
            def state: .conclusion // .status;
            def waiting: if $jobs == null then "unknown"
                elif $ci.status != "completed" then "waiting"
                elif $ci.conclusion == "success" then "skipped" else ($ci | state) end;
            def job($name): ($jobs // [] | map(select(.name == $name))[0]) as $job
                | {state:($job | state // waiting), job:$job.id};
            [($jobs // [])[] | select(.name | startswith("Tested Docker images")) | state] as $build
            | {revision:$ci.head_sha, run:$ci.id,
                build:(if any($build[]; . == "failure" or . == "timed_out") then "failure"
                    elif any($build[]; . == "in_progress") then "in_progress"
                    elif any($build[]; . == "queued" or . == "waiting" or . == "pending") then "queued"
                    elif any($build[]; . == "cancelled") then "cancelled"
                    elif $build == ["success", "success"] then "success"
                    elif any($build[]; . == "skipped") then "skipped"
                    else waiting end),
                checks:job("All required CI lanes"), early:job("Publish early dev image"),
                release:{state:(if $ci.status != "completed" or $ci.conclusion == "success"
                    then "waiting" else "skipped" end)}}')
        if [[ $(jq -r '.conclusion' <<< "$ci") == success ]]; then
            if release=$(github_actions "workflows/release.yml/runs?branch=dev&event=workflow_run&head_sha=$revision&per_page=1" | jq -ce '.workflow_runs[0] // {}'); then
                if release_run=$(jq -er '.id' <<< "$release"); then
                    jobs=$(github_actions "runs/$release_run/jobs?per_page=100" | jq -ce '.jobs | arrays
                        | map(select(.name == "Publish tested multiarch image"))
                        | map({id,status,conclusion,steps:[.steps[]? | {name,conclusion}]})') || jobs=null
                    stages=$(jq --argjson jobs "$jobs" --argjson run "$release" '
                        $jobs[0] as $job
                        | ($job.steps // [] | map(select(.name == "Promote the exact tested universal image"))[0]) as $step
                        | .release = {run:$run.id, job:$job.id, state:
                            (if $jobs == null then "unknown"
                             elif $job.conclusion == "success" then $step.conclusion // "skipped"
                             elif $job != null then $job.conclusion // $job.status
                             elif $run.status == "completed" then $run.conclusion
                             else "waiting" end)}' <<< "$stages")
                fi
            else
                stages=$(jq '.release.state = "unknown"' <<< "$stages")
            fi
        fi
    fi
    tags='{}'
    for tag in dev dev-unstable; do
        if image_info=$(timeout 6 docker buildx imagetools inspect "archivebox/archivebox:$tag" \
            --format '{{json (index .Image "linux/amd64")}}' | jq -ce '.config.Labels
                | {revision:."org.opencontainers.image.revision", version:."org.opencontainers.image.version"}
                | select(.revision | strings | test("^[0-9a-f]{40}$"))'); then
            tags=$(jq --arg tag "$tag" --argjson image "$image_info" '.[$tag]=$image' <<< "$tags")
        fi
    done
    jq -n --argjson now "$now" --argjson stages "$stages" --argjson tags "$tags" \
        '$stages + {checked_at:$now, tags:$tags}'
}

builds='{}'
if [[ -f data/builds.json ]]; then builds=$(cat data/builds.json); fi
builds_cached=$(jq -r '.checked_at // 0' <<< "$builds")
if (( now - builds_cached >= 600 )); then
    (
        collect_builds > data/builds.json.tmp
        mv data/builds.json.tmp data/builds.json
    ) &
    builds_pid=$!
fi

branches='{}'
if [[ -f data/branches.json ]]; then branches=$(cat data/branches.json); fi
cached=$(jq -r '.checked_at // 0' <<< "$branches")
cached_commit=$(jq -r '.deployed // ""' <<< "$branches")
if (( now - cached >= 600 )) || [[ "$cached_commit" != "$deployed" ]]; then
    branches=$(jq -n --arg deployed "$deployed" --argjson now "$now" '{deployed:$deployed,checked_at:$now}')
    for branch in dev main; do
        # Resolve the head first, then compare exact immutable commits.
        if head_json=$(curl -fsS --max-time 20 "$github/commits/$branch") &&
           head=$(jq -er '.sha | select(test("^[0-9a-f]{40}$"))' <<< "$head_json") &&
           comparison=$(curl -fsS --max-time 20 "$github/compare/$deployed...$head"); then
            item=$(jq --arg head "$head" '{head:$head,status:.status,behind:.ahead_by,ahead:.behind_by}' <<< "$comparison")
        else
            item='{"error":"GitHub lookup unavailable; comparison unknown"}'
        fi
        branches=$(jq --arg branch "$branch" --argjson item "$item" '.[$branch]=$item' <<< "$branches")
    done
    printf '%s\n' "$branches" > data/branches.json.tmp
    mv data/branches.json.tmp data/branches.json
fi
if [[ -n ${builds_pid:-} ]] && wait "$builds_pid"; then
    builds=$(cat data/builds.json)
fi
jq -n --argjson now "$now" --arg deployed "$deployed" --arg version "$version" --arg image "$image" \
  --argjson total "$total" --argjson available "$available" --argjson branches "$branches" --argjson builds "$builds" \
  '{updated_at:$now,host:"cabbage",deployed:$deployed,version:$version,image:$image,branches:$branches,builds:$builds,
    disk:{path:"/",total_bytes:$total,available_bytes:$available,available_gib:(($available/1073741824*10|floor)/10),free_percent:(($available/$total*1000|floor)/10)}}' > public/deployment.json.tmp
chmod 644 public/deployment.json.tmp
mv public/deployment.json.tmp public/deployment.json
# A missed heartbeat is marked failed by Gatus after three minutes.
printf 'header = "Authorization: Bearer %s"\n' "$COLLECTOR_TOKEN" |
    curl --config - -fsS --max-time 15 -X POST \
    'http://127.0.0.1:18081/api/v1/endpoints/cabbage_deployment-collector/external?success=true' >/dev/null
