"use strict";

// Historique des statuts d'un CommercialContact — append-only : chaque
// changement (sur "statut" OU "pipelineStage") crée une nouvelle ligne,
// l'ancien historique n'est jamais écrasé ni modifié. La toute première
// ligne (à la création du contact) porte type="CREATED" ; toutes les
// suivantes portent type="STATUS_CHANGED".

const User = require("../models/User");
const UserProfile = require("../models/UserProfile");
const CommercialContactStatusHistory = require("../models/CommercialContactStatusHistory");
const { resolveFullName } = require("../utils/userDisplay");

// Crée une entrée d'historique si (et seulement si) newValue diffère de
// oldValue (toujours vrai pour type="CREATED", où oldValue est null par
// construction — la toute première entrée d'un contact apparaît donc
// systématiquement, même si son statut n'est jamais modifié ensuite).
// Retourne l'entrée créée, ou null si rien n'a changé.
async function recordStatusChange({
  contactId,
  field,
  oldValue,
  newValue,
  actorUserId,
  commentaire,
  type = "STATUS_CHANGED",
  transaction,
}) {
  if (!newValue) return null;
  if (oldValue === newValue) return null; // aucune entrée si le statut ne change pas

  let changedByName = null;
  try {
    const actor = await User.findOne({
      where: { id: actorUserId },
      attributes: ["id", "email"],
      include: [{ model: UserProfile, as: "profile", attributes: ["name", "nom", "prenom"], required: false }],
    });
    changedByName = actor ? resolveFullName(actor) : null;
  } catch (err) {
    console.error("[CommercialContactHistory] resolveFullName error:", err.message);
  }

  return CommercialContactStatusHistory.create(
    {
      commercialContactId: contactId,
      field,
      type,
      ancienStatut: oldValue || null,
      nouveauStatut: newValue,
      commentaire: commentaire || null,
      changedBy: actorUserId,
      changedByName,
    },
    transaction ? { transaction } : undefined
  );
}

module.exports = { recordStatusChange };
