// Deterministic aggregation over the two monitors. Every figure is the sum of what the monitors
// return for the same period; nothing is estimated and no LLM is involved.
const { SOURCES, SourceError, api } = require('./backends');

const PERIODS = ['1H', '24H', '7D', '30D'];

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
  return rows.sort((a, b) => b.error - a.error || b.total - a.total || a.category.localeCompare(b.category)).slice(0, 15);
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
  return rows.sort((a, b) => b.count - a.count || a.errorText.localeCompare(b.errorText)).slice(0, 15);
}

const PERIOD_MS = { '1H': 36e5, '24H': 864e5, '7D': 7 * 864e5, '30D': 30 * 864e5 };

// One failure list across both monitors (newest first). Each row links to its original object page.
async function failures(period, top = 50) {
  const p = normalizePeriod(period);
  const since = new Date(Date.now() - PERIOD_MS[p]).toISOString();
  const limit = Math.min(Math.max(Number(top) || 50, 1), 200);
  const results = await perSource(async (source) => {
    if (source.key === 'idoc') {
      const rows = await api.list(source, 'IDocMessages', `$filter=statusGroup eq 'Error' and lastUpdatedAt ge ${since}&$orderby=lastUpdatedAt desc&$top=${limit}&$select=ID,idocNumber,messageType,direction,serviceName,statusText,errorText,lastUpdatedAt,senderPartner,receiverPartner`);
      return rows.map((r) => ({
        source: 'idoc', sourceLabel: 'IDoc Monitor', objectId: r.idocNumber, category: r.messageType, system: r.serviceName,
        state: 'Error', statusText: r.statusText, errorText: r.errorText || r.statusText, partner: [r.senderPartner, r.receiverPartner].filter(Boolean).join(' → '),
        occurredAt: r.lastUpdatedAt, detailUrl: `${source.dashboard}#/IDocMessages(${r.ID})`
      }));
    }
    const rows = await api.list(source, 'JobRuns', `$filter=statusGroup eq 'Error' and startedAt ge ${since}&$orderby=startedAt desc&$top=${limit}&$select=sourceRunKey,jobName,application,system,errorText,schedulerName,startedAt`);
    return rows.map((r) => ({
      source: 'job', sourceLabel: 'Job Monitor', objectId: r.jobName, category: r.application, system: r.system,
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

module.exports = { PERIODS, normalizePeriod, overview, trend, categories, topErrors, failures, syncAll };
