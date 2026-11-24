import {execFileSync, spawn} from 'node:child_process';
import {readFileSync, renameSync, writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';

const target = 'archiveboxdemo-archivebox-1';
const watchtower = 'archiveboxdemo-watchtower-1';
const cachePath = 'data/watchtower.json';
const publicPath = 'public/watchtower.json';
const container = execFileSync('docker', ['inspect', '--format', '{{.Id}}', watchtower],
  {encoding:'utf8', timeout:5000}).trim();

let cached = {};
try {
  cached = JSON.parse(readFileSync(cachePath, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
let samples = cached.samples || {};
let latest = cached.latest;
if (latest?.state === 'in_progress' && cached.container !== container) {
  latest = {...latest, state:'cancelled', finished:new Date().toISOString()};
}
let attempt;
let pendingWrite;
let previousOutput;

function save() {
  const recent = Object.entries(samples).sort(([a], [b]) => b.localeCompare(a)).slice(0, 20);
  const values = recent.map(([, value]) => value);
  const average = values.length ? {seconds:Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
    count:values.length} : null;
  const payload = JSON.stringify({...latest, average});
  if (payload === previousOutput) return;
  previousOutput = payload;
  // Atomic replacement lets the browser poll while Docker is replacing ArchiveBox.
  samples = Object.fromEntries(recent);
  writeFileSync(`${cachePath}.tmp`, JSON.stringify({container, latest, samples}) + '\n');
  renameSync(`${cachePath}.tmp`, cachePath);
  writeFileSync(`${publicPath}.tmp`, payload + '\n', {mode:0o644});
  renameSync(`${publicPath}.tmp`, publicPath);
}

function update(line) {
  const timestamp = line.match(/\btime="?([0-9TZ:+.-]+)/)?.[1];
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return;
  const isTarget = line.includes(` container=${target} `) || line.endsWith(` container=${target}`);
  if (isTarget && line.includes('msg="Found new image"')) {
    attempt = {started:timestamp, state:'in_progress'};
    if (!latest || Date.parse(timestamp) >= Date.parse(latest.started)) latest = attempt;
  } else if (attempt && ((isTarget && line.includes('msg="Started new container"')) ||
    line.includes('msg="Update session completed"'))) {
    // The session also updates the chat bot. Only ArchiveBox's own start proves success.
    const success = isTarget;
    const finished = {started:attempt.started, finished:timestamp, state:success ? 'success' : 'failure'};
    if (success) samples[attempt.started] = (Date.parse(timestamp) - Date.parse(attempt.started)) / 1000;
    if (latest === attempt) latest = finished;
    attempt = undefined;
  } else {
    return;
  }
  // Debounce the initial historical log burst so only the latest update is published.
  clearTimeout(pendingWrite);
  pendingWrite = setTimeout(save, 150);
}

save();
// Merge Docker's stdout and stderr to preserve the chronological order of Watchtower's log.
const logs = spawn('/bin/sh', ['-c', 'exec docker logs --follow --since 72h --tail 4000 "$1" 2>&1', 'watchtower', container],
  {stdio:['ignore', 'pipe', 'inherit']});
createInterface({input:logs.stdout}).on('line', update);
logs.on('close', code => {
  clearTimeout(pendingWrite);
  save();
  process.exitCode = code || 0;
});
