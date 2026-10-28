"use strict";

// Demandes de matières premières du vendredi encore EN ATTENTE DE VALIDATION
// après l'échéance (vendredi 14 h, heure de Tunis) : alerte de retard au
// demandeur et au responsable logistique achats, une seule fois par demande.
// Le statut n'est jamais modifié (aucune validation automatique).

const cron = require("node-cron");
const logger = require("../utils/logger");
const cfg = require("../config/rawMaterialRequest");
const svc = require("../modules/raw-material-requests/services/rawMaterialRequest.service");

const sweep = () =>
  svc
    .sweepLate()
    .then((r) => r.notified && logger.info(`[RAW-MATERIAL-REQUEST] late sweep: ${r.notified} alerte(s) envoyée(s)`))
    .catch((e) => logger.error(`[RAW-MATERIAL-REQUEST] late sweep error: ${e.stack || e.message}`));

if (process.env.JEST_WORKER_ID || !cfg.enabled) {
  // Tests unitaires / fonctionnalité désactivée : rien n'est planifié.
} else {
  // Toutes les 5 minutes : l'alerte part au plus 5 min après l'échéance.
  cron.schedule("*/5 * * * *", sweep, { timezone: cfg.TZ });
  // Rattrapage après un redémarrage (serveur arrêté à 14 h).
  setTimeout(sweep, 60 * 1000).unref?.();
  logger.info(`[rawMaterialRequestLate.job] scheduled (${cfg.TZ}): every 5 min + startup catch-up`);
}

module.exports = { sweep };
