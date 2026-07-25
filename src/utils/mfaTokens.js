"use strict";

// Tokens MFA — signés avec un secret DÉDIÉ (JWT_MFA_SECRET), distinct de
// JWT_ACCESS_SECRET/JWT_REFRESH_SECRET (utils/tokens.js). C'est ce qui
// garantit qu'un challengeToken (émis après mot de passe correct, MFA en
// attente) ne peut JAMAIS être accepté comme access token par
// `authRequired` (middleware/auth.middleware.js, qui vérifie uniquement
// avec JWT_ACCESS_SECRET) — aucune route protégée n'est donc accessible
// tant que le MFA n'est pas validé, par construction (voir cahier des
// charges point 5 : "Tant que le code n'est pas validé, interdire les API
// protégées").
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const CHALLENGE_TTL = "10m"; // aligné sur l'expiration de l'OTP (10 minutes)
const DEVICE_TOKEN_TTL_DAYS = 30;

// ── Challenge token (étape intermédiaire signin → mfa/verify) ──────────────
function signMfaChallengeToken({ userId }) {
  const secret = mustEnv("JWT_MFA_SECRET");
  // jti aléatoire : sans lui, un signin puis un resend émis dans la même
  // seconde produisent un JWT strictement identique (même payload + même
  // `iat` à la seconde près ⇒ même signature HMAC) — ce qui n'est pas un
  // problème de sécurité en soi (les deux représentent le même utilisateur/
  // même fenêtre), mais empêche de distinguer "ancien" et "nouveau"
  // challenge, utile pour un futur mécanisme de révocation à usage unique.
  const jti = crypto.randomBytes(16).toString("hex");
  return jwt.sign({ sub: userId, purpose: "mfa_challenge", jti }, secret, {
    expiresIn: CHALLENGE_TTL,
    issuer: "my-api",
    audience: "my-client",
  });
}

function verifyMfaChallengeToken(token) {
  const secret = mustEnv("JWT_MFA_SECRET");
  const decoded = jwt.verify(token, secret, { issuer: "my-api", audience: "my-client" });
  if (decoded.purpose !== "mfa_challenge") {
    throw new Error("Invalid token purpose");
  }
  return decoded; // { sub, purpose, iat, exp }
}

// ── Device trust token ("Faire confiance à cet appareil 30 jours") ────────
// Le JWT en clair n'est remis au client qu'une fois, à la création. Seul son
// hash SHA-256 est stocké en base (models/TrustedDevice.js) — même logique
// que resetPasswordTokenHash : une fuite de la DB ne permet pas de rejouer
// le token.
function signDeviceToken({ userId, deviceId }) {
  const secret = mustEnv("JWT_MFA_SECRET");
  const token = jwt.sign({ sub: userId, deviceId, purpose: "device_trust" }, secret, {
    expiresIn: `${DEVICE_TOKEN_TTL_DAYS}d`,
    issuer: "my-api",
    audience: "my-client",
  });
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + DEVICE_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  return { token, tokenHash, expiresAt };
}

function verifyDeviceToken(token) {
  const secret = mustEnv("JWT_MFA_SECRET");
  const decoded = jwt.verify(token, secret, { issuer: "my-api", audience: "my-client" });
  if (decoded.purpose !== "device_trust") {
    throw new Error("Invalid token purpose");
  }
  return decoded; // { sub, deviceId, purpose, iat, exp }
}

function hashDeviceToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

module.exports = {
  signMfaChallengeToken,
  verifyMfaChallengeToken,
  signDeviceToken,
  verifyDeviceToken,
  hashDeviceToken,
  DEVICE_TOKEN_TTL_DAYS,
};
