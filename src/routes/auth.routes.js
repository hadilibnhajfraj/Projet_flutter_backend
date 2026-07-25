// routes/auth.routes.js
const express = require("express");
const bcrypt = require("bcrypt");
const rateLimit = require("express-rate-limit");
const User = require("../models/User");
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require("../utils/tokens");
const UserProfile = require("../models/UserProfile");
// routes/auth.routes.js (ajoute en haut si pas déjà)
const crypto = require("crypto");
const { generateResetToken } = require("../utils/passwordReset");
const { logAttempt, countRecentRequestsByEmail } = require("../services/passwordResetLog.service");
const { enqueueEmail } = require("../services/emailQueue.service");
const logger = require("../utils/logger");

// ── MFA (conservé pour /auth/mfa/verify et /auth/mfa/resend uniquement —
// plus utilisé par /auth/signin) ─────────────────────────────────────────
const {
  resendOtpChallenge,
  MfaCooldownError,
  verifyOtp,
  recordMfaVerified,
  createTrustedDevice,
  invalidateMfaTrust,
} = require("../services/mfa.service");
const { getRequestContext } = require("../utils/requestContext");
const { mfaChallengeRequired, requireMfaFeatureEnabled } = require("../middleware/mfaChallenge.middleware");
const { logMfaAttempt } = require("../services/mfaAttemptLog.service");

const router = express.Router();

// Même variable que le reste du code (followupAutomation.service.js,
// hrRequest.service.js, ...) — unifiée ici pour que le lien de reset pointe
// vers le même domaine que les autres emails du système.
const APP_WEB_URL = process.env.APP_WEB_URL || "https://www.crmprobar.com";

const RESET_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes
const RESET_EMAIL_MAX_PER_HOUR = 3;
const RESET_EMAIL_WINDOW_MS = 60 * 60 * 1000;

// `skip` en environnement de test : les tests d'intégration (Jest +
// Supertest) enchaînent volontairement plus de requêtes que ce plafond
// depuis la même IP locale pour couvrir plusieurs scénarios ; la limite par
// IP elle-même (comportement production) n'est pas ce qui est testé ici.
const isTestEnv = () => process.env.NODE_ENV === "test";

const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 heure
  max: 10, // 10 demandes par IP par heure
  standardHeaders: true,
  legacyHeaders: false,
  skip: isTestEnv,
});

const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20, // limite le brute-force de token par IP
  standardHeaders: true,
  legacyHeaders: false,
  skip: isTestEnv,
});

// Message volontairement identique dans TOUS les cas (email invalide,
// utilisateur inexistant, rate-limit, envoi immédiat, envoi mis en file
// d'attente suite à une erreur SMTP temporaire, ou échec définitif) — un
// message qui varierait selon l'état réel de l'envoi permettrait de
// distinguer un email existant d'un email inexistant (oracle d'énumération).
const NEUTRAL_MESSAGE =
  "Si un compte est associé à cette adresse email, un lien de réinitialisation sera envoyé dès que le service de messagerie sera disponible.";

// Template email professionnel Probar — pas de logo image (aucun email du
// système n'en embarque, une URL non vérifiée casserait l'affichage), bouton
// bleu de marque (#1573FE, identique à colorPrimary100 côté Flutter).
function buildResetPasswordEmail(resetLink) {
  const subject = "Réinitialisation de votre mot de passe";
  const text = [
    "Bonjour,",
    "",
    "Nous avons reçu une demande de réinitialisation de votre mot de passe.",
    "",
    `Cliquez sur ce lien pour le réinitialiser : ${resetLink}`,
    "",
    "Ce lien expire dans 15 minutes.",
    "",
    "Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet email.",
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
          <p style="margin:0 0 24px;">Nous avons reçu une demande de réinitialisation de votre mot de passe. Cliquez sur le bouton ci-dessous :</p>
          <p style="margin:0 0 24px;text-align:center;">
            <a href="${resetLink}" style="display:inline-block;background:#1573FE;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:14px 28px;border-radius:10px;">
              RÉINITIALISER MON MOT DE PASSE
            </a>
          </p>
          <p style="margin:0 0 8px;color:#64748B;font-size:12.5px;word-break:break-all;">
            Ou copiez ce lien dans votre navigateur : <a href="${resetLink}" style="color:#1573FE;">${resetLink}</a>
          </p>
          <p style="margin:24px 0 0;color:#64748B;font-size:13px;">Ce lien expire dans <b>15 minutes</b>.</p>
          <p style="margin:8px 0 0;color:#94A3B8;font-size:12.5px;">Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet email.</p>
          <p style="margin:24px 0 0;">Cordialement,<br/>Probar CRM</p>
        </div>
      </div>
    </div>
  `;

  return { subject, text, html };
}

// POST /auth/forgot-password
// Sécurité : la réponse est TOUJOURS identique (message neutre), quel que
// soit le cas (email invalide, utilisateur inexistant, rate-limit atteint,
// ou envoi réussi) — ne jamais révéler si une adresse existe.
router.post("/forgot-password", forgotLimiter, async (req, res) => {
  const ip = req.ip;
  const rawEmail = typeof req.body?.email === "string" ? req.body.email : "";
  const cleanEmail = rawEmail.toLowerCase().trim();

  try {
    if (!isValidEmail(rawEmail)) {
      await logAttempt({ email: cleanEmail || rawEmail, ip, action: "requested", success: false, reason: "invalid_email" });
      return res.json({ message: NEUTRAL_MESSAGE });
    }

    const user = await User.findOne({ where: { email: cleanEmail } });
    if (!user) {
      logger.info("FORGOT_PASSWORD: user not found", { email: cleanEmail, ip });
      await logAttempt({ email: cleanEmail, ip, action: "requested", success: false, reason: "user_not_found" });
      return res.json({ message: NEUTRAL_MESSAGE });
    }
    logger.info("FORGOT_PASSWORD: user found", { userId: user.id, email: cleanEmail, ip });

    // Max 3 demandes / heure / utilisateur — vérifié via le journal
    // (persistant, contrairement à un limiter en mémoire).
    const recentCount = await countRecentRequestsByEmail(cleanEmail, RESET_EMAIL_WINDOW_MS);
    if (recentCount >= RESET_EMAIL_MAX_PER_HOUR) {
      logger.info("FORGOT_PASSWORD: rate limited (3/h/email)", { email: cleanEmail, ip, recentCount });
      await logAttempt({ email: cleanEmail, ip, action: "requested", success: false, reason: "rate_limited_email" });
      return res.json({ message: NEUTRAL_MESSAGE });
    }

    const { token, tokenHash } = generateResetToken();
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
    logger.info("FORGOT_PASSWORD: token generated", { userId: user.id, expiresAt: expiresAt.toISOString() });

    await user.update({
      resetPasswordTokenHash: tokenHash,
      resetPasswordExpiresAt: expiresAt,
      resetPasswordRequestedAt: new Date(),
    });
    logger.info("FORGOT_PASSWORD: token saved to DB", { userId: user.id });

    const resetLink = `${APP_WEB_URL}/#/authentication/reset_password?token=${token}&email=${encodeURIComponent(cleanEmail)}`;
    const { subject, text, html } = buildResetPasswordEmail(resetLink);

    logger.info("FORGOT_PASSWORD: starting email send", { to: cleanEmail });
    // enqueueEmail() ne rejette JAMAIS : le token est déjà en base (ci-dessus)
    // et la requête ne doit jamais échouer à cause d'un souci SMTP. Si
    // Hostinger répond une erreur temporaire (451/429 — ex: "Ratelimit
    // exceeded"), le message est conservé et réessayé automatiquement en
    // arrière-plan (30s/1min/2min/5min, 5 tentatives max) — voir
    // services/emailQueue.service.js. Toute autre erreur (554, auth, ...)
    // est journalisée en entier et marque la ligne FAILED pour renvoi manuel,
    // sans jamais remonter au client.
    const { status: queueStatus, jobId } = await enqueueEmail({
      to: cleanEmail,
      subject,
      text,
      html,
      context: "password_reset",
      meta: { email: cleanEmail },
    });
    logger.info("FORGOT_PASSWORD: email queue status", { to: cleanEmail, jobId, status: queueStatus });

    // reason reflète l'état réel de l'envoi (audit interne uniquement — la
    // réponse HTTP au client reste rigoureusement identique dans tous les cas).
    const reasonByStatus = { SENT: "sent", RETRYING: "queued_retry", FAILED: "queued_failed" };
    await logAttempt({
      email: cleanEmail,
      ip,
      action: "requested",
      success: queueStatus === "SENT",
      reason: reasonByStatus[queueStatus] || "queued_unknown",
    });
    return res.json({ message: NEUTRAL_MESSAGE });
  } catch (e) {
    // Erreur complète toujours journalisée côté serveur (jamais masquée) —
    // seule la réponse HTTP envoyée au client reste neutre, par sécurité
    // (ne jamais révéler si l'email existe / si l'envoi a réussi).
    logger.error("FORGOT_PASSWORD_ERROR:", {
      email: cleanEmail || rawEmail,
      ip,
      message: e?.message,
      code: e?.code,
      command: e?.command,
      responseCode: e?.responseCode,
      response: e?.response,
      stack: e?.stack,
    });
    await logAttempt({ email: cleanEmail || rawEmail, ip, action: "requested", success: false, reason: "server_error" });
    // Réponse neutre même en cas d'erreur serveur inattendue.
    return res.json({ message: NEUTRAL_MESSAGE });
  }
});

function isValidToken(t) {
  return typeof t === "string" && t.length >= 20 && t.length <= 200;
}

// Règle de force dédiée au reset — volontairement séparée de
// isStrongPassword (utilisée par signup/signin) pour ne jamais empêcher un
// utilisateur existant de se connecter avec un mot de passe légitime qui ne
// suivrait pas ces nouvelles règles plus strictes.
function isStrongPasswordForReset(pw) {
  if (typeof pw !== "string" || pw.length < 8 || pw.length > 72) return false;
  if (!/[A-Z]/.test(pw)) return false;
  if (!/[a-z]/.test(pw)) return false;
  if (!/[0-9]/.test(pw)) return false;
  if (!/[^A-Za-z0-9]/.test(pw)) return false;
  return true;
}

// Résout le statut d'un couple email/token — utilisé par le GET /validate
// et par le POST /reset-password, pour ne jamais dupliquer la logique de
// vérification (expiré / invalide / valide).
async function resolveResetToken(email, token) {
  if (!isValidEmail(email) || !isValidToken(token)) {
    return { status: "invalid" };
  }
  const cleanEmail = email.toLowerCase().trim();
  const user = await User.findOne({ where: { email: cleanEmail } });

  if (!user || !user.resetPasswordTokenHash || !user.resetPasswordExpiresAt) {
    return { status: "invalid" };
  }

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  if (user.resetPasswordTokenHash !== tokenHash) {
    return { status: "invalid" };
  }

  if (new Date(user.resetPasswordExpiresAt).getTime() < Date.now()) {
    return { status: "expired", user, cleanEmail };
  }

  return { status: "valid", user, cleanEmail };
}

// GET /auth/reset-password/validate?email=...&token=...
// Permet à l'écran Reset Password d'afficher le bon état (formulaire / lien
// expiré / lien invalide) avant même que l'utilisateur ne saisisse un
// nouveau mot de passe. Un token déjà utilisé retombe naturellement sur
// "invalid" (les champs sont remis à null après un reset réussi).
router.get("/reset-password/validate", async (req, res) => {
  const ip = req.ip;
  const { email, token } = req.query || {};

  try {
    const result = await resolveResetToken(typeof email === "string" ? email : "", typeof token === "string" ? token : "");
    await logAttempt({
      email: (typeof email === "string" ? email.toLowerCase().trim() : "") || "unknown",
      ip,
      action: "validated",
      success: result.status === "valid",
      reason: result.status,
    });

    if (result.status === "valid") return res.json({ valid: true });
    return res.json({ valid: false, reason: result.status });
  } catch (e) {
    console.error("VALIDATE_RESET_TOKEN_ERROR:", e);
    return res.json({ valid: false, reason: "invalid" });
  }
});

// POST /auth/reset-password
router.post("/reset-password", resetLimiter, async (req, res) => {
  const ip = req.ip;
  const { email, token, newPassword } = req.body || {};
  const cleanEmail = typeof email === "string" ? email.toLowerCase().trim() : "";

  try {
    if (!isStrongPasswordForReset(newPassword)) {
      await logAttempt({ email: cleanEmail, ip, action: "completed", success: false, reason: "weak_password" });
      return res.status(400).json({
        message:
          "Le mot de passe doit contenir au moins 8 caractères, une majuscule, une minuscule, un chiffre et un caractère spécial.",
      });
    }

    const result = await resolveResetToken(email, token);

    if (result.status === "expired") {
      await logAttempt({ email: cleanEmail, ip, action: "completed", success: false, reason: "expired" });
      return res.status(400).json({ message: "Ce lien a expiré. Demandez un nouveau lien.", reason: "expired" });
    }
    if (result.status === "invalid") {
      await logAttempt({ email: cleanEmail, ip, action: "completed", success: false, reason: "invalid" });
      return res.status(400).json({ message: "Lien invalide.", reason: "invalid" });
    }

    const { user } = result;

    // update password + invalidate reset token + invalidate refresh
    const passwordHash = await bcrypt.hash(newPassword, 12);

    await user.update({
      passwordHash,
      resetPasswordTokenHash: null,
      resetPasswordExpiresAt: null,
      refreshTokenHash: null, // force re-login partout
    });

    // MFA : un changement de mot de passe révoque tous les appareils de
    // confiance et force un nouveau code MFA à la prochaine connexion (voir
    // cahier des charges MFA — "changement du mot de passe" est un des
    // déclencheurs explicites). C'est ce qui rend le système MFA
    // "entièrement compatible" avec le flux Forgot Password existant.
    await invalidateMfaTrust(user, { ip, reason: "password_reset" });

    await logAttempt({ email: cleanEmail, ip, action: "completed", success: true, reason: "success" });
    return res.json({ message: "Votre mot de passe a été modifié avec succès." });
  } catch (e) {
    console.error("RESET_PASSWORD_ERROR:", e);
    await logAttempt({ email: cleanEmail, ip, action: "completed", success: false, reason: "server_error" });
    return res.status(500).json({ message: "Server error" });
  }
});



const signinLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

function isValidEmail(email) {
  return typeof email === "string" && email.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function isStrongPassword(pw) {
  return typeof pw === "string" && pw.length >= 8 && pw.length <= 72;
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/auth/refresh",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

// Émet accessToken + refreshToken (cookie httpOnly) pour `user` — partagé
// entre POST /auth/signin (chemin sans MFA) et POST /auth/mfa/verify (chemin
// après validation du code). Réponse identique dans les deux cas, pour ne
// jamais forcer le client Flutter à distinguer les deux origines.
async function issueSession(res, user) {
  const payload = { sub: user.id, email: user.email, role: user.role };
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);

  await user.update({ refreshTokenHash: await bcrypt.hash(refreshToken, 12) });

  res.cookie("refreshToken", refreshToken, cookieOptions());

  return {
    user: { id: user.id, email: user.email, role: user.role, isActive: user.isActive },
    accessToken,
    refreshToken,
  };
}

const mfaVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30, // limite le brute-force du code OTP par IP (en plus des `attempts` par OTP)
  standardHeaders: true,
  legacyHeaders: false,
  skip: isTestEnv,
});

const mfaResendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5, // 5 renvois par IP par heure
  standardHeaders: true,
  legacyHeaders: false,
  skip: isTestEnv,
});

// POST /auth/signup

// POST /auth/signup
router.post("/signup", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!isValidEmail(email)) {
      return res.status(400).json({ message: "Invalid email" });
    }

    if (!isStrongPassword(password)) {
      return res.status(400).json({ message: "Weak password (min 8 chars)" });
    }

    const cleanEmail = String(email).toLowerCase().trim();

    const exists = await User.findOne({ where: { email: cleanEmail } });
    if (exists) {
      return res.status(409).json({ message: "Email already used" });
    }

    const passwordHash = await bcrypt.hash(String(password), 12);

    // ✅ rôle auto selon email
    let role = "user";

    if (cleanEmail === "accueilcbif@gmail.com") {
      role = "accueil";
    } else if (cleanEmail.endsWith("@probardistribution.com")) {
      role = "commercial";
    }

    // ✅ Nouveau user: disabled par défaut
    const user = await User.create({
      email: cleanEmail,
      passwordHash,
      isActive: false,
      role,
    });

    await UserProfile.create({
      userId: user.id,
      name: null,
      designation: null,
      birthday: null,
      phone: null,
      country: null,
      state: null,
      address: null,
      about: null,
      avatarUrl: null,
    });

    return res.status(201).json({
      message: "Account created. Waiting for admin activation.",
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
      },
    });
  } catch (e) {
    console.error("SIGNUP_ERROR:", e);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /auth/signin
router.post("/signin", signinLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!isValidEmail(email)) return res.status(400).json({ message: "Invalid email" });
    if (!isStrongPassword(password)) return res.status(400).json({ message: "Invalid password" });

    const cleanEmail = email.toLowerCase().trim();
    const user = await User.findOne({ where: { email: cleanEmail } });

    if (!user) return res.status(401).json({ message: "Invalid credentials" });

    // ✅ disabled => refuse login
    if (!user.isActive) {
      return res.status(403).json({ message: "Account not activated. Please contact admin." });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    // Login classique : email + mot de passe suffisent, JWT émis directement.
    // Aucune logique MFA (OTP/challenge/EmailQueue) n'intervient ici — le
    // code MFA reste disponible dans services/mfa.service.js et sur les
    // routes /auth/mfa/verify et /auth/mfa/resend, mais n'est plus appelé
    // depuis /auth/signin.
    const session = await issueSession(res, user);
    return res.json(session);
  } catch (e) {
    console.error("SIGNIN_ERROR:", e);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /auth/mfa/verify
// Body: { challengeToken, otp, deviceId, deviceName?, trustDevice? }
router.post("/mfa/verify", requireMfaFeatureEnabled, mfaVerifyLimiter, mfaChallengeRequired, async (req, res) => {
  const ip = req.ip;
  const user = req.mfaUser;
  const { otp, trustDevice, deviceName } = req.body || {};

  try {
    if (typeof otp !== "string" || !/^\d{6}$/.test(otp)) {
      return res.status(400).json({ message: "Code invalide." });
    }

    const result = await verifyOtp(user, otp);

    if (!result.ok) {
      await logMfaAttempt({
        userId: user.id,
        email: user.email,
        ip,
        action: "otp_failed",
        success: false,
        reason: result.reason,
      });

      if (result.reason === "expired" || result.reason === "no_active_otp") {
        return res.status(400).json({ message: "Ce code a expiré. Demandez un nouveau code.", reason: "expired" });
      }
      if (result.reason === "max_attempts") {
        return res.status(429).json({ message: "Trop de tentatives. Demandez un nouveau code.", reason: "max_attempts" });
      }
      return res.status(400).json({
        message: "Code incorrect.",
        reason: "wrong_code",
        attemptsLeft: result.attemptsLeft,
      });
    }

    const context = getRequestContext(req);
    await recordMfaVerified(user, context);

    await logMfaAttempt({ userId: user.id, email: user.email, ip, action: "otp_verified", success: true });

    let deviceToken = null;
    if (trustDevice === true && context.deviceId) {
      const created = await createTrustedDevice(user, context, deviceName);
      deviceToken = created.token;
    }

    const session = await issueSession(res, user);
    return res.json({ ...session, mfaRequired: false, deviceToken });
  } catch (e) {
    console.error("MFA_VERIFY_ERROR:", e);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /auth/mfa/resend
// Body: { challengeToken }
// Conditions (cahier des charges point 5) : autorisé seulement si l'OTP
// actuel a expiré OU si plus de 60s se sont écoulées depuis le dernier envoi
// — sinon HTTP 429 (resendOtpChallenge lève MfaCooldownError).
router.post("/mfa/resend", requireMfaFeatureEnabled, mfaResendLimiter, mfaChallengeRequired, async (req, res) => {
  const ip = req.ip;
  const user = req.mfaUser;

  try {
    const { challengeToken, expiresInSeconds } = await resendOtpChallenge(user, ip);
    return res.json({
      mfaRequired: true,
      challengeToken,
      expiresInSeconds,
      message: "Un nouveau code de vérification a été envoyé par email.",
    });
  } catch (e) {
    if (e instanceof MfaCooldownError) {
      return res.status(429).json({
        message: "Veuillez patienter avant de demander un nouveau code.",
        reason: "cooldown_active",
        retryAfterSeconds: e.retryAfterSeconds,
      });
    }
    console.error("MFA_RESEND_ERROR:", e);
    return res.status(500).json({ message: "Server error" });
  }
});


// POST /auth/refresh
router.post("/refresh", async (req, res) => {
  try {
    const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;
    if (!refreshToken) return res.status(401).json({ message: "Missing refresh token" });

    const decoded = verifyRefreshToken(refreshToken);
    const user = await User.findByPk(decoded.sub);
    if (!user || !user.refreshTokenHash) return res.status(401).json({ message: "Invalid refresh token" });

    const match = await bcrypt.compare(refreshToken, user.refreshTokenHash);
    if (!match) return res.status(401).json({ message: "Invalid refresh token" });

    const payload = { sub: user.id, email: user.email, role: user.role };
    const newAccessToken = signAccessToken(payload);

    return res.json({ accessToken: newAccessToken });
  } catch (e) {
    console.error("REFRESH_ERROR:", e);
    return res.status(401).json({ message: "Invalid refresh token" });
  }
});

// POST /auth/logout
router.post("/logout", async (req, res) => {
  try {
    const refreshToken = req.cookies?.refreshToken;
    if (refreshToken) {
      try {
        const decoded = verifyRefreshToken(refreshToken);
        const user = await User.findByPk(decoded.sub);
        if (user) await user.update({ refreshTokenHash: null });
      } catch (_) {}
    }

    res.clearCookie("refreshToken", { path: "/auth/refresh" });
    return res.json({ message: "Logged out" });
  } catch (e) {
    console.error("LOGOUT_ERROR:", e);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
