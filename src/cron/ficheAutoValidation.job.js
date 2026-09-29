const cron = require("node-cron");
const logger = require("../utils/logger");
const porPromeshService = require("../modules/por-promesh/services/porPromesh.service");
const industrialRecordService = require("../modules/industrial-records/services/industrialRecord.service");
const draftArchiveService = require("../modules/production-draft-archive/services/draftArchive.service");

console.log("🔒 FICHE AUTO-VALIDATION CRON LOADED");
console.log("🗄️  PRODUCTION DRAFT AUTO-ARCHIVE (8h) — same cron tick, no second scheduler");
logger.info("[PRODUCTION-DRAFT-ARCHIVE] JOB STARTED");

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

// Archivage automatique de TOUT brouillon > 2h (aucune exception de
// complétude, voir draftArchive.service.js). Volontairement dans LE MÊME
// tick cron (pas un 2e scheduler concurrent) : ce fichier est déjà "le cron
// du cycle de vie des fiches PROMESH/PROBAR" ; idempotent (une fiche déjà
// ARCHIVED/archivee est exclue du WHERE, jamais retraitée), et fonctionne
// même après un arrêt prolongé du serveur (comparaison createdAt + 2h <=
// maintenant, jamais basée sur l'heure de démarrage). Le log "CHECK" lui-même
// est émis DANS draftArchiveService.sweepDraftArchive (à chaque appel, même
// sans rien à archiver) — c'est la preuve que le scheduler tourne, distincte
// du résumé "Archivage automatique / No expired drafts found" ci-dessous.
async function runDraftArchiveSweep() {
  try {
    const { promesh, probar } = await draftArchiveService.sweepDraftArchive();
    const total = promesh.archived + probar.archived;
    if (total > 0) {
      logger.info(
        `[PRODUCTION-DRAFT-ARCHIVE] Archivage automatique (8h) — PROMESH ${promesh.archived}/${promesh.checked} vérifiées, ` +
          `PROBAR ${probar.archived}/${probar.checked} vérifiées`
      );
    } else {
      logger.info("[PRODUCTION-DRAFT-ARCHIVE] No expired drafts found.");
    }
  } catch (err) {
    logger.error("[PRODUCTION-DRAFT-ARCHIVE] Erreur du sweep :", err);
  }
}

// `isFirstRun` distingue le rattrapage immédiat au chargement du module
// ("INITIAL CHECK" — preuve que le scheduler démarre bien tout de suite,
// sans attendre 5 minutes ni la moindre requête HTTP/WebSocket) des tocs
// périodiques suivants du cron ("CHECK", toutes les 5 minutes) — même
// fonction, même logique, seul le libellé du log diffère.
async function runFicheLifecycleSweep(isFirstRun = false) {
  logger.info(isFirstRun ? "[PRODUCTION-DRAFT-ARCHIVE] INITIAL CHECK" : "[PRODUCTION-DRAFT-ARCHIVE] CHECK (cron tick)");
  await runFicheAutoValidationSweep();
  await runDraftArchiveSweep();
}

// Le tick cron est TOUJOURS programmé (jamais conditionné à
// AUTO_VALIDATION_ENABLED) : les deux règles ont chacune leur propre coupe-
// circuit indépendant, déjà vérifié À L'INTÉRIEUR de chaque sweep
// (isAutoValidationEnabled() / draftArchiveService.isDraftArchiveEnabled()).
// Avant cette correction, désactiver AUTO_VALIDATION_ENABLED désactivait
// aussi, par erreur, l'archivage automatique à 2h — les deux règles doivent
// pouvoir être coupées indépendamment.
if (AUTO_VALIDATION_ENABLED) {
  console.log("[ficheAutoValidation.job] Déverrouillage automatique 24h : actif.");
} else {
  console.log("[ficheAutoValidation.job] AUTO_VALIDATION_ENABLED=false — règle des 24h désactivée (le cron reste programmé pour l'archivage à 8h).");
}
if (!draftArchiveService.isDraftArchiveEnabled()) {
  console.log("[production-draft-archive] PRODUCTION_DRAFT_ARCHIVE_ENABLED=false — archivage à 8h désactivé (le cron reste programmé pour la règle des 24h).");
}

// Toutes les 5 minutes — cadence explicitement demandée pour les deux règles.
// `() => runFicheLifecycleSweep(false)` (pas une référence directe à la
// fonction) : node-cron appelle son callback avec un argument `now` (Date)
// que runFicheLifecycleSweep interpréterait à tort comme `isFirstRun`.
cron.schedule("*/5 * * * *", () => runFicheLifecycleSweep(false), { timezone: "Africa/Tunis" });
// Rattrapage immédiat au démarrage (serveur arrêté plusieurs heures, ou tout
// juste redémarré : une fiche dépassant déjà les 2h/24h doit être détectée
// sans attendre le premier tick, ni la moindre requête HTTP/WebSocket/
// utilisateur connecté — 100% piloté par le backend).
runFicheLifecycleSweep(true);

module.exports = { runFicheAutoValidationSweep, runDraftArchiveSweep, runFicheLifecycleSweep };
