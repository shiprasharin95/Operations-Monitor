// 'User' = OpsMonitor_Viewer; the second is the Job Monitor's User scope (foreign scope reference),
// so JobMonitor_Viewer / JobFailureMonitor_Viewer users can open this dashboard without a new role.
@requires: ['User', 'cloud-alm-job-failure-monitor!t78145.User']
@path: 'ops'
service OperationsService {

  type Counts { total : Integer; success : Integer; error : Integer; warning : Integer; inProcess : Integer; successRate : Decimal(5,2); }

  type SourceStatus {
    source       : String;
    label        : String;
    available    : Boolean;
    message      : String;
    lastSyncAt   : Timestamp;
    lastSyncOk   : Boolean;
    lastSyncInfo : String;
    dashboardUrl : String;
    counts       : Counts;
  }

  type Overview {
    period      : String;
    asOf        : Timestamp;
    total       : Integer;
    success     : Integer;
    error       : Integer;
    warning     : Integer;
    inProcess   : Integer;
    successRate : Decimal(5,2);
    idocErrors  : Integer;
    jobErrors   : Integer;
    sources     : array of SourceStatus;
  }

  type TrendPoint { bucket : String; idocError : Integer; jobError : Integer; idocSuccess : Integer; jobSuccess : Integer; idocWarning : Integer; jobWarning : Integer; }
  // displayCategory: what the dashboard shows. For IDocs with a blank/placeholder message type (ZZZZZ)
  // it is the IDoc basic type (CREMAS06); category stays the real key.
  type CategoryStat { source : String; sourceLabel : String; category : String; displayCategory : String; success : Integer; error : Integer; warning : Integer; inProcess : Integer; total : Integer; }
  type TopError { source : String; sourceLabel : String; category : String; displayCategory : String; errorText : String; count : Integer; }

  type Failure {
    source      : String;
    sourceLabel : String;
    sourceKey   : String;
    objectId    : String;
    category    : String;
    displayCategory : String;
    idocType    : String;
    system      : String;
    state       : String;
    statusText  : String;
    errorText   : String;
    partner     : String;
    occurredAt  : Timestamp;
    detailUrl   : String;
    // SAP module (SD, MM, PP, ...) of the failure's category; moduleBy = USER | RULE | AI | NONE
    module           : String;
    moduleText       : String;
    moduleBy         : String;
    moduleConfidence : Integer;
  }
  type Unavailable { source : String; message : String; }
  type FailureList { period : String; rows : array of Failure; unavailable : array of Unavailable; }
  type SyncResult { source : String; label : String; success : Boolean; message : String; }

  function getOverview(period : String)   returns Overview;
  function getTrend(period : String)      returns array of TrendPoint;
  function getCategories(period : String) returns array of CategoryStat;
  function getTopErrors(period : String)  returns array of TopError;
  function getFailures(period : String, top : Integer) returns FailureList;
  action   syncAll() returns array of SyncResult;

  // Manual corrections: the operations team's own fix steps, stored in HANA. They are shown again in
  // the AI analysis of every failure with the same source + category.
  type ManualCorrectionReference {
    source         : String;
    sourceKey      : String;
    objectId       : String;
    category       : String;
    system         : String;
    correctionText : LargeString;
    createdBy      : String;
    createdAt      : Timestamp;
    modifiedBy     : String;
    modifiedAt     : Timestamp;
  }

  // AI-generated possible resolution for one failure (IDoc or job), via SAP AI Core.
  // The failure is re-read from its monitor as the calling user; only its error facts are sent to the AI.
  type FailureAnalysis {
    source             : String;
    sourceKey          : String;
    objectId           : String;
    analysis           : LargeString;
    analyzedAt         : String;
    disclaimer         : String;
    // Manually written corrections of failures with the same source + category, stored in HANA.
    manualCorrections  : array of ManualCorrectionReference;
  }

  action   analyzeFailure(source : String, sourceKey : String, refresh : Boolean) returns FailureAnalysis;

  // Read/save the manual correction of one failure. Saving an empty text deletes the entry.
  // objectId / category / system / errorText are display metadata; they are re-read from the monitor
  // when possible and only used as a fallback for the stored row.
  type ManualCorrectionResult { source : String; sourceKey : String; correction : ManualCorrectionReference; }
  function getManualCorrection(source : String, sourceKey : String) returns ManualCorrectionResult;

  // ---------------------------------------------------------------- errors per SAP module
  // The module classifier agent assigns each category (IDoc message type / job name) to an SAP module:
  // user override > rule table > AI (SAP AI Core, stored in HANA). Counts come from the monitors.
  type ModuleStat {
    source        : String;
    sourceLabel   : String;
    module        : String;
    moduleText    : String;
    error         : Integer;
    warning       : Integer;
    categoryCount : Integer;
    aiClassified  : Integer;
    topCategories : String;
  }
  type ModuleCategory {
    source       : String;
    category     : String;
    displayCategory : String;
    error        : Integer;
    module       : String;
    moduleText   : String;
    classifiedBy : String;
    confidence   : Integer;
    reason       : String;
  }
  type ModuleBreakdown {
    period      : String;
    idocTotal   : Integer;
    jobTotal    : Integer;
    modules     : array of ModuleStat;
    categories  : array of ModuleCategory;
    unavailable : array of Unavailable;
  }
  type ModuleInfo { code : String; text : String; }
  type ModuleClassificationResult {
    source       : String;
    category     : String;
    module       : String;
    moduleText   : String;
    classifiedBy : String;
    confidence   : Integer;
    reason       : String;
  }

  function getModuleBreakdown(period : String) returns ModuleBreakdown;
  function getModules() returns array of ModuleInfo;
  // module '' or 'AUTO' removes the override.
  action   setModuleClassification(source : String, category : String, module : String) returns ModuleClassificationResult;
  // Forgets all AI decisions (overrides are kept); the next breakdown classifies again.
  action   reclassifyModules() returns Integer;
  action   saveManualCorrection(
    source         : String,
    sourceKey      : String,
    correctionText : String,
    objectId       : String,
    category       : String,
    system         : String,
    errorText      : String
  ) returns ManualCorrectionResult;
}
