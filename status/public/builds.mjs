const api = 'https://api.github.com/repos/ArchiveBox/ArchiveBox';
export const repo = 'https://github.com/ArchiveBox/ArchiveBox';
export const dockerBuild = 'Tested Docker images';
export const earlyPublish = 'Publish early dev image';
export const testedPublish = 'Publish tested multiarch image';
export const requiredCI = 'All required CI lanes';

export async function github(path, token) {
  const headers = {Accept: 'application/vnd.github+json'};
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${api}/${path}`, {headers, cache: 'no-store', signal: AbortSignal.timeout(12000)});
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status} · ${path}`);
  return response.json();
}

export function ciRuns(branch, token, count = 1) {
  return github(`actions/workflows/ci.yml/runs?branch=${branch}&event=push&per_page=${count}`, token);
}

export function jobRecord(job) {
  const labels = job.labels?.map(label => label.toLowerCase()).sort();
  return {
    id: job.id, name: job.name, state: job.conclusion || job.status,
    started: job.started_at, finished: job.completed_at,
    created: job.created_at,
    runnerPool: labels?.length ? labels.join(',') : undefined,
    assigned: job.runner_id > 0 || undefined,
  };
}

export async function workflowJobs(run, token, pageSize = 50) {
  const path = `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=${pageSize}`;
  const first = await github(path, token);
  const remaining = Array.from({length: Math.max(0, Math.ceil(first.total_count / pageSize) - 1)},
    (_, index) => github(`${path}&page=${index + 2}`, token));
  const pages = [first, ...await Promise.all(remaining)];
  return [...new Map(pages.flatMap(page => page.jobs).map(job => [job.id, job])).values()];
}

export async function ciJobsWithRunners(run, token) {
  return (await workflowJobs(run, token)).map(jobRecord);
}

export async function ciJobs(run, token) {
  const suite = run.check_suite_id;
  if (!suite) return [];
  const path = `check-suites/${suite}/check-runs?per_page=100`;
  const first = await github(path, token);
  const remaining = Array.from({length: Math.max(0, Math.ceil(first.total_count / 100) - 1)},
    (_, index) => github(`${path}&page=${index + 2}`, token));
  const pages = [first, ...await Promise.all(remaining)];
  return [...new Map(pages.flatMap(page => page.check_runs).map(job => [job.id, jobRecord(job)])).values()];
}

export function runRecord(run, jobs = []) {
  return {
    id: run.id, attempt: run.run_attempt, revision: run.head_sha, state: run.conclusion || run.status,
    status: run.status, created: run.created_at, started: ['queued', 'requested', 'pending', 'waiting'].includes(run.status) ? null : run.run_started_at,
    finished: run.status === 'completed' ? run.updated_at : null, jobs,
  };
}

export async function releaseRecord(run, token) {
  const jobs = await workflowJobs(run, token, 30);
  const record = runRecord(run, jobs.map(jobRecord));
  const publisher = jobs.find(job => job.name === testedPublish);
  // Docker promotion can finish before the cascade and other publishing jobs.
  // Keep the workflow's actual completion state for the full release ETA.
  record.publisher = publisher?.id;
  return record;
}

async function currentCIJobs(run, previous, token, refreshWaits) {
  const routed = new Map((previous || []).filter(job => job.runnerPool).map(job => [job.id, job]));
  const needsRouting = refreshWaits || !routed.size;
  if (needsRouting) {
    try {
      return await ciJobsWithRunners(run, token);
    } catch (error) {
      if (token || typeof window === 'undefined') console.error(error.message);
    }
  }
  const checks = await ciJobs(run, token);
  if (!needsRouting && checks.some(job => job.state === 'queued' && !routed.has(job.id))) {
    try {
      return await ciJobsWithRunners(run, token);
    } catch {
      // Check runs still provide the current status.
    }
  }
  return checks.map(job => {
    const prior = routed.get(job.id);
    return prior ? {...job, created: prior.created, runnerPool: prior.runnerPool, assigned: prior.assigned} : job;
  });
}

async function currentMainRequest(token) {
  const [branch, lastPush] = await Promise.all([
    github('branches/main', token), ciRuns('main', token),
  ]);
  const head = branch.commit.sha;
  const {workflow_runs: runs} = await github(
    `actions/workflows/ci.yml/runs?branch=main&head_sha=${head}&per_page=10`, token);
  return {head, runs, push: lastPush.workflow_runs[0]};
}

export async function currentBuilds(previous = {}, token, includeMain = false) {
  const devRequest = ciRuns('dev', token);
  const mainRequest = includeMain ? currentMainRequest(token) : Promise.resolve(null);
  const [devResult, mainResult] = await Promise.allSettled([devRequest, mainRequest]);
  if (devResult.status === 'rejected') throw devResult.reason;
  const {workflow_runs: devRuns} = devResult.value;
  const run = devRuns[0];
  if (!run) throw new Error('No dev CI workflow runs');

  async function withJobs(raw, old, dev) {
    const record = runRecord(raw);
    const same = old?.id === record.id && old.attempt === record.attempt;
    if (same && record.finished && old.finished && !old.jobsUnavailable) return old;
    try {
      record.jobs = dev ? await currentCIJobs(raw, same ? old.jobs : [], token, includeMain) : await ciJobs(raw, token);
      // A workflow can report queued while its matrix already has running jobs.
      if (!record.finished && record.jobs.some(job => job.state === 'in_progress')) record.state = 'in_progress';
      if (!record.started && record.jobs.some(job => job.started &&
        ['in_progress', 'success', 'failure', 'timed_out'].includes(job.state))) record.started = raw.run_started_at;
    } catch (error) {
      record.jobsUnavailable = true;
      record.jobs = same ? old.jobs : [];
      if (token || typeof window === 'undefined') console.error(error.message);
    }
    return record;
  }
  async function currentMain(data) {
    if (!data) return previous.main;
    // The push-only list can refer to an older SHA after a manual run. Main's
    // current status belongs to the exact branch head, not the last push.
    for (const candidate of data.runs) {
      if (candidate.head_sha !== data.head) continue;
      if (candidate.event === 'push') return withJobs(candidate, previous.main, false);
      if (candidate.event !== 'workflow_dispatch' || candidate.status !== 'completed') continue;
      const record = await withJobs(candidate, previous.main, false);
      const gate = record.jobs.find(job => job.name === requiredCI);
      // Manual invocations can be scoped or no-ops; require an actual CI gate.
      if (gate?.state === 'success' || (gate?.state === 'failure' && record.state === 'failure')) return record;
    }
    return null;
  }

  const mainData = mainResult.value;
  const mainPush = mainData ? (mainData.push ? runRecord(mainData.push) : null) : previous.mainPush;
  const [ci, main] = await Promise.all([withJobs(run, previous.ci, true), currentMain(mainData)]);

  let release = null;
  if (ci.state === 'success' && ci.jobs.find(job => job.name === requiredCI)?.state !== 'skipped') {
    const prior = previous.ci?.id === ci.id && previous.ci.attempt === ci.attempt ? previous.release : null;
    if (prior?.status === 'completed' && prior.finished) {
      release = prior;
    } else {
      try {
        const {workflow_runs: runs} = await github(
          `actions/workflows/release.yml/runs?branch=dev&event=workflow_run&head_sha=${ci.revision}&per_page=1`, token);
        if (runs[0]) release = await releaseRecord(runs[0], token);
      } catch (error) {
        release = prior;
        if (token || typeof window === 'undefined') console.error(error.message);
      }
    }
  }

  return {
    checked_at: Math.floor(Date.now() / 1000), ci, release, main, mainPush,
  };
}

export function jobStage(jobs, name, parent, count = 1) {
  const stageJobs = jobs.filter(job => job.name === name || job.name.startsWith(`${name} / `));
  const running = stageJobs.some(job => job.state === 'in_progress');
  const queued = stageJobs.some(job => job.state === 'queued');
  const failing = stageJobs.find(job => failed(job.state));
  const started = stageJobs.filter(job => job.started && !['queued', 'skipped'].includes(job.state))
    .map(job => job.started).sort()[0];
  const successful = stageJobs.length === count && stageJobs.every(job => job.state === 'success');
  const finished = !running && !queued ? stageJobs.map(job => job.finished).filter(Boolean).sort().at(-1) : null;
  let state = 'waiting';
  if (running) state = 'in_progress';
  else if (queued) state = 'queued';
  else if (failing) state = failing.state;
  else if (successful) state = 'success';
  else if (stageJobs.some(job => job.state === 'cancelled') || parent.state === 'cancelled') state = 'cancelled';
  else if (parent.jobsUnavailable) state = 'unknown';
  else if (parent.finished) state = 'skipped';
  return {state, started, finished, jobs: stageJobs};
}

export function failed(state) {
  return ['failure', 'timed_out', 'startup_failure'].includes(state);
}
