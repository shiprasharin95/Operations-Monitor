sap.ui.define([
  "sap/m/VBox",
  "sap/m/HBox",
  "sap/m/Text",
  "sap/m/Title",
  "sap/m/Table",
  "sap/m/Column",
  "sap/m/ColumnListItem",
  "sap/m/ObjectStatus",
  "sap/m/FormattedText",
  "sap/m/MessageStrip",
  "sap/m/Button",
  "sap/ui/core/format/DateFormat"
], function (VBox, HBox, Text, Title, Table, Column, ColumnListItem, ObjectStatus, FormattedText, MessageStrip, Button, DateFormat) {
  "use strict";

  var fmtDateTime = DateFormat.getDateTimeInstance({ style: "medium" });

  // ------------------------------------------------------------------ Markdown helpers
  var LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
    });
  }

  /** Escapes first, then re-applies the few inline styles the AI answer uses. */
  function inline(text) {
    var links = [];
    var work = String(text == null ? "" : text).replace(LINK, function (match, label, url) {
      links.push('<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' + escapeHtml(label) + "</a>");
      return "\u0000" + (links.length - 1) + "\u0000";
    });
    work = escapeHtml(work)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
    return work.replace(/\u0000(\d+)\u0000/g, function (match, index) { return links[Number(index)] || ""; });
  }

  /** Plain text for controls that cannot render HTML (Text, ObjectStatus). */
  function plain(text) {
    return String(text == null ? "" : text)
      .replace(LINK, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^\s*[-*+]\s+/, "")
      .trim();
  }

  function listItems(lines) {
    var items = [];
    var seen = false;
    lines.forEach(function (line) {
      var bullet = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(line);
      if (bullet) {
        items.push(bullet[1].trim());
        seen = true;
      } else if (line.trim() && seen) {
        items[items.length - 1] += " " + line.trim();
      }
    });
    return items.filter(Boolean);
  }

  /** Text before the first bullet (e.g. the cited SAP Help paragraph), as inline HTML. */
  function leadHtml(lines) {
    var lead = [];
    lines.forEach(function (line) {
      if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) { return; }
      if (line.trim()) { lead.push(line.trim()); }
    });
    return lead.length ? "<p>" + inline(lead.join(" ")) + "</p>" : "";
  }

  // ------------------------------------------------------------------ Section parsing
  var OVERVIEW_LABELS = {
    "job name": "Job name",
    "message type": "Message type",
    "business purpose": "Business purpose",
    "related sap application": "Related SAP application",
    "direction / partners": "Direction / partners",
    "direction": "Direction",
    "partners": "Partners",
    "idoc type": "IDoc type",
    "status": "Status",
    "system": "System",
    "application": "Application"
  };

  var ROOT_CAUSE_FIELDS = [
    { key: "why", label: /why (it )?happens|^reason$/i },
    { key: "verify", label: /how to verify|how to check|verification/i },
    { key: "resolution", label: /documented resolution|^resolution$|sap documented/i },
    { key: "confidence", label: /confidence/i }
  ];

  function splitSections(markdown) {
    var sections = [{ title: "", lines: [] }];
    String(markdown || "").replace(/\r\n/g, "\n").split("\n").forEach(function (raw) {
      var heading = /^\s{0,3}(#{1,6})\s*(.*)$/.exec(raw.replace(/\s+$/, ""));
      if (heading) {
        sections.push({ title: plain(heading[2]), lines: [] });
      } else {
        sections[sections.length - 1].lines.push(raw.replace(/\s+$/, ""));
      }
    });
    return sections;
  }

  function classify(title) {
    var text = String(title || "").toLowerCase();
    if (/overview|summary/.test(text)) { return "overview"; }
    if (/documented/.test(text)) { return "documented"; }
    if (/root cause|causes|hypothes/.test(text)) { return "rootCauses"; }
    if (/investigation|steps|next step|recommend/.test(text)) { return "steps"; }
    return "other";
  }

  function parseOverview(lines) {
    var pairs = [];
    lines.forEach(function (line) {
      var text = line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim();
      if (!text) { return; }
      var pair = /^([^:]{2,60}):\s*(.*)$/.exec(text);
      if (!pair) {
        if (pairs.length) { pairs[pairs.length - 1].value += " " + plain(text); }
        return;
      }
      var label = plain(pair[1]).replace(/\*+/g, "").trim();
      var key = label.toLowerCase();
      pairs.push({ label: OVERVIEW_LABELS[key] || label, value: plain(pair[2]) || "—" });
    });
    return pairs;
  }

  function parseRootCauses(lines) {
    var causes = [];
    var current = null;
    var lastField = null;

    function flush() {
      if (current && (current.title || current.why || current.resolution)) { causes.push(current); }
      current = null;
      lastField = null;
    }

    function start(title) {
      flush();
      current = { title: plain(title), why: "", verify: "", resolution: "", confidence: "" };
    }

    lines.forEach(function (raw) {
      var text = raw.trim();
      if (!text) { return; }
      if (/^-{3,}$/.test(text)) { flush(); return; }

      var numbered = /^\d+\.\s+(.*)$/.exec(text);
      if (numbered) {
        var boldTitle = /^\*\*(.+?)\*\*\s*[:\-]?\s*(.*)$/.exec(numbered[1]);
        start(boldTitle ? boldTitle[1] : numbered[1]);
        if (boldTitle && boldTitle[2]) { current.why = plain(boldTitle[2]); lastField = "why"; }
        return;
      }

      var fieldLine = /^\s*(?:[-*+]\s+)?([^:]{3,60}):\s*(.*)$/.exec(text);
      if (fieldLine) {
        var fieldKey = null;
        ROOT_CAUSE_FIELDS.forEach(function (field) { if (field.label.test(fieldLine[1])) { fieldKey = field.key; } });
        if (fieldKey) {
          if (!current) { start(""); }
          current[fieldKey] = plain(fieldLine[2]) || "—";
          lastField = fieldKey;
          return;
        }
      }

      // "Description:" on its own is a caption for the numbered causes, not a cause itself.
      if (/^description\s*:?\s*$/i.test(text)) { lastField = null; return; }

      // A bold line that is not one of the known fields starts a new cause.
      var boldLine = /^\*\*(.+?)\*\*:?\s*(.*)$/.exec(text);
      if (boldLine) {
        start(boldLine[1]);
        if (boldLine[2]) { current.why = plain(boldLine[2]); lastField = "why"; }
        return;
      }

      if (current && lastField) {
        current[lastField] += " " + plain(text);
      } else if (current && !current.title) {
        current.title = plain(text);
      } else if (current) {
        current.why = (current.why ? current.why + " " : "") + plain(text);
        lastField = "why";
      } else {
        start(text);
      }
    });

    flush();
    return causes;
  }

  /**
   * Turns the AI Markdown into displayable blocks. Anything unrecognised stays as formatted
   * Markdown, so answers in an older shape still render readably.
   */
  function parse(markdown) {
    var result = { overview: [], documented: [], documentedLead: "", rootCauses: [], steps: [], other: [] };
    var source = String(markdown || "").trim();
    if (!source) { return result; }

    splitSections(source).forEach(function (section) {
      var kind = classify(section.title);
      if (kind === "overview") {
        result.overview = result.overview.concat(parseOverview(section.lines));
      } else if (kind === "documented") {
        result.documented = result.documented.concat(listItems(section.lines));
        result.documentedLead = leadHtml(section.lines) || result.documentedLead;
      } else if (kind === "rootCauses") {
        result.rootCauses = result.rootCauses.concat(parseRootCauses(section.lines));
      } else if (kind === "steps") {
        result.steps = result.steps.concat(listItems(section.lines));
      } else {
        var body = section.lines.join("\n").trim();
        if (body) {
          result.other.push({ title: section.title, html: body.split(/\n{2,}/).map(function (chunk) { return "<p>" + inline(chunk).replace(/\n/g, "<br>") + "</p>"; }).join("") });
        }
      }
    });

    // An answer with no headings at all: treat bullet lists as steps.
    if (!result.overview.length && !result.rootCauses.length && !result.steps.length && result.other.length) {
      var loose = listItems(source.split("\n"));
      if (loose.length > 1) {
        result.steps = loose;
        result.other = [];
      }
    }
    return result;
  }

  function confidenceState(value) {
    var text = String(value || "").toLowerCase();
    if (/high|strong|very|\b(8\d|9\d)\b/.test(text)) { return "Success"; }
    if (/medium|moderate|\b(5\d|6\d|7\d)\b/.test(text)) { return "Warning"; }
    if (/low|weak|uncertain|\b([1-4]\d)\b/.test(text)) { return "Error"; }
    return "Information";
  }

  function hasContent(parsed) {
    return !!(parsed.overview.length || parsed.documented.length || parsed.rootCauses.length || parsed.steps.length || parsed.other.length);
  }

  // ------------------------------------------------------------------ Control
  return VBox.extend("ops.monitor.ext.ai.AiAnalysis", {
    metadata: {
      properties: {
        analysis: { type: "string", defaultValue: "" },
        analyzedAt: { type: "any", defaultValue: null },
        disclaimer: { type: "string", defaultValue: "" },
        manualCorrections: { type: "object", defaultValue: null },
        showGenerate: { type: "boolean", defaultValue: true },
        generateText: { type: "string", defaultValue: "Generate AI Analysis" },
        busy: { type: "boolean", defaultValue: false },
        emptyText: { type: "string", defaultValue: "No AI analysis yet. Generate one to get documented causes, the most likely root causes and the recommended next steps." }
      },
      events: {
        generate: {}
      }
    },

    init: function () {
      VBox.prototype.init.apply(this, arguments);
      this.addStyleClass("aiAnalysis");
      this._rebuild();
    },

    setAnalysis: function (value) { this.setProperty("analysis", value, true); this._rebuild(); return this; },
    setAnalyzedAt: function (value) { this.setProperty("analyzedAt", value, true); this._rebuild(); return this; },
    setManualCorrections: function (value) { this.setProperty("manualCorrections", value, true); this._rebuild(); return this; },
    setBusy: function (value) { this.setProperty("busy", value, true); this._syncButton(); return this; },
    setShowGenerate: function (value) { this.setProperty("showGenerate", value, true); this._rebuild(); return this; },

    _syncButton: function () {
      if (!this._generateButton) { return; }
      var busy = !!this.getBusy();
      this._generateButton.setBusy(busy);
      this._generateButton.setEnabled(!busy);
    },

    _onGenerate: function () { this.fireEvent("generate"); },

    _rebuild: function () {
      if (!this.getAnalysis && !this.getProperty) { return; }
      var parsed = parse(this.getAnalysis());
      var showContent = hasContent(parsed);
      var busy = !!this.getBusy();

      this.destroyItems();
      this._generateButton = null;

      if (showContent) {
        if (this.getDisclaimer()) {
          this.addItem(new MessageStrip({ text: this.getDisclaimer(), type: "Information", showIcon: true }).addStyleClass("aiDisclaimer"));
        }
        if (parsed.overview.length) { this.addItem(this._section("Overview", this._overviewTable(parsed.overview))); }
        if (parsed.rootCauses.length) { this.addItem(this._section("Most Likely Root Causes", this._rootCauseTable(parsed.rootCauses))); }
        if (parsed.documented.length) { this.addItem(this._section("Documented Failure Causes", this._documented(parsed))); }
        if (parsed.steps.length) { this.addItem(this._section("Recommended Investigation Steps", this._bullets(parsed.steps, true))); }
        parsed.other.forEach(function (chunk) {
          this.addItem(this._section(chunk.title || "Further Details", new FormattedText({ htmlText: chunk.html })));
        }.bind(this));
      } else if (busy) {
        this.addItem(new MessageStrip({ text: "Generating the analysis from official SAP documentation…", type: "Information", showIcon: true, customIcon: "sap-icon://ai" }).addStyleClass("aiDisclaimer"));
      } else {
        this.addItem(new MessageStrip({ text: this.getEmptyText(), type: "Information", showIcon: true }).addStyleClass("aiDisclaimer"));
      }

      var corrections = Array.isArray(this.getManualCorrections()) ? this.getManualCorrections() : [];
      if (corrections.length) { this.addItem(this._section("Manual Corrections To Refer", this._manualCorrections(corrections))); }

      if (this.getAnalyzedAt() || (showContent && !busy)) {
        this.addItem(new Text({ text: this._metaText(showContent), class: "aiMeta" }));
      }

      if (this.getShowGenerate()) {
        this._generateButton = new Button({
          text: this.getGenerateText(),
          type: "Emphasized",
          icon: "sap-icon://ai",
          busy: busy,
          enabled: !busy,
          press: this._onGenerate.bind(this)
        }).addStyleClass("aiGenerateButton");
        this.addItem(this._generateButton);
      }
    },

    _metaText: function (showContent) {
      var parts = [];
      var analyzedAt = this.getAnalyzedAt();
      if (analyzedAt) {
        var date = analyzedAt instanceof Date ? analyzedAt : new Date(analyzedAt);
        if (!isNaN(date.getTime())) { parts.push("Analyzed " + fmtDateTime.format(date)); }
      }
      if (showContent) { parts.push("AI-generated from official SAP documentation. Validate before applying changes."); }
      return parts.join("  ·  ");
    },

    _section: function (title, control) {
      return new VBox({
        items: [
          new Title({ text: title, level: "H4" }).addStyleClass("aiSectionTitle"),
          control
        ]
      }).addStyleClass("aiSection");
    },

    _bullets: function (items, ordered) {
      var tag = ordered ? "ol" : "ul";
      var html = "<" + tag + ">" + items.map(function (item) { return "<li>" + inline(item) + "</li>"; }).join("") + "</" + tag + ">";
      return new FormattedText({ htmlText: html }).addStyleClass("aiRichText");
    },

    /** Documented causes: keeps the cited SAP Help paragraph above the bullet list. */
    _documented: function (parsed) {
      var html = (parsed.documentedLead || "")
        + "<ul>" + parsed.documented.map(function (item) { return "<li>" + inline(item) + "</li>"; }).join("") + "</ul>";
      return new FormattedText({ htmlText: html }).addStyleClass("aiRichText");
    },

    /** Manually written corrections from HANA for failures of the same message type / job. */
    _manualCorrections: function (rows) {
      return new VBox({
        items: rows.map(function (row) {
          var meta = [row.objectId, row.system].filter(Boolean).join("  ·  ");
          var when = row.modifiedAt || row.createdAt;
          var date = when ? new Date(when) : null;
          var stamp = date && !isNaN(date.getTime()) ? fmtDateTime.format(date) : "";
          var by = [row.modifiedBy || row.createdBy, stamp].filter(Boolean).join(", ");
          return new VBox({
            items: [
              new HBox({
                alignItems: "Center",
                wrap: "Wrap",
                items: [
                  new ObjectStatus({ text: "Saved correction", state: "Success", inverted: true, icon: "sap-icon://accept" }),
                  new Text({ text: meta }).addStyleClass("aiCorrectionMeta sapUiSmallMarginBegin"),
                  new Text({ text: by }).addStyleClass("aiCorrectionMeta sapUiSmallMarginBegin")
                ]
              }).addStyleClass("aiCorrectionHead"),
              new FormattedText({ htmlText: inline(String(row.correctionText || "")).replace(/\n/g, "<br>") })
                .addStyleClass("aiCorrectionText")
            ]
          }).addStyleClass("aiCorrectionCard");
        })
      }).addStyleClass("aiCorrections");
    },

    _overviewTable: function (pairs) {
      var table = new Table({
        mode: "None",
        growing: false,
        showSeparators: "Inner",
        columns: [
          new Column({ width: "22%", header: new Text({ text: "Attribute" }) }),
          new Column({ header: new Text({ text: "Value" }) })
        ]
      }).addStyleClass("aiTable aiOverviewTable");

      pairs.forEach(function (pair) {
        table.addItem(new ColumnListItem({
          cells: [
            new Text({ text: pair.label }).addStyleClass("aiKey"),
            new Text({ text: pair.value, wrapping: true })
          ]
        }));
      });
      return table;
    },

    _rootCauseTable: function (causes) {
      var table = new Table({
        mode: "None",
        growing: false,
        showSeparators: "All",
        columns: [
          new Column({ width: "18%", header: new Text({ text: "Most Likely Root Cause" }) }),
          new Column({ width: "25%", header: new Text({ text: "Why It Happens" }) }),
          new Column({ width: "23%", header: new Text({ text: "How To Verify" }) }),
          new Column({ width: "26%", header: new Text({ text: "SAP Documented Resolution" }) }),
          new Column({ width: "8%", header: new Text({ text: "Confidence" }) })
        ]
      }).addStyleClass("aiTable aiRootCauseTable");

      causes.forEach(function (cause, index) {
        table.addItem(new ColumnListItem({
          cells: [
            new Text({ text: cause.title || "Possible cause " + (index + 1), wrapping: true }).addStyleClass("aiCauseTitle"),
            new Text({ text: cause.why || "—", wrapping: true }),
            new Text({ text: cause.verify || "—", wrapping: true }),
            new Text({ text: cause.resolution || "—", wrapping: true }),
            cause.confidence
              ? new ObjectStatus({ text: plain(cause.confidence), state: confidenceState(cause.confidence), inverted: true })
              : new Text({ text: "—" })
          ]
        }));
      });
      return table;
    }
  });
});
