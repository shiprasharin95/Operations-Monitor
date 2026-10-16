sap.ui.define([
  "sap/fe/core/PageController", "sap/ui/model/json/JSONModel", "sap/m/MessageToast", "sap/m/MessageBox", "sap/ui/core/format/DateFormat"
], function (PageController, JSONModel, MessageToast, MessageBox, DateFormat) {
  "use strict";

  var PERIOD_TEXT = { "1H": "Last hour", "24H": "Last 24 hours", "7D": "Last 7 days", "30D": "Last 30 days" };
  var REFRESH_SECONDS = 30;
  var fmtHour = DateFormat.getDateTimeInstance({ pattern: "HH:mm" });
  var fmtDay = DateFormat.getDateInstance({ pattern: "EEE dd.MM" });
  var fmtFull = DateFormat.getDateTimeInstance({ style: "medium" });
  var fmtRel = DateFormat.getDateTimeInstance({ relative: true, relativeScale: "auto", style: "short" });

  function initialPeriod() {
    var m = /[?&]period=(1H|24H|7D|30D)/i.exec(window.location.href);
    return m ? m[1].toUpperCase() : "24H";
  }

  return PageController.extend("ops.monitor.ext.main.Main", {
    onInit: function () {
      PageController.prototype.onInit.apply(this, arguments);
      var period = initialPeriod();
      this._ui = new JSONModel({
        period: period, periodText: PERIOD_TEXT[period], autoRefresh: true, syncing: false,
        overview: { total: 0, success: 0, error: 0, warning: 0, inProcess: 0, successRate: 0, idocErrors: 0, jobErrors: 0, sources: [] },
        trend: [], categories: [], topErrors: [], failures: [], failuresView: [], failureCount: 0, sourceFilter: "", search: "", unavailableText: ""
      });
      this.getView().setModel(this._ui, "ui");
      this._initCharts();
      this._startTimer();
    },

    onAfterRendering: function () {
      if (!this._loadedOnce) { this._loadedOnce = true; this._load(); }
    },

    onExit: function () { this._stopTimer(); },

    _serviceUrl: function () { return (this.getView().getModel() || this.getAppComponent().getModel()).getServiceUrl(); },

    _call: function (fn, extra) {
      var period = this._ui.getProperty("/period");
      var params = "period='" + period + "'" + (extra ? "," + extra : "");
      return fetch(this._serviceUrl() + fn + "(" + params + ")", { headers: { Accept: "application/json" }, credentials: "include" })
        .then(function (r) { if (!r.ok) { throw new Error(fn + " failed: HTTP " + r.status); } return r.json(); });
    },

    _load: function () {
      var that = this;
      var period = this._ui.getProperty("/period");
      var fmt = period === "7D" || period === "30D" ? fmtDay : fmtHour;
      return Promise.all([this._call("getOverview"), this._call("getTrend"), this._call("getCategories"), this._call("getTopErrors"), this._call("getFailures", "top=200")])
        .then(function (res) {
          var ov = res[0];
          ov.sources = (ov.sources || []).map(function (s) { return Object.assign({ lastSyncText: s.lastSyncAt ? fmtRel.format(new Date(s.lastSyncAt)) : "" }, s); });
          that._ui.setProperty("/overview", ov);
          that._ui.setProperty("/trend", (res[1].value || []).map(function (p) {
            var d = new Date(p.bucket.length === 10 ? p.bucket + "T00:00:00Z" : p.bucket + ":00Z");
            return Object.assign({ label: fmt.format(d) }, p);
          }));
          that._ui.setProperty("/categories", (res[2].value || []).map(function (c) {
            var name = (c.source === "idoc" ? "IDoc " : "Job ") + c.category;
            return Object.assign({}, c, { label: name.length > 42 ? name.slice(0, 41) + "…" : name });
          }));
          that._ui.setProperty("/topErrors", res[3].value || []);
          var failures = (res[4].rows || []).map(function (f) { return Object.assign({ timeText: f.occurredAt ? fmtFull.format(new Date(f.occurredAt)) : "-" }, f); });
          that._ui.setProperty("/failures", failures);
          that._ui.setProperty("/unavailableText", (res[4].unavailable || []).map(function (u) { return u.message; }).join(" · "));
          that._applyFailureFilter();
        })
        .catch(function (e) { MessageToast.show("Could not load dashboard data: " + e.message); });
    },

    _applyFailureFilter: function () {
      var source = this._ui.getProperty("/sourceFilter");
      var q = (this._ui.getProperty("/search") || "").toLowerCase();
      var rows = (this._ui.getProperty("/failures") || []).filter(function (f) {
        if (source && f.source !== source) { return false; }
        if (!q) { return true; }
        return [f.objectId, f.category, f.errorText, f.system, f.partner].join(" ").toLowerCase().indexOf(q) >= 0;
      });
      this._ui.setProperty("/failuresView", rows);
      this._ui.setProperty("/failureCount", rows.length);
    },

    onRefresh: function () { this._load(); },
    onPeriodChange: function (e) { var k = e.getParameter("item").getKey(); this._ui.setProperty("/period", k); this._ui.setProperty("/periodText", PERIOD_TEXT[k]); this._load(); },
    onAutoRefreshToggle: function (e) { if (e.getParameter("state")) { this._startTimer(); } else { this._stopTimer(); } },
    onSourceFilter: function (e) { this._ui.setProperty("/sourceFilter", e.getParameter("item").getKey()); this._applyFailureFilter(); },
    onSearch: function (e) { this._ui.setProperty("/search", e.getParameter("newValue")); this._applyFailureFilter(); },

    onTilePress: function (e) {
      var source = e.getSource().data("source");
      this._ui.setProperty("/sourceFilter", source || "");
      this._applyFailureFilter();
      var t = this.byId("failureTable");
      if (t && t.getDomRef()) { t.getDomRef().scrollIntoView({ behavior: "smooth", block: "start" }); }
    },

    /** Opens the row's detail page in the original monitor (IDoc object page or Job run page) in a new tab. */
    onFailurePress: function (e) {
      var row = e.getSource().getBindingContext("ui").getObject();
      if (row.detailUrl) { window.open(row.detailUrl, "_blank", "noopener"); }
    },

    onSyncAll: function () {
      var that = this;
      this._ui.setProperty("/syncing", true);
      var action = this.getView().getModel().bindContext("/syncAll(...)");
      action.execute().then(function () {
        var results = action.getBoundContext().getObject() || [];
        var lines = (results.value || results).map(function (r) { return (r.success ? "✓ " : "✗ ") + r.label + ": " + r.message; });
        var failed = (results.value || results).some(function (r) { return !r.success; });
        if (failed) { MessageBox.warning(lines.join("\n"), { title: "Pull from Cloud ALM" }); } else { MessageToast.show(lines.join("\n")); }
        that._load();
      }).catch(function (err) { MessageBox.error(err.message, { title: "Pull from Cloud ALM failed" }); })
        .finally(function () { that._ui.setProperty("/syncing", false); });
    },

    _startTimer: function () {
      var that = this; this._stopTimer();
      this._timer = setInterval(function () { if (that._ui.getProperty("/autoRefresh") && !document.hidden) { that._load(); } }, REFRESH_SECONDS * 1000);
    },
    _stopTimer: function () { if (this._timer) { clearInterval(this._timer); this._timer = null; } },

    _initCharts: function () {
      var base = { title: { visible: false }, legend: { visible: true }, legendGroup: { layout: { position: "bottom" } }, valueAxis: { title: { visible: false } }, categoryAxis: { title: { visible: false } }, plotArea: { dataLabel: { visible: false } } };
      var trend = this.byId("trendChart"); if (trend) { trend.setVizProperties(Object.assign({}, base, { plotArea: { colorPalette: ["#0070f2", "#5d36ff"], dataLabel: { visible: false } } })); }
      var cat = this.byId("categoryChart"); if (cat) { cat.setVizProperties(Object.assign({}, base, { plotArea: { colorPalette: ["#36a41d", "#e76500", "#d20a0a"], dataLabel: { visible: false } } })); }
    }
  });
});
