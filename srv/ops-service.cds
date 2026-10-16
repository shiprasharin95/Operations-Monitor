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
  type CategoryStat { source : String; sourceLabel : String; category : String; success : Integer; error : Integer; warning : Integer; inProcess : Integer; total : Integer; }
  type TopError { source : String; sourceLabel : String; category : String; errorText : String; count : Integer; }

  type Failure {
    source      : String;
    sourceLabel : String;
    objectId    : String;
    category    : String;
    system      : String;
    state       : String;
    statusText  : String;
    errorText   : String;
    partner     : String;
    occurredAt  : Timestamp;
    detailUrl   : String;
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
}
