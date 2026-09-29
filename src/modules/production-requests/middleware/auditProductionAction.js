"use strict";

// Trace dans production_request_audit_log chaque décision (APPROVE / REJECT)
// prise sur une demande Production — utilisateur, email, horodatage, demande,
// ancienne valeur (PENDING : seules les demandes en attente sont décidables,
// voir loadPendingForUpdate) et nouvelle valeur (statut renvoyé par le
// service). Posé AUTOUR des contrôleurs existants, sans les modifier.
// Une décision refusée (409 déjà traitée, 400 motif manquant...) est tracée
// avec outcome=FAILED et le code HTTP. Jamais bloquant pour la réponse.

const ProductionRequestAudit = require("../../../models/ProductionRequestAudit");
const logger = require("../../../utils/logger");

function auditProductionAction(action, requestType) {
  return (req, res, next) => {
    let body;
    const originalJson = res.json.bind(res);
    res.json = (payload) => {
      body = payload;
      return originalJson(payload);
    };

    res.on("finish", () => {
      const ok = res.statusCode < 400;
      const actor = req.productionActor || { id: req.user?.sub, email: req.user?.email };
      ProductionRequestAudit.create({
        userId: actor.id || null,
        userEmail: actor.email || null,
        action,
        requestType,
        requestId: /^[0-9a-f-]{36}$/i.test(req.params?.id || "") ? req.params.id : null,
        oldValue: ok ? "PENDING" : null,
        newValue: ok ? body?.data?.status ?? null : null,
        outcome: ok ? "SUCCESS" : "FAILED",
        httpStatus: res.statusCode,
        details: {
          ...(req.body?.note ? { note: String(req.body.note).slice(0, 1000) } : {}),
          ...(!ok && body?.code ? { code: body.code } : {}),
        },
      }).catch((err) => logger.error(`[PRODUCTION-WORKFLOW AUDIT] échec ${action} ${requestType}: ${err.message}`));
    });

    next();
  };
}

module.exports = { auditProductionAction };
