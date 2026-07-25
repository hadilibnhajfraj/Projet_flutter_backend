// utils/mailer.js
const nodemailer = require("nodemailer");
const logger = require("./logger");

function getTransporter() {
  const host = process.env.EMAIL_HOST;
  const port = Number(process.env.EMAIL_PORT || 587);
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  const secure = String(process.env.EMAIL_SECURE || "false") === "true";

  // createTransport() ne reçoit aucun `from`/`sender` par défaut — donc rien
  // ici ne peut écraser le `from` passé à sendMail() plus bas (point 6 de
  // l'audit : confirmé, pas de valeur par défaut au niveau du transport).
  return nodemailer.createTransport({
    host,
    port,
    secure, // false pour 587, true pour 465
    auth: { user, pass },
  });
}

// Extrait l'adresse "bare" (sans le nom affiché) d'un header du type
// `"CBI Tunisia" <cbitunisia@cbi-tunisia.com>` — utilisé pour construire
// l'enveloppe SMTP explicitement (MAIL FROM) plutôt que de laisser
// Nodemailer la déduire implicitement du header `From`.
function extractBareAddress(headerValue) {
  if (!headerValue) return null;
  const match = headerValue.match(/<([^>]+)>/);
  const candidate = (match ? match[1] : headerValue).trim();
  const isValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate);
  return isValidEmail ? candidate : null;
}

// Extrait les champs utiles d'une erreur SMTP (nodemailer/Node net) pour un
// log exploitable — jamais tronqué, jamais masqué, même si l'appelant ne
// propage à son tour qu'un message générique côté client (sécurité).
function describeSmtpError(err) {
  return {
    message: err?.message,
    code: err?.code, // ex: EAUTH, ECONNECTION, EMESSAGE, ETIMEDOUT
    command: err?.command, // ex: AUTH, DATA, CONN
    responseCode: err?.responseCode, // ex: 554, 535
    response: err?.response, // texte brut renvoyé par le serveur SMTP
  };
}

async function sendMail({ to, subject, html, text }) {
  const transporter = getTransporter();

  // 1. from — header visible "De :". Point 5 : on vérifie que EMAIL_FROM
  //    contient bien une adresse email valide (pas juste un nom affiché).
  const from = process.env.EMAIL_FROM || process.env.EMAIL_USER;
  const fromAddress = extractBareAddress(from);
  if (!fromAddress) {
    // Config invalide dès le départ : mieux vaut échouer immédiatement et
    // explicitement que d'envoyer avec un `from` cassé.
    const err = new Error(
      `MAILER CONFIG ERROR: EMAIL_FROM ("${from}") ne contient pas d'adresse email valide.`
    );
    logger.error("MAILER: invalid EMAIL_FROM", { from });
    throw err;
  }
  if (fromAddress.toLowerCase() !== "cbitunisia@cbi-tunisia.com") {
    logger.warn("MAILER: EMAIL_FROM address différente de cbitunisia@cbi-tunisia.com", {
      fromAddress,
    });
  }

  // 2. sender — volontairement absent. Nodemailer ne l'utilise que pour
  //    distinguer un expéditeur "technique" (header Sender) du `from`
  //    affiché ; sans lui, from/sender/envelope.from restent cohérents,
  //    ce qui est le comportement recherché ici (un seul compte SMTP,
  //    aucune délégation d'envoi).
  const sender = undefined;

  // 3. replyTo — absent côté .env, on retombe sur `from` par défaut pour
  //    qu'une réponse utilisateur arrive bien sur une boîte existante
  //    plutôt que de laisser le header Reply-To vide.
  const replyTo = process.env.EMAIL_REPLY_TO || from;

  // 4. envelope — rendue explicite (au lieu de laisser Nodemailer la
  //    déduire du header `From`) pour garantir que MAIL FROM utilise bien
  //    la même adresse que le compte authentifié (exigence courante des
  //    serveurs SMTP pour éviter un rejet anti-spoofing).
  const envelope = { from: fromAddress, to };

  const mailObject = { from, sender, replyTo, envelope, to, subject, text, html };

  // 7. Log exact de l'objet transmis à Nodemailer (contenu HTML tronqué
  //    pour ne pas noyer les logs, tout le reste est intact).
  logger.info("MAILER: mail object envoyé à Nodemailer", {
    ...mailObject,
    html: html ? `<${html.length} chars>` : html,
    text: text ? `<${text.length} chars>` : text,
  });

  logger.info("MAILER: verifying SMTP connection", {
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: process.env.EMAIL_SECURE,
  });
  try {
    await transporter.verify();
    logger.info("MAILER: SMTP verify OK");
  } catch (err) {
    logger.error("MAILER: SMTP verify FAILED", describeSmtpError(err));
    throw err;
  }

  logger.info("MAILER: sending email", { to, subject, from, envelope });
  try {
    const info = await transporter.sendMail(mailObject);
    logger.info("MAILER: email sent", {
      messageId: info.messageId,
      response: info.response,
      accepted: info.accepted,
      rejected: info.rejected,
      envelope: info.envelope,
    });
    return info;
  } catch (err) {
    // Ne jamais avaler l'erreur ici : on la journalise en entier puis on la
    // relance, pour que l'appelant (ex: /auth/forgot-password) sache que
    // l'envoi a réellement échoué, même si sa réponse HTTP reste neutre.
    logger.error("MAILER: sendMail FAILED", describeSmtpError(err));
    throw err;
  }
}

module.exports = { sendMail };
