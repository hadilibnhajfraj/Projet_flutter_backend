"use strict";

// Cœur de la logique MFA — voir cahier des charges :
//   - mfa_last_verified_at : re-vérification tous les 3 jours (24h pour les
//     rôles admin/superadmin/superadmin2).
//   - OTP 6 chiffres, hashé en base (SHA-256), expire en 10 minutes.
//   - "Faire confiance à cet appareil 30 jours" : device token signé, hash
//     stocké, expiration 30 jours.
//   - Un changement d'IP / navigateur / appareil / pays force un MFA
//     immédiat, même sur un appareil de confiance ou une vérification
//     récente.
//   - Compatible avec le système EmailQueue déjà en place (l'OTP passe par
//     enqueueEmail(), jamais par un envoi SMTP direct).

const { Op } = require("sequelize");
const { sequelize } = require("../db");
const User = require("../models/User");
const MfaOtp = require("../models/MfaOtp");
const TrustedDevice = require("../models/TrustedDevice");
const { generateOtp, hashOtp } = require("../utils/otp");
const {
  signMfaChallengeToken,
  signDeviceToken,
  verifyDeviceToken,
  hashDeviceToken,
} = require("../utils/mfaTokens");
const { enqueueEmail, findActiveJob, cancelJob } = require("./emailQueue.service");
const { logMfaAttempt } = require("./mfaAttemptLog.service");
const logger = require("../utils/logger");
const jwt = require("jsonwebtoken");

// ─────────────────────────────────────────────────────────────────────────
// DIAGNOSTIC TEMPORAIRE — audit "code OTP refusé à la vérification".
// Aucun comportement changé : uniquement des logs. Préfixe [MFA-DIAG] pour
// pouvoir grep/filtrer facilement, à retirer une fois la cause confirmée.
// L'OTP en clair n'est loggé qu'en dehors de production.
// ─────────────────────────────────────────────────────────────────────────
function mfaDiag(label, fields) {
  console.log(`[MFA-DIAG] ${label}`, JSON.stringify(fields));
}
const SHOW_PLAINTEXT_OTP = process.env.NODE_ENV !== "production";

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_MAX_ATTEMPTS = 5;

// Anti-doublon (cahier des charges "robustesse SMTP / anti double-clic") :
//   - un OTP encore valide plus de 30s n'est jamais régénéré (double-clic sur
//     "Se connecter" côté signin) ;
//   - un renvoi explicite (POST /auth/mfa/resend) n'est autorisé que si le
//     dernier envoi date de plus de 60s (ou que l'OTP a expiré).
const OTP_REUSE_MIN_REMAINING_MS = 30 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;

const ADMIN_ROLES = ["admin", "superadmin", "superadmin2"];
const STANDARD_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000; // 3 jours
const ADMIN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 heures

function mfaIntervalForRole(role) {
  return ADMIN_ROLES.includes(role) ? ADMIN_INTERVAL_MS : STANDARD_INTERVAL_MS;
}

// Levée par resendOtpChallenge() quand le cooldown de 60s est encore actif —
// la route POST /auth/mfa/resend la traduit en HTTP 429.
class MfaCooldownError extends Error {
  constructor(retryAfterSeconds) {
    super("Veuillez patienter avant de demander un nouveau code.");
    this.name = "MfaCooldownError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Template email — même identité visuelle que buildResetPasswordEmail
// (routes/auth.routes.js) : bleu Probar #1573FE, sans logo image.
function buildOtpEmail(code) {
  const subject = "Votre code de vérification";
  const text = [
    "Bonjour,",
    "",
    "Voici votre code de vérification à usage unique :",
    "",
    code,
    "",
    "Ce code expire dans 10 minutes.",
    "",
    "Si vous n'êtes pas à l'origine de cette connexion, changez votre mot de passe immédiatement.",
    "",
    "Cordialement,",
    "Probar CRM",
  ].join("\n");

  const html = `
    <div style="background:#F1F5F9;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
      <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0;">
        <div style="padding:24px 32px;border-bottom:1px solid #E2E8F0;">
          <span style="font-size:20px;font-weight:800;color:#1573FE;letter-spacing:-0.3px;">Probar</span>
          <span style="font-size:12px;color:#94A3B8;display:block;margin-top:2px;">Project Management Platform</span>
        </div>
        <div style="padding:32px;color:#0F172A;font-size:14px;line-height:1.6;">
          <p style="margin:0 0 16px;">Bonjour,</p>
          <p style="margin:0 0 24px;">Voici votre code de vérification à usage unique :</p>
          <p style="margin:0 0 24px;text-align:center;">
            <span style="display:inline-block;background:#EEF2FF;color:#1573FE;font-weight:800;font-size:32px;letter-spacing:8px;padding:16px 28px;border-radius:10px;">${code}</span>
          </p>
          <p style="margin:24px 0 0;color:#64748B;font-size:13px;">Ce code expire dans <b>10 minutes</b>.</p>
          <p style="margin:8px 0 0;color:#94A3B8;font-size:12.5px;">Si vous n'êtes pas à l'origine de cette connexion, changez votre mot de passe immédiatement.</p>
          <p style="margin:24px 0 0;">Cordialement,<br/>Probar CRM</p>
        </div>
      </div>
    </div>
  `;

  return { subject, text, html };
}

// ── Détection de changement de contexte ────────────────────────────────────
// Ne compare que les valeurs connues des deux côtés — évite les faux
// positifs quand geoip/UA échouent à déterminer une valeur (IP privée,
// User-Agent absent, etc.), et lors de la toute première connexion d'un
// utilisateur (lastLogin* tous null).
function detectRiskReasons(user, context) {
  const reasons = [];
  if (user.lastLoginIp && context.ip && user.lastLoginIp !== context.ip) reasons.push("new_ip");
  if (user.lastLoginBrowser && context.browser && user.lastLoginBrowser !== context.browser) reasons.push("new_browser");
  if (user.lastLoginCountry && context.country && user.lastLoginCountry !== context.country) reasons.push("new_country");
  if (user.lastLoginDeviceId && context.deviceId && user.lastLoginDeviceId !== context.deviceId) reasons.push("new_device");
  return reasons;
}

// Un device token n'exempte du MFA que si : signature valide, non expiré,
// non révoqué, appartient bien à cet utilisateur/appareil, ET le contexte
// (IP/navigateur/pays) correspond encore à celui enregistré quand la
// confiance a été accordée — un token volé mais rejoué depuis ailleurs ne
// suffit pas à contourner le MFA.
async function findValidTrustedDevice(user, context, rawDeviceToken) {
  if (!rawDeviceToken || !context.deviceId) return null;

  let decoded;
  try {
    decoded = verifyDeviceToken(rawDeviceToken);
  } catch {
    return null;
  }
  if (decoded.sub !== user.id || decoded.deviceId !== context.deviceId) return null;

  const tokenHash = hashDeviceToken(rawDeviceToken);
  const row = await TrustedDevice.findOne({
    where: {
      userId: user.id,
      deviceId: context.deviceId,
      tokenHash,
      revokedAt: null,
      expiresAt: { [Op.gt]: new Date() },
    },
  });
  if (!row) return null;

  if (row.ip && context.ip && row.ip !== context.ip) return null;
  if (row.browser && context.browser && row.browser !== context.browser) return null;
  if (row.country && context.country && row.country !== context.country) return null;

  return row;
}

/**
 * Décide si un MFA est requis pour cette tentative de connexion.
 * @returns {Promise<{required: boolean, reason: string, trustedDevice: object|null}>}
 */
async function evaluateMfaRequirement(user, context, rawDeviceToken) {
  const riskReasons = detectRiskReasons(user, context);
  if (riskReasons.length > 0) {
    return { required: true, reason: riskReasons.join(","), trustedDevice: null };
  }

  const trustedDevice = await findValidTrustedDevice(user, context, rawDeviceToken);
  if (trustedDevice) {
    await trustedDevice.update({ lastUsedAt: new Date() });
    return { required: false, reason: "trusted_device", trustedDevice };
  }

  const interval = mfaIntervalForRole(user.role);
  const last = user.mfaLastVerifiedAt ? new Date(user.mfaLastVerifiedAt).getTime() : null;
  const stale = last === null || Date.now() - last > interval;

  if (stale) {
    return { required: true, reason: last === null ? "never_verified" : "interval_expired", trustedDevice: null };
  }

  return { required: false, reason: "recently_verified", trustedDevice: null };
}

// Dernier OTP encore valide (non consommé, non expiré) pour cet utilisateur.
async function findActiveOtp(userId, transaction) {
  return MfaOtp.findOne({
    where: { userId, consumedAt: null, expiresAt: { [Op.gt]: new Date() } },
    order: [["createdAt", "DESC"]],
    transaction,
  });
}

// Crée la ligne MfaOtp + met à jour mfaLastSentAt — DB uniquement, aucun
// I/O réseau ici (l'envoi SMTP se fait toujours hors transaction, voir
// requestOtp/resendOtpChallenge : ne jamais garder un verrou de ligne
// pendant un aller-retour SMTP potentiellement lent).
async function _issueFreshOtp(user, transaction, { replaced = false, previousOtpId = null } = {}) {
  const { code, codeHash } = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  mfaDiag(replaced ? "OTP REPLACED" : "OTP CREATED", {
    userId: user.id,
    otp: SHOW_PLAINTEXT_OTP ? code : "[hidden in production]",
    otp_hash: codeHash,
    otp_expire_at: expiresAt.toISOString(),
    previousOtpId,
  });

  // INSERT MFA
  const row = await MfaOtp.create(
    { userId: user.id, otpHash: codeHash, expiresAt, attempts: 0, maxAttempts: OTP_MAX_ATTEMPTS },
    { transaction }
  );
  mfaDiag("SQL INSERT mfa_otps", { userId: user.id, otpId: row.id, otp_hash: codeHash, otp_expire_at: expiresAt.toISOString() });

  // UPDATE users (mfaLastSentAt)
  await user.update({ mfaLastSentAt: new Date() }, { transaction });
  mfaDiag("SQL UPDATE users.mfaLastSentAt", { userId: user.id, mfaLastSentAt: new Date().toISOString() });

  return { code, expiresAt, otpId: row.id };
}

async function _sendOtpEmail(user, code, ip, logReasonPrefix = "") {
  const { subject, text, html } = buildOtpEmail(code);
  const { status } = await enqueueEmail({
    to: user.email,
    subject,
    text,
    html,
    context: "mfa_otp",
    userId: user.id,
    meta: { email: user.email, userId: user.id },
  });
  await logMfaAttempt({
    userId: user.id,
    email: user.email,
    ip,
    action: "otp_requested",
    success: status !== "FAILED",
    reason: `${logReasonPrefix}${status.toLowerCase()}`,
  });
  return status;
}

/**
 * Point d'entrée appelé par POST /auth/signin quand un MFA est requis.
 * Anti-doublon complet :
 *   - verrouille la ligne `users` (SELECT ... FOR UPDATE) le temps de la
 *     décision + écriture DB, ce qui sérialise toute requête concurrente
 *     pour CE MÊME utilisateur (double-clic, plusieurs onglets, requêtes
 *     simultanées — voir cahier des charges point 3) ;
 *   - réutilise l'OTP actif s'il reste plus de 30s avant expiration (point 1) ;
 *   - ne recrée jamais un job EmailQueue si un envoi/retry est déjà en cours
 *     pour cet utilisateur (point 2) ;
 *   - respecte un cooldown de 60s entre deux envois réels (point 4).
 * Ne rejette jamais côté email (enqueueEmail ne rejette jamais) — une
 * défaillance SMTP ne doit jamais bloquer la tentative de connexion.
 */
async function requestOtp(user, ip) {
  let action; // 'created' | 'reused' | 'queue_exists' | 'cooldown'
  let freshCode = null;
  let expiresAt = null;
  let retryAfterSeconds = 0;

  mfaDiag("requestOtp() APPELÉ — signin ne doit PAS régénérer si un OTP valide existe déjà", { userId: user.id, ip });

  await sequelize.transaction(async (t) => {
    const lockedUser = await User.findByPk(user.id, { transaction: t, lock: t.LOCK.UPDATE });

    const existingJob = await findActiveJob({ userId: user.id, context: "mfa_otp" });
    const existingOtp = await findActiveOtp(user.id, t);

    mfaDiag("requestOtp() état constaté", {
      userId: user.id,
      existingJobId: existingJob?.id || null,
      existingJobStatus: existingJob?.status || null,
      existingOtpId: existingOtp?.id || null,
      existingOtp_hash: existingOtp?.otpHash || null,
      existingOtp_expire_at: existingOtp?.expiresAt?.toISOString() || null,
      mfaLastSentAt: lockedUser.mfaLastSentAt?.toISOString() || null,
    });

    if (existingJob) {
      action = "queue_exists";
      expiresAt = existingOtp?.expiresAt || new Date(Date.now() + OTP_TTL_MS);
      return;
    }

    if (existingOtp && existingOtp.expiresAt.getTime() - Date.now() > OTP_REUSE_MIN_REMAINING_MS) {
      action = "reused";
      expiresAt = existingOtp.expiresAt;
      mfaDiag("OTP REUSED", {
        userId: user.id,
        otpId: existingOtp.id,
        otp_hash: existingOtp.otpHash,
        otp_expire_at: existingOtp.expiresAt.toISOString(),
      });
      return;
    }

    const sinceLastSent = lockedUser.mfaLastSentAt ? Date.now() - lockedUser.mfaLastSentAt.getTime() : Infinity;
    if (sinceLastSent < RESEND_COOLDOWN_MS) {
      action = "cooldown";
      retryAfterSeconds = Math.ceil((RESEND_COOLDOWN_MS - sinceLastSent) / 1000);
      expiresAt = existingOtp?.expiresAt || null;
      return;
    }

    const fresh = await _issueFreshOtp(lockedUser, t, {
      replaced: !!existingOtp,
      previousOtpId: existingOtp?.id || null,
    });
    action = "created";
    freshCode = fresh.code;
    expiresAt = fresh.expiresAt;
  });

  if (action === "created") {
    await _sendOtpEmail(user, freshCode, ip);
    logger.info("MFA: nouveau code envoyé", { userId: user.id, ip });
  } else if (action === "reused") {
    await logMfaAttempt({ userId: user.id, email: user.email, ip, action: "otp_requested", success: true, reason: "otp_reused" });
    logger.info("MFA: OTP existant réutilisé — aucun nouvel email", { userId: user.id, ip });
  } else if (action === "queue_exists") {
    await logMfaAttempt({ userId: user.id, email: user.email, ip, action: "otp_requested", success: true, reason: "queue_already_exists" });
    logger.info("MFA: envoi déjà en cours pour cet utilisateur — aucun nouveau job", { userId: user.id, ip });
  } else if (action === "cooldown") {
    await logMfaAttempt({ userId: user.id, email: user.email, ip, action: "otp_requested", success: false, reason: "cooldown_active" });
    logger.info("MFA: cooldown actif — envoi ignoré", { userId: user.id, ip, retryAfterSeconds });
  }

  const challengeToken = signMfaChallengeToken({ userId: user.id });
  const decodedChallenge = jwt.decode(challengeToken);
  mfaDiag("challengeToken généré (signin)", {
    userId: user.id,
    sub: decodedChallenge?.sub,
    jti: decodedChallenge?.jti,
    exp: decodedChallenge?.exp,
    action,
  });

  const expiresInSeconds = expiresAt
    ? Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 1000))
    : Math.round(OTP_TTL_MS / 1000);

  const duplicate = action !== "created";
  const message =
    action === "cooldown"
      ? "Veuillez patienter avant de demander un nouveau code."
      : duplicate
        ? "Un code de vérification a déjà été envoyé. Veuillez consulter votre boîte mail."
        : "Un code de vérification a été envoyé par email.";

  return { challengeToken, expiresInSeconds, duplicate, action, message, retryAfterSeconds };
}

/**
 * Point d'entrée appelé par POST /auth/mfa/resend — renvoi EXPLICITE demandé
 * par l'utilisateur. Contrairement à requestOtp() (déclenchement automatique
 * au login), un OTP encore largement valide n'empêche PAS le renvoi : seule
 * la règle "OTP expiré OU plus de 60s depuis le dernier envoi" gouverne
 * (cahier des charges point 5) — sinon MfaCooldownError (→ HTTP 429).
 */
async function resendOtpChallenge(user, ip) {
  let allowed = false;
  let retryAfterSeconds = 0;
  let freshCode = null;
  let expiresAt = null;

  mfaDiag("resendOtpChallenge() APPELÉ", { userId: user.id, ip });

  await sequelize.transaction(async (t) => {
    const lockedUser = await User.findByPk(user.id, { transaction: t, lock: t.LOCK.UPDATE });
    const existingOtp = await findActiveOtp(user.id, t);

    const sinceLastSent = lockedUser.mfaLastSentAt ? Date.now() - lockedUser.mfaLastSentAt.getTime() : Infinity;
    allowed = !existingOtp || sinceLastSent >= RESEND_COOLDOWN_MS;

    mfaDiag("resendOtpChallenge() état constaté", {
      userId: user.id,
      existingOtpId: existingOtp?.id || null,
      existingOtp_expire_at: existingOtp?.expiresAt?.toISOString() || null,
      mfaLastSentAt: lockedUser.mfaLastSentAt?.toISOString() || null,
      allowed,
    });

    if (!allowed) {
      retryAfterSeconds = Math.ceil((RESEND_COOLDOWN_MS - sinceLastSent) / 1000);
      return;
    }

    // Un seul envoi actif à la fois : l'éventuel job encore en cours pour
    // l'ancien OTP devient inutile dès qu'un renvoi explicite est accordé.
    const existingJob = await findActiveJob({ userId: user.id, context: "mfa_otp" });
    if (existingJob) await cancelJob(existingJob.id, "resend_requested");

    const fresh = await _issueFreshOtp(lockedUser, t, {
      replaced: !!existingOtp,
      previousOtpId: existingOtp?.id || null,
    });
    freshCode = fresh.code;
    expiresAt = fresh.expiresAt;
  });

  if (!allowed) {
    await logMfaAttempt({ userId: user.id, email: user.email, ip, action: "otp_requested", success: false, reason: "cooldown_active" });
    logger.info("MFA: resend refusé (cooldown actif)", { userId: user.id, ip, retryAfterSeconds });
    throw new MfaCooldownError(retryAfterSeconds);
  }

  await _sendOtpEmail(user, freshCode, ip, "resend_");
  logger.info("MFA: nouveau code envoyé (resend)", { userId: user.id, ip });

  const challengeToken = signMfaChallengeToken({ userId: user.id });
  const decodedChallenge = jwt.decode(challengeToken);
  mfaDiag("challengeToken généré (resend)", {
    userId: user.id,
    sub: decodedChallenge?.sub,
    jti: decodedChallenge?.jti,
    exp: decodedChallenge?.exp,
  });

  const expiresInSeconds = Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 1000));
  return { challengeToken, expiresInSeconds };
}

/**
 * Vérifie le code fourni contre le dernier OTP actif de l'utilisateur.
 * @returns {Promise<{ok: boolean, reason?: string, attemptsLeft?: number}>}
 */
async function verifyOtp(user, code) {
  mfaDiag("verifyOtp() APPELÉ", {
    userId: user.id,
    otp_recu: SHOW_PLAINTEXT_OTP ? code : "[hidden in production]",
  });

  const otpRow = await MfaOtp.findOne({
    where: { userId: user.id, consumedAt: null },
    order: [["createdAt", "DESC"]],
  });

  if (!otpRow) {
    mfaDiag("OTP INVALID (aucun OTP actif trouvé pour cet userId)", { userId: user.id });
    return { ok: false, reason: "no_active_otp" };
  }

  mfaDiag("verifyOtp() OTP trouvé en base", {
    userId: user.id,
    otpId: otpRow.id,
    otp_hash_recupere: otpRow.otpHash,
    otp_expire_at: otpRow.expiresAt?.toISOString(),
    attempts: otpRow.attempts,
    maxAttempts: otpRow.maxAttempts,
    createdAt: otpRow.createdAt?.toISOString(),
  });

  if (otpRow.expiresAt.getTime() < Date.now()) {
    mfaDiag("OTP EXPIRED", { userId: user.id, otpId: otpRow.id, otp_expire_at: otpRow.expiresAt.toISOString(), now: new Date().toISOString() });
    return { ok: false, reason: "expired" };
  }
  if (otpRow.attempts >= otpRow.maxAttempts) {
    mfaDiag("OTP INVALID (max_attempts atteint)", { userId: user.id, otpId: otpRow.id, attempts: otpRow.attempts, maxAttempts: otpRow.maxAttempts });
    return { ok: false, reason: "max_attempts" };
  }

  const providedHash = hashOtp(code);
  mfaDiag("verifyOtp() comparaison des hash (SHA-256 — PAS bcrypt : voir note d'audit)", {
    userId: user.id,
    otpId: otpRow.id,
    otp_recu: SHOW_PLAINTEXT_OTP ? code : "[hidden in production]",
    hash_calcule_sur_otp_recu: providedHash,
    otp_hash_en_base: otpRow.otpHash,
    match: providedHash === otpRow.otpHash,
  });

  if (providedHash !== otpRow.otpHash) {
    mfaDiag("OTP INVALID (hash différent)", { userId: user.id, otpId: otpRow.id });
    // otpRow.update() mute déjà `otpRow.attempts` en mémoire vers la
    // nouvelle valeur (post-incrément) — attemptsLeft doit donc être calculé
    // directement à partir de cette valeur, sans soustraire 1 une seconde
    // fois (bug corrigé : renvoyait un tentativesLeft trop bas de 1).
    await otpRow.update({ attempts: otpRow.attempts + 1 });
    mfaDiag("SQL UPDATE mfa_otps (attempts++)", { userId: user.id, otpId: otpRow.id, attempts: otpRow.attempts });
    return { ok: false, reason: "wrong_code", attemptsLeft: Math.max(0, otpRow.maxAttempts - otpRow.attempts) };
  }

  mfaDiag("OTP VERIFIED", { userId: user.id, otpId: otpRow.id });

  // Nettoyage (cahier des charges point 7) : le hash et l'expiration ne sont
  // plus nécessaires une fois le code validé — `consumedAt` seul suffit à
  // empêcher toute réutilisation (voir le WHERE ci-dessus). L'éventuel job
  // EmailQueue encore PENDING/RETRYING pour cet OTP (ex: un retry après un
  // 451 Hostinger) devient inutile : on l'annule plutôt que de le laisser
  // continuer à tenter d'envoyer un code déjà validé.
  await otpRow.update({ consumedAt: new Date(), otpHash: null, expiresAt: null });
  mfaDiag("SQL UPDATE mfa_otps (consumedAt, otpHash=null, expiresAt=null)", { userId: user.id, otpId: otpRow.id });

  const staleJob = await findActiveJob({ userId: user.id, context: "mfa_otp" });
  if (staleJob) {
    await cancelJob(staleJob.id, "otp_verified");
    logger.info("MFA: job EmailQueue résiduel annulé après validation", { userId: user.id, jobId: staleJob.id });
  }

  return { ok: true };
}

// Marque le MFA comme vérifié maintenant (point 6 du cahier des charges) et
// enregistre le contexte de cette connexion — sert de référence pour
// détecter un changement lors de la PROCHAINE connexion.
async function recordMfaVerified(user, context) {
  await user.update({
    mfaLastVerifiedAt: new Date(),
    lastLoginIp: context.ip || user.lastLoginIp,
    lastLoginBrowser: context.browser || user.lastLoginBrowser,
    lastLoginCountry: context.country || user.lastLoginCountry,
    lastLoginDeviceId: context.deviceId || user.lastLoginDeviceId,
  });
  mfaDiag("SQL UPDATE users.mfaLastVerifiedAt", { userId: user.id, mfaLastVerifiedAt: new Date().toISOString() });
}

// Connexion réussie SANS passer par un OTP (device de confiance, ou fenêtre
// encore fraîche) — met à jour uniquement le contexte de connexion, PAS
// mfaLastVerifiedAt (qui ne doit avancer que sur une vérification OTP
// réelle — sinon la règle "3 jours"/"24h" ne serait jamais réellement testée
// pour un appareil non signalé comme changé).
async function recordLoginContext(user, context) {
  await user.update({
    lastLoginIp: context.ip || user.lastLoginIp,
    lastLoginBrowser: context.browser || user.lastLoginBrowser,
    lastLoginCountry: context.country || user.lastLoginCountry,
    lastLoginDeviceId: context.deviceId || user.lastLoginDeviceId,
  });
}

/**
 * Crée un appareil de confiance pour 30 jours et retourne le token en clair
 * (à remettre au client — jamais reloggé, jamais restocké en clair).
 */
async function createTrustedDevice(user, context, deviceName) {
  const { token, tokenHash, expiresAt } = signDeviceToken({ userId: user.id, deviceId: context.deviceId });

  await TrustedDevice.create({
    userId: user.id,
    deviceId: context.deviceId,
    tokenHash,
    deviceName: deviceName ? String(deviceName).slice(0, 150) : null,
    ip: context.ip || null,
    browser: context.browser || null,
    country: context.country || null,
    expiresAt,
    lastUsedAt: new Date(),
  });

  await logMfaAttempt({
    userId: user.id,
    email: user.email,
    ip: context.ip,
    action: "device_trusted",
    success: true,
  });

  return { token, expiresAt };
}

/**
 * Révoque toute confiance MFA existante pour cet utilisateur : force un
 * nouveau code MFA à la prochaine connexion, quel que soit l'appareil.
 * À appeler après un changement de mot de passe ou d'email (voir cahier des
 * charges : "Demander immédiatement un nouveau code MFA si... changement du
 * mot de passe... changement de l'email"). Déjà branché sur
 * POST /auth/reset-password (routes/auth.routes.js).
 */
async function invalidateMfaTrust(user, { ip, reason = "security_change" } = {}) {
  await user.update({ mfaLastVerifiedAt: null });
  await TrustedDevice.update(
    { revokedAt: new Date() },
    { where: { userId: user.id, revokedAt: null } }
  );

  await logMfaAttempt({
    userId: user.id,
    email: user.email,
    ip: ip || null,
    action: "mfa_invalidated",
    success: true,
    reason,
  });
}

module.exports = {
  evaluateMfaRequirement,
  requestOtp,
  resendOtpChallenge,
  MfaCooldownError,
  verifyOtp,
  recordMfaVerified,
  recordLoginContext,
  createTrustedDevice,
  invalidateMfaTrust,
  mfaIntervalForRole,
  OTP_TTL_MS,
};
