"use strict";

// "Production Follow-up" — contrôle quotidien à 23:00 (heure de Tunis) des
// journées de production SANS AUCUNE fiche (§3). UN SEUL scheduler pour cette
// règle (pas de 2e cron concurrent) — complémentaire au cron Production
// Compliance existant (productionCompliance.job.js), jamais fusionné dedans
// ni le remplaçant (§2/§16/§20 : ne rien casser).

const cron = require("node-cron");
const logger = require("../utils/logger");
const cfg = require("../config/productionCompliance");
const followUp = require("../modules/production-follow-up/services/productionFollowUp.service");

if (!followUp.isEnabled()) {
  logger.info("[productionFollowUp.job] PRODUCTION_FOLLOW_UP_ENABLED=false — not scheduled.");
} else {
  logger.info("[PRODUCTION-FOLLOW-UP] JOB STARTED");

  // 23:00 heure de Tunis, tous les jours — §3.
  cron.schedule("0 23 * * *", () => followUp.sweepFollowUp().catch((e) => logger.error(`[PRODUCTION-FOLLOW-UP] scheduled sweep error: ${e.stack || e.message}`)), {
    timezone: cfg.timezone,
  });

  // Rattrapage après un redémarrage (laisse le temps à la DB de se
  // connecter) : couvre à la fois un 23:00 manqué (serveur arrêté) ET le
  // retry d'un e-mail resté PENDING (§11/§17) / la détection d'une
  // régularisation (§15) — sweepFollowUp() est déjà conçu pour ça.
  setTimeout(() => followUp.sweepFollowUp().catch(() => {}), 50 * 1000).unref?.();

  logger.info(`[productionFollowUp.job] scheduled (${cfg.timezone}): daily 23:00 + startup catch-up`);
}

module.exports = {};
