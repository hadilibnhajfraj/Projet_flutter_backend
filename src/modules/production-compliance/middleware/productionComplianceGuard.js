"use strict";

// Contrôle CÔTÉ BACKEND de la CRÉATION d'une fiche PROMESH / PROBAR et du
// CHANGEMENT DE DATE d'une fiche par les comptes production_1 / production_2.
//
// Ce middleware n'est attaché QU'aux routes d'écriture :
//   POST /por-promesh, POST /por-promesh/new, PUT /por-promesh/:id,
//   POST /industrial-records, PUT /industrial-records/:id
// Jamais aux GET (ouverture des pages, lecture, listes, historiques, machines,
// modules…) ni à un router.use() global. Une sauvegarde d'une fiche existante
// SANS changement de date n'est pas bloquée non plus.
//
// Refus (HTTP 403, corps structuré) :
//   - BACKFILL_NOT_AUTHORIZED       : date antérieure sans autorisation de rattrapage
//   - PREVIOUS_PRODUCTION_MISSING   : création du jour alors qu'une date passée est manquante
// Chaque décision est journalisée : [PRODUCTION-COMPLIANCE] ...

const svc = require("../services/compliance.service");
const PorPromesh = require("../../../models/PorPromesh");
const IndustrialRecord = require("../../../models/IndustrialRecord");
const logger = require("../../../utils/logger");

function logDecision(req, prod, { requested, decision, reason, missingDate, authorization }) {
  const now = svc.getNow();
  logger.info(
    [
      "[PRODUCTION-COMPLIANCE]",
      `${req.method} ${String(req.originalUrl || "").split("?")[0]}`,
      `user=${req.user?.email}`,
      `production=${prod.key}`,
      `requestedDate=${requested || "-"}`,
      `currentDate=${svc.todayStr(now)}`,
      `currentTime=${svc.tzNow(now).format("HH:mm")}`,
      `productionStart=${prod.start}`,
      `productionEnd=${prod.end}`,
      `missingDate=${missingDate || "-"}`,
      `authorization=${authorization || "none"}`,
      `decision=${decision}`,
      `reason=${reason}`,
    ].join(" ")
  );
}

/**
 * source: "promesh" | "probar"
 * mode:   "create"      → date lue dans le corps (par défaut : aujourd'hui)
 *         "createDraft" → POST /new : date optionnelle du corps, sinon aujourd'hui
 *         "update"      → seulement si le corps CHANGE la date de la fiche existante
 */
function complianceGuard({ source, mode }) {
  const bodyField = source === "promesh" ? "dateProduction" : "dateFiche";

  return async function guard(req, res, next) {
    const email = req.user?.email;
    const prod = svc.getMonitoredByEmail(email);
    if (!prod || !svc.cfg.enabled) return next(); // autres utilisateurs : jamais concernés

    let requested = null;
    try {
      if (mode === "create" || mode === "createDraft") {
        if (source === "probar" && req.body?.module !== "probar") {
          logDecision(req, prod, { decision: "ALLOW", reason: "out_of_scope_module" });
          return next(); // mélange / maintenance : hors périmètre
        }
        requested = svc.normalizeDate(req.body?.[bodyField]);
      } else {
        if (req.body?.[bodyField] === undefined) {
          logDecision(req, prod, { decision: "ALLOW", reason: "no_date_in_body" });
          return next(); // la date ne change pas
        }
        const existing =
          source === "promesh"
            ? await PorPromesh.findByPk(req.params.id, { attributes: ["id", "dateProduction"] })
            : await IndustrialRecord.findByPk(req.params.id, { attributes: ["id", "module", "dateFiche"] });
        if (!existing) return next(); // le contrôleur répondra 404
        if (source === "probar" && existing.module !== "probar") return next();
        const current = svc.normalizeDate(existing[bodyField]);
        requested = svc.normalizeDate(req.body[bodyField]);
        if (requested === current) {
          logDecision(req, prod, { requested, decision: "ALLOW", reason: "date_unchanged" });
          return next();
        }
      }

      const check = await svc.assertCanCreate({ email, userId: req.user.sub, productionDate: requested });

      logDecision(req, prod, {
        requested: check.date,
        decision: "ALLOW",
        reason: check.kind === "backfill" ? "backfill_authorized" : "no_previous_date_missing",
        authorization: check.kind === "backfill" ? `${check.authorization.type}#${check.authorization.id}` : undefined,
      });

      if (check.kind === "backfill") {
        // Consommer l'autorisation UNIQUEMENT si la fiche a réellement été créée / re-datée.
        const ficheType = source === "promesh" ? "PROMESH" : "PROBAR";
        const originalJson = res.json.bind(res);
        res.json = (payload) => {
          const id = res.statusCode < 300 ? payload?.data?.id || payload?.id || (mode === "update" ? req.params.id : null) : null;
          if (!id) return originalJson(payload);
          // L'autorisation (et sa demande) passent à USED AVANT que le client reçoive le succès :
          // pas de fenêtre où la même autorisation pourrait encore servir une 2e fois.
          svc
            .consumeAuthorization(check.authorization.id, { type: ficheType, id })
            .catch((e) => logger.error(`[COMPLIANCE] consume failed: ${e.message}`))
            .finally(() => originalJson(payload));
          return res;
        };
      }
      return next();
    } catch (err) {
      if (err instanceof svc.ComplianceError) {
        logDecision(req, prod, {
          requested: requested || err.extra?.requestedDate,
          decision: "BLOCK",
          reason: err.code,
          missingDate: err.extra?.missingDate,
          authorization: "none",
        });
        return res.status(err.status || 403).json(err.toJSON());
      }
      logger.error(`[PRODUCTION-COMPLIANCE] guard error (${req.method} ${req.originalUrl}): ${err.stack || err.message}`);
      // Échec fermé : en cas d'erreur inattendue pour un compte surveillé, on ne laisse pas passer.
      return res.status(503).json({ success: false, code: "COMPLIANCE_CHECK_FAILED", message: "Le contrôle de conformité de production a échoué. Veuillez réessayer." });
    }
  };
}

module.exports = { complianceGuard };
