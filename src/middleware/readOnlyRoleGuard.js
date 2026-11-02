"use strict";

// Garde du rôle `backoffice_readonly` (règles : config/backofficeReadOnly.js).
// Monté dans app.js AVANT tous les routeurs : aucune route ne peut le
// contourner, quel que soit son propre contrôle d'accès.
//
//   1. Toute requête d'écriture (POST / PUT / PATCH / DELETE…) → 403, sauf
//      l'authentification du compte lui-même.
//   2. Lectures à effet de bord (agenda Google) → 403.
//   3. Autres lectures : exécutées avec l'identité du compte de référence
//      (en-tête Authorization remplacé par un jeton de ce compte, porteur de
//      `viewAs` = le compte back-office) — exactement sa visibilité, jamais
//      plus. Le compte de référence doit exister, être actif et ne jamais être
//      administrateur ; sinon refus (403, jamais d'accès élargi).
// Les routes d'identité (/auth, /users/me, /me, /notifications) gardent
// l'identité réelle du compte. Aucun jeton n'est journalisé.

const cfg = require("../config/backofficeReadOnly");
const { verifyAccessToken, signAccessToken } = require("../utils/tokens");
const logger = require("../utils/logger");

const CACHE_MS = 60 * 1000;
let cache = { at: 0, email: null, user: null };

async function referenceUser() {
  const email = cfg.referenceEmail();
  if (cache.email === email && Date.now() - cache.at < CACHE_MS) return cache.user;
  const User = require("../models/User");
  const user = await User.findOne({ where: { email }, attributes: ["id", "email", "role", "isActive"] });
  cache = { at: Date.now(), email, user };
  return user;
}

function deny(res, code, message) {
  return res.status(403).json({ success: false, code, message });
}

async function readOnlyRoleGuard(req, res, next) {
  const header = req.headers.authorization || "";
  const [type, token] = header.split(" ");
  if (type !== "Bearer" || !token) return next();

  let decoded;
  try {
    decoded = verifyAccessToken(token);
  } catch (_) {
    return next(); // jeton invalide / expiré : la route renvoie elle-même 401
  }
  if (!cfg.isReadOnlyRole(decoded.role)) return next();

  const method = req.method.toUpperCase();
  const path = req.path;

  if (!cfg.READ_METHODS.has(method)) {
    if (cfg.isAllowedWrite(method, path)) return next();
    logger.warn(`[BACKOFFICE] écriture refusée ${method} ${path} user=${decoded.email}`);
    return deny(res, "READ_ONLY_ACCOUNT", "Compte back-office en consultation uniquement : aucune création, modification ou suppression.");
  }
  if (method === "OPTIONS") return next();
  if (cfg.isBlockedRead(path)) {
    logger.warn(`[BACKOFFICE] lecture à effet de bord refusée ${path} user=${decoded.email}`);
    return deny(res, "READ_ONLY_ACCOUNT", "Action non disponible en consultation uniquement.");
  }
  if (cfg.usesOwnIdentity(path)) return next();

  try {
    const ref = await referenceUser();
    if (!ref || ref.isActive === false || cfg.ADMIN_ROLES.has(ref.role) || cfg.isReadOnlyRole(ref.role)) {
      logger.error(`[BACKOFFICE] compte de référence indisponible ou non conforme (${cfg.referenceEmail()}) — lecture refusée`);
      return deny(res, "REFERENCE_UNAVAILABLE", "Consultation indisponible : compte de référence non configuré.");
    }
    req.headers.authorization = `Bearer ${signAccessToken({ sub: ref.id, email: ref.email, role: ref.role, viewAs: decoded.sub })}`;
    req.backofficeActor = { id: decoded.sub, email: decoded.email };
    return next();
  } catch (e) {
    logger.error(`[BACKOFFICE] résolution du compte de référence impossible : ${e.message}`);
    return deny(res, "REFERENCE_UNAVAILABLE", "Consultation indisponible.");
  }
}

module.exports = { readOnlyRoleGuard, _resetCache: () => (cache = { at: 0, email: null, user: null }) };
