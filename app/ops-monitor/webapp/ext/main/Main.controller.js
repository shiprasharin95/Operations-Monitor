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

  // The AI answer is rendered by the shared control in ext/ai/AiAnalysis.js.
  var EMPTY_AI = { source: "", sourceLabel: "", sourceKey: "", objectId: "", category: "", analysis: "", analyzedAt: null, disclaimer: "", manualCorrections: [], message: "", messageType: "Information", busy: false };
  var EMPTY_CORR = { source: "", sourceLabel: "", sourceKey: "", objectId: "", category: "", system: "", statusText: "", statusState: "Error", errorText: "", text: "", savedText: "", metaText: "", editing: true, saving: false, message: "", messageType: "Information", busy: false };

  function statusState(value) {
    var text = String(value || "").toLowerCase();
    if (/error|failed|abort/.test(text)) { return "Error"; }
    if (/warn/.test(text)) { return "Warning"; }
    if (/success|posted|processed/.test(text)) { return "Success"; }
    return "Information";
  }

  return PageController.extend("ops.monitor.ext.main.Main", {
    onInit: function () {
      PageController.prototype.onInit.apply(this, arguments);
      var period = initialPeriod();
      this._ui = new JSONModel({
        tab: "dashboard", loading: true,
        period: period, periodText: PERIOD_TEXT[period], autoRefresh: true, syncing: false,
        overview: { total: 0, success: 0, error: 0, warning: 0, inProcess: 0, successRate: 0, idocErrors: 0, jobErrors: 0, sources: [] },
        trend: [], categories: [], topErrors: [], failures: [], failuresView: [], failureCount: 0, sourceFilter: "", search: "", unavailableText: "",
        aiList: [], aiListCount: 0, aiSourceFilter: "", aiSearch: "",
        ai: Object.assign({}, EMPTY_AI),
        corrList: [], corrListCount: 0, corrSourceFilter: "", corrSearch: "",
        corr: Object.assign({}, EMPTY_CORR)
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
      this._ui.setProperty("/loading", true);
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
          that._applyAiFilter();
          that._applyCorrFilter();
        })
        .catch(function (e) { MessageToast.show("Could not load dashboard data: " + e.message); })
        .finally(function () { that._ui.setProperty("/loading", false); });
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

    /** The AI Analysis tab lists the same failures, filtered on its own toolbar. */
    _applyAiFilter: function () {
      var source = this._ui.getProperty("/aiSourceFilter");
      var q = (this._ui.getProperty("/aiSearch") || "").toLowerCase();
      var rows = (this._ui.getProperty("/failures") || []).filter(function (f) {
        if (source && f.source !== source) { return false; }
        if (!q) { return true; }
        return [f.objectId, f.category, f.errorText, f.system, f.partner].join(" ").toLowerCase().indexOf(q) >= 0;
      });
      this._ui.setProperty("/aiList", rows);
      this._ui.setProperty("/aiListCount", rows.length);
      this._restoreAiSelection();
    },

    /** The Manual Corrections tab lists the same failures, filtered on its own toolbar. */
    _applyCorrFilter: function () {
      var source = this._ui.getProperty("/corrSourceFilter");
      var q = (this._ui.getProperty("/corrSearch") || "").toLowerCase();
      var rows = (this._ui.getProperty("/failures") || []).filter(function (f) {
        if (source && f.source !== source) { return false; }
        if (!q) { return true; }
        return [f.objectId, f.category, f.errorText, f.system, f.partner].join(" ").toLowerCase().indexOf(q) >= 0;
      });
      this._ui.setProperty("/corrList", rows);
      this._ui.setProperty("/corrListCount", rows.length);
      this._restoreCorrSelection();
    },

    _restoreCorrSelection: function () {
      var key = this._ui.getProperty("/corr/sourceKey");
      var source = this._ui.getProperty("/corr/source");
      var list = this.byId("corrList");
      if (!list || !key) { return; }
      var index = (this._ui.getProperty("/corrList") || []).findIndex(function (f) { return f.sourceKey === key && f.source === source; });
      if (index < 0) { return; }
      var items = list.getItems();
      if (items[index]) { list.setSelectedItem(items[index], true); }
    },

    onRefresh: function () { this._load(); },
    onPeriodChange: function (e) { var k = e.getParameter("item").getKey(); this._ui.setProperty("/period", k); this._ui.setProperty("/periodText", PERIOD_TEXT[k]); this._load(); },
    onAutoRefreshToggle: function (e) { if (e.getParameter("state")) { this._startTimer(); } else { this._stopTimer(); } },
    onSourceFilter: function (e) { this._ui.setProperty("/sourceFilter", e.getParameter("item").getKey()); this._applyFailureFilter(); },
    onSearch: function (e) { this._ui.setProperty("/search", e.getParameter("newValue")); this._applyFailureFilter(); },
    onAiSourceFilter: function (e) { this._ui.setProperty("/aiSourceFilter", e.getParameter("item").getKey()); this._applyAiFilter(); },
    onAiSearch: function (e) { this._ui.setProperty("/aiSearch", e.getParameter("newValue")); this._applyAiFilter(); },
    onCorrSourceFilter: function (e) { this._ui.setProperty("/corrSourceFilter", e.getParameter("item").getKey()); this._applyCorrFilter(); },
    onCorrSearch: function (e) { this._ui.setProperty("/corrSearch", e.getParameter("newValue")); this._applyCorrFilter(); },

    /** Row click in the AI Analysis tab list: analyze that failure. */
    onAiSelect: function (e) {
      var item = e.getParameter("listItem");
      var row = item && item.getBindingContext("ui") && item.getBindingContext("ui").getObject();
      if (row) { this._openAnalysis(row, false, item); }
    },

    _restoreAiSelection: function () {
      var key = this._ui.getProperty("/ai/sourceKey");
      var source = this._ui.getProperty("/ai/source");
      var list = this.byId("aiList");
      if (!list || !key) { return; }
      var index = (this._ui.getProperty("/aiList") || []).findIndex(function (f) { return f.sourceKey === key && f.source === source; });
      if (index < 0) { return; }
      var items = list.getItems();
      if (items[index]) { list.setSelectedItem(items[index], true); }
    },

    onTilePress: function (e) {
      var source = e.getSource().data("source");
      this._ui.setProperty("/sourceFilter", source || "");
      this._applyFailureFilter();
      var t = this.byId("failureTable");
      if (t && t.getDomRef()) { t.getDomRef().scrollIntoView({ behavior: "smooth", block: "start" }); }
    },

    /** Opens the row's detail page in the original monitor (IDoc object page or Job run page) in a new tab. */
    onFailurePress: function (e) {
      var src = e.getParameter && e.getParameter("srcControl");
      if (src && src.isA && src.isA("sap.m.Button")) { return; }
      var row = e.getSource().getBindingContext("ui").getObject();
      if (row.detailUrl) { window.open(row.detailUrl, "_blank", "noopener"); }
    },

    /** AI Analysis for one failure (button in the failures table): jumps to the AI Analysis tab. */
    onAnalyzeFailure: function (e) {
      this._openAnalysis(e.getSource().getBindingContext("ui").getObject(), false);
    },

    onGenerateAnalysis: function () { this._openAnalysis(this._ui.getProperty("/ai"), true); },

    onTabSelect: function (e) {
      var key = e.getParameter("key");
      this._ui.setProperty("/tab", key);
      if (key === "ai") { setTimeout(this._restoreAiSelection.bind(this), 0); }
      if (key === "corrections") { setTimeout(this._restoreCorrSelection.bind(this), 0); }
    },

    /** Row click in the Manual Corrections tab: load the text saved for that failure. */
    onCorrSelect: function (e) {
      var item = e.getParameter("listItem");
      var row = item && item.getBindingContext("ui") && item.getBindingContext("ui").getObject();
      if (row && !row.sourceKey) { return; }
      if (row) { this._openCorrection(row); }
    },

    _openCorrection: function (row) {
      var that = this;
      if (!row || !row.sourceKey) { return; }
      var base = Object.assign({}, EMPTY_CORR, {
        source: row.source, sourceLabel: row.sourceLabel, sourceKey: row.sourceKey,
        objectId: row.objectId, category: row.category, system: row.system,
        statusText: row.statusText || "", statusState: statusState(row.statusText || row.state),
        errorText: row.errorText || "", busy: true
      });
      this._ui.setProperty("/corr", base);
      this._ui.setProperty("/tab", "corrections");
      var fn = this.getView().getModel().bindContext("/getManualCorrection(...)");
      fn.setParameter("source", row.source);
      fn.setParameter("sourceKey", row.sourceKey);
      fn.execute().then(function () {
        var res = fn.getBoundContext().getObject() || {};
        if (Array.isArray(res.value)) { res = res.value[0] || {}; }
        var saved = res.correction || null;
        var text = saved && saved.correctionText ? saved.correctionText : "";
        that._ui.setProperty("/corr", Object.assign({}, base, {
          busy: false, text: text, savedText: text, editing: !text,
          metaText: saved ? that._correctionMeta(saved) : ""
        }));
      }).catch(function (err) {
        that._ui.setProperty("/corr", Object.assign({}, base, { busy: false, editing: true, message: err.message, messageType: "Error" }));
      });
    },

    _correctionMeta: function (saved) {
      var when = saved.modifiedAt || saved.createdAt;
      var date = when ? new Date(when) : null;
      var stamp = date && !isNaN(date.getTime()) ? fmtFull.format(date) : "";
      var by = saved.modifiedBy || saved.createdBy || "";
      return [by ? "Saved by " + by : "", stamp].filter(Boolean).join(", ");
    },

    onEditCorrection: function () {
      this._ui.setProperty("/corr/editing", true);
      this._ui.setProperty("/corr/message", "");
    },

    onResetCorrection: function () {
      this._ui.setProperty("/corr/text", this._ui.getProperty("/corr/savedText") || "");
      this._ui.setProperty("/corr/editing", false);
      this._ui.setProperty("/corr/message", "");
    },

    onSaveCorrection: function () { this._saveCorrectionText(this._ui.getProperty("/corr/text") || ""); },

    onDeleteCorrection: function () {
      var that = this;
      MessageBox.confirm("Delete the saved correction for this failure?", {
        title: "Delete correction",
        onClose: function (action) {
          if (action === MessageBox.Action.OK) { that._saveCorrectionText(""); }
        }
      });
    },

    _saveCorrectionText: function (text) {
      var that = this;
      var corr = this._ui.getProperty("/corr") || {};
      if (!corr.sourceKey) { return; }
      this._ui.setProperty("/corr/saving", true);
      var action = this.getView().getModel().bindContext("/saveManualCorrection(...)");
      action.setParameter("source", corr.source);
      action.setParameter("sourceKey", corr.sourceKey);
      action.setParameter("correctionText", text);
      action.setParameter("objectId", corr.objectId || "");
      action.setParameter("category", corr.category || "");
      action.setParameter("system", corr.system || "");
      action.setParameter("errorText", corr.errorText || "");
      action.execute().then(function () {
        var res = action.getBoundContext().getObject() || {};
        if (Array.isArray(res.value)) { res = res.value[0] || {}; }
        var saved = res.correction || null;
        var savedText = saved && saved.correctionText ? saved.correctionText : "";
        that._ui.setProperty("/corr", Object.assign({}, corr, {
          saving: false, text: savedText, savedText: savedText, editing: !savedText,
          metaText: saved ? that._correctionMeta(saved) : "",
          message: savedText ? "Correction saved. It is shown in the AI analysis of similar failures." : "Correction deleted.",
          messageType: savedText ? "Success" : "Information"
        }));
        MessageToast.show(savedText ? "Correction saved" : "Correction deleted");
      }).catch(function (err) {
        that._ui.setProperty("/corr", Object.assign({}, corr, { saving: false, message: err.message, messageType: "Error" }));
      });
    },

    _openAnalysis: function (row, refresh) {
      var that = this;
      if (!row || !row.sourceKey) { return; }
      var previous = this._ui.getProperty("/ai") || {};
      var sameObject = previous.sourceKey === row.sourceKey && previous.source === row.source;
      var base = Object.assign({}, EMPTY_AI, {
        source: row.source, sourceLabel: row.sourceLabel, sourceKey: row.sourceKey,
        objectId: row.objectId, category: row.category
      }, sameObject && previous.analysis
        ? { analysis: previous.analysis, analyzedAt: previous.analyzedAt, disclaimer: previous.disclaimer, manualCorrections: previous.manualCorrections || [] }
        : null);
      this._ui.setProperty("/ai", base);
      this._ui.setProperty("/tab", "ai");
      setTimeout(this._restoreAiSelection.bind(this), 0);
      // Even a cached analysis is re-read, so corrections saved in the meantime appear right away;
      // the AI text itself then comes from the server cache and no model call is made.
      this._ui.setProperty("/ai/busy", !base.analysis);
      var action = this.getView().getModel().bindContext("/analyzeFailure(...)");
      action.setParameter("source", row.source);
      action.setParameter("sourceKey", row.sourceKey);
      if (refresh) { action.setParameter("refresh", true); }
      action.execute().then(function () {
        var res = action.getBoundContext().getObject() || {};
        if (Array.isArray(res.value)) { res = res.value[0] || {}; }
        that._ui.setProperty("/ai", Object.assign({}, base, {
          busy: false,
          analysis: res.analysis || "",
          analyzedAt: res.analyzedAt || null,
          disclaimer: res.disclaimer || "",
          manualCorrections: res.manualCorrections || []
        }));
      }).catch(function (err) {
        that._ui.setProperty("/ai", Object.assign({}, base, { busy: false, message: err.message, messageType: "Error" }));
      });
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
