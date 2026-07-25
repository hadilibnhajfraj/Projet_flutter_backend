"use strict";

// Chiffrement at-rest (AES-256-GCM) des tokens OAuth Google — aucun token
// (access/refresh) n'est jamais persisté en clair en base. Clé dérivée de
// GOOGLE_TOKEN_ENC_KEY (chaîne hex 64 caractères = 32 octets), générée une
// fois et conservée en .env (voir GOOGLE_CALENDAR_SETUP.md).

const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // recommandé pour GCM

function getKey() {
  const raw = process.env.GOOGLE_TOKEN_ENC_KEY;
  if (!raw) throw new Error("Missing env var: GOOGLE_TOKEN_ENC_KEY");
  const key = Buffer.from(raw, "hex");
  if (key.length !== 32) {
    throw new Error("GOOGLE_TOKEN_ENC_KEY must be a 64-char hex string (32 bytes)");
  }
  return key;
}

// Retourne une chaîne unique "iv:authTag:ciphertext" (base64) — pratique à
// stocker dans une seule colonne TEXT.
function encrypt(plainText) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(":");
}

function decrypt(payload) {
  if (!payload) return null;
  const [ivB64, authTagB64, dataB64] = String(payload).split(":");
  if (!ivB64 || !authTagB64 || !dataB64) return null;

  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

module.exports = { encrypt, decrypt };
