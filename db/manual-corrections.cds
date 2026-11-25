// Manual corrections written by support users, stored in HANA (not in the source monitors).
// One row per failure: the free text describes the steps a colleague performed to fix it and is shown
// again in the AI analysis of every failure with the same source + category (message type / job name).
namespace ops.monitor;

entity ManualCorrections {
  key ID             : UUID;
      source         : String(10);
      sourceKey      : String(200);
      objectId       : String(500);
      category       : String(200);
      system         : String(200);
      errorText      : String(4000);
      correctionText : String(5000);
      createdBy      : String(120);
      createdAt      : Timestamp;
      modifiedBy     : String(120);
      modifiedAt     : Timestamp;
}
