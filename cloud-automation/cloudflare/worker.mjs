export async function dispatch(env, fetchImpl = fetch) {
  if (!env.GITHUB_TOKEN) throw new Error('Configure the GITHUB_TOKEN Worker secret before enabling the schedule');
  const repository = env.GITHUB_REPOSITORY;
  const branch = env.GITHUB_BRANCH;
  const workflow = env.GITHUB_WORKFLOW;
  if (repository !== 'optiona286/btc-options-klines' || branch !== 'main' || workflow !== 'update-op-data.yml') throw new Error('Unexpected dispatch destination');
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'btc-op-daily-scheduler',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ ref: branch }),
    signal: AbortSignal.timeout(30000),
  });
  if (![200, 204].includes(response.status)) throw new Error(`GitHub workflow dispatch failed: HTTP ${response.status}`);
  // Do not log GitHub response bodies or any credential.
  return { accepted: true, repository, branch, workflow };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ service: 'BTC OP dispatch helper', scheduleEnabled: false, storage: 'no R2', execution: 'GitHub Actions' });
    }
    return new Response('Not found', { status: 404 });
  },
};
