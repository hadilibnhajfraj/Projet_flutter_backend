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
// l'identité réelle du compte, de même que les lectures Production si le rôle
// a la permission production.read_all. Aucun jeton n'est journalisé.

const cfg = require("../config/backofficeReadOnly");
const { PERMISSIONS, roleHasPermission, loadRolePermissions, lastLoadError } = require("../config/rolePermissions");
const { verifyAccessToken, signAccessToken } = require("../utils/tokens");
const logger = require("../utils/logger");
const { logPermissionDenied, traceAccess } = require("../utils/permissionDiagnostics");

const CACHE_MS = 60 * 1000;
let cache = { at: 0, email: null, user: null };
// Compte back-office RELU en base (rôle, actif) pour la consultation
// Production — jamais le seul rôle du jeton : un rôle retiré ou un compte
// désactivé perd l'accès en 60 s au plus, sans attendre l'expiration du JWT.
let accounts = new Map();

async function accountFromDb(id) {
  const hit = accounts.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.user;
  const User = require("../models/User");
  const user = await User.findByPk(id, { attributes: ["id", "email", "role", "isActive"] });
  accounts.set(id, { at: Date.now(), user });
  return user;
}

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

  const trace = (decision, reason, expected) =>
    traceAccess({ middleware: "readOnlyRoleGuard", decision, method, url: req.originalUrl, user: decoded, expected, reason });

  if (!cfg.READ_METHODS.has(method)) {
    if (cfg.isAllowedWrite(method, path)) return next();
    if (cfg.isProductionRead(path)) trace("DENY", "écriture interdite au compte en consultation seule (READ_ONLY_ACCOUNT)", "méthode GET");
    logger.warn(`[BACKOFFICE] écriture refusée ${method} ${path} user=${decoded.email}`);
    return deny(res, "READ_ONLY_ACCOUNT", "Compte back-office en consultation uniquement : aucune création, modification ou suppression.");
  }
  if (method === "OPTIONS") return next();
  if (cfg.isBlockedRead(path)) {
    logger.warn(`[BACKOFFICE] lecture à effet de bord refusée ${path} user=${decoded.email}`);
    return deny(res, "READ_ONLY_ACCOUNT", "Action non disponible en consultation uniquement.");
  }
  // Identité réelle : routes propres au compte, et consultation globale du
  // module Production si le rôle a production.read_all (lecture seule, voir
  // PRODUCTION_READ_PREFIXES).
  if (cfg.usesOwnIdentity(path)) return next();
  if (cfg.isProductionRead(path)) {
    const READ_ALL = PERMISSIONS.PRODUCTION_READ_ALL;
    let me;
    try {
      me = await accountFromDb(decoded.sub);
      await loadRolePermissions(); // attributions lues en base (role_permissions)
    } catch (e) {
      logger.error(`[BACKOFFICE] lecture du compte impossible : ${e.message}`);
      return deny(res, "PERMISSION_DENIED", "Consultation Production indisponible.");
    }
    if (me && me.isActive !== false && me.role === decoded.role && roleHasPermission(me.role, READ_ALL)) {
      trace("ALLOW", `rôle en base = rôle du jeton (${me.role}), ${READ_ALL} dans role_permissions : identité réelle conservée (aucun compte de référence)`, READ_ALL);
      return next();
    }
    const reason = !me
      ? "compte introuvable en base"
      : me.isActive === false
        ? "compte désactivé"
        : me.role !== decoded.role
          ? `rôle du jeton (${decoded.role}) différent du rôle en base (${me.role}) : reconnexion requise`
          : lastLoadError()
            ? `permissions illisibles en base (role_permissions) : ${lastLoadError()}`
            : `rôle ${me.role} sans la permission ${READ_ALL} dans role_permissions`;
    trace("DENY", reason, READ_ALL);
    logPermissionDenied({ method, url: req.originalUrl, user: decoded, expected: READ_ALL, reason, dbUser: me || null });
    return deny(res, "PERMISSION_DENIED", "Consultation Production non autorisée pour ce compte.");
  }

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

module.exports = {
  readOnlyRoleGuard,
  _resetCache: () => {
    cache = { at: 0, email: null, user: null };
    accounts = new Map();
  },
};
