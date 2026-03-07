// routes/auth.routes.js
const express = require("express");
const bcrypt = require("bcrypt");
const rateLimit = require("express-rate-limit");
const User = require("../models/User");
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require("../utils/tokens");
const UserProfile = require("../models/UserProfile");
// routes/auth.routes.js (ajoute en haut si pas déjà)
const crypto = require("crypto");
const { sendMail } = require("../utils/mailer");
const { generateResetToken } = require("../utils/passwordReset");
const router = express.Router();
// (optionnel) base URL frontend pour construire le lien
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:57745";

const forgotLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /auth/forgot-password
router.post("/forgot-password", forgotLimiter, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!isValidEmail(email)) {
      // réponse neutre (évite l’enumération d’emails)
      return res.json({ message: "If the email exists, a reset link has been sent." });
    }

    const cleanEmail = email.toLowerCase().trim();
    const user = await User.findOne({ where: { email: cleanEmail } });

    // réponse neutre même si pas trouvé
    if (!user) {
      return res.json({ message: "If the email exists, a reset link has been sent." });
    }

    const { token, tokenHash } = generateResetToken();

    // expire dans 30 minutes (tu peux changer)
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    await user.update({
      resetPasswordTokenHash: tokenHash,
      resetPasswordExpiresAt: expiresAt,
    });

    // lien reset (frontend)
    const resetLink = `${FRONTEND_URL}/reset-password?token=${token}&email=${encodeURIComponent(cleanEmail)}`;

    const subject = "Reset your password";
    const text = `You requested a password reset. Open this link: ${resetLink} (valid 30 minutes).`;
    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.5">
        <h2>Password reset</h2>
        <p>You requested a password reset.</p>
        <p>
          <a href="${resetLink}" style="display:inline-block;padding:10px 14px;border-radius:8px;background:#0F4FA8;color:#fff;text-decoration:none">
            Reset password
          </a>
        </p>
        <p style="color:#555">This link is valid for 30 minutes.</p>
        <p style="color:#999;font-size:12px">If you did not request this, ignore this email.</p>
      </div>
    `;

    // envoi email
    await sendMail({ to: cleanEmail, subject, text, html });

    return res.json({ message: "If the email exists, a reset link has been sent." });
  } catch (e) {
    console.error("FORGOT_PASSWORD_ERROR:", e);
    // réponse neutre
    return res.json({ message: "If the email exists, a reset link has been sent." });
  }
});

function isValidToken(t) {
  return typeof t === "string" && t.length >= 20 && t.length <= 200;
}

// POST /auth/reset-password
router.post("/reset-password", async (req, res) => {
  try {
    const { email, token, newPassword } = req.body || {};

    if (!isValidEmail(email)) return res.status(400).json({ message: "Invalid email" });
    if (!isValidToken(token)) return res.status(400).json({ message: "Invalid token" });
    if (!isStrongPassword(newPassword)) return res.status(400).json({ message: "Weak password (min 8 chars)" });

    const cleanEmail = email.toLowerCase().trim();

    // hash token reçu pour comparer avec DB
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const user = await User.findOne({ where: { email: cleanEmail } });
    if (!user || !user.resetPasswordTokenHash || !user.resetPasswordExpiresAt) {
      return res.status(400).json({ message: "Invalid or expired reset token" });
    }

    // expire ?
    if (new Date(user.resetPasswordExpiresAt).getTime() < Date.now()) {
      return res.status(400).json({ message: "Invalid or expired reset token" });
    }

    // match ?
    if (user.resetPasswordTokenHash !== tokenHash) {
      return res.status(400).json({ message: "Invalid or expired reset token" });
    }

    // update password + invalidate reset token + invalidate refresh
    const passwordHash = await bcrypt.hash(newPassword, 12);

    await user.update({
      passwordHash,
      resetPasswordTokenHash: null,
      resetPasswordExpiresAt: null,
      refreshTokenHash: null, // force re-login partout
    });

    return res.json({ message: "Password updated successfully. Please sign in again." });
  } catch (e) {
    console.error("RESET_PASSWORD_ERROR:", e);
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

    const payload = { sub: user.id, email: user.email, role: user.role };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    await user.update({ refreshTokenHash: await bcrypt.hash(refreshToken, 12) });

    res.cookie("refreshToken", refreshToken, cookieOptions());

    return res.json({
      user: { id: user.id, email: user.email, role: user.role, isActive: user.isActive },
      accessToken,
    });
  } catch (e) {
    console.error("SIGNIN_ERROR:", e);
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
