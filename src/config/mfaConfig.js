"use strict";

// Interrupteur central du système MFA — piloté par la variable
// d'environnement MFA_ENABLED (voir .env). Permet de désactiver
// entièrement le MFA (aucun OTP, aucun challenge, aucune ligne EmailQueue
// MFA créée, POST /auth/mfa/verify et /auth/mfa/resend renvoient 404) SANS
// toucher au code — aucun fichier MFA n'est supprimé (models/MfaOtp.js,
// models/TrustedDevice.js, services/mfa.service.js, etc. restent intacts et
// inutilisés) — et de le réactiver plus tard en remettant MFA_ENABLED=true,
// sans redéploiement de code.
//
// Défaut : true (comportement actuel préservé) si la variable est absente —
// évite qu'un environnement qui oublierait de la définir se retrouve
// silencieusement sans MFA.
function isMfaEnabled() {
  const raw = process.env.MFA_ENABLED;
  if (raw === undefined || raw === null || raw === "") return true;
  return String(raw).toLowerCase().trim() === "true";
}

module.exports = { isMfaEnabled };
