const router = require("express").Router();
const jwt = require("jsonwebtoken");
const { authRequired } = require("../middleware/auth.middleware");
const googleCalendarService = require("../services/googleCalendar.service");
const googleCalendarWatch = require("../services/googleCalendarWatch.service");
const googleCalendarInboundSync = require("../services/googleCalendarInboundSync.service");
const GoogleCalendarAccount = require("../models/GoogleCalendarAccount");

// ═══════════════════════════════════════════════════════════════════════
// OAuth2 Google Calendar — connexion du compte Google d'un commercial.
//
// Flux : le front demande une auth-url (authentifié), ouvre cette URL dans
// un onglet navigateur ; Google redirige ensuite vers /callback SANS
// header Authorization (requête faite par le navigateur de l'utilisateur,
// pas par l'app) — l'identité de l'utilisateur est donc portée par un
// state signé (JWT courte durée), pas par le token d'accès applicatif.
// ═══════════════════════════════════════════════════════════════════════

const STATE_SECRET = process.env.JWT_ACCESS_SECRET;

function signState(userId) {
  return jwt.sign({ uid: userId, purpose: "google_oauth_state" }, STATE_SECRET, { expiresIn: "10m" });
}

function verifyState(state) {
  const decoded = jwt.verify(state, STATE_SECRET);
  if (decoded.purpose !== "google_oauth_state" || !decoded.uid) {
    throw new Error("Invalid state payload");
  }
  return decoded.uid;
}

function successPage(message) {
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"><title>Google Calendar</title></head>
<body style="font-family: Arial, sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; background:#F8FAFC;">
  <div style="text-align:center; color:#1E293B;">
    <h2 style="color:#4F46E5;">${message}</h2>
    <p>Vous pouvez fermer cette fenêtre.</p>
  </div>
</body>
</html>`;
}

// Variables requises par googleCalendarService.getAuthUrl() /
// exchangeCodeForTokens() — note : ce code construit l'URL OAuth2 à la main
// (URLSearchParams) et n'utilise PAS google-auth-library ni sa classe
// OAuth2Client ; il n'existe pas non plus de variable GOOGLE_CALLBACK_URL
// dans ce projet (seule GOOGLE_REDIRECT_URI est utilisée, y compris pour
// /callback).
const REQUIRED_GOOGLE_ENV_VARS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"];

router.get("/auth-url", authRequired, (req, res) => {
  try {
    console.log(`[GoogleCalendar] GET /auth-url — userId=${req.user?.sub}`);

    console.log("[GoogleCalendar][auth-url] Config check:", {
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ? "set" : "MISSING",
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ? "set" : "MISSING",
      GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI || "MISSING",
      SCOPES: googleCalendarService.SCOPES,
    });

    const missing = REQUIRED_GOOGLE_ENV_VARS.filter((name) => !process.env[name]);
    if (missing.length > 0) {
      console.error("❌ [GoogleCalendar][auth-url] Configuration manquante:", missing);
      return res.status(500).json({ message: "Google OAuth configuration missing", missing });
    }

    const state = signState(req.user.sub);
    console.log("[GoogleCalendar][auth-url] state signé avec succès");

    const url = googleCalendarService.getAuthUrl(state);
    console.log("[GoogleCalendar][auth-url] URL générée:", url);

    return res.json({ url });
  } catch (err) {
    console.error("❌ [GoogleCalendar][auth-url] Erreur inattendue");
    console.error("Message :", err.message);
    console.error("Stack   :", err.stack);
    return res.status(500).json({ message: err.message });
  }
});

router.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;
  console.log(
    `[GoogleCalendar] GET /callback — code=${code ? "present" : "MISSING"} state=${state ? "present" : "MISSING"} error=${error || "none"}`
  );

  if (error) {
    console.error("❌ [GoogleCalendar] callback — consentement refusé par l'utilisateur:", error);
    return res.status(400).send(successPage(`Connexion refusée : ${error}`));
  }
  if (!code || !state) {
    console.error("❌ [GoogleCalendar] callback — paramètres manquants (code/state)");
    return res.status(400).send(successPage("Paramètres manquants."));
  }

  try {
    const userId = verifyState(state);
    const tokens = await googleCalendarService.exchangeCodeForTokens(code);
    await googleCalendarService.saveTokensForUser(userId, tokens);

    // Best-effort — canal push (sync entrante Google -> CRM, Phase B). Skip
    // propre si pas d'URL webhook publique configurée (voir le service).
    googleCalendarWatch.registerWatchChannel(userId).catch((err) =>
      console.error("❌ [GoogleCalendar] registerWatchChannel error:", err.message)
    );

    return res.send(successPage("Compte Google connecté avec succès"));
  } catch (err) {
    console.error("❌ [GoogleCalendar] callback error");
    console.error("HTTP Status    :", err.response?.status ?? "N/A");
    console.error("Google message :", err.response?.data?.error_description || err.response?.data || err.message);
    console.error("Stack          :", err.stack);
    return res.status(400).send(successPage("Échec de la connexion Google."));
  }
});

router.get("/status", authRequired, async (req, res) => {
  try {
    const status = await googleCalendarService.getStatus(req.user.sub);
    return res.json(status);
  } catch (err) {
    console.error("❌ [GoogleCalendar] status error:", err.message);
    return res.status(500).json({ message: err.message });
  }
});

router.post("/disconnect", authRequired, async (req, res) => {
  try {
    await googleCalendarWatch.stopWatchChannel(req.user.sub);
    await googleCalendarService.disconnect(req.user.sub);
    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ [GoogleCalendar] disconnect error:", err.message);
    return res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Webhook Google (events.watch) — endpoint PUBLIC, sans authRequired : les
// notifications push viennent des serveurs Google, pas du navigateur d'un
// utilisateur connecté (même contrat que /callback ci-dessus). Google exige
// une réponse 200 rapide ; le traitement réel (sync entrante) est best-effort
// et ne doit jamais faire attendre Google ni faire échouer l'accusé réception.
// ═══════════════════════════════════════════════════════════════════════
router.post("/webhook", async (req, res) => {
  // Toujours répondre 200 immédiatement — Google désactive un canal qui
  // répond en erreur de façon répétée.
  res.status(200).end();

  const channelId = req.get("X-Goog-Channel-ID");
  const resourceState = req.get("X-Goog-Resource-State");
  const token = req.get("X-Goog-Channel-Token");

  if (!channelId || resourceState === "sync") {
    // "sync" = message de confirmation initial à l'enregistrement du canal,
    // pas un vrai changement — rien à faire.
    return;
  }

  try {
    const account = await GoogleCalendarAccount.findOne({ where: { watchChannelId: channelId } });
    if (!account) {
      console.warn(`[GoogleCalendar] webhook — channelId inconnu: ${channelId}`);
      return;
    }
    if (!account.watchToken || account.watchToken !== token) {
      console.warn(`[GoogleCalendar] webhook — token invalide pour channelId=${channelId}`);
      return;
    }

    await googleCalendarInboundSync.syncFromGoogle(account.userId);
  } catch (err) {
    console.error("❌ [GoogleCalendar] webhook processing error:", err.message);
  }
});

module.exports = router;
