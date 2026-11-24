import {readFile, rename, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {ciJobs, ciJobsWithRunners, ciRuns, currentBuilds, dockerBuild, earlyPublish, github, jobStage, releaseRecord, requiredCI, runRecord, testedPublish} from './public/builds.mjs';

const cachePath = 'data/builds-history.json';
const token = process.env.GH_TOKEN;
const seed = process.argv[2] === '--seed';

async function readJSON(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

const history = await readJSON(cachePath);
const jobHistory = history.jobs = {
  ci: Object.assign(Object.create(null), history.jobs?.ci),
  release: Object.assign(Object.create(null), history.jobs?.release),
};
const waitHistory = history.waits = {
  ci: Object.assign(Object.create(null), history.waits?.ci),
  release: Object.assign(Object.create(null), history.waits?.release),
};

function record(name, run, start, end, timings = history) {
  const duration = Math.round((Date.parse(end) - Date.parse(start)) / 1000);
  if (!(duration >= 0)) return;
  if (!Object.hasOwn(timings, name)) Object.defineProperty(timings, name, {value: {}, enumerable: true});
  const samples = timings[name];
  samples[`${run.id}.${run.attempt}`] = duration;
  const ordered = Object.keys(samples).sort((a, b) => {
    const [aRun, aAttempt] = a.split('.').map(Number);
    const [bRun, bAttempt] = b.split('.').map(Number);
    return bRun - aRun || bAttempt - aAttempt;
  });
  for (const key of ordered.slice(20)) delete samples[key];
}

function recordJobs(run, workflow) {
  for (const job of run.jobs) {
    if (job.state === 'success') record(job.name, run, job.started, job.finished, jobHistory[workflow]);
    if (job.assigned && job.runnerPool && job.created && job.started && job.state !== 'queued') {
      const pool = waitHistory[workflow][job.runnerPool] ||= {};
      record(job.name, run, job.created, job.started, pool);
    }
  }
}

function mean(values) {
  return {seconds: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length), count: values.length};
}

function averages(timings) {
  return Object.fromEntries(Object.entries(timings).map(([name, samples]) => [name, mean(Object.values(samples))]));
}

function waitAverages(history) {
  return Object.fromEntries(Object.entries(history).flatMap(([pool, jobs]) => {
    const values = Object.values(jobs).flatMap(samples => Object.values(samples));
    return values.length ? [[pool, {average: mean(values), jobs: averages(jobs)}]] : [];
  }));
}

function recordCI(run, name) {
  const gate = run.jobs.find(job => job.name === requiredCI);
  if (run.state === 'success' && gate?.state === 'success') {
    record(name, run, run.started, gate.finished);
  }
}

function recordDocker(ci) {
  recordJobs(ci, 'ci');
  const build = jobStage(ci.jobs, dockerBuild, ci, 2);
  const early = jobStage(ci.jobs, earlyPublish, ci);
  if (build.state === 'success') record('docker', ci, build.started, build.finished);
  if (early.state === 'success') {
    record('early', ci, early.started, early.finished);
    record('unstable', ci, ci.started, early.finished);
  }
}

function recordRelease(release) {
  if (!release) return;
  recordJobs(release, 'release');
  if (release.state === 'success') record('release', release, release.started, release.finished);
}

async function inspectTag(tag) {
  return new Promise(resolve => {
    const child = spawn('docker', ['buildx', 'imagetools', 'inspect', `archivebox/archivebox:${tag}`,
      '--format', '{{json (index .Image "linux/amd64")}}'], {stdio: ['ignore', 'pipe', 'inherit'], timeout: 6500});
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.on('error', () => resolve(null));
    child.on('close', code => {
      if (code) return resolve(null);
      try {
        const labels = JSON.parse(stdout)?.config.Labels;
        const revision = labels?.['org.opencontainers.image.revision'];
        const version = labels?.['org.opencontainers.image.version'];
        resolve(/^[a-f0-9]{40}$/.test(revision) ? {revision, version} : null);
      } catch {
        resolve(null);
      }
    });
  });
}

async function collect() {
  const previous = await readJSON('data/builds.json');
  const snapshot = currentBuilds(previous, token, true).catch(error => {
    console.error(error.message);
    return previous;
  });
  const tagNames = ['dev', 'dev-unstable'];
  const [data, ...images] = await Promise.all([snapshot, ...tagNames.map(inspectTag)]);
  if (data.ci) {
    recordCI(data.ci, 'dev');
    recordDocker(data.ci);
  }
  if (data.main) recordCI(data.main, 'main');
  recordRelease(data.release);
  const {jobs, waits, ...stages} = history;
  const tags = Object.fromEntries(tagNames.flatMap((tag, index) => images[index] ? [[tag, images[index]]] : []));
  await writeFile(`${cachePath}.tmp`, JSON.stringify(history) + '\n');
  await rename(`${cachePath}.tmp`, cachePath);
  console.log(JSON.stringify({...data, averages: averages(stages),
    job_averages: {ci: averages(jobs.ci), release: averages(jobs.release)},
    wait_averages: {ci: waitAverages(waits.ci), release: waitAverages(waits.release)},
    tags, collected_at: Math.floor(Date.now() / 1000)}));
}

async function seedHistory() {
  const [dev, main, releases, successfulDev] = await Promise.all([
    ciRuns('dev', token, 50), ciRuns('main', token, 30),
    github('actions/workflows/release.yml/runs?branch=dev&status=success&per_page=50', token),
    github('actions/workflows/ci.yml/runs?branch=dev&event=push&status=success&per_page=50', token),
  ]);
  const recentDev = dev.workflow_runs.slice(0, 24);
  const waits = new Set(recentDev.map(run => run.id));
  const candidates = [...new Map([
    ...recentDev,
    ...main.workflow_runs.filter(run => run.conclusion === 'success').slice(0, 12),
    ...successfulDev.workflow_runs,
  ].map(run => [run.id, run])).values()];
  for (let index = 0; index < candidates.length; index += 3) {
    const results = await Promise.allSettled(candidates.slice(index, index + 3).map(async run => {
      const jobs = await (waits.has(run.id) ? ciJobsWithRunners(run, token) : ciJobs(run, token));
      const record = runRecord(run, jobs);
      recordCI(record, run.head_branch);
      if (run.head_branch === 'dev') recordDocker(record);
    }));
    for (const result of results) if (result.status === 'rejected') console.error(result.reason.message);
  }
  for (let index = 0; index < releases.workflow_runs.length &&
    (Object.keys(history.release || {}).length < 10 ||
      !Object.values(waitHistory.release).some(pool => Object.keys(pool[testedPublish] || {}).length >= 10)); index += 4) {
    await Promise.all(releases.workflow_runs.slice(index, index + 4).map(async run => recordRelease(await releaseRecord(run, token))));
  }
  console.log(JSON.stringify(history));
}

await (seed ? seedHistory() : collect());
