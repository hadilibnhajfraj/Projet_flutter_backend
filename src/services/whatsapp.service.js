"use strict";

// WhatsApp — scaffold prêt à brancher (Twilio WhatsApp API).
//
// Tant que TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_WHATSAPP_NUMBER
// ne sont pas renseignés dans .env, aucun message n'est réellement envoyé :
// on logue l'intention et on retourne { success:false, skipped:true }.
//
// Ne lève JAMAIS d'exception — best-effort, ne doit jamais faire échouer
// l'appelant (email/notification/calendrier restent fonctionnels même si
// WhatsApp n'est pas configuré ou échoue).

function isConfigured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_WHATSAPP_NUMBER
  );
}

async function sendWhatsappMessage(to, message) {
  if (!to) {
    console.warn("[WhatsappService] Aucun numéro destinataire — envoi ignoré.");
    return { success: false, skipped: true, reason: "no_recipient" };
  }

  if (!isConfigured()) {
    // Jamais un console.error ici : l'absence de config Twilio est un état
    // attendu, pas une erreur — le Follow-up doit continuer normalement.
    console.log(`[WhatsappService] WhatsApp non configuré (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_WHATSAPP_NUMBER manquants) — envoi ignoré pour ${to}.`);
    return { success: false, skipped: true, reason: "not_configured" };
  }

  try {
    const twilio = require("twilio");
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

    const result = await client.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:${to}`,
      body: message,
    });

    console.log(`✅ WHATSAPP SENT — to=${to} sid=${result.sid}`);
    return { success: true, sid: result.sid };
  } catch (error) {
    console.error(`❌ WHATSAPP ERROR — to=${to}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

module.exports = { sendWhatsappMessage, isConfigured };
