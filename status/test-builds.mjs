import assert from 'node:assert/strict';
import {test} from 'node:test';
import {currentBuilds, requiredCI} from './public/builds.mjs';

const at = '2026-11-27T00:00:00Z';
const run = (id, head_sha, event, conclusion = 'success') => ({
  id, head_sha, event, conclusion, status: 'completed', check_suite_id: id, run_attempt: 1,
  created_at: at, run_started_at: at, updated_at: at,
});
const job = (id, name, conclusion) => ({id, name, conclusion, completed_at: at});
const dev = run(1, 'dev-sha', 'push', 'failure');
const historical = run(2, 'old-sha', 'push', 'failure');

function useGitHub(t, runs, jobs, push = historical) {
  t.mock.method(globalThis, 'fetch', async path => {
    const url = new URL(path);
    if (url.pathname.endsWith('/branches/main')) return Response.json({commit: {sha: 'actual-sha'}});
    if (url.pathname.endsWith('/ci.yml/runs')) {
      const branch = url.searchParams.get('branch');
      if (branch === 'dev') {
        assert.equal(url.searchParams.get('event'), 'push');
        return Response.json({workflow_runs: [dev]});
      }
      if (url.searchParams.get('event') === 'push') return Response.json({workflow_runs: [push]});
      assert.equal(url.searchParams.get('head_sha'), 'actual-sha');
      return Response.json({workflow_runs: runs});
    }
    if (url.pathname.endsWith('/runs/1/attempts/1/jobs')) return Response.json({total_count: 0, jobs: []});
    const check = /\/check-suites\/(\d+)\/check-runs$/.exec(url.pathname);
    if (check) {
      const rows = jobs[Number(check[1])] || [];
      return Response.json({total_count: rows.length, check_runs: rows});
    }
    throw new Error(`Unexpected GitHub request: ${url.pathname}`);
  });
}

test('selects a full manual run on main head and keeps the last push as history', async t => {
  const complete = run(3, 'actual-sha', 'workflow_dispatch');
  const partial = run(4, 'actual-sha', 'workflow_dispatch');
  const stale = run(5, 'old-sha', 'workflow_dispatch');
  useGitHub(t, [stale, partial, complete], {
    3: [job(30, requiredCI, 'success')],
    4: [job(40, requiredCI, 'skipped')],
    5: [job(50, requiredCI, 'success')],
  });
  const result = await currentBuilds({}, 'test', true);
  assert.equal(result.main.id, complete.id);
  assert.equal(result.main.state, 'success');
  assert.equal(result.mainPush.id, historical.id);
  assert.equal(result.mainPush.state, 'failure');
  assert.equal(result.ci.id, dev.id);
});

test('does not report current main green from a partial or stale manual run', async t => {
  useGitHub(t, [run(3, 'actual-sha', 'workflow_dispatch'), run(4, 'old-sha', 'workflow_dispatch')], {
    3: [job(30, 'A non-gating job', 'success')],
    4: [job(40, requiredCI, 'success')],
  });
  const result = await currentBuilds({}, 'test', true);
  assert.equal(result.main, null);
  assert.equal(result.mainPush.id, historical.id);
});

test('reports a failed exact-head manual gate instead of an older successful exact-head push', async t => {
  const failed = run(4, 'actual-sha', 'workflow_dispatch', 'failure');
  const push = run(3, 'actual-sha', 'push');
  useGitHub(t, [failed, push], {
    3: [job(30, requiredCI, 'success')],
    4: [job(40, requiredCI, 'failure')],
  }, push);
  const result = await currentBuilds({}, 'test', true);
  assert.equal(result.main.id, failed.id);
  assert.equal(result.main.state, 'failure');
});
