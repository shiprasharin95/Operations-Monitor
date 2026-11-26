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

  // Chart category labels: long job names are shortened on the axis; the full name stays in the tooltip.
  var LABEL_MAX = 34;

  // One fixed colour per SAP module, so the IDoc and the job chart read the same.
  var MODULE_COLORS = {
    SD: "#0070f2", MM: "#30914c", PP: "#e76500", QM: "#7858ff", PM: "#a93e00", FI: "#d20a0a", CO: "#cc00dc",
    TM: "#049f9a", EWM: "#5d36ff", LE: "#1b90ff", PS: "#8d6e00", HR: "#da6c6c", CROSS: "#5b738b", BASIS: "#3c4f63", UNKNOWN: "#a9b4be"
  };
  function moduleLabel(m) { return m.module + " \u2013 " + m.moduleText; }

  return PageController.extend("ops.monitor.ext.main.Main", {
    onInit: function () {
      PageController.prototype.onInit.apply(this, arguments);
      var period = initialPeriod();
      this._ui = new JSONModel({
        loading: true,
        period: period, periodText: PERIOD_TEXT[period], autoRefresh: true, syncing: false,
        overview: { total: 0, success: 0, error: 0, warning: 0, inProcess: 0, successRate: 0, idocErrors: 0, jobErrors: 0, sources: [] },
        trend: [], categories: [], topErrors: [], failures: [], failuresView: [], failureCount: 0, sourceFilter: "", search: "", unavailableText: "",
        modulesLoading: false, moduleBreakdown: { idocTotal: 0, jobTotal: 0, modules: [], categories: [] }, idocModules: [], jobModules: [],
        idocModuleChartHeight: "160px", jobModuleChartHeight: "160px", moduleAiCount: 0, moduleUnavailableText: "",
        moduleFilter: null, moduleFilterText: "", moduleOptions: [],
        mapping: [], mappingView: [], mappingSource: "", mappingBy: "", mappingSearch: "", mappingBusy: false
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
      var url = this._serviceUrl() + fn + "(" + params + ")";
      var attempt = function () {
        return fetch(url, { headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" }, credentials: "include", cache: "no-store" })
          .then(function (r) {
            var type = r.headers.get("Content-Type") || "";
            if (r.ok && type.indexOf("json") >= 0) { return r.json(); }
            // The approuter answers with an HTML page (login after session timeout, gateway timeout) instead of JSON.
            var err = new Error(type.indexOf("html") >= 0 || r.redirected
              ? fn + ": session expired or request timed out \u2013 please reload the page"
              : fn + " failed: HTTP " + r.status);
            err.retry = r.status >= 500 || type.indexOf("html") >= 0;
            throw err;
          });
      };
      // One retry: the AI classification can make the first call slow; a second call uses the stored result.
      return attempt().catch(function (e) {
        if (!e.retry) { throw e; }
        return new Promise(function (res) { setTimeout(res, 1500); }).then(attempt);
      });
    },

    _load: function () {
      var that = this;
      var period = this._ui.getProperty("/period");
      var fmt = period === "7D" || period === "30D" ? fmtDay : fmtHour;
      this._ui.setProperty("/loading", true);
      var main = Promise.all([this._call("getOverview"), this._call("getTrend"), this._call("getCategories"), this._call("getTopErrors"), this._call("getFailures", "top=200")])
        .then(function (res) {
          var ov = res[0];
          ov.sources = (ov.sources || []).map(function (s) { return Object.assign({ lastSyncText: s.lastSyncAt ? fmtRel.format(new Date(s.lastSyncAt)) : "" }, s); });
          that._ui.setProperty("/overview", ov);
          that._ui.setProperty("/trend", (res[1].value || []).map(function (p) {
            var d = new Date(p.bucket.length === 10 ? p.bucket + "T00:00:00Z" : p.bucket + ":00Z");
            return Object.assign({ label: fmt.format(d) }, p);
          }));
          that._ui.setProperty("/categories", (res[2].value || []).map(function (c) {
            var name = (c.source === "idoc" ? "IDoc: " : "Job: ") + (c.displayCategory || c.category);
            return Object.assign({}, c, { fullName: name, label: name.length > LABEL_MAX ? name.slice(0, LABEL_MAX - 1) + "\u2026" : name });
          }));
          that._ui.setProperty("/topErrors", res[3].value || []);
          var failures = (res[4].rows || []).map(function (f) { return Object.assign({ timeText: f.occurredAt ? fmtFull.format(new Date(f.occurredAt)) : "-" }, f); });
          that._ui.setProperty("/failures", failures);
          that._ui.setProperty("/unavailableText", (res[4].unavailable || []).map(function (u) { return u.message; }).join(" · "));
          that._patchFailureModules();
          that._applyFailureFilter();
        })
        .catch(function (e) { MessageToast.show("Could not load dashboard data: " + e.message); })
        .finally(function () { that._ui.setProperty("/loading", false); });
      // Loaded separately: the first classification of new categories may wait for the AI.
      this._loadModules();
      return main;
    },

    // ------------------------------------------------------------ errors per SAP module
    _loadModules: function () {
      var that = this;
      var seq = (this._moduleSeq || 0) + 1;
      this._moduleSeq = seq;
      if (!this._ui.getProperty("/moduleBreakdown/modules").length) { this._ui.setProperty("/modulesLoading", true); }
      return this._call("getModuleBreakdown").then(function (b) {
        if (seq !== that._moduleSeq) { return; }
        that._ui.setProperty("/moduleBreakdown", b);
        var decorate = function (m) { return Object.assign({}, m, { label: moduleLabel(m), color: MODULE_COLORS[m.module] || MODULE_COLORS.UNKNOWN }); };
        var idoc = (b.modules || []).filter(function (m) { return m.source === "idoc"; }).map(decorate);
        var job = (b.modules || []).filter(function (m) { return m.source === "job"; }).map(decorate);
        that._ui.setProperty("/idocModules", idoc);
        that._ui.setProperty("/jobModules", job);
        that._ui.setProperty("/idocModuleChartHeight", Math.max(160, idoc.length * 38 + 40) + "px");
        that._ui.setProperty("/jobModuleChartHeight", Math.max(160, job.length * 38 + 40) + "px");
        that._ui.setProperty("/moduleAiCount", (b.categories || []).filter(function (c) { return c.classifiedBy === "AI"; }).length);
        that._ui.setProperty("/moduleUnavailableText", (b.unavailable || []).map(function (u) { return u.message; }).join(" · "));
        that._colorModuleChart("idocModuleChart", idoc);
        that._colorModuleChart("jobModuleChart", job);
        that._patchFailureModules();
        that._applyFailureFilter();
        if (that._mappingDialog && that._mappingDialog.isOpen()) { that._buildMapping(); }
      }).catch(function (e) {
        if (seq === that._moduleSeq) { that._ui.setProperty("/moduleUnavailableText", "Module breakdown unavailable: " + e.message); }
      }).finally(function () { if (seq === that._moduleSeq) { that._ui.setProperty("/modulesLoading", false); } });
    },

    // The failure list is classified without the AI (fast); categories the AI has just classified in
    // the breakdown are copied onto the rows here.
    _patchFailureModules: function () {
      var cats = this._ui.getProperty("/moduleBreakdown/categories") || [];
      if (!cats.length) { return; }
      var byKey = {};
      cats.forEach(function (c) { byKey[c.source + "|" + c.category] = c; });
      var rows = this._ui.getProperty("/failures") || [];
      rows.forEach(function (f) {
        var key = f.source + "|" + (f.source === "idoc" ? f.category : f.objectId);
        var c = byKey[key];
        if (c && (f.moduleBy === "NONE" || !f.module || f.module !== c.module)) {
          f.module = c.module; f.moduleText = c.moduleText; f.moduleBy = c.classifiedBy; f.moduleConfidence = c.confidence;
        }
      });
      this._ui.setProperty("/failures", rows);
    },

    _colorModuleChart: function (id, rows) {
      var chart = this.byId(id);
      if (!chart) { return; }
      // Pie slices follow the data order (sorted by errors), so the palette is built in the same order:
      // every module keeps its fixed colour in both pies.
      chart.setVizProperties({ plotArea: { colorPalette: rows.length ? rows.map(function (m) { return m.color; }) : [MODULE_COLORS.UNKNOWN] } });
    },

    _setModuleFilter: function (source, module) {
      var list = this._ui.getProperty(source === "idoc" ? "/idocModules" : "/jobModules") || [];
      var m = list.filter(function (x) { return x.module === module; })[0];
      this._ui.setProperty("/moduleFilter", { source: source, module: module });
      this._ui.setProperty("/moduleFilterText", (source === "idoc" ? "IDoc · " : "Job · ") + (m ? m.label : module));
      this._ui.setProperty("/sourceFilter", source);
      this._applyFailureFilter();
      var t = this.byId("failureTable");
      if (t && t.getDomRef()) { t.getDomRef().scrollIntoView({ behavior: "smooth", block: "start" }); }
    },

    onModuleSelect: function (e) {
      var chart = e.getSource();
      var point = (e.getParameter("data") || [])[0];
      if (!point || !point.data) { return; }
      var label = point.data.Module;
      var source = chart.data("source");
      var list = this._ui.getProperty(source === "idoc" ? "/idocModules" : "/jobModules") || [];
      var m = list.filter(function (x) { return x.label === label; })[0];
      chart.vizSelection([], { clearSelection: true });
      if (m) { this._setModuleFilter(source, m.module); }
    },

    onModuleItemPress: function (e) {
      var m = e.getSource().getBindingContext("ui").getObject();
      this._setModuleFilter(m.source, m.module);
    },

    onClearModuleFilter: function () {
      this._ui.setProperty("/moduleFilter", null);
      this._ui.setProperty("/moduleFilterText", "");
      this._applyFailureFilter();
    },

    // ------------------------------------------------------------ module mapping dialog
    onOpenModuleMapping: function () {
      var that = this;
      var ready = this._ui.getProperty("/moduleOptions").length ? Promise.resolve() : fetch(this._serviceUrl() + "getModules()", { headers: { Accept: "application/json" }, credentials: "include" })
        .then(function (r) { if (!r.ok) { throw new Error("HTTP " + r.status); } return r.json(); })
        .then(function (body) {
          var options = [{ code: "AUTO", label: "Automatic (rules / AI)" }].concat((body.value || []).map(function (m) { return { code: m.code, label: m.code + " \u2013 " + m.text }; }));
          that._ui.setProperty("/moduleOptions", options);
        });
      var dialog = this._mappingDialog ? Promise.resolve(this._mappingDialog) : this.loadFragment({ name: "ops.monitor.ext.main.ModuleMapping" }).then(function (d) {
        that._mappingDialog = d;
        return d;
      });
      Promise.all([ready, dialog]).then(function (res) {
        that._buildMapping();
        res[1].open();
      }).catch(function (e) { MessageBox.error("Could not open the module mapping: " + e.message); });
    },

    onCloseModuleMapping: function () { if (this._mappingDialog) { this._mappingDialog.close(); } },

    _buildMapping: function () {
      var rows = (this._ui.getProperty("/moduleBreakdown/categories") || []).map(function (c) {
        return Object.assign({}, c, { selectedKey: c.module });
      });
      this._ui.setProperty("/mapping", rows);
      this._applyMappingFilter();
    },

    _applyMappingFilter: function () {
      var source = this._ui.getProperty("/mappingSource");
      var by = this._ui.getProperty("/mappingBy");
      var q = (this._ui.getProperty("/mappingSearch") || "").toLowerCase();
      var rows = (this._ui.getProperty("/mapping") || []).filter(function (r) {
        if (source && r.source !== source) { return false; }
        if (by && r.classifiedBy !== by) { return false; }
        return !q || [r.category, r.displayCategory, r.module, r.moduleText, r.reason].join(" ").toLowerCase().indexOf(q) >= 0;
      });
      this._ui.setProperty("/mappingView", rows);
    },

    onMappingFilter: function () { this._applyMappingFilter(); },
    onMappingSearch: function (e) { this._ui.setProperty("/mappingSearch", e.getParameter("newValue")); this._applyMappingFilter(); },

    onModuleOverride: function (e) {
      var that = this;
      var row = e.getSource().getBindingContext("ui").getObject();
      var key = e.getParameter("selectedItem").getKey();
      var action = this.getView().getModel().bindContext("/setModuleClassification(...)");
      action.setParameter("source", row.source);
      action.setParameter("category", row.category);
      action.setParameter("module", key);
      this._ui.setProperty("/mappingBusy", true);
      action.execute().then(function () {
        var r = action.getBoundContext().getObject();
        MessageToast.show((row.displayCategory || row.category) + " \u2192 " + r.module + (key === "AUTO" ? " (automatic)" : " (manual)"));
        return that._loadModules();
      }).catch(function (err) {
        MessageBox.error(err.message, { title: "Could not change the module" });
        that._buildMapping();
      }).finally(function () { that._ui.setProperty("/mappingBusy", false); });
    },

    onReclassify: function () {
      var that = this;
      MessageBox.confirm("Forget all AI module assignments and let the AI classify the categories again? Manual assignments are kept.", {
        title: "Re-run AI classification",
        onClose: function (choice) {
          if (choice !== MessageBox.Action.OK) { return; }
          var action = that.getView().getModel().bindContext("/reclassifyModules(...)");
          that._ui.setProperty("/mappingBusy", true);
          action.execute().then(function () { return that._loadModules(); })
            .then(function () { MessageToast.show("Module classification refreshed"); })
            .catch(function (err) { MessageBox.error(err.message); })
            .finally(function () { that._ui.setProperty("/mappingBusy", false); });
        }
      });
    },

    _applyFailureFilter: function () {
      var source = this._ui.getProperty("/sourceFilter");
      var moduleFilter = this._ui.getProperty("/moduleFilter");
      var q = (this._ui.getProperty("/search") || "").toLowerCase();
      var rows = (this._ui.getProperty("/failures") || []).filter(function (f) {
        if (source && f.source !== source) { return false; }
        if (moduleFilter && (f.source !== moduleFilter.source || f.module !== moduleFilter.module)) { return false; }
        if (!q) { return true; }
        return [f.objectId, f.category, f.displayCategory, f.idocType, f.errorText, f.system, f.partner, f.module, f.moduleText].join(" ").toLowerCase().indexOf(q) >= 0;
      });
      this._ui.setProperty("/failuresView", rows);
      this._ui.setProperty("/failureCount", rows.length);
    },

    onRefresh: function () { this._load(); },
    onPeriodChange: function (e) { var k = e.getParameter("item").getKey(); this._ui.setProperty("/period", k); this._ui.setProperty("/periodText", PERIOD_TEXT[k]); this._load(); },
    onAutoRefreshToggle: function (e) { if (e.getParameter("state")) { this._startTimer(); } else { this._stopTimer(); } },
    onSourceFilter: function (e) {
      var key = e.getParameter("item").getKey();
      var mf = this._ui.getProperty("/moduleFilter");
      if (mf && key && mf.source !== key) { this._ui.setProperty("/moduleFilter", null); this._ui.setProperty("/moduleFilterText", ""); }
      this._ui.setProperty("/sourceFilter", key); this._applyFailureFilter();
    },
    onSearch: function (e) { this._ui.setProperty("/search", e.getParameter("newValue")); this._applyFailureFilter(); },
    onTilePress: function (e) {
      var source = e.getSource().data("source");
      this._ui.setProperty("/sourceFilter", source || "");
      this._applyFailureFilter();
      var t = this.byId("failureTable");
      if (t && t.getDomRef()) { t.getDomRef().scrollIntoView({ behavior: "smooth", block: "start" }); }
    },

    /**
     * Opens the row's detail page in the original monitor (IDoc object page or Job run page) in a new
     * tab. AI analysis and manual corrections are on that detail page.
     */
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
      var axisLabel = { style: { fontSize: "12px", color: "#5b738b" } };
      var base = {
        general: { background: { color: "transparent" } },
        title: { visible: false },
        legend: { visible: true, label: { style: { fontSize: "12px" } } },
        legendGroup: { layout: { position: "bottom", alignment: "center" } },
        valueAxis: { title: { visible: false }, label: axisLabel, axisLine: { visible: false }, color: "#e3e8ee" },
        categoryAxis: { title: { visible: false }, label: axisLabel, axisTick: { visible: false }, color: "#d9d9d9" },
        interaction: { selectability: { mode: "NONE" } }
      };
      var trend = this.byId("trendChart");
      if (trend) {
        trend.setVizProperties(Object.assign({}, base, {
          plotArea: {
            colorPalette: ["#0070f2", "#7858ff"],
            gap: { barSpacing: 0.35 },
            gridline: { color: "#eef1f5" },
            dataLabel: { visible: true, hideWhenOverlap: true, style: { fontSize: "11px", color: "#1d2d3e" } }
          }
        }));
      }
      var cat = this.byId("categoryChart");
      if (cat) {
        cat.setVizProperties(Object.assign({}, base, {
          // Long job names: wrap/shorten the axis labels instead of cutting them off.
          categoryAxis: Object.assign({}, base.categoryAxis, { label: Object.assign({}, axisLabel, { truncatedLabelRatio: 0.45 }) }),
          plotArea: {
            colorPalette: ["#30914c", "#e76500", "#d20a0a"],
            gap: { barSpacing: 0.4 },
            gridline: { color: "#eef1f5" },
            dataLabel: { visible: true, hideWhenOverlap: true, style: { fontSize: "11px", color: "#ffffff" } }
          }
        }));
      }
      ["idocModuleChart", "jobModuleChart"].forEach(function (id) {
        var chart = this.byId(id);
        if (!chart) { return; }
        chart.setVizProperties({
          general: { background: { color: "transparent" } },
          title: { visible: false },
          legend: { visible: true, title: { visible: false }, label: { style: { fontSize: "12px" } } },
          legendGroup: { layout: { position: "right", alignment: "center" } },
          interaction: { selectability: { mode: "SINGLE" } },
          tooltip: { visible: true },
          plotArea: {
            colorPalette: [MODULE_COLORS.UNKNOWN],
            dataLabel: { visible: true, type: "value", hideWhenOverlap: true },
            drawingEffect: "normal"
          }
        });
      }, this);
    }
  });
});
