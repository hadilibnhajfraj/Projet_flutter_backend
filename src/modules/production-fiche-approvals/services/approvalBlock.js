"use strict";

const { STATUS_LABELS } = require("../../../config/productionFicheApproval");

// Bloc `approval` ajouté aux réponses fiche PROMESH / PROBAR existantes
// (null : fiche hors circuit de validation). Sans dépendance vers les
// modèles, pour être utilisable depuis les DTO.
function toApprovalBlock(r) {
  if (!r || !r.approvalStatus) return null;
  return {
    status: r.approvalStatus,
    label: STATUS_LABELS[r.approvalStatus] || r.approvalStatus,
    version: r.approvalVersion,
    submittedAt: r.approvalSubmittedAt,
    decidedAt: r.approvalDecidedAt,
    decidedByEmail: r.approvalDecidedByEmail,
    rejectedAt: r.approvalRejectedAt,
    rejectionComment: r.approvalRejectionComment,
  };
}

module.exports = { toApprovalBlock };
