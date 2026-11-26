// Module classifier agent: decides which SAP module (SD, MM, PP, QM, FI, CO, TM, EWM, ...) an error
// category belongs to. Category = IDoc message type (source 'idoc') or job name (source 'job').
//
// Decision order (first hit wins):
//   1. USER  - an override saved by a support user in HANA
//   2. RULE  - the deterministic rule table below (known message types / job-name keywords)
//   3. AI    - an earlier AI decision saved in HANA
//   4. AI    - new categories are sent to SAP AI Core in one batched call; the answers are saved
// Only the category, a hint (IDoc type / job application) and one sample error text are sent to the AI.
const cds = require('@sap/cds');
const ai = require('./ai');

const ENTITY = 'ops.monitor.ModuleClassifications';

const MODULES = {
  SD: 'Sales & Distribution',
  MM: 'Materials Management',
  PP: 'Production Planning',
  QM: 'Quality Management',
  PM: 'Plant Maintenance',
  FI: 'Financial Accounting',
  CO: 'Controlling',
  TM: 'Transportation Mgmt',
  EWM: 'Warehouse Mgmt',
  LE: 'Logistics Execution',
  PS: 'Project System',
  HR: 'Human Resources',
  CROSS: 'Master Data / Cross-App',
  BASIS: 'Basis / Technical',
  UNKNOWN: 'Unassigned'
};

const AI_BATCH = 40;
const AI_MAX_BATCHES = 3;
const AI_RETRY_MS = Number(process.env.MODULE_AI_RETRY_MS || 5 * 60e3);

// ---------------------------------------------------------------- rule table
// IDoc message types (exact or prefix). Direction-dependent types (ORDERS, INVOIC, ...) get the
// usual S/4HANA meaning and a lower confidence; users can override them.
const IDOC_RULES = [
  [/^(ORDERS|ORDCHG|QUOTES|REQOTE|SALESORDER|SLSORD|COND_A|SDPACK|SDPICK)/, 'SD', 80],
  [/^INVOIC/, 'SD', 60, 'Outbound billing documents are SD; inbound supplier invoices are MM.'],
  [/^(ORDRSP|MATMAS|ARTMAS|CREMAS|INFREC|SRCLST|PORDCR|PORDCH|PREQCR|MBGMCR|GSVERF|INVCON|BATMAS|RESMAS|PUR|CONTRL)/, 'MM', 85],
  [/^(FIDCC|FIDCCP|ACC_|ACLPAY|ACLREC|GLMAST|GLROLL|GLCORE|PAYEXT|REMADV|FINSTA|EUPEXR|BANK|DIRDEB|CREADV|DEBADV|TXN|FIPAYM)/, 'FI', 90],
  [/^(COSMAS|COAMAS|COELEM|COACTV|COGRP|PRCMAS|COCOKA|COPAGN|CCMAS|CCRS)/, 'CO', 90],
  [/^(LOIPRO|LOIROU|LOIBOM|LOIPLO|LOIWCS|LOINUM|LOIMSO|LOISTD|LOIRSV|BOMMAT|PPCC|PROACT|PROD_|PRODORD|OPERA)/, 'PP', 90],
  [/^(QPMK|QCERT|QALITY|QMNOT|QINSP|QMSMAS|INSPLOT)/, 'QM', 90],
  [/^(EQUI|FUNCLOC|IORDER|PMORD|MPLAN|MAINTPLN|ALMNOT)/, 'PM', 85],
  [/^(SHPMNT|TPSDLS|TPSSHT|TPS|IFTMIN|IFTSTA|IFCSUM|TOR_|TRANSP)/, 'TM', 85],
  [/^(WMTORD|WMCATO|WMTOCO|WMSUMO|WMINVE|WMMBXY|WMBBIN|WMPHYS|WMRREF|\/SCWM\/)/, 'EWM', 85],
  [/^(DELVRY|DESADV|SHP_OBDLV|SHP_IBDLV|WHSCON|SHPCON|SHPORD|DELINS|SEQJIT)/, 'LE', 80],
  [/^(HRMD|HRCC|HRSM|HR_)/, 'HR', 90],
  [/^(PROJECT|PROJ|WBS)/, 'PS', 85],
  [/^(DEBMAS|ADRMAS|ADR2MAS|ADR3MAS|CLFMAS|CHRMAS|CLSMAS|BUPA|COND_|CURRAT|EXCHRT|UNIT)/, 'CROSS', 80],
  [/^(ALEAUD|SYNCH|STATUS|TXTRAW|SYSTAT|ALEREQ|USERCLONE)/, 'BASIS', 90]
];

// Job names (keywords, checked in order; the first match wins).
const JOB_RULES = [
  // Intelligent Scenario Lifecycle Management (ISLM) turnkey jobs deploy AI scenarios: technical, no business module.
  [/intelligent scenario|turnkey schedule|\bislm\b/, 'BASIS', 90],
  [/material ledger|actual costing/, 'CO', 85],
  // German job names (S/4HANA Cloud tenants often run with DE job templates).
  [/faktura|fakturierung|kundenauftrag|verkauf/, 'SD', 80],
  [/wertminderung|zahlungs|zahllauf|mahnung|mahnlauf|abschreibung|anlagen|hauptbuch|bankauszug|ausgleich|umbewertung|steuer/, 'FI', 80],
  [/bestellung|beschaffung|lieferant|wareneingang|bestand|material/, 'MM', 75],
  [/fertigungsauftrag|prozessauftrag|bedarfsplanung|disposition|planauftrag/, 'PP', 80],
  [/prüflos|qualit/, 'QM', 85],
  [/kostenstelle|abrechnung|umlage|gemeinkosten/, 'CO', 75],
  [/settlement management|condition contract|rebate/, 'SD', 80],
  [/dunning|payment (run|program|proposal)|automatic payment|foreign currency|fx valuation|revaluation|reconcil|clearing|depreciation|\bassets?\b|g\/l|general ledger|bank statement|accrual|balance carry|carry forward|\btax|journal entr|universal journal|intercompany|open item|credit memo request|cash management|liquidity/, 'FI', 80],
  [/settlement|cost center|overhead|allocation|assessment|wip\b|work in process|variance|costing|profit center|results analysis|co-pa|margin analysis/, 'CO', 80],
  [/\bmrp\b|material requirements|planned order|production order|process order|backflush|capacity|ddmrp|demand-driven|kanban|production|manufactur/, 'PP', 80],
  [/inspection|quality|\bqm\b|usage decision/, 'QM', 85],
  [/maintenance|equipment|functional location|\bpm\b/, 'PM', 80],
  [/freight|transportation|carrier|\btm\b|shipment cost/, 'TM', 85],
  [/warehouse|\bewm\b|\bwave|picking|putaway|put-away|replenishment|handling unit/, 'EWM', 80],
  [/billing|sales|order fulfil|customer|pricing|credit management|output.*(sales|billing)/, 'SD', 75],
  [/delivery|deliveries|shipping|goods issue/, 'LE', 75],
  [/purchas|procure|supplier|vendor|goods receipt|gr\/ir|inventory|stock|material|batch|reservation|consignment|scheduling agreement|requisition|source of supply|invoice verification/, 'MM', 75],
  [/project|\bwbs\b/, 'PS', 80],
  [/payroll|employee|time evaluation|personnel/, 'HR', 85],
  [/business partner|master data|replicat|classification/, 'CROSS', 70],
  [/archiv|reorg|spool|application log|clean ?up|cleanup|deletion|delete|data aging|housekeeping/, 'BASIS', 75]
];

// SAP application component prefix (FI-GL, SD-BIL, MM-PUR, ...) in the job's application field.
const COMPONENT_PREFIX = { FI: 'FI', CO: 'CO', SD: 'SD', MM: 'MM', PP: 'PP', QM: 'QM', PM: 'PM', EAM: 'PM', TM: 'TM', EWM: 'EWM', SCM: 'EWM', WM: 'EWM', LE: 'LE', PS: 'PS', HR: 'HR', PA: 'HR', PY: 'HR', BC: 'BASIS', CA: 'CROSS', LO: 'CROSS', FIN: 'FI', PUR: 'MM' };

function clip(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, max);
}

function result(module, confidence, classifiedBy, reason, extra = {}) {
  const key = MODULES[module] ? module : 'UNKNOWN';
  return { module: key, moduleText: MODULES[key], confidence, classifiedBy, reason: reason || null, ...extra };
}

/** IDoc rule-table match for a message type or basic type (incl. Z/Y-prefixed custom names). */
function idocRule(upper, label) {
  for (const [pattern, module, confidence, reason] of IDOC_RULES) {
    if (pattern.test(upper)) return result(module, confidence, 'RULE', reason || `${label} ${upper} belongs to ${MODULES[module]}.`);
  }
  // Customer-specific names often keep the standard name after a Z/Y prefix (ZORDERS, YMATMAS).
  if (/^[ZY]/.test(upper) && upper.length > 4) {
    const inner = idocRule(upper.slice(1).replace(/^_/, ''), label);
    if (inner) return { ...inner, confidence: Math.min(inner.confidence, 65), reason: `Custom ${label.toLowerCase()} based on ${upper.slice(1)}. ${inner.reason}` };
  }
  return null;
}

/** Rule-table decision for one category, or null when no rule applies. */
function byRule(source, category, hint) {
  const value = String(category || '').trim();
  if (!value) return null;
  if (source === 'idoc') {
    const upper = value.toUpperCase();
    const direct = idocRule(upper, 'Message type');
    if (direct) return direct;
    // Custom or placeholder message types (ZZZZZ, ZVENDOR, ...) still carry a standard basic type
    // (CREMAS06, ORDERS05, ...) that tells the module.
    const basicType = String(hint || '').trim().toUpperCase();
    if (basicType && basicType !== upper) {
      const byType = idocRule(basicType, 'IDoc basic type');
      if (byType) return { ...byType, confidence: Math.min(byType.confidence, 80), reason: `Message type ${upper} is custom; ${byType.reason}` };
    }
    return null;
  }
  const component = /^([A-Z]{2,4})(?:[-_ ]|$)/.exec(String(hint || '').trim().toUpperCase());
  if (component && COMPONENT_PREFIX[component[1]]) {
    const module = COMPONENT_PREFIX[component[1]];
    return result(module, 90, 'RULE', `Application component ${hint} belongs to ${MODULES[module]}.`);
  }
  const lower = value.toLowerCase();
  for (const [pattern, module, confidence] of JOB_RULES) {
    if (pattern.test(lower)) return result(module, confidence, 'RULE', `Job name matches the ${MODULES[module]} keyword "${lower.match(pattern)[0]}".`);
  }
  return null;
}

// ---------------------------------------------------------------- persistence
async function db() {
  try { return await cds.connect.to('db'); } catch { return null; }
}

const keyOf = (source, category) => `${source}|${category}`;

async function storedRows(items) {
  const database = await db();
  if (!database || !items.length) return new Map();
  try {
    const rows = [];
    for (const source of ['idoc', 'job']) {
      const categories = [...new Set(items.filter((i) => i.source === source).map((i) => i.category))];
      for (let i = 0; i < categories.length; i += 200) {
        const chunk = categories.slice(i, i + 200);
        if (chunk.length) rows.push(...(await database.run(SELECT.from(ENTITY).where({ source, category: { in: chunk } }))));
      }
    }
    return new Map(rows.map((row) => [keyOf(row.source, row.category), row]));
  } catch (error) {
    console.warn(JSON.stringify({ event: 'module-classifier-db-read-failed', error: String(error.message).slice(0, 200) }));
    return new Map();
  }
}

async function upsert(row) {
  const database = await db();
  if (!database) return;
  await database.run(DELETE.from(ENTITY).where({ source: row.source, category: row.category }));
  await database.run(INSERT.into(ENTITY).entries(row));
}

// ---------------------------------------------------------------- AI
const SYSTEM_PROMPT = `You are an SAP S/4HANA Public Cloud solution architect. Classify each error category into exactly one SAP module.
Allowed module codes: ${Object.entries(MODULES).map(([code, text]) => `${code} (${text})`).join(', ')}.
Category is either an IDoc message type (source "idoc") or an application job name (source "job").
For IDocs the hint is the IDoc basic type (e.g. CREMAS06 = supplier master, ORDERS05 = orders); when the message type is a custom or placeholder name, classify by the basic type.
Job names may be in German or English; translate them mentally before classifying.
Technical jobs with no business module (Intelligent Scenario Lifecycle Management / "Turnkey schedule for the intelligent scenario", AI/ML scenario deployment, application log, archiving, data aging, cleanup, spool, monitoring) are BASIS, not UNKNOWN.
Use UNKNOWN only when neither the name, the hint nor the sample error indicates a module (e.g. placeholder or test names like "ZZZZZ" without a known basic type). Do not invent modules.
Answer with JSON only, no Markdown, no prose: an array of objects {"id": <number>, "module": "<code>", "confidence": <0-100>, "reason": "<max 20 words>"} with one entry per input id.`;

function parseAiAnswer(text) {
  const raw = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('AI answer contains no JSON array.');
  const parsed = JSON.parse(raw.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('AI answer is not an array.');
  return parsed.map((entry) => {
    const module = String(entry?.module || '').toUpperCase().replace(/[^A-Z]/g, '');
    const confidence = Math.max(0, Math.min(100, Math.round(Number(entry?.confidence) || 0)));
    return { id: Number(entry?.id), module: MODULES[module] ? module : 'UNKNOWN', confidence, reason: clip(entry?.reason, 300) };
  });
}

let aiBlockedUntil = 0;
const inFlight = new Map();

async function askAi(items, deps = {}) {
  const complete = deps.complete || ai.complete;
  const answers = new Map();
  for (let b = 0; b < Math.min(Math.ceil(items.length / AI_BATCH), AI_MAX_BATCHES); b++) {
    const batch = items.slice(b * AI_BATCH, (b + 1) * AI_BATCH);
    const user = JSON.stringify(batch.map((item, index) => ({
      id: index,
      source: item.source,
      category: clip(item.category, 200),
      hint: clip(item.hint, 120) || undefined,
      sampleError: clip(item.sampleError, 300) || undefined
    })));
    const text = await complete(SYSTEM_PROMPT, user, { temperature: 0, maxTokens: 2500, ...(deps.http && { http: deps.http }), ...(deps.resolve && { resolve: deps.resolve }) });
    for (const answer of parseAiAnswer(text)) {
      const item = batch[answer.id];
      if (item) answers.set(keyOf(item.source, item.category), answer);
    }
  }
  return answers;
}

/**
 * Classifies categories. items: [{ source, category, hint?, sampleError? }]
 * Returns Map 'source|category' -> { module, moduleText, confidence, classifiedBy, reason, modifiedBy, modifiedAt }.
 * options.useAi = false never calls the AI (unknown categories become UNKNOWN / NONE).
 */
async function classify(items, { useAi = true, actor = 'system', ...deps } = {}) {
  const unique = new Map();
  for (const item of items || []) {
    const category = clip(item.category, 500);
    if (!category || (item.source !== 'idoc' && item.source !== 'job')) continue;
    const key = keyOf(item.source, category);
    const existing = unique.get(key);
    if (!existing) unique.set(key, { ...item, category });
    else {
      if (!existing.sampleError && item.sampleError) existing.sampleError = item.sampleError;
      if (!existing.hint && item.hint) existing.hint = item.hint;
    }
  }
  const stored = await storedRows([...unique.values()]);
  const out = new Map();
  const pending = [];

  for (const [key, item] of unique) {
    const row = stored.get(key);
    const meta = row ? { modifiedBy: row.modifiedBy, modifiedAt: row.modifiedAt } : {};
    if (row?.classifiedBy === 'USER') { out.set(key, result(row.module, 100, 'USER', row.reason || 'Set manually.', meta)); continue; }
    const rule = byRule(item.source, item.category, item.hint);
    if (rule) { out.set(key, rule); continue; }
    if (row?.classifiedBy === 'AI') { out.set(key, result(row.module, row.confidence, 'AI', row.reason, meta)); continue; }
    pending.push(item);
  }

  if (pending.length && useAi && Date.now() >= aiBlockedUntil) {
    const todo = pending.filter((item) => !inFlight.has(keyOf(item.source, item.category)));
    if (todo.length) {
      const run = askAi(todo, deps);
      for (const item of todo) inFlight.set(keyOf(item.source, item.category), run);
      try {
        const answers = await run;
        const now = new Date().toISOString();
        for (const item of todo) {
          const key = keyOf(item.source, item.category);
          const answer = answers.get(key);
          if (!answer) continue;
          const row = { source: item.source, category: item.category, module: answer.module, confidence: answer.confidence, reason: answer.reason, classifiedBy: 'AI', modifiedBy: clip(actor, 120) || 'system', modifiedAt: now };
          await upsert(row).catch((error) => console.warn(JSON.stringify({ event: 'module-classifier-db-write-failed', error: String(error.message).slice(0, 200) })));
          out.set(key, result(row.module, row.confidence, 'AI', row.reason, { modifiedBy: row.modifiedBy, modifiedAt: now }));
        }
        console.log(JSON.stringify({ event: 'module-classifier-ai', requested: todo.length, answered: answers.size }));
      } catch (error) {
        aiBlockedUntil = Date.now() + AI_RETRY_MS;
        console.warn(JSON.stringify({ event: 'module-classifier-ai-failed', error: String(error.message).slice(0, 300) }));
      } finally {
        for (const item of todo) inFlight.delete(keyOf(item.source, item.category));
      }
    }
    // Categories another request is classifying right now: wait for that answer.
    for (const item of pending) {
      const key = keyOf(item.source, item.category);
      if (out.has(key) || !inFlight.has(key)) continue;
      try {
        const answer = (await inFlight.get(key)).get(key);
        if (answer) out.set(key, result(answer.module, answer.confidence, 'AI', answer.reason));
      } catch { /* handled by the request that started the call */ }
    }
  }

  for (const item of pending) {
    const key = keyOf(item.source, item.category);
    if (!out.has(key)) out.set(key, result('UNKNOWN', 0, 'NONE', useAi ? 'Not classified yet (AI unavailable).' : 'Not classified yet.'));
  }
  return out;
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

/** User override. module '' or 'AUTO' removes the override (rules / AI apply again). */
async function setOverride(request, { source, category, module }) {
  const src = String(source || '').toLowerCase();
  if (src !== 'idoc' && src !== 'job') throw badRequest(`Unsupported source '${source}'. Use idoc or job.`);
  const value = clip(category, 500);
  if (!value) throw badRequest('A category is required.');
  const code = String(module || '').toUpperCase();
  const database = await db();
  if (!database) throw Object.assign(new Error('Database not available.'), { statusCode: 503 });
  if (!code || code === 'AUTO') {
    await database.run(DELETE.from(ENTITY).where({ source: src, category: value, classifiedBy: 'USER' }));
  } else {
    if (!MODULES[code]) throw badRequest(`Unknown module '${module}'. Use one of ${Object.keys(MODULES).join(', ')}.`);
    await upsert({ source: src, category: value, module: code, confidence: 100, reason: 'Set manually.', classifiedBy: 'USER', modifiedBy: clip(request?.user?.id, 120) || 'unknown', modifiedAt: new Date().toISOString() });
  }
  return (await classify([{ source: src, category: value }], { useAi: false })).get(keyOf(src, value));
}

/** Forgets all AI decisions so the next breakdown asks the AI again. User overrides are kept. */
async function resetAi() {
  const database = await db();
  if (!database) return 0;
  aiBlockedUntil = 0;
  const count = await database.run(DELETE.from(ENTITY).where({ classifiedBy: 'AI' }));
  return Number(count) || 0;
}

module.exports = { MODULES, ENTITY, byRule, classify, setOverride, resetAi, parseAiAnswer, keyOf, _reset: () => { aiBlockedUntil = 0; inFlight.clear(); } };
