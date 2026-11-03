"use strict";

// DIAGNOSTIC TEMPORAIRE des contrôles d'accès — une ligne par étape :
//   [ACCESS-TRACE] ALLOW|DENY middleware=<étape> email= role= permissions=
//                  endpoint="<méthode> <chemin>" attendu=<permission/rôles> raison="..."
// et, pour chaque refus, une ligne [PERMISSION-DENIED] détaillée (rôle relu
// en base, compte actif). Jamais le jeton, le mot de passe, les paramètres de
// requête ni les données métier. PERMISSION_DIAGNOSTICS=false pour désactiver.

const logger = require("./logger");
const { permissionsOfRole } = require("../config/rolePermissions");

const enabled = () => process.env.PERMISSION_DIAGNOSTICS !== "false";
const endpointOf = (method, url) => `${method} ${String(url || "").split("?")[0]}`;

/** Trace d'une décision d'accès (ALLOW ou DENY) pour une étape donnée. */
function traceAccess({ middleware, decision, method, url, user = {}, expected, reason, permissions }) {
  if (!enabled()) return;
  const perms = permissions ?? permissionsOfRole(user.role);
  const line =
    `[ACCESS-TRACE] ${decision} middleware=${middleware} email=${user.email || "-"} role=${user.role || "-"}` +
    ` permissions=${JSON.stringify(perms)} endpoint="${endpointOf(method, url)}" attendu=${expected || "-"} raison="${reason}"`;
  if (decision === "DENY") logger.warn(line);
  else logger.info(line);
}

/**
 * Détail d'un refus (403 PERMISSION_DENIED) : rôle du jeton ET rôle relu en base.
 * @param {object} o
 * @param {string} o.method
 * @param {string} o.url          chemin demandé (la query string est retirée)
 * @param {{sub?: string, email?: string, role?: string}} o.user  contenu du jeton
 * @param {string} o.expected     permission ou rôles attendus
 * @param {string} o.reason       motif exact du refus
 * @param {object|null} [o.dbUser] compte déjà relu en base (sinon relu ici)
 */
async function logPermissionDenied({ method, url, user = {}, expected, reason, dbUser }) {
  if (!enabled()) return;
  try {
    let db = dbUser;
    if (db === undefined && user.sub) {
      const User = require("../models/User");
      db = await User.findByPk(user.sub, { attributes: ["id", "email", "role", "isActive"] });
    }
    const effectiveRole = db?.role ?? user.role;
    logger.warn(
      `[PERMISSION-DENIED] email=${user.email || "-"} id=${user.sub || "-"} roleJwt=${user.role || "-"} roleBase=${db ? db.role : "introuvable"}` +
        ` actif=${db ? db.isActive !== false : "-"} permissions=${JSON.stringify(permissionsOfRole(effectiveRole))}` +
        ` endpoint="${endpointOf(method, url)}" attendu=${expected} motif="${reason}"`
    );
  } catch (e) {
    logger.error(`[PERMISSION-DENIED] diagnostic impossible : ${e.message}`);
  }
}

module.exports = { logPermissionDenied, traceAccess };
