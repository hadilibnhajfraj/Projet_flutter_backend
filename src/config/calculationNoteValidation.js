"use strict";

// Validation obligatoire des notes de calcul.
//
// Validateur officiel : medwethekgc@gmail.com (compte existant, rôle `user`).
// L'adresse sert uniquement à RETROUVER le compte : son ID est résolu à
// chaque soumission et enregistré sur la note (calculation_notes.validatorId).
// Seul cet ID peut ensuite valider ou refuser la note. Aucun compte n'est
// créé : si l'adresse ne correspond à aucun compte actif, la création d'une
// note est refusée avec un message explicite (VALIDATOR_UNAVAILABLE).
// Surcharge possible : CALCULATION_NOTE_VALIDATOR_EMAIL.

const DEFAULT_VALIDATOR_EMAIL = "medwethekgc@gmail.com";

const STATUSES = Object.freeze({
  PENDING: "EN_ATTENTE_VALIDATION",
  VALIDATED: "VALIDEE",
  REJECTED: "REFUSEE",
  CANCELLED: "ANNULEE",
});

const STATUS_LABELS = Object.freeze({
  EN_ATTENTE_VALIDATION: "En attente de validation",
  VALIDEE: "Validée",
  REFUSEE: "Refusée",
  ANNULEE: "Annulée",
});

// Note modifiable (informations, documents) : ni validée ni annulée — une
// note validée est verrouillée (aucun processus de réouverture à ce jour).
const EDITABLE_STATUSES = [STATUSES.PENDING, STATUSES.REJECTED];
// Annulable par son créateur.
const CANCELLABLE_STATUSES = [STATUSES.PENDING, STATUSES.REJECTED];

const MIN_REASON_LENGTH = 3;

// « Affecter à » : facultatif par défaut (règle métier à confirmer) ;
// CALCULATION_NOTE_ASSIGNEE_REQUIRED=true le rend obligatoire à la création
// (vérifié par le backend, affiché par le formulaire).
function assigneeRequired() {
  return String(process.env.CALCULATION_NOTE_ASSIGNEE_REQUIRED || "").toLowerCase() === "true";
}

function validatorEmail() {
  return String(process.env.CALCULATION_NOTE_VALIDATOR_EMAIL || DEFAULT_VALIDATOR_EMAIL).trim().toLowerCase();
}

module.exports = { DEFAULT_VALIDATOR_EMAIL, STATUSES, STATUS_LABELS, EDITABLE_STATUSES, CANCELLABLE_STATUSES, MIN_REASON_LENGTH, validatorEmail, assigneeRequired };
