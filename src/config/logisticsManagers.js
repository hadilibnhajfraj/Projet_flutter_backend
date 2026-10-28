"use strict";

// Responsables (logistique et production) : SOURCE UNIQUE des comptes qui
// disposent des droits nominatifs du responsable logistique — validation des
// fiches de production, demandes de matières premières, demandes Production
// (rattrapage / désarchivage), récapitulatif de production complet,
// demandes de maintenance.
//
// Par email et non par rôle : ces comptes partagent le rôle
// `responsable_logistique_achat` avec production_1..5, qui ne doivent jamais
// obtenir ces droits. Chaque fonctionnalité garde sa propre variable
// d'environnement (FICHE_APPROVAL_VALIDATORS, RAW_MATERIAL_REQUEST_VALIDATORS,
// …) qui, si elle est définie, remplace cette liste pour elle seule.
// LOGISTICS_MANAGER_EMAILS remplace la liste par défaut partout.

const list = (v, fallback) => (v ? String(v).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : fallback);

const DEFAULT_EMAILS = Object.freeze(["responsable_logistique@cbi-tunisia.com", "responsable_production@cbi-tunisia.com"]);

module.exports = {
  get emails() {
    return list(process.env.LOGISTICS_MANAGER_EMAILS, [...DEFAULT_EMAILS]);
  },
  isLogisticsManager(email) {
    return this.emails.includes(String(email || "").trim().toLowerCase());
  },
};
