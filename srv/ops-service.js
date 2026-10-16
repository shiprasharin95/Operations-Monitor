const aggregate = require('./aggregate');

function fail(request, error) {
  return request.error(error.statusCode || 502, error.message);
}

module.exports = (service) => {
  service.on('getOverview', (request) => aggregate.overview(request.data.period).catch((e) => fail(request, e)));
  service.on('getTrend', (request) => aggregate.trend(request.data.period).catch((e) => fail(request, e)));
  service.on('getCategories', (request) => aggregate.categories(request.data.period).catch((e) => fail(request, e)));
  service.on('getTopErrors', (request) => aggregate.topErrors(request.data.period).catch((e) => fail(request, e)));
  service.on('getFailures', (request) => aggregate.failures(request.data.period, request.data.top).catch((e) => fail(request, e)));
  service.on('syncAll', (request) => aggregate.syncAll().catch((e) => fail(request, e)));
};
