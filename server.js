const cds = require('@sap/cds');
const { mountA2A } = require('./srv/a2a');

const DASHBOARD_PATH = '/ops-monitor/webapp/index.html';

cds.on('bootstrap', (app) => {
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
