// AI resolution suggestions for one failure (IDoc or application job), via SAP AI Core.
// Same approach as the Job Failure Monitor (srv/job-failure-agent.js there): OpenAI-compatible
// chat completions on a foundation-model deployment, reached through a BTP destination with a
// technical OAuth client. Only object type, message type / job name, status and error text are sent.
const { getDestination } = require('@sap-cloud-sdk/connectivity');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

const AI_DESTINATIONS = [process.env.AI_DESTINATION, 'GENERATIVE_AI_HUB'].filter(Boolean);
const DEPLOYMENT_ID = process.env.AI_DEPLOYMENT_ID || 'd4da60fb50a82e0d';
const API_VERSION = process.env.AI_API_VERSION || '2024-10-21';
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 45000);
const CACHE_TTL_MS = Number(process.env.AI_CACHE_TTL_MS || 12 * 36e5);
const CACHE_MAX = 500;

const RULES = `Use only official SAP documentation from help.sap.com. Never invent causes, resolutions, SAP Notes, configuration activities, apps, transactions, tables, APIs or troubleshooting steps. If documentation is not available, explicitly say that no resolution steps were found in the official SAP documentation. Be short and human-readable; never provide more than two likely causes.`;

// Section layout mirrors the Job Monitor's AI Analysis tab, so both dashboards read the same.
const PROMPTS = {
  idoc: `You are an SAP S/4HANA Public Cloud integration support consultant specializing in IDoc processing (ALE/EDI), message types, partner profiles, port and logical system configuration, troubleshooting and root cause analysis.

${RULES}

Return short, human-readable Markdown using exactly these sections:

### IDoc Overview
- Message Type:
- Business Purpose:
- Direction / Partners:

## Documented Failure Causes

## Most Likely Root Causes
Description:
- Why it happens:
- How to verify:
- SAP documented resolution:
- Confidence Level:

## Recommended Investigation Steps
- List (include how to reprocess the IDoc once the cause is fixed, if documented)`,

  job: `You are an SAP S/4HANA Public Cloud Support Consultant specializing in Application Jobs, standard business processes, troubleshooting, and root cause analysis.

${RULES}

Return short, human-readable Markdown using exactly these sections:

### Job Overview
- Job Name:
- Business Purpose:
- Related SAP Application:

## Documented Failure Causes

## Most Likely Root Causes
Description:
- Why it happens:
- How to verify:
- SAP documented resolution:
- Confidence Level:

## Recommended Investigation Steps
- List`
};

const DISCLAIMER = 'The resolution steps are AI-generated from official SAP documentation. Please validate them before applying changes.';

const cache = new Map();

function cached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
  return { text: hit.value, at: new Date(hit.at).toISOString() };
}

function remember(key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  const at = Date.now();
  cache.set(key, { at, value });
  return new Date(at).toISOString();
}

function clip(value, max) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, max);
}

// The user message: only the facts of the failure, never free text from the browser.
function userMessage(failure) {
  if (failure.source === 'idoc') {
    return [
      `IDoc Number: ${clip(failure.objectId, 40)}`,
      `Message Type: ${clip(failure.category, 60)}`,
      `IDoc Type: ${clip(failure.idocType, 70) || 'unknown'}`,
      `Direction: ${clip(failure.direction, 20) || 'unknown'}`,
      `Partners: ${clip(failure.partner, 200) || 'unknown'}`,
      `Status: ${clip(failure.statusText, 300) || 'unknown'}`,
      '',
      'Error details:',
      clip(failure.errorText, 3000) || 'No error text was returned by the IDoc Monitor.'
    ].join('\n');
  }
  return [
    `Job Name: ${clip(failure.objectId, 500)}`,
    `Application: ${clip(failure.category, 200) || 'unknown'}`,
    '',
    'Error details:',
    clip(failure.errorText, 3000) || 'No error text was returned by the Job Monitor.'
  ].join('\n');
}

function property(destination, name) {
  if (destination[name]) return destination[name];
  const props = destination.originalProperties || {};
  const key = Object.keys(props).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? props[key] : undefined;
}

async function aiDestination() {
  for (const name of AI_DESTINATIONS) {
    const destination = await getDestination({ destinationName: name });
    if (destination) return destination;
  }
  const error = new Error(`AI analysis is not configured: none of the destinations ${AI_DESTINATIONS.join(', ')} was found.`);
  error.statusCode = 503;
  throw error;
}

async function complete(system, user, { http = executeHttpRequest, resolve = aiDestination, temperature = 0.1, maxTokens = 900 } = {}) {
  const destination = await resolve();
  const url = property(destination, 'AiChatPath') || `/v2/inference/deployments/${DEPLOYMENT_ID}/chat/completions?api-version=${API_VERSION}`;
  const resourceGroup = property(destination, 'AiResourceGroup') || property(destination, 'URL.headers.AI-Resource-Group') || 'default';
  try {
    const response = await http(destination, {
      method: 'post',
      url,
      headers: { 'content-type': 'application/json', 'AI-Resource-Group': resourceGroup },
      data: { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature, max_tokens: maxTokens },
      timeout: TIMEOUT_MS
    }, { fetchCsrfToken: false });
    const text = response.data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('The AI service returned no analysis text.');
    return text.trim();
  } catch (error) {
    const response = error.cause?.response || error.response;
    const detail = response?.data?.error?.message || response?.data?.message || error.message;
    const wrapped = new Error(`AI analysis is currently unavailable: ${String(detail).slice(0, 200)}`);
    wrapped.statusCode = 502;
    throw wrapped;
  }
}

/**
 * failure: { source: 'idoc'|'job', sourceKey, objectId, category, errorText, statusText, direction, partner, existingAnalysis, existingAnalyzedAt }
 * Returns { source, sourceKey, objectId, analysis, analyzedAt, disclaimer }.
 */
async function analyzeFailure(failure, { refresh = false, ...deps } = {}) {
  if (!PROMPTS[failure.source]) {
    const error = new Error(`Unsupported source '${failure.source}'. Use idoc or job.`);
    error.statusCode = 400;
    throw error;
  }
  const base = { source: failure.source, sourceKey: failure.sourceKey, objectId: failure.objectId, disclaimer: DISCLAIMER };
  // The Job Monitor stores its own AI analysis per run; reuse it so both dashboards show the same text.
  if (failure.existingAnalysis && !refresh) {
    return { ...base, analysis: failure.existingAnalysis, analyzedAt: failure.existingAnalyzedAt || null };
  }
  const key = `${failure.source}:${failure.sourceKey}`;
  if (!refresh) {
    const hit = cached(key);
    if (hit) return { ...base, analysis: hit.text, analyzedAt: hit.at };
  }
  const analysis = await complete(PROMPTS[failure.source], userMessage(failure), deps);
  const at = remember(key, analysis);
  return { ...base, analysis, analyzedAt: at };
}

module.exports = { analyzeFailure, complete, userMessage, PROMPTS, DISCLAIMER, _cache: cache };
