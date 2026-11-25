// Manual corrections kept in HANA. They are the operations team's own knowledge: the steps that
// actually fixed a failure. They are written for one failure and re-shown for every failure with the
// same source + category (IDoc message type / job name), because that is what makes the same error
// recur.
const cds = require('@sap/cds');

const ENTITY = 'ops.monitor.ManualCorrections';
const MAX_TEXT = 5000;
const MAX_CATEGORY = 200;
const MATCH_LIMIT = 3;

function clip(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .trim()
    .slice(0, max);
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function actorOf(request) {
  return clip(request?.user?.id, 120) || 'unknown';
}

async function db() {
  return cds.connect.to('db');
}

function normalize(row) {
  if (!row) return null;
  return {
    ID: row.ID,
    source: row.source,
    sourceKey: row.sourceKey,
    objectId: row.objectId,
    category: row.category,
    system: row.system,
    errorText: row.errorText,
    correctionText: row.correctionText,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    modifiedBy: row.modifiedBy,
    modifiedAt: row.modifiedAt
  };
}

/** The correction saved for exactly this failure, if any. */
async function byFailure(source, sourceKey) {
  const rows = await (await db()).run(
    SELECT.one.from(ENTITY).where({ source, sourceKey })
  );
  return normalize(rows);
}

/** Corrections of other failures with the same source + category, newest first. */
async function byCategory(source, category, { excludeKey } = {}) {
  const value = clip(category, MAX_CATEGORY);
  if (!source || !value) return [];
  const rows = await (await db()).run(
    SELECT.from(ENTITY)
      .where({ source, category: value })
      .orderBy('modifiedAt desc')
      .limit(50)
  );
  return (rows || [])
    .map(normalize)
    .filter((row) => row && row.correctionText && row.sourceKey !== excludeKey)
    .slice(0, MATCH_LIMIT);
}

/** Creates or updates the correction of one failure; an empty text deletes it. */
async function save(request, { source, sourceKey, correctionText, failure } = {}) {
  const src = String(source || '').toLowerCase();
  if (src !== 'idoc' && src !== 'job') throw badRequest(`Unsupported source '${source}'. Use idoc or job.`);
  const key = clip(sourceKey, 200);
  if (!key) throw badRequest('A failure key is required.');

  const text = clip(correctionText, MAX_TEXT);
  const database = await db();
  const existing = await database.run(SELECT.one.from(ENTITY).where({ source: src, sourceKey: key }));

  if (!text) {
    if (existing) await database.run(DELETE.from(ENTITY).where({ ID: existing.ID }));
    return null;
  }

  const facts = failure || {};
  const actor = actorOf(request);
  const now = new Date().toISOString();

  if (existing) {
    const patch = {
      correctionText: text,
      objectId: clip(facts.objectId, 500) || existing.objectId,
      category: clip(facts.category, MAX_CATEGORY) || existing.category,
      system: clip(facts.system, 200) || existing.system,
      errorText: clip(facts.errorText, 4000) || existing.errorText,
      modifiedBy: actor,
      modifiedAt: now
    };
    await database.run(UPDATE.entity(ENTITY, existing.ID).with(patch));
    return byFailure(src, key);
  }

  const row = {
    ID: cds.utils.uuid(),
    source: src,
    sourceKey: key,
    objectId: clip(facts.objectId, 500),
    category: clip(facts.category, MAX_CATEGORY),
    system: clip(facts.system, 200),
    errorText: clip(facts.errorText, 4000),
    correctionText: text,
    createdBy: actor,
    createdAt: now,
    modifiedBy: actor,
    modifiedAt: now
  };
  await database.run(INSERT.into(ENTITY).entries(row));
  return normalize(row);
}

/** Shape used by the AI analysis section and the Manual Corrections tab. */
function reference(row) {
  return {
    source: row.source,
    sourceKey: row.sourceKey,
    objectId: row.objectId,
    category: row.category,
    system: row.system,
    correctionText: row.correctionText,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    modifiedBy: row.modifiedBy,
    modifiedAt: row.modifiedAt
  };
}

module.exports = { ENTITY, MAX_TEXT, byFailure, byCategory, save, reference, clip, badRequest };
