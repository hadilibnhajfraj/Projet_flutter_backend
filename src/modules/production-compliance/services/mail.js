"use strict";

// Transport e-mail : en production on délègue à utils/mailer.js (SMTP réel,
// variables EMAIL_HOST / EMAIL_PORT / EMAIL_SECURE / EMAIL_USER / EMAIL_PASS /
// EMAIL_FROM). Les tests unitaires peuvent injecter une implémentation ; les
// tests réels n'en injectent aucune.
const logger = require("../../../utils/logger");

let impl = null;

const realMailer = () => require("../../../utils/mailer");

async function verify() {
  if (impl) return { ok: true, simulated: true };
  const v = await realMailer().verifyConnection();
  logger.info(
    `[PRODUCTION-COMPLIANCE-MAIL] SMTP connection: ${v.ok ? "OK" : "FAILED"} host=${v.host}:${v.port} secure=${v.secure} from=${v.from}${v.ok ? "" : " error=" + (v.error?.message || "unknown")}`
  );
  return v;
}

async function send(message) {
  const to = [].concat(message.to).join(", ");
  if (!impl) await verify();
  try {
    const info = await (impl || realMailer().sendMail)(message);
    logger.info(
      `[PRODUCTION-COMPLIANCE-MAIL] ${impl ? "SIMULATED " : ""}sent to=${to} subject="${message.subject}" messageId=${info?.messageId} accepted=${JSON.stringify(info?.accepted)} rejected=${JSON.stringify(info?.rejected)} response=${info?.response}`
    );
    return info;
  } catch (err) {
    logger.error(`[PRODUCTION-COMPLIANCE-MAIL] send FAILED to=${to} subject="${message.subject}": ${err?.message}`);
    throw err;
  }
}

module.exports = {
  send,
  verify,
  setMailer(fn) {
    impl = fn;
  },
};
