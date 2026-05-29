"use strict";

/**
 * Project completion check.
 *
 * Each entry defines a field to test and the French label shown to the user
 * when that field is missing. The `_location` pseudo-field passes when either
 * latitude or longitude is present.
 *
 * completionRate = filled / total * 100 (rounded to nearest integer)
 */

const CHECKS = [
  { field: "nomProjet",           label: "Nom projet manquant" },
  { field: "telephoneIngenieur",  label: "Téléphone ingénieur manquant" },
  { field: "emailIngenieur",      label: "Email ingénieur manquant" },
  { field: "architecte",          label: "Architecte non renseigné" },
  { field: "telephoneArchitecte", label: "Téléphone architecte manquant" },
  { field: "emailArchitecte",     label: "Email architecte manquant" },
  { field: "adresse",             label: "Adresse non renseignée" },
  { field: "_location",           label: "Localisation manquante" },
  { field: "montantMarche",       label: "Montant marché non renseigné" },
  { field: "bureauEtude",         label: "Bureau d'étude non renseigné" },
  { field: "entreprise",          label: "Entreprise non renseignée" },
  { field: "promoteur",           label: "Promoteur non renseigné" },
];

function _isPresent(p, field) {
  if (field === "_location") {
    return p.latitude != null || p.longitude != null;
  }
  const v = p[field];
  return v != null && String(v).trim() !== "";
}

/**
 * @param {object} p — plain project object (toJSON() already called)
 * @returns {{ completionRate: number, missingFields: string[] }}
 */
function computeCompletion(p) {
  const missingFields = [];
  for (const { field, label } of CHECKS) {
    if (!_isPresent(p, field)) missingFields.push(label);
  }
  const completionRate = Math.round(((CHECKS.length - missingFields.length) / CHECKS.length) * 100);
  return { completionRate, missingFields };
}

module.exports = { computeCompletion };
