"use strict";

const crypto = require("crypto");

// Génère un OTP à 6 chiffres (000000–999999, zéro-paddé) via crypto.randomInt
// (CSPRNG — jamais Math.random pour un secret). Retourne le code en clair
// (envoyé par email, jamais stocké tel quel) et son hash SHA-256 (stocké en
// base — si la DB fuite, les codes ne sont pas directement réutilisables).
function generateOtp() {
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  const codeHash = crypto.createHash("sha256").update(code).digest("hex");
  return { code, codeHash };
}

function hashOtp(code) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
}

module.exports = { generateOtp, hashOtp };
