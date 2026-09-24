"use strict";

// Contrôle quotidien des fiches PROD 1 / PROD 2 — UN seul module de
// planification (heure de Tunis) : une exécution à la fin de la plage de
// chaque production (14:30 / 22:00) + un balayage de rattrapage toutes les
// 30 minutes (serveur redémarré, e-mail échoué). Tout passe par la même
// fonction idempotente (runCheck) : une alerte n'est jamais envoyée deux fois
// pour un même utilisateur + production + date, même avec plusieurs
// instances ou plusieurs exécutions.

const cron = require("node-cron");
const logger = require("../utils/logger");
const cfg = require("../config/productionCompliance");
const alerts = require("../modules/production-compliance/services/alerts.service");
const mail = require("../modules/production-compliance/services/mail");

if (!cfg.enabled) {
  logger.info("[productionCompliance.job] PRODUCTION_COMPLIANCE_ENABLED=false — not scheduled.");
} else {
  for (const prod of Object.values(cfg.productions)) {
    const [h, m] = prod.end.split(":").map(Number);
    cron.schedule(
      `${m} ${h} * * *`,
      () => alerts.runCheck(prod.key).then((r) => logger.info(`[productionCompliance] ${prod.label} ${prod.end}: ${r.result}`)).catch((e) => logger.error(`[productionCompliance] ${prod.label}: ${e.stack || e.message}`)),
      { timezone: cfg.timezone }
    );
  }
  cron.schedule("*/30 * * * *", () => alerts.sweepAll().catch((e) => logger.error(`[productionCompliance] sweep: ${e.message}`)), {
    timezone: cfg.timezone,
  });
  // Vérification SMTP réelle au démarrage : [PRODUCTION-COMPLIANCE-MAIL] SMTP connection: OK|FAILED
  setTimeout(() => mail.verify().catch((e) => logger.error(`[PRODUCTION-COMPLIANCE-MAIL] SMTP connection: FAILED ${e.message}`)), 10 * 1000).unref?.();
  // Rattrapage après un redémarrage (laisse le temps à la DB de se connecter).
  setTimeout(() => alerts.sweepAll().catch(() => {}), 45 * 1000).unref?.();
  logger.info(
    `[productionCompliance.job] scheduled (${cfg.timezone}): ` +
      Object.values(cfg.productions).map((p) => `${p.label} ${p.end}`).join(", ") +
      ` + sweep */30min`
  );
}
