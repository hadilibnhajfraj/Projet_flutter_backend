"use strict";

// Journalisation des tentatives MFA — best-effort : un échec d'écriture du
// log ne doit jamais faire échouer le flux d'authentification principal
// (même contrat que passwordResetLog.service.js).

const MfaAttemptLog = require("../models/MfaAttemptLog");

async function logMfaAttempt({ userId = null, email, ip, action, success = false, reason = null }) {
  try {
    await MfaAttemptLog.create({ userId, email, ip, action, success, reason });
  } catch (err) {
    console.error("[MfaAttemptLog] Échec journalisation:", err.message);
  }
}

module.exports = { logMfaAttempt };
