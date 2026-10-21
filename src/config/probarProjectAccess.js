"use strict";

// Gestion des projets commerciaux PROBAR — SOURCE UNIQUE de la règle
// "même fonctionnalités que info@probardistribution.com" pour les comptes
// professionnels @probardistribution.com.
//
// Compte de référence : info@probardistribution.com (role=commercial). Ses
// droits fonctionnels sur la gestion des projets sont :
//   - le rôle "commercial" (KPI Commercial Contacts personnels, Commercial
//     Contacts restreints à ses propres contacts/affectations, Mes Projets) ;
//   - la règle nominative "Follow-up" (choix obligatoire du commercial sur une
//     relance datée + automatisation calendrier/email/WhatsApp), auparavant
//     réservée à la seule adresse info@.
// Ces droits sont étendus à tout compte dont :
//   - l'adresse, normalisée (trim + minuscules), a EXACTEMENT le domaine
//     probardistribution.com (une seule "@", partie locale non vide) — jamais
//     une recherche de sous-chaîne : "x@probardistribution.com.evil.tn",
//     "x@evil-probardistribution.com", "x@sub.probardistribution.com" ou
//     "probardistribution.com@gmail.com" sont refusés ;
//   - ET le rôle est "user" ou "commercial". Les rôles admin-tier n'en ont pas
//     besoin (droits déjà supérieurs) et les rôles dédiés (finance_probar,
//     finance_production, responsable_logistique_achat, controle_qualite,
//     accueil) ne sont JAMAIS élargis par cette règle — aucun droit
//     Superadmin/admin n'est accordé ici.
// Le backend est l'autorité : le frontend ne fait que lire le drapeau
// `permissions.probarProjectManager` renvoyé à la connexion (auth.routes.js).
const PROBAR_PROJECT_DOMAIN = "probardistribution.com";
const PROBAR_PROJECT_ELIGIBLE_ROLES = ["user", "commercial"];

function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

function isProbarDomainEmail(email) {
  const parts = normalizeEmail(email).split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  return local.length > 0 && !/\s/.test(local) && domain === PROBAR_PROJECT_DOMAIN;
}

// `user` = payload JWT (req.user : { sub, email, role }) ou instance User.
function isProbarProjectManager(user) {
  const role = String(user?.role ?? "").trim().toLowerCase();
  return PROBAR_PROJECT_ELIGIBLE_ROLES.includes(role) && isProbarDomainEmail(user?.email);
}

// Vrai pour les comptes dont la vue Commercial Contacts est restreinte à
// leurs propres contacts/affectations (comportement historique du rôle
// "commercial", appliqué aussi aux comptes PROBAR pour ne jamais leur donner
// une vue plus large que celle d'info@).
function isCommercialScoped(user) {
  return user?.role === "commercial" || isProbarProjectManager(user);
}

module.exports = {
  PROBAR_PROJECT_DOMAIN,
  PROBAR_PROJECT_ELIGIBLE_ROLES,
  normalizeEmail,
  isProbarDomainEmail,
  isProbarProjectManager,
  isCommercialScoped,
};
