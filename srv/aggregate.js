// Deterministic aggregation over the two monitors. Every figure is the sum of what the monitors
// return for the same period; nothing is estimated. The only LLM use is the module classifier, which
// assigns a category to an SAP module; it never changes a count.
const { SOURCES, SourceError, api } = require('./backends');
const classifier = require('./module-classifier');

const PERIODS = ['1H', '24H', '7D', '30D'];

// Blank or placeholder IDoc message types (e.g. "ZZZZZ", "XXXX", "(none)") say nothing to the user;
// the dashboard shows the IDoc basic type (CREMAS06, ...) instead. The real message type stays the key.
function isPlaceholderMessageType(value) {
  const v = String(value || '').trim().toUpperCase();
  return !v || v === '(NONE)' || /^(.)\1+$/.test(v);
}

function idocDisplayName(messageType, idocType) {
  return isPlaceholderMessageType(messageType) && idocType ? String(idocType).trim() : (String(messageType || '').trim() || '(none)');
}

// Basic type per placeholder message type, read only when such a message type occurs.
async function placeholderBasicTypes(period, messageTypes) {
  const wanted = new Set(messageTypes.filter(isPlaceholderMessageType).map((m) => String(m || '').trim()));
  const out = new Map();
  if (!wanted.size) return out;
  try {
    const since = new Date(Date.now() - PERIOD_MS[period]).toISOString();
    const rows = await api.list(SOURCES.idoc, 'IDocMessages', `$filter=lastUpdatedAt ge ${since}&$orderby=lastUpdatedAt desc&$top=500&$select=messageType,idocType`);
    for (const r of rows) {
      const m = String(r.messageType || '').trim();
      if (wanted.has(m) && r.idocType && !out.has(m)) out.set(m, r.idocType);
    }
  } catch (error) {
    console.warn(JSON.stringify({ event: 'idoc-basic-types-failed', error: String(error.message).slice(0, 200) }));
  }
  return out;
}

function normalizePeriod(period) {
  const value = String(period || '24H').toUpperCase();
  if (!PERIODS.includes(value)) {
    const error = new Error(`Unsupported period '${period}'. Use one of ${PERIODS.join(', ')}.`);
    error.statusCode = 400;
    throw error;
  }
  return value;
}

// Runs one request per source in parallel; a failing source becomes { error } instead of failing all.
async function perSource(fnBySource) {
  const entries = await Promise.all(Object.values(SOURCES).map(async (source) => {
    try {
      return [source.key, { ok: true, value: await fnBySource(source) }];
    } catch (error) {
      const status = error instanceof SourceError ? error.status : 503;
      return [source.key, { ok: false, error: error.message, status }];
    }
  }));
  return Object.fromEntries(entries);
}

const zero = () => ({ total: 0, success: 0, error: 0, warning: 0, inProcess: 0 });

function sourceStatus(source, result, kpi) {
  return {
    source: source.key,
    label: source.label,
    available: result.ok,
    message: result.ok ? null : result.error,
    lastSyncAt: kpi?.lastSyncAt || null,
    lastSyncOk: kpi?.lastSyncOk ?? null,
    lastSyncInfo: kpi?.lastSyncInfo || null,
    dashboardUrl: source.dashboard,
    counts: kpi ? { total: kpi.total, success: kpi.success, error: kpi.error, warning: kpi.warning, inProcess: kpi.inProcess, successRate: Number(kpi.successRate) } : zero()
  };
}

async function overview(period) {
  const p = normalizePeriod(period);
  const results = await perSource((source) => api.kpis(source, p));
  const sources = Object.values(SOURCES).map((source) => sourceStatus(source, results[source.key], results[source.key].ok ? results[source.key].value : null));
  const totals = zero();
  for (const status of sources) for (const key of Object.keys(totals)) totals[key] += status.counts[key] || 0;
  const finished = totals.success + totals.error + totals.warning;
  return {
    period: p,
    asOf: new Date().toISOString(),
    ...totals,
    successRate: finished ? Math.round((totals.success / finished) * 10000) / 100 : 100,
    idocErrors: sources.find((s) => s.source === 'idoc').counts.error,
    jobErrors: sources.find((s) => s.source === 'job').counts.error,
    sources
  };
}

// Both monitors use the same bucket keys (day / hour / 10 min, UTC), so points merge by key.
async function trend(period) {
  const p = normalizePeriod(period);
  const results = await perSource((source) => api.trend(source, p));
  const buckets = new Map();
  for (const source of Object.values(SOURCES)) {
    if (!results[source.key].ok) continue;
    for (const point of results[source.key].value) {
      const entry = buckets.get(point.bucket) || { bucket: point.bucket, idocError: 0, jobError: 0, idocSuccess: 0, jobSuccess: 0, idocWarning: 0, jobWarning: 0 };
      entry[`${source.key}Error`] += point.error || 0;
      entry[`${source.key}Success`] += point.success || 0;
      entry[`${source.key}Warning`] += point.warning || 0;
      buckets.set(point.bucket, entry);
    }
  }
  return [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
}

// Failures by category: IDoc message type and job name side by side, failures first.
async function categories(period) {
  const p = normalizePeriod(period);
  const results = await perSource((source) => api.categories(source, p));
  const rows = [];
  for (const source of Object.values(SOURCES)) {
    if (!results[source.key].ok) continue;
    for (const row of results[source.key].value) {
      rows.push({ source: source.key, sourceLabel: source.label, category: row[source.categoryField] || '(none)', success: row.success || 0, error: row.error || 0, warning: row.warning || 0, inProcess: row.inProcess || 0, total: row.total || 0 });
    }
  }
  const top = rows.sort((a, b) => b.error - a.error || b.total - a.total || a.category.localeCompare(b.category)).slice(0, 15);
  await addIdocDisplayNames(p, top);
  return top;
}

async function addIdocDisplayNames(period, rows) {
  const basic = await placeholderBasicTypes(period, rows.filter((r) => r.source === 'idoc').map((r) => r.category));
  for (const r of rows) r.displayCategory = r.source === 'idoc' ? idocDisplayName(r.category, basic.get(String(r.category || '').trim())) : r.category;
  return rows;
}

async function topErrors(period) {
  const p = normalizePeriod(period);
  const results = await perSource((source) => api.topErrors(source, p));
  const rows = [];
  for (const source of Object.values(SOURCES)) {
    if (!results[source.key].ok) continue;
    for (const row of results[source.key].value) {
      rows.push({ source: source.key, sourceLabel: source.label, category: row.messageType || row.jobName || '(none)', errorText: row.errorText || '(no message)', count: row.count || 0 });
    }
  }
  return addIdocDisplayNames(p, rows.sort((a, b) => b.count - a.count || a.errorText.localeCompare(b.errorText)).slice(0, 15));
}

const PERIOD_MS = { '1H': 36e5, '24H': 864e5, '7D': 7 * 864e5, '30D': 30 * 864e5 };

// One failure list across both monitors (newest first). Each row links to its original object page.
async function failures(period, top = 50) {
  const p = normalizePeriod(period);
  const since = new Date(Date.now() - PERIOD_MS[p]).toISOString();
  const limit = Math.min(Math.max(Number(top) || 50, 1), 200);
  const results = await perSource(async (source) => {
    if (source.key === 'idoc') {
      const rows = await api.list(source, 'IDocMessages', `$filter=statusGroup eq 'Error' and lastUpdatedAt ge ${since}&$orderby=lastUpdatedAt desc&$top=${limit}&$select=ID,idocNumber,messageType,idocType,direction,serviceName,statusText,errorText,lastUpdatedAt,senderPartner,receiverPartner`);
      return rows.map((r) => ({
        source: 'idoc', sourceLabel: 'IDoc Monitor', sourceKey: String(r.ID), objectId: r.idocNumber, category: r.messageType, displayCategory: idocDisplayName(r.messageType, r.idocType), idocType: r.idocType, system: r.serviceName,
        state: 'Error', statusText: r.statusText, errorText: r.errorText || r.statusText, partner: [r.senderPartner, r.receiverPartner].filter(Boolean).join(' → '),
        occurredAt: r.lastUpdatedAt, detailUrl: `${source.dashboard}#/IDocMessages(${r.ID})`
      }));
    }
    const rows = await api.list(source, 'JobRuns', `$filter=statusGroup eq 'Error' and startedAt ge ${since}&$orderby=startedAt desc&$top=${limit}&$select=sourceRunKey,jobName,application,system,errorText,schedulerName,startedAt`);
    return rows.map((r) => ({
      source: 'job', sourceLabel: 'Job Monitor', sourceKey: r.sourceRunKey, objectId: r.jobName, category: r.application, displayCategory: r.application, system: r.system,
      state: 'Error', statusText: 'Failed', errorText: r.errorText, partner: r.schedulerName || '',
      occurredAt: r.startedAt, detailUrl: `${source.dashboard}#/JobRuns('${encodeURIComponent(r.sourceRunKey)}')`
    }));
  });
  const rows = [];
  const unavailable = [];
  for (const source of Object.values(SOURCES)) {
    if (results[source.key].ok) rows.push(...results[source.key].value); else unavailable.push({ source: source.key, message: results[source.key].error });
  }
  rows.sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
  return { period: p, rows: rows.slice(0, limit), unavailable };
}

// Failure list for the dashboard, each row with its SAP module. The AI is not called here (the list
// must stay fast); new categories are classified by getModuleBreakdown, which the dashboard loads too.
async function failuresWithModules(period, top) {
  const list = await failures(period, top);
  await withModules(list.rows, { useAi: false }).catch((error) => console.warn(JSON.stringify({ event: 'module-classification-failed', error: String(error.message).slice(0, 200) })));
  return list;
}

// Reads one failure from its monitor *as the calling user*, so AI analysis is only possible for
// records the user may see, and the text sent to the AI comes from the monitor, not the browser.
const IDOC_KEY = /^[0-9a-fA-F-]{1,64}$/;
const JOB_KEY = /^[\w.:\-/|#]{1,200}$/;

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function notFound(message) {
  const error = new Error(message);
  error.statusCode = 404;
  return error;
}

// The IDoc status records carry the real error text (message class/number); they are the closest
// equivalent of the Job Monitor's job log, so they are added to the AI input when readable.
async function idocStatusText(id, fallback) {
  try {
    const records = await api.list(SOURCES.idoc, 'StatusRecords', `$filter=idoc_ID eq ${id}&$orderby=sequenceNo&$top=20&$select=sequenceNo,status,statusText,message,severity,messageClass,messageNumber`);
    const lines = records
      .filter((record) => record.message || record.statusText)
      .map((record) => `[${record.sequenceNo || ''} ${record.status || ''}] ${[record.message || record.statusText, record.messageClass && record.messageNumber ? `(${record.messageClass} ${record.messageNumber})` : ''].filter(Boolean).join(' ')}`);
    return lines.length ? lines.join('\n').slice(0, 3000) : fallback;
  } catch {
    return fallback;
  }
}

async function failureByKey(sourceKey, key) {
  if (sourceKey === 'idoc') {
    if (!IDOC_KEY.test(String(key || ''))) throw badRequest('Invalid IDoc key.');
    const rows = await api.list(SOURCES.idoc, 'IDocMessages', `$filter=ID eq ${key}&$top=1&$select=ID,idocNumber,messageType,idocType,direction,status,statusText,statusMessage,errorText,senderPartner,receiverPartner,serviceName`);
    const r = rows[0];
    if (!r) throw notFound('IDoc not found or not visible for your user.');
    const fallback = r.errorText || r.statusMessage || r.statusText;
    return {
      source: 'idoc', sourceKey: String(r.ID), objectId: r.idocNumber, category: r.messageType, idocType: r.idocType, direction: r.direction,
      system: r.serviceName,
      statusText: [r.status, r.statusText].filter(Boolean).join(' '), errorText: await idocStatusText(r.ID, fallback),
      partner: [r.senderPartner, r.receiverPartner].filter(Boolean).join(' → ')
    };
  }
  if (sourceKey === 'job') {
    if (!JOB_KEY.test(String(key || ''))) throw badRequest('Invalid job run key.');
    const literal = `'${String(key).replace(/'/g, "''")}'`;
    const rows = await api.list(SOURCES.job, 'JobRuns', `$filter=sourceRunKey eq ${encodeURIComponent(literal)}&$top=1&$select=sourceRunKey,jobName,application,system,errorText,aiAnalysis,aiAnalyzedAt`);
    const r = rows[0];
    if (!r) throw notFound('Job run not found or not visible for your user.');
    return { source: 'job', sourceKey: r.sourceRunKey, objectId: r.jobName, category: r.application, system: r.system, errorText: r.errorText, existingAnalysis: r.aiAnalysis || null, existingAnalyzedAt: r.aiAnalyzedAt || null };
  }
  throw badRequest(`Unsupported source '${sourceKey}'. Use idoc or job.`);
}

// ---------------------------------------------------------------- SAP module breakdown
// Module key of a failure row: IDoc message type, or the job name (the Job Monitor's category axis);
// the job's application field is only a hint for the classifier.
function moduleItem(row) {
  return row.source === 'idoc'
    ? { source: 'idoc', category: row.category, hint: row.idocType, sampleError: row.errorText }
    : { source: 'job', category: row.objectId, hint: row.category, sampleError: row.errorText };
}

/** Adds module, moduleText, moduleBy, moduleConfidence to failure rows (in place). */
async function withModules(rows, options = {}) {
  const map = await classifier.classify(rows.map(moduleItem), options);
  for (const row of rows) {
    const item = moduleItem(row);
    const c = map.get(classifier.keyOf(item.source, String(item.category || '').trim())) || { module: 'UNKNOWN', moduleText: classifier.MODULES.UNKNOWN, classifiedBy: 'NONE', confidence: 0 };
    Object.assign(row, { module: c.module, moduleText: c.moduleText, moduleBy: c.classifiedBy, moduleConfidence: c.confidence });
  }
  return rows;
}

/**
 * Errors per SAP module and source. Counts come from the monitors' category functions (all failures of
 * the period, not just the latest rows); the failure list adds job application hints and sample errors.
 */
async function moduleBreakdown(period, options = {}) {
  const p = normalizePeriod(period);
  const [results, list] = await Promise.all([
    perSource((source) => api.categories(source, p)),
    failures(p, 200).catch(() => ({ rows: [], unavailable: [] }))
  ]);
  const samples = new Map();
  for (const row of list.rows) {
    const item = moduleItem(row);
    const key = classifier.keyOf(item.source, String(item.category || '').trim());
    if (!samples.has(key)) samples.set(key, item);
  }
  const stats = [];
  const unavailable = [];
  for (const source of Object.values(SOURCES)) {
    if (!results[source.key].ok) { unavailable.push({ source: source.key, message: results[source.key].error }); continue; }
    for (const row of results[source.key].value) {
      const error = row.error || 0;
      if (!error) continue;
      const category = String(row[source.categoryField] || '').trim() || '(none)';
      stats.push({ source: source.key, category, error, warning: row.warning || 0 });
    }
  }
  // The failure list is capped (jobs can push IDocs out), so read the IDoc basic type per message type
  // directly: it identifies the module for custom/placeholder message types (ZZZZZ + CREMAS06 -> MM).
  const missing = stats.filter((s) => s.source === 'idoc' && !samples.get(classifier.keyOf('idoc', s.category))?.hint).map((s) => s.category);
  if (missing.length && results.idoc?.ok) {
    try {
      const since = new Date(Date.now() - PERIOD_MS[p]).toISOString();
      const rows = await api.list(SOURCES.idoc, 'IDocMessages', `$filter=statusGroup eq 'Error' and lastUpdatedAt ge ${since}&$orderby=lastUpdatedAt desc&$top=500&$select=messageType,idocType,errorText`);
      for (const r of rows) {
        const key = classifier.keyOf('idoc', String(r.messageType || '').trim());
        const current = samples.get(key);
        if (r.idocType && !current?.hint) samples.set(key, { source: 'idoc', category: r.messageType, hint: r.idocType, sampleError: current?.sampleError || r.errorText });
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: 'module-idoc-types-failed', error: String(error.message).slice(0, 200) }));
    }
  }
  const items = stats.map((s) => ({ ...(samples.get(classifier.keyOf(s.source, s.category)) || {}), source: s.source, category: s.category }));
  const map = await classifier.classify(items, options);

  const groups = new Map();
  const categories = [];
  for (const s of stats) {
    const c = map.get(classifier.keyOf(s.source, s.category)) || { module: 'UNKNOWN', moduleText: classifier.MODULES.UNKNOWN, classifiedBy: 'NONE', confidence: 0, reason: null };
    const label = s.source === 'idoc' ? idocDisplayName(s.category, samples.get(classifier.keyOf('idoc', s.category))?.hint) : s.category;
    categories.push({ source: s.source, category: s.category, displayCategory: label, error: s.error, module: c.module, moduleText: c.moduleText, classifiedBy: c.classifiedBy, confidence: c.confidence, reason: c.reason });
    const key = `${s.source}|${c.module}`;
    const g = groups.get(key) || { source: s.source, sourceLabel: SOURCES[s.source].label, module: c.module, moduleText: c.moduleText, error: 0, warning: 0, categoryCount: 0, aiClassified: 0, topCategories: [] };
    g.error += s.error;
    g.warning += s.warning;
    g.categoryCount += 1;
    if (c.classifiedBy === 'AI') g.aiClassified += 1;
    g.topCategories.push({ category: label, error: s.error });
    groups.set(key, g);
  }
  const modules = [...groups.values()].map((g) => {
    const top = g.topCategories.sort((a, b) => b.error - a.error);
    return { ...g, topCategories: top.slice(0, 5).map((t) => `${t.category} (${t.error})`).join(', ') + (top.length > 5 ? `, +${top.length - 5} more` : '') };
  }).sort((a, b) => b.error - a.error || a.module.localeCompare(b.module));
  categories.sort((a, b) => b.error - a.error);
  const total = (source) => modules.filter((m) => m.source === source).reduce((sum, m) => sum + m.error, 0);
  return { period: p, idocTotal: total('idoc'), jobTotal: total('job'), modules, categories, unavailable };
}

async function syncAll() {
  const results = await perSource((source) => api.syncNow(source));
  return Object.values(SOURCES).map((source) => {
    const r = results[source.key];
    if (!r.ok) return { source: source.key, label: source.label, success: false, message: r.error };
    const v = r.value || {};
    // IDoc returns a SyncRuns row { success, message }; Job returns { success, message }.
    return { source: source.key, label: source.label, success: v.success !== false, message: v.message || 'Sync triggered' };
  });
}

module.exports = { PERIODS, normalizePeriod, idocDisplayName, overview, trend, categories, topErrors, failures, failureByKey, syncAll, moduleBreakdown, withModules, moduleItem, failuresWithModules };
