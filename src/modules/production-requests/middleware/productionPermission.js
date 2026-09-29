"use strict";

// Garde des permissions production.* (voir config/productionWorkflow.js) —
// même mécanique que requireManager (production-compliance) : l'utilisateur
// est TOUJOURS relu en base (actif, id cohérent avec le JWT), jamais le seul
// JWT. Accès si responsable historique (cfg.managers / rôle admin) OU si la
// permission demandée est accordée nominativement à son email.

const compliance = require("../../production-compliance/services/compliance.service");
const ProductionRequestAudit = require("../../../models/ProductionRequestAudit");
const logger = require("../../../utils/logger");

function requireProductionPermission(permission) {
  return async (req, res, next) => {
    try {
      const user = await compliance.findUserByEmail(req.user?.email);
      const valid = !!user && user.id === req.user.sub && user.isActive !== false;
      const granted = valid && compliance.hasProductionPermission(user, permission);
      logger.info(
        `[PRODUCTION-WORKFLOW ACCESS] email: ${req.user?.email || "-"} | role: ${user?.role || "-"} | permission: ${permission} | access: ${granted ? "GRANTED" : "DENIED"}`
      );
      if (!granted) {
        // Tentative refusée sur une action (approve/reject) : tracée aussi.
        if (req.method !== "GET" && req.params?.id) {
          ProductionRequestAudit.create({
            userId: req.user?.sub || null,
            userEmail: req.user?.email || null,
            action: permission.endsWith(".approve") ? "APPROVE" : "REJECT",
            requestType: permission.startsWith("production.archive") ? "UNARCHIVE" : "AUTHORIZATION",
            requestId: /^[0-9a-f-]{36}$/i.test(req.params.id) ? req.params.id : null,
            outcome: "DENIED",
            httpStatus: 403,
            details: { permission },
          }).catch((err) => logger.error(`[PRODUCTION-WORKFLOW AUDIT] échec: ${err.message}`));
        }
        return res.status(403).json({ success: false, code: "NOT_A_MANAGER", message: "Only a production compliance manager can access this." });
      }
      req.productionActor = { id: user.id, email: user.email, role: user.role };
      return next();
    } catch (err) {
      logger.error(`[PRODUCTION-WORKFLOW ACCESS] error: ${err.stack || err.message}`);
      return res.status(500).json({ success: false, message: "Permission check failed" });
    }
  };
}

module.exports = { requireProductionPermission };
