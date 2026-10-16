const { randomUUID } = require('node:crypto');
const { DefaultRequestHandler, InMemoryTaskStore } = require('@a2a-js/sdk/server');
const { agentCardHandler, jsonRpcHandler } = require('@a2a-js/sdk/server/express');
const { iasAuthMiddleware, userBuilder, isAuthorized, issuer, REQUIRED_GROUPS } = require('./auth');
const { orchestrate } = require('./orchestrator');

const A2A_PATH = '/a2a';
const CARD_PATH = '/.well-known/agent-card.json';
const TIMEOUT_MS = Number(process.env.A2A_REPORT_TIMEOUT_MS || 55000);

function publicBaseUrl() {
  if (process.env.A2A_PUBLIC_URL) return process.env.A2A_PUBLIC_URL.replace(/\/+$/, '');
  try {
    const uris = JSON.parse(process.env.VCAP_APPLICATION || '{}').application_uris || [];
    const publicUri = uris.find((uri) => !uri.endsWith('.apps.internal'));
    if (publicUri) return `https://${publicUri}`;
  } catch { /* local default */ }
  return `http://localhost:${process.env.PORT || 4004}`;
}

function buildAgentCard() {
  const url = `${publicBaseUrl()}${A2A_PATH}`;
  const card = {
    name: 'Operations Monitor Agent',
    description: 'Orchestrator over the IDoc Monitor and the Job Failure Monitor (SAP Cloud ALM). Answers questions about failed IDocs and failed application jobs by asking both monitors and merging the results. Read-only and deterministic; figures match the Operations Monitor dashboard.',
    version: '1.0.0',
    protocolVersion: '0.3.0',
    url,
    preferredTransport: 'JSONRPC',
    additionalInterfaces: [{ url, transport: 'JSONRPC' }],
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [{
      id: 'operations_report',
      name: 'Operations report',
      description: 'Combined IDoc and job failure report for the last hour, 24 hours, 7 days or 30 days. Ask about IDocs only, jobs only, or both.',
      tags: ['idoc', 'jobs', 'integration', 'batch', 'Cloud ALM', 'orchestrator'],
      examples: ['How are my integrations and jobs today?', 'How many IDocs failed this week?', 'Which jobs failed in the last hour?']
    }]
  };
  if (issuer) {
    card.securitySchemes = { ias: { type: 'openIdConnect', openIdConnectUrl: `${issuer}/.well-known/openid-configuration` } };
    card.security = [{ ias: [] }];
  }
  return card;
}

class OrchestratorExecutor {
  constructor({ run = orchestrate } = {}) { this.run = run; }

  async execute(requestContext, eventBus) {
    const { taskId, contextId, userMessage, task } = requestContext;
    const status = (state, text, final) => ({
      kind: 'status-update', taskId, contextId, final,
      status: { state, timestamp: new Date().toISOString(), ...(text && { message: { kind: 'message', messageId: randomUUID(), role: 'agent', taskId, contextId, parts: [{ kind: 'text', text }] } }) }
    });
    const textArtifact = (name, text) => ({ kind: 'artifact-update', taskId, contextId, lastChunk: true, artifact: { artifactId: randomUUID(), name, parts: [{ kind: 'text', text }] } });
    try {
      if (!task) eventBus.publish({ kind: 'task', id: taskId, contextId, status: { state: 'submitted', timestamp: new Date().toISOString() }, history: [userMessage] });
      const caller = requestContext.context?.user;
      if (!isAuthorized(caller)) {
        const text = `You are not authorized to view operations data. Ask your administrator to add you to one of the IAS groups: ${REQUIRED_GROUPS.join(', ')}.`;
        eventBus.publish(textArtifact('operations_report_error', text));
        eventBus.publish(status('rejected', text, true));
        return;
      }
      eventBus.publish(status('working', null, false));
      const question = (userMessage?.parts || []).filter((p) => p.kind === 'text').map((p) => p.text).join('\n');
      let timer;
      const report = await Promise.race([
        this.run(question, caller),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The monitors did not answer in time.')), TIMEOUT_MS); })
      ]).finally(() => clearTimeout(timer));
      console.log(JSON.stringify({ event: 'a2a-orchestration-complete', taskId, targets: report.data.targets, totalFailed: report.data.totalFailed, ok: report.ok }));
      eventBus.publish({ kind: 'artifact-update', taskId, contextId, lastChunk: true, artifact: { artifactId: randomUUID(), name: 'operations_report', parts: [{ kind: 'text', text: report.text }, { kind: 'data', data: report.data }] } });
      eventBus.publish(status(report.ok ? 'completed' : 'failed', report.ok ? null : report.text, true));
    } catch (error) {
      console.error(JSON.stringify({ event: 'a2a-orchestration-failed', taskId, error: String(error.message).slice(0, 300) }));
      const text = `Could not load the operations report: ${String(error.message).slice(0, 300)}`;
      eventBus.publish(textArtifact('operations_report_error', text));
      eventBus.publish(status('failed', text, true));
    } finally {
      eventBus.finished();
    }
  }

  async cancelTask(taskId, eventBus) {
    eventBus.publish({ kind: 'status-update', taskId, contextId: taskId, final: true, status: { state: 'canceled', timestamp: new Date().toISOString() } });
    eventBus.finished();
  }
}

function mountA2A(app, { run } = {}) {
  const card = buildAgentCard();
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new OrchestratorExecutor({ run }));
  app.use(CARD_PATH, agentCardHandler({ agentCardProvider: handler }));
  app.use(A2A_PATH, iasAuthMiddleware, jsonRpcHandler({ requestHandler: handler, userBuilder }));
  return card;
}

module.exports = { mountA2A, buildAgentCard, A2A_PATH, CARD_PATH };
