"use strict";

// Vérifie le challengeToken émis par POST /auth/signin quand un MFA est
// requis. Distinct de `authRequired` (middleware/auth.middleware.js) :
// un challengeToken est signé avec JWT_MFA_SECRET (utils/mfaTokens.js), un
// secret différent de JWT_ACCESS_SECRET — `authRequired` le rejette donc
// automatiquement s'il est présenté à une route protégée normale, et ce
// middleware rejette symétriquement un access token normal s'il est
// présenté ici. Les deux univers de tokens ne se recoupent jamais.
const { verifyMfaChallengeToken } = require("../utils/mfaTokens");
const User = require("../models/User");
const { isMfaEnabled } = require("../config/mfaConfig");

// Interrupteur global (voir config/mfaConfig.js, variable MFA_ENABLED) —
// placé en tête de POST /auth/mfa/verify et /auth/mfa/resend
// (routes/auth.routes.js) : quand le MFA est désactivé, ces deux routes
// n'existent plus fonctionnellement (404), sans qu'aucun fichier ne soit
// supprimé — il suffit de repasser MFA_ENABLED=true pour les réactiver.
function requireMfaFeatureEnabled(req, res, next) {
  if (!isMfaEnabled()) {
    return res.status(404).json({ message: "Not found" });
  }
  return next();
}

// DIAGNOSTIC TEMPORAIRE (audit "code OTP refusé à la vérification") — log du
// challengeToken décodé, aucun comportement changé. Préfixe [MFA-DIAG].
function mfaDiag(label, fields) {
  console.log(`[MFA-DIAG] ${label}`, JSON.stringify(fields));
}

async function mfaChallengeRequired(req, res, next) {
  try {
    const { challengeToken } = req.body || {};
    if (typeof challengeToken !== "string" || !challengeToken) {
      mfaDiag("mfaChallengeRequired() challengeToken manquant", {});
      return res.status(401).json({ message: "Missing challenge token" });
    }

    const decoded = verifyMfaChallengeToken(challengeToken);
    mfaDiag("mfaChallengeRequired() challengeToken décodé", {
      sub: decoded.sub,
      jti: decoded.jti,
      exp: decoded.exp,
      purpose: decoded.purpose,
    });

    const user = await User.findByPk(decoded.sub);
    if (!user || !user.isActive) {
      mfaDiag("mfaChallengeRequired() utilisateur introuvable/inactif pour sub", { sub: decoded.sub });
      return res.status(401).json({ message: "Invalid challenge token" });
    }

    mfaDiag("mfaChallengeRequired() utilisateur résolu", { sub: decoded.sub, userId: user.id, email: user.email });

    req.mfaUser = user;
    return next();
  } catch (e) {
    mfaDiag("mfaChallengeRequired() ÉCHEC vérification du token", { error: e.message });
    return res.status(401).json({ message: "Invalid or expired challenge token" });
  }
}

module.exports = { mfaChallengeRequired, requireMfaFeatureEnabled };
