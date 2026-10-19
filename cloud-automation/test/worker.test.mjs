import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { dispatch, default as worker } from '../cloudflare/worker.mjs';

const env = { GITHUB_TOKEN: 'test-placeholder-not-a-real-token', GITHUB_REPOSITORY: 'optiona286/btc-options-klines', GITHUB_BRANCH: 'main', GITHUB_WORKFLOW: 'update-op-data.yml' };

test('Worker dispatches only the configured workflow and accepts GitHub 200 and 204', async () => {
  for (const status of [200, 204]) {
    const result = await dispatch(env, async (url, init) => {
      assert.equal(url, 'https://api.github.com/repos/optiona286/btc-options-klines/actions/workflows/update-op-data.yml/dispatches');
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), { ref: 'main' });
      assert.equal(init.headers.Authorization, `Bearer ${env.GITHUB_TOKEN}`);
      return new Response(null, { status });
    });
    assert.equal(result.accepted, true);
    assert.equal(JSON.stringify(result).includes(env.GITHUB_TOKEN), false);
  }
});
test('missing credentials, changed destination, or rejected dispatch cannot look successful', async () => {
  await assert.rejects(dispatch({ ...env, GITHUB_TOKEN: '' }), /secret/);
  await assert.rejects(dispatch({ ...env, GITHUB_BRANCH: 'other' }), /destination/);
  await assert.rejects(dispatch(env, async () => new Response(null, { status: 403 })), /403/);
});
test('no public HTTP request can trigger a GitHub mutation', async () => {
  assert.equal((await worker.fetch(new Request('https://worker.example/run', { method: 'POST' }))).status, 404);
  const health = await worker.fetch(new Request('https://worker.example/health'));
  assert.equal((await health.json()).scheduleEnabled, false);
});
test('the optional Worker has no schedule', async () => {
  const config = JSON.parse(await fs.readFile(new URL('../cloudflare/wrangler.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(config.triggers.crons, []);
  assert.equal('scheduled' in worker, false);
  assert.equal('r2_buckets' in config, false);
});
