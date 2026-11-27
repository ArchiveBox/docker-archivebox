import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {promisify} from 'node:util';
import {jobRecord, latestRuns} from './public/builds.mjs';

const exec = promisify(execFile);
const names = [
  'ArchiveBox', 'abx-dl', 'abx-plugins', 'ios-archivebox', 'android-archivebox',
  'electron-archivebox', 'archivebox-browser-extension', 'archivebox-chat-bot',
  'archivebox-js', 'abxpkg', 'abxbus',
];
const token = process.env.GH_TOKEN;
const seed = process.argv[2] === '--seed';
const cache = await readFile('data/repos.json', 'utf8').then(JSON.parse, error => {
  if (error.code === 'ENOENT') return {repos: []};
  throw error;
});
const now = Math.floor(Date.now() / 1000);
const bad = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);
const active = run => run.status !== 'completed';
const runKey = run => `${run.id}.${run.run_attempt}`;
const historyKey = run => `${run.workflow_id}:${run.event}`;
// At one authenticated refresh per minute, leave capacity for build and branch
// lookups within GitHub's hourly allowance even when many matrices are active.
let remaining = token && !seed ? 60 : Infinity;
let reserve = 0;

async function github(path) {
  if (remaining <= reserve) throw Error('GitHub API budget');
  const headers = {Accept: 'application/vnd.github+json'};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (remaining !== Infinity) remaining--;
  const response = await fetch(`https://api.github.com/${path}`, {headers, signal: AbortSignal.timeout(12000)});
  if (!response.ok) throw Error(`GitHub HTTP ${response.status} · ${path}`);
  return response.json();
}

function record(history, run) {
  if (run.conclusion !== 'success') return;
  const seconds = (Date.parse(run.updated_at) - Date.parse(run.run_started_at)) / 1000;
  if (!(seconds > 0)) return;
  const samples = history[historyKey(run)] ||= {};
  samples[runKey(run)] = seconds;
  // A workflow rerun keeps its ID but is a separate timing sample.
  const ordered = Object.keys(samples).sort((a, b) => {
    const [idA, attemptA] = a.split('.').map(Number);
    const [idB, attemptB] = b.split('.').map(Number);
    return idB - idA || attemptB - attemptA;
  });
  for (const key of ordered.slice(20)) delete samples[key];
}

async function workflowJobs(path, run, history) {
  const failures = [];
  const activeJobs = [];
  const cancelled = [];
  const attempt = `${path}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=50`;
  // Large matrix responses have failed at 100 jobs per page. Keep page offsets fixed.
  for (let page = 1; ; page++) {
    const {jobs, total_count: total} = await github(`${attempt}&page=${page}`);
    // Reuse fetched job results to measure runner time, without another API pass.
    for (const job of jobs.filter(job => job.conclusion === 'success')) {
      const seconds = (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000;
      if (!(seconds >= 0)) continue;
      const samples = history[job.name] ||= {};
      samples[runKey(run)] = seconds;
      const keys = Object.keys(samples).sort((a, b) => {
        const [aRun, aAttempt] = a.split('.').map(Number);
        const [bRun, bAttempt] = b.split('.').map(Number);
        return bRun - aRun || bAttempt - aAttempt;
      });
      for (const key of keys.slice(20)) delete samples[key];
    }
    failures.push(...jobs.filter(job => bad.has(job.conclusion)).map(job => ({id:job.id, name:job.name})));
    // This response is already fetched for failures. Keep runner assignments
    // for active work too, so contention does not require a second API pass.
    activeJobs.push(...jobs.filter(active).map(jobRecord));
    cancelled.push(...jobs.filter(job => job.conclusion === 'cancelled'));
    if (page * 50 >= total) break;
  }
  if (!failures.length && run.conclusion === 'failure') {
    // A runner acquisition failure can appear as a cancelled job with a failure annotation.
    for (const job of cancelled.slice(0, 8)) {
      if (remaining <= reserve) break;
      const annotations = await github(`${path}/check-runs/${job.id}/annotations?per_page=30`);
      if (annotations.some(item => item.annotation_level === 'failure')) failures.push({id:job.id, name:job.name});
    }
  }
  return {failures, jobs:activeJobs};
}

async function seedRuns(path, branch, head, recent, previous, history) {
  const filters = `branch=${encodeURIComponent(branch)}`;
  const [workflows, headRuns, scheduled] = await Promise.all([
    github(`${path}/actions/workflows?per_page=100`),
    github(`${path}/actions/runs?${filters}&head_sha=${head}&per_page=50`),
    github(`${path}/actions/runs?${filters}&event=schedule&per_page=50`),
  ]);
  const schedules = new Set([...scheduled.workflow_runs, ...previous.filter(run => run.event === 'schedule')]
    .map(run => run.workflow_id));
  const runs = [...headRuns.workflow_runs, ...scheduled.workflow_runs];
  for (const workflow of workflows.workflows.filter(workflow => workflow.state === 'active')) {
    // Query each workflow so a frequent schedule cannot hide a monthly run.
    const {workflow_runs} = await github(`${path}/actions/workflows/${workflow.id}/runs?${filters}&event=schedule&per_page=20`);
    if (workflow_runs.length) schedules.add(workflow.id);
    runs.push(...workflow_runs);
  }
  const activeWorkflows = new Set(workflows.workflows.filter(workflow => workflow.state === 'active').map(workflow => workflow.id));
  const observed = [...new Map([...recent, ...runs]
    .filter(run => run.event !== 'pull_request' && (run.head_sha === head || schedules.has(run.workflow_id) && run.event === 'schedule'))
    .map(run => [historyKey(run), run])).values()];
  for (const run of observed) {
    const {workflow_runs} = await github(`${path}/actions/workflows/${run.workflow_id}/runs?${filters}&event=${run.event}&status=success&per_page=20`);
    for (const sample of workflow_runs) record(history, sample);
  }
  return {runs, activeWorkflows};
}

async function collect(name, previous = {}) {
  const slug = `ArchiveBox/${name}`;
  const path = `repos/${slug}`;
  // Git resolves the exact default-branch HEAD without spending REST API requests.
  const {stdout} = await exec('git', ['ls-remote', '--symref', `https://github.com/${slug}.git`, 'HEAD'], {timeout:10000});
  const branch = stdout.match(/^ref: refs\/heads\/(.+)\tHEAD$/m)?.[1];
  const head = stdout.match(/^([a-f0-9]{40})\tHEAD$/m)?.[1];
  if (!branch || !head) throw Error(`Missing default branch for ${slug}`);
  // Runner capacity is shared with PRs and other branches, not just HEAD.
  const {workflow_runs: recent} = await github(`${path}/actions/runs?per_page=50`);
  const history = {...previous.history};
  const job_history = structuredClone(previous.job_history || {});
  const prior = previous.runs || [];
  const boot = seed ? await seedRuns(path, branch, head, recent, prior, history) : null;
  let activeWorkflows = boot?.activeWorkflows;
  let workflowsChecked = previous.workflows_checked_at;
  if (boot) workflowsChecked = now;
  else if (now - (workflowsChecked || 0) >= 86400 && remaining > reserve) {
    // Periodic runs can outlive a disabled workflow in GitHub's run history.
    try {
      const {workflows} = await github(`${path}/actions/workflows?per_page=100`);
      activeWorkflows = new Set(workflows.filter(workflow => workflow.state === 'active').map(workflow => workflow.id));
      workflowsChecked = now;
    } catch (error) {
      console.error(error.message);
    }
  }
  const incoming = [...new Map([...(boot?.runs || []), ...recent].map(run => [run.id, run])).values()];
  const previousRuns = prior.filter(run => !activeWorkflows || activeWorkflows.has(run.workflow_id));
  // Retain infrequent scheduled runs well after they leave the repository's recent list.
  const candidates = new Map(previousRuns.map(run => [run.id, run]));
  for (const run of incoming) {
    if (!run.event.startsWith('pull_request') && run.head_branch === branch) record(history, run);
    if ((run.event.startsWith('pull_request') && !active(run)) ||
        (run.event === 'schedule' && activeWorkflows && !activeWorkflows.has(run.workflow_id)) ||
        !(active(run) || run.event === 'schedule' || run.head_sha === head)) {
      // An active older head/PR must disappear when its completion arrives;
      // retaining its cached record would falsely keep runners busy forever.
      candidates.delete(run.id);
      continue;
    }
    if (active(run) || run.event === 'schedule' || run.head_sha === head) {
      const cached = prior.find(item => runKey(item) === runKey(run) && item.status === run.status);
      candidates.set(run.id, {...run, failures:cached?.failures});
    }
  }
  const eligible = [...candidates.values()].filter(run => active(run) || run.event === 'schedule' || run.head_sha === head);
  const selected = [...latestRuns(eligible.filter(run => run.event !== 'schedule'), branch),
    ...latestRuns(eligible.filter(run => run.event === 'schedule'), branch)];
  const runs = [];
  for (let run of selected) {
    if (active(run) && !incoming.some(item => item.id === run.id)) {
      try {
        const current = await github(`${path}/actions/runs/${run.id}`);
        run = runKey(current) === runKey(run) && current.status === run.status ? {...current, failures:run.failures} : current;
        record(history, run);
      } catch (error) {
        console.error(error.message);
      }
    }
    let {failures} = run;
    // An API failure must not erase the last observed assignments or make
    // them look current. Rerun attempts must never inherit the old job IDs.
    const cached = prior.find(item => runKey(item) === runKey(run));
    let jobs = active(run) ? cached?.jobs : [];
    let jobs_checked_at = cached?.jobs_checked_at;
    let jobsUnavailable, jobsError;
    const jobHistory = job_history[run.workflow_id] ||= {};
    if (active(run) || (bad.has(run.conclusion) && !failures?.length) ||
        (run.conclusion === 'success' && (!cached?.jobs_checked_at || cached.status !== 'completed'))) {
      try {
        const result = await workflowJobs(path, run, jobHistory);
        failures = result.failures;
        jobs = active(run) ? result.jobs : [];
        jobs_checked_at = Math.floor(Date.now() / 1000);
      } catch (error) {
        jobsUnavailable = true;
        jobsError = error.message;
        console.error(error.message);
      }
    }
    const times = Object.values(history[historyKey(run)] || {});
    const avg = times.length ? Math.round(times.reduce((sum, s) => sum + s, 0) / times.length) : null;
    runs.push({
      id:run.id, workflow_id:run.workflow_id, run_attempt:run.run_attempt, name:run.name,
      event:run.event, head_sha:run.head_sha, head_branch:run.head_branch,
      // GitHub can call a whole matrix queued even while its jobs occupy runners.
      status:active(run) && jobs?.some(job => job.state === 'in_progress') ? 'in_progress' : run.status,
      conclusion:run.conclusion,
      run_started_at:run.run_started_at, created_at:run.created_at, updated_at:run.updated_at,
      avg, failures, jobs, jobs_checked_at, jobsUnavailable, jobsError,
      job_averages: Object.fromEntries(Object.entries(jobHistory).map(([name, samples]) => {
        const values = Object.values(samples);
        return [name, {seconds:Math.round(values.reduce((sum, s) => sum + s, 0) / values.length), count:values.length}];
      })),
    });
  }
  return {name, branch, head, checked_at:now, workflows_checked_at:workflowsChecked, runs, history, job_history};
}

if (!seed && !token) {
  // Reserve anonymous REST capacity for the Docker diagrams and branch comparisons.
  try {
    const {resources:{core}} = await github('rate_limit');
    remaining = core.remaining;
    reserve = Math.ceil(36 * Math.max(0, core.reset - now) / 3600) + 4;
  } catch (error) {
    console.error(error.message);
    remaining = 0;
  }
}
const previous = new Map(cache.repos.map(repo => [repo.name, repo]));
const attempted = cache.attempted || {};
const due = seed ? names : [...names].sort((a, b) =>
  (attempted[a] || previous.get(a)?.checked_at || 0) - (attempted[b] || previous.get(b)?.checked_at || 0)).slice(0, token ? names.length : 1);
if (remaining > reserve) {
  const batchSize = seed || token ? 3 : 1;
  for (let i = 0; i < due.length; i += batchSize) {
    if (remaining <= reserve) break;
    await Promise.all(due.slice(i, i + batchSize).map(async name => {
      attempted[name] = now;
      try {
        previous.set(name, await collect(name, previous.get(name)));
        console.error(`${name} · ${previous.get(name).runs.length} runs`);
      } catch (error) {
        if (seed) throw error;
        console.error(error.message);
      }
    }));
  }
}
if (seed && previous.size !== names.length) throw Error('Incomplete repository CI data');
console.log(JSON.stringify({
  collected_at: now, attempted,
  repos: names.flatMap(name => previous.has(name) ? [previous.get(name)] : []),
}));
