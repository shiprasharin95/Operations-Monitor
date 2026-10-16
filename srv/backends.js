// Clients for the two source monitors. Both are called with a token issued for the *calling user*
// (XSUAA JWT bearer token exchange), so every monitor keeps enforcing its own role collections.
// The Operations Monitor stores no data: it is a view over the two monitors' OData services.
const cds = require('@sap/cds');
const { getDestination } = require('@sap-cloud-sdk/connectivity');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

const SOURCES = {
  idoc: {
    key: 'idoc',
    label: 'IDoc Monitor',
    destination: process.env.IDOC_MONITOR_DESTINATION || 'IDOC_MONITOR_API',
    servicePath: '/odata/v4/monitor',
    dashboard: process.env.IDOC_DASHBOARD_URL || 'https://bearingpointgmbh-sap-genai-genai-idoc-monitor.cfapps.eu20-001.hana.ondemand.com/idoc-monitor/webapp/index.html',
    categoryFunction: 'getByMessageType',
    categoryField: 'messageType'
  },
  job: {
    key: 'job',
    label: 'Job Monitor',
    destination: process.env.JOB_MONITOR_DESTINATION || 'JOB_MONITOR_API',
    servicePath: '/odata/v4/job-monitor',
    dashboard: process.env.JOB_DASHBOARD_URL || 'https://job-failure-monitor.cfapps.eu20-001.hana.ondemand.com/job-monitor/webapp/index.html',
    categoryFunction: 'getByJob',
    categoryField: 'jobName'
  }
};

const TIMEOUT_MS = Number(process.env.BACKEND_TIMEOUT_MS || 15000);

class SourceError extends Error {
  constructor(source, status, message) {
    super(message);
    this.source = source;
    this.status = status;
  }
}

function userJwt() {
  const jwt = cds.context?.http?.req?.headers?.authorization?.replace(/^Bearer\s+/i, '');
  return jwt || cds.context?.user?.tokenInfo?.getTokenValue?.() || null;
}

// Resolves the destination for the current user: an OAuth2UserTokenExchange destination lets the
// destination service exchange the caller's XSUAA token for one of the target app's XSUAA.
async function resolve(source) {
  const jwt = userJwt();
  const destination = await getDestination({ destinationName: source.destination, jwt: jwt || undefined });
  if (!destination) throw new SourceError(source.key, 503, `Destination ${source.destination} not found.`);
  return destination;
}

async function call(source, method, path, data) {
  const destination = await resolve(source);
  try {
    const response = await executeHttpRequest(destination, {
      method,
      url: `${source.servicePath}${path}`,
      headers: { accept: 'application/json', ...(data ? { 'content-type': 'application/json' } : {}) },
      data,
      timeout: TIMEOUT_MS
    }, { fetchCsrfToken: false });
    return response.data;
  } catch (error) {
    const response = error.cause?.response || error.response;
    const status = response?.status || 503;
    const detail = response?.data?.error?.message || error.message;
    throw new SourceError(source.key, status, status === 401 || status === 403
      ? `You are not authorized in the ${source.label}.`
      : `${source.label} unavailable: ${String(detail).slice(0, 200)}`);
  }
}

function fn(source, name, period) {
  return call(source, 'get', `/${name}(period='${period}')`);
}

const api = {
  kpis: (source, period) => fn(source, 'getKpis', period),
  trend: (source, period) => fn(source, 'getTrend', period).then((body) => body.value || []),
  categories: (source, period) => fn(source, source.categoryFunction, period).then((body) => body.value || []),
  topErrors: (source, period) => fn(source, 'getTopErrors', period).then((body) => body.value || []),
  syncNow: (source) => call(source, 'post', '/syncNow', {}),
  list: (source, entity, query) => call(source, 'get', `/${entity}?${query}`).then((body) => body.value || [])
};

module.exports = { SOURCES, SourceError, api };
