"use strict";

// Extrait le contexte de sécurité d'une requête (IP, navigateur, pays) —
// utilisé par mfa.service.js pour détecter un changement d'IP/navigateur/
// pays et forcer un MFA immédiat (voir cahier des charges MFA).
//
// geoip-lite : base MaxMind locale embarquée, aucun appel réseau externe,
// aucune clé API. Retourne `null` pour les IP privées/locales (127.0.0.1,
// ::1, LAN) — traité comme "pays inconnu", jamais comme un changement.
const geoip = require("geoip-lite");
const { UAParser } = require("ua-parser-js");

function getRequestContext(req) {
  const ip = req.ip || req.connection?.remoteAddress || "";

  const uaString = req.headers["user-agent"] || "";
  const parser = new UAParser(uaString);
  const browser = parser.getBrowser()?.name || null; // ex: "Chrome" — la version n'est volontairement pas comparée

  const geo = geoip.lookup(ip);
  const country = geo?.country || null; // code ISO 2 lettres, ex: "FR"

  // deviceId : généré et persisté côté client (Flutter, flutter_secure_storage)
  // — envoyé dans le corps de /auth/signin et /auth/mfa/verify. Absent =
  // appareil inconnu (traité comme "nouvel appareil", jamais comme "identique").
  const deviceId = typeof req.body?.deviceId === "string" && req.body.deviceId.trim()
    ? req.body.deviceId.trim().slice(0, 100)
    : null;

  return { ip, browser, country, deviceId };
}

module.exports = { getRequestContext };
