// Orchestrator routing + A2A contract tests (real @a2a-js/sdk server, real JWT validation against a local JWKS).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const AUDIENCE = 'ops-monitor-test-client';
let issuerServer; let agentServer; let agentUrl; let keys;

before(async () => {
  const jose = await import('jose');
  keys = await jose.generateKeyPair('RS256');
  const jwk = { ...(await jose.exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  issuerServer = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise((r) => issuerServer.listen(0, r));
  const issuer = `http://localhost:${issuerServer.address().port}`;
  process.env.IAS_ISSUER = issuer; process.env.IAS_AUDIENCE = AUDIENCE; process.env.IAS_JWKS_URL = `${issuer}/oauth2/certs`; process.env.A2A_PUBLIC_URL = 'http://localhost';

  const { mountA2A } = require('../srv/a2a');
  const app = express();
  mountA2A(app, { run: async (question) => ({ ok: true, text: `report for: ${question}`, data: { type: 'operations_report', targets: ['idoc', 'job'], totalFailed: 3, period: '24H' } }) });
  agentServer = http.createServer(app);
  await new Promise((r) => agentServer.listen(0, r));
  agentUrl = `http://localhost:${agentServer.address().port}`;
});
after(() => { agentServer?.close(); issuerServer?.close(); });

async function token(claims, audience = AUDIENCE) {
  const jose = await import('jose');
  return new jose.SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(process.env.IAS_ISSUER).setAudience(audience).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
}
async function send(bearer, text = 'How are my integrations and jobs today?') {
  const r = await fetch(`${agentUrl}/a2a`, { method: 'POST', headers: { 'content-type': 'application/json', ...(bearer && { authorization: `Bearer ${bearer}` }) },
    body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'message/send', params: { message: { kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'text', text }] } } }) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

test('question routing picks the right monitors and period', () => {
  const { targetsFrom, periodFrom } = require('../srv/a2a/orchestrator');
  assert.deepEqual(targetsFrom('How many IDocs failed this week?'), ['idoc']);
  assert.deepEqual(targetsFrom('Which jobs failed in the last hour?'), ['job']);
  assert.deepEqual(targetsFrom('How are my integrations and jobs today?'), ['idoc', 'job']);
  assert.deepEqual(targetsFrom('What failed today?'), ['idoc', 'job']);
  assert.equal(periodFrom('this week'), '7D'); assert.equal(periodFrom('last hour'), '1H'); assert.equal(periodFrom('this month'), '30D'); assert.equal(periodFrom('today'), '24H');
});

test('agent card is public', async () => {
  const card = await (await fetch(`${agentUrl}/.well-known/agent-card.json`)).json();
  assert.equal(card.protocolVersion, '0.3.0'); assert.equal(card.skills[0].id, 'operations_report'); assert.ok(card.securitySchemes.ias);
});

test('viewer gets a completed task with text + data', async () => {
  const { status, body } = await send(await token({ sub: 'u1', email: 'v@bearingpoint.com', groups: ['OpsMonitor_Viewer'] }));
  assert.equal(status, 200); assert.equal(body.result.status.state, 'completed');
  const parts = body.result.artifacts[0].parts; assert.equal(parts[0].kind, 'text'); assert.equal(parts[1].data.type, 'operations_report');
});

test('job-only group is accepted by the orchestrator', async () => {
  const { body } = await send(await token({ sub: 'u2', email: 'j@bearingpoint.com', groups: ['JobMonitor_Viewer'] }));
  assert.equal(body.result.status.state, 'completed');
});

test('user without any monitor group is rejected', async () => {
  const { body } = await send(await token({ sub: 'u3', email: 'n@bearingpoint.com', groups: ['Other'] }));
  assert.equal(body.result.status.state, 'rejected');
});

test('technical token rejected; wrong audience and no token get 401', async () => {
  assert.equal((await send(await token({ sub: 'client', groups: ['OpsMonitor_Viewer'] }))).body.result.status.state, 'rejected');
  assert.equal((await send(await token({ sub: 'u1', email: 'a@b.com', groups: ['OpsMonitor_Viewer'] }, 'other'))).status, 401);
  assert.equal((await send(null)).status, 401);
});
