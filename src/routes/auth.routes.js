// routes/auth.routes.js
const express = require("express");
const bcrypt = require("bcrypt");
const rateLimit = require("express-rate-limit");
const User = require("../models/User");
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require("../utils/tokens");
const UserProfile = require("../models/UserProfile");

const router = express.Router();

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

    if (!isValidEmail(email)) return res.status(400).json({ message: "Invalid email" });
    if (!isStrongPassword(password)) return res.status(400).json({ message: "Weak password (min 8 chars)" });

    const cleanEmail = email.toLowerCase().trim();

    const exists = await User.findOne({ where: { email: cleanEmail } });
    if (exists) return res.status(409).json({ message: "Email already used" });

    const passwordHash = await bcrypt.hash(password, 12);

    // ✅ Nouveau user: disabled par défaut
    // ✅ role forcé "user" (pas de création admin/superadmin via signup)
    const user = await User.create({
      email: cleanEmail,
      passwordHash,
      isActive: false,   // ✅ disabled par défaut
      role: "user",
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
      user: { id: user.id, email: user.email, role: user.role, isActive: user.isActive },
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
