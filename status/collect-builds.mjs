import {readFile, rename, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {ciJobs, ciRuns, currentBuilds, dockerBuild, earlyPublish, github, jobStage, releaseRecord, requiredCI, runRecord} from './public/builds.mjs';

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

const history = seed ? {} : await readJSON(cachePath);

function record(name, run, start, end) {
  const duration = Math.round((Date.parse(end) - Date.parse(start)) / 1000);
  if (!(duration > 0)) return;
  const samples = history[name] ||= {};
  samples[`${run.id}.${run.attempt}`] = duration;
  const ordered = Object.keys(samples).sort((a, b) => Number(b) - Number(a));
  for (const key of ordered.slice(20)) delete samples[key];
}

function recordCI(run, name) {
  const gate = run.jobs.find(job => job.name === requiredCI);
  if (run.state === 'success' && gate?.state === 'success') {
    record(name, run, run.started, gate.finished);
  }
}

function recordDocker(ci) {
  const build = jobStage(ci.jobs, dockerBuild, ci, 2);
  const early = jobStage(ci.jobs, earlyPublish, ci);
  if (build.state === 'success') record('docker', ci, build.started, build.finished);
  if (early.state === 'success') {
    record('early', ci, early.started, early.finished);
    record('unstable', ci, ci.started, early.finished);
  }
}

function recordRelease(release) {
  if (release?.state === 'success') record('release', release, release.started, release.finished);
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
  const averages = Object.fromEntries(Object.entries(history).map(([key, samples]) => {
    const values = Object.values(samples);
    return [key, {seconds: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length), count: values.length}];
  }));
  const tags = Object.fromEntries(tagNames.flatMap((tag, index) => images[index] ? [[tag, images[index]]] : []));
  await writeFile(`${cachePath}.tmp`, JSON.stringify(history) + '\n');
  await rename(`${cachePath}.tmp`, cachePath);
  console.log(JSON.stringify({...data, averages, tags, collected_at: Math.floor(Date.now() / 1000)}));
}

async function seedHistory() {
  const [dev, main, releases, successfulDev] = await Promise.all([
    ciRuns('dev', token, 50), ciRuns('main', token, 30),
    github('actions/workflows/release.yml/runs?branch=dev&status=success&per_page=50', token),
    github('actions/workflows/ci.yml/runs?branch=dev&event=push&status=success&per_page=50', token),
  ]);
  const candidates = [...new Map([
    ...dev.workflow_runs.filter(run => run.status === 'completed').slice(0, 24),
    ...main.workflow_runs.filter(run => run.conclusion === 'success').slice(0, 12),
    ...successfulDev.workflow_runs,
  ].map(run => [run.id, run])).values()];
  for (let index = 0; index < candidates.length; index += 3) {
    await Promise.all(candidates.slice(index, index + 3).map(async run => {
      const jobs = await ciJobs(run, token);
      const record = runRecord(run, jobs);
      recordCI(record, run.head_branch);
      if (run.head_branch === 'dev') recordDocker(record);
    }));
  }
  for (let index = 0; index < releases.workflow_runs.length && Object.keys(history.release || {}).length < 10; index += 4) {
    await Promise.all(releases.workflow_runs.slice(index, index + 4).map(async run => recordRelease(await releaseRecord(run, token))));
  }
  console.log(JSON.stringify(history));
}

await (seed ? seedHistory() : collect());
