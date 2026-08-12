const cron = require("node-cron");
const logger = require("../utils/logger");
const porPromeshService = require("../modules/por-promesh/services/porPromesh.service");
const industrialRecordService = require("../modules/industrial-records/services/industrialRecord.service");

console.log("🔒 FICHE AUTO-VALIDATION CRON LOADED");

// ═══════════════════════════════════════════════════════════════════════
// "Configuration métier — verrouillage automatique des fiches" : toute
// fiche PROBAR/PROMESH restée en Brouillon plus de 24h (calculées depuis
// createdAt, jamais depuis le démarrage du serveur) passe automatiquement
// au statut existant "Validée" — SEULEMENT si elle remplit déjà les mêmes
// conditions que la validation manuelle (mêmes champs obligatoires que
// POST /por-promesh/:id/validate et PUT /industrial-records/:id avec
// statut=validee — voir missingRequiredFieldsForValidation/
// missingRequiredFieldsForProbarValidation). Une fiche incomplète reste en
// brouillon au-delà de 24h plutôt que d'être verrouillée de force.
//
// Ce cron est le mécanisme PRINCIPAL (toutes les 5 minutes) ; un filet de
// sécurité identique (même règle, même code) tourne aussi à la lecture
// d'une fiche unique (getPorPromeshById/getRecordById) pour ne jamais
// laisser une fiche bloquée en brouillon si ce cron n'est pas encore passé.
//
// N'affecte JAMAIS les fiches créées avant l'introduction de cette règle —
// voir AUTO_VALIDATION_CUTOFF_AT dans chaque service (par défaut
// 2026-08-11T00:00:00Z, overridable en .env).
// ═══════════════════════════════════════════════════════════════════════

// Actif par défaut (règle métier demandée explicitement, pas une
// automatisation optionnelle comme les autres crons de ce dossier) —
// AUTO_VALIDATION_ENABLED=false en .env pour désactiver sans redéploiement.
const AUTO_VALIDATION_ENABLED = process.env.AUTO_VALIDATION_ENABLED !== "false";

async function runFicheAutoValidationSweep() {
  try {
    const [promesh, probar] = await Promise.all([
      porPromeshService.sweepAutoValidation(),
      industrialRecordService.sweepAutoValidation(),
    ]);
    if (promesh.validated || probar.validated) {
      logger.info(
        `[ficheAutoValidation] Déverrouillage automatique — PROMESH ${promesh.validated}/${promesh.checked} vérifiées, ` +
          `PROBAR ${probar.validated}/${probar.checked} vérifiées`
      );
    }
  } catch (err) {
    logger.error("[ficheAutoValidation] Erreur du sweep :", err);
  }
}

if (AUTO_VALIDATION_ENABLED) {
  // Toutes les 5 minutes — cadence explicitement demandée.
  cron.schedule("*/5 * * * *", runFicheAutoValidationSweep, {
    timezone: "Africa/Tunis",
  });
} else {
  console.log("[ficheAutoValidation.job] AUTO_VALIDATION_ENABLED=false — cron NOT scheduled.");
}

module.exports = { runFicheAutoValidationSweep };
