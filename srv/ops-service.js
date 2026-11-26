const aggregate = require('./aggregate');
const ai = require('./ai');
const corrections = require('./corrections');
const classifier = require('./module-classifier');

function fail(request, error) {
  return request.error(error.statusCode || 502, error.message);
}

// AI analysis + the manual corrections saved for the same source + category (message type / job name),
// so the team's own fix steps are shown next to the generated answer.
async function analyzeFailure({ source, sourceKey, refresh }) {
  const failure = await aggregate.failureByKey(String(source || '').toLowerCase(), sourceKey);
  const [analysis, own, similar] = await Promise.all([
    ai.analyzeFailure(failure, { refresh: refresh === true }),
    corrections.byFailure(failure.source, failure.sourceKey).catch(() => null),
    corrections.byCategory(failure.source, failure.category, { excludeKey: failure.sourceKey }).catch(() => [])
  ]);
  // The correction written for this very failure comes first, then the ones of the same category.
  const rows = [own, ...similar].filter(Boolean).map(corrections.reference);
  return { ...analysis, manualCorrections: rows };
}

async function getManualCorrection({ source, sourceKey }) {
  const src = String(source || '').toLowerCase();
  const key = String(sourceKey || '');
  const correction = await corrections.byFailure(src, key);
  return { source: src, sourceKey: key, correction: correction ? corrections.reference(correction) : null };
}

async function saveManualCorrection(request, { source, sourceKey, correctionText, objectId, category, system, errorText }) {
  const src = String(source || '').toLowerCase();
  const key = String(sourceKey || '');
  let failure = null;
  try {
    failure = await aggregate.failureByKey(src, key);
  } catch (error) {
    // The monitor may be unavailable or the failure may be out of retention; the note is still worth
    // keeping, so saving never fails because the source record could not be read again.
  }
  // Facts from the failure list are used only when the monitor did not return them again.
  const facts = failure || { objectId, category, system, errorText };
  const saved = await corrections.save(request, { source: src, sourceKey: key, correctionText, failure: facts });
  return { source: src, sourceKey: key, correction: saved ? corrections.reference(saved) : null };
}

module.exports = (service) => {
  service.on('getOverview', (request) => aggregate.overview(request.data.period).catch((e) => fail(request, e)));
  service.on('getTrend', (request) => aggregate.trend(request.data.period).catch((e) => fail(request, e)));
  service.on('getCategories', (request) => aggregate.categories(request.data.period).catch((e) => fail(request, e)));
  service.on('getTopErrors', (request) => aggregate.topErrors(request.data.period).catch((e) => fail(request, e)));
  service.on('getFailures', (request) => aggregate.failuresWithModules(request.data.period, request.data.top).catch((e) => fail(request, e)));
  service.on('getModuleBreakdown', (request) => aggregate.moduleBreakdown(request.data.period, { actor: request.user?.id }).catch((e) => fail(request, e)));
  service.on('getModules', () => Object.entries(classifier.MODULES).map(([code, text]) => ({ code, text })));
  service.on('setModuleClassification', async (request) => {
    try {
      const { source, category, module } = request.data;
      const c = await classifier.setOverride(request, { source, category, module });
      return { source: String(source).toLowerCase(), category, module: c.module, moduleText: c.moduleText, classifiedBy: c.classifiedBy, confidence: c.confidence, reason: c.reason };
    } catch (e) { return fail(request, e); }
  });
  service.on('reclassifyModules', (request) => classifier.resetAi().catch((e) => fail(request, e)));
  service.on('syncAll', (request) => aggregate.syncAll().catch((e) => fail(request, e)));
  service.on('analyzeFailure', (request) => analyzeFailure(request.data).catch((e) => fail(request, e)));
  service.on('getManualCorrection', (request) => getManualCorrection(request.data).catch((e) => fail(request, e)));
  service.on('saveManualCorrection', (request) => saveManualCorrection(request, request.data).catch((e) => fail(request, e)));
};
