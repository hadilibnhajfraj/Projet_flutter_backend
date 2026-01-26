// utils/passwordReset.js
const crypto = require("crypto");

function generateResetToken() {
  // token brut envoyé par email
  const token = crypto.randomBytes(32).toString("hex");

  // hash stocké en DB (si DB leak -> token inutilisable)
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  return { token, tokenHash };
}

module.exports = { generateResetToken };
