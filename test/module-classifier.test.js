// Module classifier agent: rule table, AI fallback (fake AI), persistence and user overrides.
const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert');

const cds = require('@sap/cds');
const classifier = require('../srv/module-classifier');

const admin = { user: { id: 'alice' } };

before(async () => {
  await cds.deploy('db').to('sqlite::memory:');
});

beforeEach(async () => {
  classifier._reset();
  await DELETE.from(classifier.ENTITY);
});

function fakeAi(answerFor) {
  const calls = [];
  const complete = async (system, user, options) => {
    calls.push({ system, items: JSON.parse(user), options });
    return JSON.stringify(JSON.parse(user).map((item) => ({ id: item.id, ...answerFor(item) })));
  };
  return { complete, calls };
}

test('rule table: IDoc message types', () => {
  const cases = { ORDERS05: 'SD', ORDERS: 'SD', MATMAS: 'MM', CREMAS: 'MM', LOIPRO: 'PP', QPMK: 'QM', FIDCCP02: 'FI', COSMAS: 'CO', SHPMNT: 'TM', WMMBXY: 'EWM', DESADV: 'LE', DEBMAS: 'CROSS', ALEAUD: 'BASIS', ZMATMAS: 'MM' };
  for (const [type, module] of Object.entries(cases)) {
    assert.equal(classifier.byRule('idoc', type)?.module, module, type);
  }
  assert.equal(classifier.byRule('idoc', 'ZXYZ_CUSTOM'), null);
});

test('rule table: placeholder message type falls back to the IDoc basic type', () => {
  assert.equal(classifier.byRule('idoc', 'ZZZZZ', 'CREMAS06')?.module, 'MM');
  assert.equal(classifier.byRule('idoc', 'ZVEND', 'ORDERS05')?.module, 'SD');
  assert.equal(classifier.byRule('idoc', 'ZZZZZ'), null);
});

test('dashboard label: blank/placeholder message type shows the IDoc basic type', () => {
  const { idocDisplayName } = require('../srv/aggregate');
  assert.equal(idocDisplayName('ZZZZZ', 'CREMAS06'), 'CREMAS06');
  assert.equal(idocDisplayName('', 'CREMAS06'), 'CREMAS06');
  assert.equal(idocDisplayName('(none)', 'MATMAS05'), 'MATMAS05');
  assert.equal(idocDisplayName('CREMAS', 'CREMAS06'), 'CREMAS');
  assert.equal(idocDisplayName('ZZZZZ', null), 'ZZZZZ');
});

test('rule table: jobs by application component and name', () => {
  assert.equal(classifier.byRule('job', 'Anything', 'FI-GL')?.module, 'FI');
  assert.equal(classifier.byRule('job', 'Anything', 'SD-BIL')?.module, 'SD');
  assert.equal(classifier.byRule('job', 'Run MRP for plant 1010')?.module, 'PP');
  assert.equal(classifier.byRule('job', 'Create billing documents')?.module, 'SD');
  assert.equal(classifier.byRule('job', 'Automatic Payment Run')?.module, 'FI');
  assert.equal(classifier.byRule('job', 'Material Ledger actual costing run')?.module, 'CO');
  assert.equal(classifier.byRule('job', 'Purchase order output')?.module, 'MM');
  assert.equal(classifier.byRule('job', 'Freight order planning')?.module, 'TM');
  assert.equal(classifier.byRule('job', 'Wave processing warehouse 1710')?.module, 'EWM');
  assert.equal(classifier.byRule('job', 'Z_CUSTOM_REPORT_42'), null);
  // Real job names seen in the tenant
  assert.equal(classifier.byRule('job', 'Turnkey schedule for the intelligent scenario GLO_MFD_GENAI')?.module, 'BASIS');
  assert.equal(classifier.byRule('job', 'Kreditrisikobasierte Wertminderung buchen 2')?.module, 'FI');
  assert.equal(classifier.byRule('job', 'Erstellung von Fakturaanforderungen für Serviceaufträge einplanen')?.module, 'SD');
});

test('unknown categories go to the AI once, are stored, and are reused', async () => {
  const ai = fakeAi(() => ({ module: 'qm', confidence: 72, reason: 'Inspection related' }));
  const items = [{ source: 'idoc', category: 'ZINSPRES', sampleError: 'lot missing' }, { source: 'idoc', category: 'MATMAS' }];
  const first = await classifier.classify(items, { complete: ai.complete });
  assert.equal(ai.calls.length, 1);
  assert.deepEqual(ai.calls[0].items.map((i) => i.category), ['ZINSPRES'], 'rule hits are not sent to the AI');
  assert.equal(ai.calls[0].options.temperature, 0);
  assert.equal(first.get('idoc|ZINSPRES').module, 'QM');
  assert.equal(first.get('idoc|ZINSPRES').classifiedBy, 'AI');
  assert.equal(first.get('idoc|MATMAS').classifiedBy, 'RULE');

  const second = await classifier.classify(items, { complete: ai.complete });
  assert.equal(ai.calls.length, 1, 'stored AI decision is reused');
  assert.equal(second.get('idoc|ZINSPRES').confidence, 72);
});

test('invalid AI module becomes UNKNOWN; broken AI answer leaves category unassigned', async () => {
  const ai = fakeAi(() => ({ module: 'XYZ', confidence: 90 }));
  const r = await classifier.classify([{ source: 'job', category: 'Z_JOB_1' }], { complete: ai.complete });
  assert.equal(r.get('job|Z_JOB_1').module, 'UNKNOWN');

  classifier._reset();
  const broken = async () => 'Sorry, I cannot help.';
  const r2 = await classifier.classify([{ source: 'job', category: 'Z_JOB_2' }], { complete: broken });
  assert.equal(r2.get('job|Z_JOB_2').classifiedBy, 'NONE');
  assert.equal(r2.get('job|Z_JOB_2').module, 'UNKNOWN');
});

test('parseAiAnswer accepts fenced JSON and clamps values', () => {
  const parsed = classifier.parseAiAnswer('```json\n[{"id":0,"module":"fi","confidence":150,"reason":"x"}]\n```');
  assert.deepEqual(parsed, [{ id: 0, module: 'FI', confidence: 100, reason: 'x' }]);
});

test('user override wins over rule and AI, and AUTO removes it', async () => {
  const overridden = await classifier.setOverride(admin, { source: 'idoc', category: 'ORDERS', module: 'MM' });
  assert.equal(overridden.module, 'MM');
  assert.equal(overridden.classifiedBy, 'USER');
  const row = await SELECT.one.from(classifier.ENTITY).where({ source: 'idoc', category: 'ORDERS' });
  assert.equal(row.modifiedBy, 'alice');

  const back = await classifier.setOverride(admin, { source: 'idoc', category: 'ORDERS', module: 'AUTO' });
  assert.equal(back.module, 'SD');
  assert.equal(back.classifiedBy, 'RULE');

  await assert.rejects(() => classifier.setOverride(admin, { source: 'idoc', category: 'ORDERS', module: 'NOPE' }), /Unknown module/);
  await assert.rejects(() => classifier.setOverride(admin, { source: 'mail', category: 'X', module: 'SD' }), /Unsupported source/);
});

test('resetAi forgets AI decisions but keeps overrides', async () => {
  const ai = fakeAi(() => ({ module: 'PP', confidence: 60 }));
  await classifier.classify([{ source: 'job', category: 'Z_JOB_A' }], { complete: ai.complete });
  await classifier.setOverride(admin, { source: 'job', category: 'Z_JOB_B', module: 'FI' });
  await classifier.resetAi();
  const rows = await SELECT.from(classifier.ENTITY);
  assert.deepEqual(rows.map((r) => r.category), ['Z_JOB_B']);
});

test('useAi false never calls the AI', async () => {
  let called = false;
  const r = await classifier.classify([{ source: 'job', category: 'Z_JOB_C' }], { useAi: false, complete: async () => { called = true; return '[]'; } });
  assert.equal(called, false);
  assert.equal(r.get('job|Z_JOB_C').classifiedBy, 'NONE');
});
