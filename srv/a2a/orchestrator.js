// Orchestrator: answers one question by asking the two monitors and merging their answers.
//   Job Monitor  -> A2A (JSON-RPC message/send) via destination JOB_MONITOR_A2A, forwarding the caller's IAS token
//   IDoc Monitor -> its OData functions via destination IDOC_MONITOR_API (the IDoc app has no A2A endpoint yet)
// Read-only and deterministic: figures come straight from the monitors; no LLM computes them.
const { randomUUID } = require('node:crypto');
const { getDestination } = require('@sap-cloud-sdk/connectivity');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const { SOURCES, api } = require('../backends');

const PERIOD_TEXT = { '1H': 'last hour', '24H': 'last 24 hours', '7D': 'last 7 days', '30D': 'last 30 days' };
const AGENT_TIMEOUT_MS = Number(process.env.A2A_SUBAGENT_TIMEOUT_MS || 20000);

function periodFrom(question) {
  const text = String(question || '').toLowerCase();
  if (/\b(30\s*d|30\s*days?|month|monthly)\b/.test(text)) return '30D';
  if (/\b(7\s*d|7\s*days?|week|weekly)\b/.test(text)) return '7D';
  if (/\b(1\s*h|1\s*hour|last\s+hour|past\s+hour|this\s+hour)\b/.test(text)) return '1H';
  return '24H';
}

// Which monitors the question is about. Mentions of only one keep the other out of the answer.
function targetsFrom(question) {
  const text = String(question || '').toLowerCase();
  const idoc = /\bidocs?\b|\binterface|\bintegration|\bedi\b|\bmessage type/.test(text);
  const job = /\bjobs?\b|\bbatch|\bschedul|\bbackground/.test(text);
  if (idoc && !job) return ['idoc'];
  if (job && !idoc) return ['job'];
  return ['idoc', 'job'];
}

function dashboardUrl(period) {
  const base = (process.env.DASHBOARD_URL || '').replace(/\/+$/, '');
  return base ? `${base}?period=${period}` : null;
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not answer within ${Math.round(ms / 1000)} s.`)), ms); })])
    .finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------- Job Monitor via A2A
async function askJobAgent(question, callerJwt) {
  const destination = await getDestination({ destinationName: process.env.JOB_MONITOR_A2A_DESTINATION || 'JOB_MONITOR_A2A', jwt: callerJwt });
  if (!destination) throw new Error('Destination JOB_MONITOR_A2A not found.');
  const response = await executeHttpRequest(destination, {
    method: 'post',
    url: '/a2a',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    data: { jsonrpc: '2.0', id: randomUUID(), method: 'message/send', params: { message: { kind: 'message', messageId: randomUUID(), role: 'user', parts: [{ kind: 'text', text: question }] } } },
    timeout: AGENT_TIMEOUT_MS
  }, { fetchCsrfToken: false });
  const body = response.data;
  if (body.error) throw new Error(body.error.message || 'Job Monitor agent error');
  const task = body.result;
  const parts = (task.artifacts || []).flatMap((artifact) => artifact.parts || []);
  const text = parts.find((part) => part.kind === 'text')?.text || task.status?.message?.parts?.[0]?.text || '';
  const data = parts.find((part) => part.kind === 'data')?.data || null;
  return { state: task.status?.state, text, data };
}

// ---------------------------------------------------------------- IDoc Monitor via OData
async function askIdocMonitor(period) {
  const source = SOURCES.idoc;
  const [kpis, byType, topErrors, latest] = await Promise.all([
    api.kpis(source, period),
    api.categories(source, period),
    api.topErrors(source, period),
    api.list(source, 'IDocMessages', `$filter=statusGroup eq 'Error'&$orderby=lastUpdatedAt desc&$top=10&$select=idocNumber,messageType,senderPartner,receiverPartner,errorText,statusText,lastUpdatedAt`)
  ]);
  const failing = byType.filter((row) => row.error > 0).sort((a, b) => b.error - a.error).slice(0, 5);
  const lines = [
    `**${kpis.error} failed IDoc(s)** in the ${PERIOD_TEXT[period]}`,
    `- **Successful:** ${kpis.success} · **Failed:** ${kpis.error} · **Warnings:** ${kpis.warning} · **In process:** ${kpis.inProcess} · **Success rate:** ${Number(kpis.successRate).toFixed(2)}%`
  ];
  if (failing.length) lines.push(`- **Failures by message type:** ${failing.map((row) => `${row.messageType} (${row.error})`).join(', ')}`);
  if (topErrors[0]) lines.push(`- **Most frequent error:** ${topErrors[0].errorText}`);
  lines.push(`- Last Cloud ALM sync: ${kpis.lastSyncAt ? new Date(kpis.lastSyncAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'not yet run'}${kpis.lastSyncOk === false ? ' (failed)' : ''}`);
  const table = latest.length ? [
    '| IDoc | Message type | Partner | Error |', '|---|---|---|---|',
    ...latest.map((r) => `| **${r.idocNumber}** | ${r.messageType || '-'} | ${[r.senderPartner, r.receiverPartner].filter(Boolean).join(' → ') || '-'} | ${String(r.errorText || r.statusText || '-').replace(/\|/g, '/')} |`)
  ].join('\n') : '';
  return {
    state: 'completed',
    text: lines.join('\n'),
    data: { type: 'failed_idoc_report', period, counts: { total: kpis.total, success: kpis.success, error: kpis.error, warning: kpis.warning, inProcess: kpis.inProcess }, successRate: Number(kpis.successRate), topError: topErrors[0]?.errorText || null, failuresByMessageType: failing, lastSyncAt: kpis.lastSyncAt || null, hasFailures: kpis.error > 0, markdownTable: table }
  };
}

// ---------------------------------------------------------------- merge
async function orchestrate(question, caller) {
  const period = periodFrom(question);
  const targets = targetsFrom(question);
  const results = {};
  await Promise.all(targets.map(async (target) => {
    try {
      results[target] = target === 'job'
        ? await withTimeout(askJobAgent(question, caller.jwt), AGENT_TIMEOUT_MS, 'Job Monitor agent')
        : await withTimeout(askIdocMonitor(period), AGENT_TIMEOUT_MS, 'IDoc Monitor');
    } catch (error) {
      results[target] = { state: 'failed', text: `${SOURCES[target].label}: ${String(error.message).slice(0, 200)}`, data: null };
    }
  }));

  const sections = [];
  let totalFailed = 0;
  let anyOk = false;
  for (const target of targets) {
    const r = results[target];
    const label = SOURCES[target].label;
    if (r.state === 'completed' && r.data) {
      anyOk = true;
      totalFailed += r.data.counts?.error || 0;
      sections.push(`### ${label}\n${r.text}`);
    } else {
      sections.push(`### ${label}\n_${r.state === 'rejected' ? 'Not authorized: ' : 'Unavailable: '}${r.text || 'no answer'}_`);
    }
  }
  const header = targets.length > 1
    ? `**${totalFailed} failure(s) across IDocs and jobs** in the ${PERIOD_TEXT[period]}`
    : null;
  const link = dashboardUrl(period);
  const text = [header, ...sections, link ? `[Open the Operations Monitor for the ${PERIOD_TEXT[period]}](${link})` : null].filter(Boolean).join('\n\n');
  const tables = targets.map((t) => results[t].data?.markdownTable).filter(Boolean).join('\n\n');
  return {
    ok: anyOk,
    text,
    data: {
      type: 'operations_report', period, targets, totalFailed, dashboardUrl: link,
      idoc: results.idoc?.data || null, job: results.job?.data || null,
      hasFailures: totalFailed > 0, markdownTable: tables
    }
  };
}

module.exports = { orchestrate, periodFrom, targetsFrom };
