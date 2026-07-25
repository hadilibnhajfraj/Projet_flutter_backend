"use strict";

// Journalisation des tentatives de réinitialisation de mot de passe (voir
// auth.routes.js) + comptage pour la limite "3 demandes/heure/utilisateur".
// Best-effort : un échec d'écriture du log ne doit jamais faire échouer le
// flux d'authentification principal.

const { Op } = require("sequelize");
const PasswordResetLog = require("../models/PasswordResetLog");

async function logAttempt({ email, ip, action, success = false, reason = null }) {
  try {
    await PasswordResetLog.create({ email, ip, action, success, reason });
  } catch (err) {
    console.error("[PasswordResetLog] Échec journalisation:", err.message);
  }
}

// Nombre de demandes "requested" pour cet email dans la fenêtre donnée —
// source de vérité pour la limite par utilisateur (persistant, contrairement
// à un limiter en mémoire qui ne survit pas à un redémarrage serveur).
async function countRecentRequestsByEmail(email, windowMs) {
  return PasswordResetLog.count({
    where: {
      email,
      action: "requested",
      createdAt: { [Op.gte]: new Date(Date.now() - windowMs) },
    },
  });
}

module.exports = { logAttempt, countRecentRequestsByEmail };
