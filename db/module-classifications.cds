// SAP module (SD, MM, PP, QM, FI, TM, ...) assigned to one error category, stored in HANA.
// Category = IDoc message type (source 'idoc') or job name (source 'job').
// Rows are written by the AI classifier (classifiedBy 'AI') or by a user override (classifiedBy 'USER').
// Rule-table hits are not stored: they are computed on every request so rule changes apply at once.
namespace ops.monitor;

entity ModuleClassifications {
  key source       : String(10);
  key category     : String(500);
      module       : String(10);
      confidence   : Integer;      // 0..100
      reason       : String(500);
      classifiedBy : String(10);   // AI | USER
      modifiedBy   : String(120);
      modifiedAt   : Timestamp;
}
