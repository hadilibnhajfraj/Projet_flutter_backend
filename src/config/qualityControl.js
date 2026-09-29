"use strict";

// Configuration du module CONTRÔLE QUALITÉ (checklist de production).
//
// PARAMETERS = les 15 paramètres du document papier, dans l'ordre et avec
// les intitulés EXACTS du document — ne jamais renommer/supprimer une entrée
// (les `key` sont stockées en base dans quality_control_items.parameterKey).
// Servie telle quelle au front via GET /quality-control/parameters : Flutter
// ne code jamais cette liste en dur.
//
// `autoTime: true` (HEURE) : pré-rempli avec l'heure de Tunisie du contrôle
// si laissé vide — l'utilisateur ne saisit jamais l'heure par défaut.

const PARAMETERS = [
  { key: "heure", label: "HEURE", autoTime: true },
  { key: "niveau_bain_graines", label: "NIVEAU BAIN DE GRAINES" },
  { key: "diametre_bar", label: "DIAMÈTRE DE BAR" },
  { key: "temperature_machine", label: "TEMPÉRATURE DE MACHINE" },
  { key: "temperature_eau", label: "TEMPÉRATURE D'EAU" },
  { key: "pression_air_comprime", label: "PRESSION D'AIR COMPRIMÉ" },
  { key: "etat_impression", label: "ÉTAT D'IMPRESSION" },
  { key: "nombre_bar_longueur", label: "NOMBRE DE BAR EN LONGUEUR" },
  { key: "dimensions_maille", label: "DIMENSIONS DE MAILLE" },
  { key: "dimensions_cote_1_long", label: "DIMENSIONS COTE 1 LONG" },
  { key: "dimensions_cote_2_long", label: "DIMENSIONS COTE 2 LONG" },
  { key: "fuite_eau", label: "FUITE D'EAU" },
  { key: "fuite_air_comprime", label: "FUITE D'AIR COMPRIMÉ" },
  { key: "etat_disque_coupe", label: "ÉTAT DISQUE DE COUPE" },
  { key: "nombre_bar_largeur", label: "NOMBRE DE BAR EN LARGEUR" },
].map((p, i) => Object.freeze({ autoTime: false, ...p, position: i + 1 }));

const list = (v) => (v ? String(v).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : null);

module.exports = {
  timezone: "Africa/Tunis",

  // Rôle dédié (voir migration 20260925090000) + tiers admin, comme les autres
  // modules Production. controle_qualite est owner-scoped (ne voit que ses
  // propres contrôles) ; les rôles admin voient tout.
  role: "controle_qualite",
  writeRoles: ["controle_qualite", "admin", "superadmin", "superadmin2"],
  deleteRoles: ["admin", "superadmin", "superadmin2"],

  parameters: Object.freeze(PARAMETERS),

  // Destinataires des notifications internes "Contrôle qualité non conforme" :
  // par défaut les responsables Production déjà configurés pour Production
  // Compliance (PRODUCTION_COMPLIANCE_MANAGERS) — surcharge possible via
  // QUALITY_CONTROL_NOTIFY_RECIPIENTS. Jamais d'email client.
  get notifyRecipients() {
    return list(process.env.QUALITY_CONTROL_NOTIFY_RECIPIENTS) || require("./productionCompliance").managers;
  },
};
