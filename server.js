const cds = require('@sap/cds');
const { mountA2A } = require('./srv/a2a');

const DASHBOARD_PATH = '/ops-monitor/webapp/index.html';

cds.on('bootstrap', (app) => {
  // The UI5 manifest uses a relative service URI ("odata/v4/ops/") so the same app works inside
  // SAP Build Work Zone (HTML5 repo + managed approuter). Standalone, that resolves to
  // /ops-monitor/webapp/odata/..., which is mapped back to the CAP service here.
  app.use((req, res, next) => {
    if (req.url.startsWith('/ops-monitor/webapp/odata/')) req.url = req.url.slice('/ops-monitor/webapp'.length);
    // TEMP DIAG: which token arrives (no signature/secret logged)
    if (req.url.includes('$metadata') && req.headers.authorization) {
      try {
        const p = JSON.parse(Buffer.from(req.headers.authorization.split('.')[1], 'base64url').toString());
        console.log('TOKENDIAG', JSON.stringify({ user: p.user_name, origin: p.origin, iss: p.iss, cid: p.cid, aud: p.aud, scope: p.scope, xs_rc: p['xs.system.attributes'] }));
      } catch (e) { console.log('TOKENDIAG parse failed'); }
    }
    next();
  });
  app.get(['/', '/index.html'], (req, res) => {
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    res.redirect(`${DASHBOARD_PATH}${query}`);
  });
  app.get('/health', (req, res) => res.json({ status: 'UP' }));
  // Orchestrator A2A agent: public agent card + IAS-protected POST /a2a.
  mountA2A(app);
});

async function startServer() {
  return cds.server();
}

module.exports = startServer;

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Failed to start Operations Monitor.', { errorCode: String(error.code || error.name || 'STARTUP_ERROR').slice(0, 80) });
    process.exit(1);
  });
}
