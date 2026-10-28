"use strict";

// Contrôle CÔTÉ BACKEND : le vendredi, un compte soumis à la demande de
// matières premières (config/rawMaterialRequest.js — par défaut production_1,
// poste Matin) ne peut CRÉER une fiche PROMESH / PROBAR / MÉLANGE qu'une fois
// la demande de ce vendredi soumise (en attente, validée ou en traitement —
// pas rejetée). Les autres jours, et pour tous les autres comptes, rien ne
// change. Attaché uniquement aux routes de création :
//   POST /por-promesh, POST /por-promesh/new, POST /industrial-records
//   (PROBAR et MÉLANGE ; jamais MAINTENANCE)
// Jamais aux mises à jour ni aux lectures.
//
// La demande vaut pour toutes les fiches du vendredi ; la première fiche
// créée lui est rattachée pour la traçabilité.

const cfg = require("../../../config/rawMaterialRequest");
const svc = require("../services/rawMaterialRequest.service");
const logger = require("../../../utils/logger");

/** source: "promesh" | "probar" */
function rawMaterialRequestGuard({ source }) {
  return async function guard(req, res, next) {
    const module = source === "promesh" ? "promesh" : req.body?.module;
    if (source === "probar" && module !== "probar" && module !== "melange") return next(); // maintenance
    const ficheType = module.toUpperCase();
    // Fiche MÉLANGE : pas de poste dans le formulaire → poste du compte.
    const poste = module === "melange" ? cfg.sessionPosteFor(req.user?.email) : req.body?.poste;
    if (!cfg.isRequiredFor({ email: req.user?.email, poste, module })) return next();

    let request;
    try {
      request = await svc.findActiveRequestForFiche({ userId: req.user.sub, poste });
    } catch (err) {
      logger.error(`[RAW-MATERIAL-REQUEST] guard error (${req.method} ${req.originalUrl}): ${err.stack || err.message}`);
      // Échec fermé, comme le contrôle de conformité.
      return res.status(503).json({
        success: false,
        code: "RAW_MATERIAL_REQUEST_CHECK_FAILED",
        message: "La vérification de la demande de matières premières a échoué. Veuillez réessayer.",
      });
    }

    if (!request) {
      logger.info(`[RAW-MATERIAL-REQUEST] BLOCK create ${ficheType} user=${req.user.email} poste=${poste}`);
      return res.status(403).json({
        success: false,
        code: "RAW_MATERIAL_REQUEST_REQUIRED",
        message: "Le vendredi, la demande de matières premières doit être soumise avant de créer une fiche de production.",
      });
    }

    if (request.ficheId) return next(); // déjà rattachée à une fiche de ce vendredi

    const originalJson = res.json.bind(res);
    res.json = (payload) => {
      const ficheId = res.statusCode < 300 ? payload?.data?.id || payload?.id : null;
      if (!ficheId) return originalJson(payload);
      // Lien écrit AVANT la réponse : la demande est rattachée à sa fiche dès que le client voit le succès.
      svc
        .linkToFiche(request.id, { ficheType, ficheId })
        .then(() => logger.info(`[RAW-MATERIAL-REQUEST] linked ${request.requestNumber} fiche=${ficheType}#${ficheId}`))
        .catch((e) => logger.error(`[RAW-MATERIAL-REQUEST] link failed: ${e.message}`))
        .finally(() => originalJson(payload));
      return res;
    };
    return next();
  };
}

module.exports = { rawMaterialRequestGuard };
