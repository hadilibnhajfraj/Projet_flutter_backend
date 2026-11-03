"use strict";

// Permissions nommées accordées PAR RÔLE, en plus des listes de rôles propres
// à chaque route (requireRole). Une route qui accepte une permission le dit
// explicitement : requireRoleOrPermission(permission, ...rôles) — jamais
// d'accès implicite, jamais de rôle administrateur accordé par ce biais.
//
// ATTRIBUTIONS ENREGISTRÉES EN BASE : table role_permissions (migration
// 20261108090000-create-role-permissions.js), relue toutes les 60 s au plus.
// Le code ne fait que DÉCLARER les permissions existantes : une permission
// absente de la table n'est accordée à personne (refus, jamais d'accès par
// défaut), une ligne de la table portant un nom non déclaré est ignorée.
//
// Distinct des permissions production.* du workflow des demandes
// (config/productionWorkflow.js : accordées par email, avec droits de
// décision) : celles-ci ne donnent que de la CONSULTATION.

const logger = require("../utils/logger");

const PERMISSIONS = Object.freeze({
  // Module Production — consultation GLOBALE en lecture seule : récapitulatifs
  // PROBAR / PROMESH, listes et détails des fiches (données de production et
  // de contrôle qualité enregistrées dans la fiche), statistiques, rapport
  // PDF, historique de validation. Uniquement sur des routes GET : aucune
  // création, modification, suppression, validation ni archivage.
  PRODUCTION_READ_ALL: "production.read_all",
});

const DECLARED = new Set(Object.values(PERMISSIONS));
const CACHE_MS = 60 * 1000;
let cache = { at: 0, grants: new Map(), error: null };

/** Relit role_permissions (au plus toutes les 60 s, ou immédiatement si `force`). */
async function loadRolePermissions({ force = false } = {}) {
  if (!force && cache.at && Date.now() - cache.at < CACHE_MS) return cache;
  const { sequelize } = require("../db");
  try {
    const rows = await sequelize.query(`SELECT role, permission FROM role_permissions`, { type: sequelize.QueryTypes.SELECT, logging: false });
    const grants = new Map();
    for (const { role, permission } of rows) {
      if (!DECLARED.has(permission)) {
        logger.warn(`[ROLE-PERMISSIONS] permission non déclarée ignorée : ${role} → ${permission}`);
        continue;
      }
      if (!grants.has(role)) grants.set(role, []);
      grants.get(role).push(permission);
    }
    cache = { at: Date.now(), grants, error: null };
  } catch (e) {
    // Table absente (migration non exécutée) ou base indisponible : AUCUNE
    // permission accordée (refus), jamais un repli sur une liste en dur.
    if (cache.error !== e.message) logger.error(`[ROLE-PERMISSIONS] lecture de role_permissions impossible — aucune permission accordée : ${e.message}`);
    cache = { at: Date.now(), grants: new Map(), error: e.message };
  }
  return cache;
}

/** Permissions du rôle d'après la dernière lecture de la base (synchrone). */
function permissionsOfRole(role) {
  return cache.grants.get(role) || [];
}

function roleHasPermission(role, permission) {
  return permissionsOfRole(role).includes(permission);
}

/** Variante asynchrone : garantit une lecture récente de la base. */
async function rolePermissions(role) {
  await loadRolePermissions();
  return permissionsOfRole(role);
}

module.exports = {
  PERMISSIONS,
  loadRolePermissions,
  rolePermissions,
  permissionsOfRole,
  roleHasPermission,
  lastLoadError: () => cache.error,
  _resetCache: () => (cache = { at: 0, grants: new Map(), error: null }),
};
