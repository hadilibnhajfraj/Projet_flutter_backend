"use strict";

// COMPTE BACK-OFFICE EN CONSULTATION SEULE — source unique des règles.
//
// Rôle `backoffice_readonly` (ex. backoffice@cbi-tunisia.com) :
//   - VISIBILITÉ = celle du compte de référence (par défaut
//     info@probardistribution.com, rôle commercial) : chaque LECTURE est
//     exécutée avec l'identité de ce compte (voir middleware/readOnlyRoleGuard),
//     donc exactement les mêmes modules et la même limite de données — jamais
//     une règle dupliquée, jamais de droits administrateur ;
//   - AUCUNE ÉCRITURE : toute requête autre que GET / HEAD est refusée (403),
//     sauf les routes d'authentification propres au compte (connexion,
//     session, déconnexion, mot de passe oublié / réinitialisation) et, pour
//     le seul module Notes de calcul, Valider / Refuser une note ;
//   - Notes de calcul : VUE GLOBALE (toutes les notes), décidée par le module
//     lui-même (calculationNote.service.js), sans élargir aucun autre module ;
//   - les quelques lectures qui écrivent en base (connexion d'un agenda
//     Google) sont refusées aussi.
// Le frontend ne fait que masquer les actions ; le backend reste l'autorité.

const ROLE = "backoffice_readonly";

// Compte dont la visibilité est reproduite. Surchargé par
// BACKOFFICE_REFERENCE_EMAIL si besoin ; jamais un rôle administrateur
// (vérifié à chaque requête — refus sinon).
const DEFAULT_REFERENCE_EMAIL = "info@probardistribution.com";
const ADMIN_ROLES = new Set(["admin", "superadmin", "superadmin2"]);

// Seules écritures permises : l'authentification du compte lui-même.
const ALLOWED_WRITES = new Set([
  "POST /auth/signin",
  "POST /auth/refresh",
  "POST /auth/logout",
  "POST /auth/forgot-password",
  "POST /auth/reset-password",
]);

// EXCEPTION — module Notes de calcul uniquement : le back-office valide ou
// refuse les notes (mêmes règles que le validateur : première décision
// enregistrée gagnante, motif de refus obligatoire, historique). Ces deux
// écritures passent avec l'identité RÉELLE du compte back-office (jamais
// celle de référence) ; le module revérifie le rôle et le statut de la note.
// Aucune autre écriture n'est ouverte, dans aucun module.
const ALLOWED_WRITE_PATTERNS = [/^POST \/calculation-notes\/\d+\/(validate|reject)$/];

// Lectures exécutées avec l'identité RÉELLE du compte back-office (son
// propre profil, sa session, ses notifications) — jamais celle de référence.
const OWN_IDENTITY_PREFIXES = ["/auth", "/users/me", "/me", "/notifications"];

// Lectures qui modifient des données (connexion d'un agenda Google au compte
// de référence) : refusées.
const BLOCKED_READ_PREFIXES = ["/google-calendar/auth-url", "/google-calendar/callback"];

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function referenceEmail() {
  return String(process.env.BACKOFFICE_REFERENCE_EMAIL || DEFAULT_REFERENCE_EMAIL).trim().toLowerCase();
}

// Express route sans tenir compte de la casse ni des barres obliques en
// double / en fin : le chemin est normalisé AVANT toute comparaison (sinon
// « /Google-Calendar/auth-url/ » contournerait le blocage).
function normalizePath(path) {
  const p = String(path || "/").toLowerCase().replace(/\/{2,}/g, "/");
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

const startsWithAny = (path, prefixes) => {
  const p = normalizePath(path);
  return prefixes.some((x) => p === x || p.startsWith(`${x}/`));
};

module.exports = {
  ROLE,
  ADMIN_ROLES,
  ALLOWED_WRITES,
  ALLOWED_WRITE_PATTERNS,
  OWN_IDENTITY_PREFIXES,
  BLOCKED_READ_PREFIXES,
  READ_METHODS,
  referenceEmail,
  isReadOnlyRole: (role) => role === ROLE,
  normalizePath,
  isAllowedWrite: (method, path) => {
    const key = `${String(method).toUpperCase()} ${normalizePath(path)}`;
    return ALLOWED_WRITES.has(key) || ALLOWED_WRITE_PATTERNS.some((re) => re.test(key));
  },
  usesOwnIdentity: (path) => startsWithAny(path, OWN_IDENTITY_PREFIXES),
  isBlockedRead: (path) => startsWithAny(path, BLOCKED_READ_PREFIXES),
};
