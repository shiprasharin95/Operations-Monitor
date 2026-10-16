// IAS authentication for the A2A endpoint (same contract as the IDoc / PO monitor agents).
// Joule (or an orchestrator agent) calls with an IAS-issued JWT via an OAuth2JWTBearer destination.
// The token must be issued by IAS_ISSUER for audience IAS_AUDIENCE (client ID of the IAS application
// "Job Monitor A2A Agent"). Authorization: the token's groups claim must contain JobMonitor_Viewer or
// JobMonitor_Admin. Fails closed when IAS is not configured.
const IAS_ISSUER = (process.env.IAS_ISSUER || '').replace(/\/+$/, '');
// IAS emits the issuer with or without scheme / trailing slash depending on the grant; accept all variants.
const IAS_HOST = IAS_ISSUER.replace(/^https?:\/\//, '');
const IAS_ISSUERS = IAS_ISSUER ? [IAS_ISSUER, `${IAS_ISSUER}/`, IAS_HOST, `${IAS_HOST}/`] : [];
const IAS_AUDIENCE = (process.env.IAS_AUDIENCE || '').split(',').map((value) => value.trim()).filter(Boolean);
const IAS_JWKS_URL = process.env.IAS_JWKS_URL || (IAS_ISSUER ? `${IAS_ISSUER}/oauth2/certs` : '');
const requiredApiSetting = (process.env.IAS_REQUIRED_API ?? 'none').trim();
const IAS_REQUIRED_API = requiredApiSetting.toLowerCase() === 'none' ? '' : requiredApiSetting;
const GROUPS_CLAIM = process.env.IAS_GROUPS_CLAIM || 'groups';
const REQUIRED_GROUPS = (process.env.A2A_REQUIRED_GROUPS || 'OpsMonitor_Viewer,JobMonitor_Viewer,IDocMonitor_Viewer,JobMonitor_Admin,IDocMonitor_Admin')
  .split(',').map((value) => value.trim()).filter(Boolean);
const AUTH_DISABLED = process.env.A2A_AUTH_DISABLED === 'true' && process.env.NODE_ENV !== 'production';

let jwksPromise;

// jose is ESM-only; a dynamic import keeps this CommonJS module loadable.
async function loadVerifier() {
  const jose = await import('jose');
  jwksPromise ||= jose.createRemoteJWKSet(new URL(IAS_JWKS_URL));
  return { jose, jwks: await jwksPromise };
}

function isConfigured() {
  return Boolean(IAS_ISSUER && IAS_AUDIENCE.length);
}

function unauthorized(res, message) {
  res.set('WWW-Authenticate', 'Bearer').status(401).json({ error: 'unauthorized', message });
}

function groupsOf(payload) {
  const value = payload[GROUPS_CLAIM];
  if (Array.isArray(value)) return value.map(String);
  return value ? [String(value)] : [];
}

async function iasAuthMiddleware(req, res, next) {
  if (AUTH_DISABLED) {
    const groups = (process.env.A2A_DEV_GROUPS ?? 'JobMonitor_Viewer').split(',').map((v) => v.trim()).filter(Boolean);
    req.a2aUser = { name: 'local-dev', groups, hasUserIdentity: true };
    return next();
  }
  if (!isConfigured()) {
    console.error(JSON.stringify({ event: 'a2a-auth-misconfigured', message: 'IAS_ISSUER and IAS_AUDIENCE must be set.' }));
    return res.status(503).json({ error: 'a2a-auth-not-configured' });
  }

  const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  if (!match) return unauthorized(res, 'Missing bearer token.');

  try {
    const { jose, jwks } = await loadVerifier();
    const { payload } = await jose.jwtVerify(match[1], jwks, { issuer: IAS_ISSUERS, audience: IAS_AUDIENCE });
    if (IAS_REQUIRED_API && !(Array.isArray(payload.ias_apis) && payload.ias_apis.includes(IAS_REQUIRED_API))) {
      console.warn(JSON.stringify({ event: 'a2a-auth-rejected', reason: `missing ${IAS_REQUIRED_API} in ias_apis` }));
      return res.status(403).json({ error: 'forbidden', message: `Token lacks the ${IAS_REQUIRED_API} scope.` });
    }
    const hasUserIdentity = Boolean(payload.mail || payload.email || payload.user_uuid);
    const groups = groupsOf(payload);
    // Claim names and counts only, never values (no personal data in logs).
    console.log(JSON.stringify({ event: 'a2a-auth-accepted', hasUserIdentity, claims: Object.keys(payload).sort(), groupCount: groups.length }));
    req.a2aUser = { name: payload.sub || payload.azp || 'unknown', hasUserIdentity, groups, jwt: match[1] };
    return next();
  } catch (error) {
    console.warn(JSON.stringify({ event: 'a2a-auth-rejected', reason: error.code || error.message }));
    return unauthorized(res, 'Invalid token.');
  }
}

// The group decision is made in the executor so Joule gets a readable "rejected" task instead of an HTTP error.
function isAuthorized(user) {
  return Boolean(user?.hasUserIdentity) && (user.groups || []).some((group) => REQUIRED_GROUPS.includes(group));
}

async function userBuilder(req) {
  return {
    isAuthenticated: true,
    userName: req.a2aUser?.name || 'unknown',
    hasUserIdentity: Boolean(req.a2aUser?.hasUserIdentity),
    groups: req.a2aUser?.groups || [],
    jwt: req.a2aUser?.jwt
  };
}

module.exports = { iasAuthMiddleware, userBuilder, isAuthorized, isConfigured, issuer: IAS_ISSUER, REQUIRED_GROUPS };

