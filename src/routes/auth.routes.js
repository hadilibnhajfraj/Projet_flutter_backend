const express = require("express");
const bcrypt = require("bcrypt");
const rateLimit = require("express-rate-limit");
const User = require("../models/User");
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} = require("../utils/tokens");

const router = express.Router();

const signinLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

function isValidEmail(email) {
  return (
    typeof email === "string" &&
    email.length <= 200 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );
}
function isStrongPassword(pw) {
  return typeof pw === "string" && pw.length >= 8 && pw.length <= 72;
}

// POST /auth/signup
router.post("/signup", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!isValidEmail(email)) return res.status(400).json({ message: "Invalid email" });
    if (!isStrongPassword(password)) return res.status(400).json({ message: "Password too weak (min 8 chars)" });

    const cleanEmail = email.toLowerCase().trim();

    const exists = await User.findOne({ where: { email: cleanEmail } });
    if (exists) return res.status(409).json({ message: "Email already used" });

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await User.create({
      email: cleanEmail,
      passwordHash,
      isActive: true,
    });

    const payload = { sub: user.id, email: user.email };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    const refreshTokenHash = await bcrypt.hash(refreshToken, 12);
    await user.update({ refreshTokenHash });

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: false, // true en HTTPS
      sameSite: "lax",
      path: "/auth/refresh",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.status(201).json({
      user: { id: user.id, email: user.email },
      accessToken,
    });
  } catch (e) {
    console.error("SIGNUP_ERROR:", e); // ✅ important pour voir la vraie erreur
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// POST /auth/signin
router.post("/signin", signinLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!isValidEmail(email) || typeof password !== "string") {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    const cleanEmail = email.toLowerCase().trim();
    const user = await User.findOne({ where: { email: cleanEmail } });

    if (!user) return res.status(401).json({ message: "Invalid credentials" });
    if (!user.isActive) return res.status(403).json({ message: "Account disabled" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    const payload = { sub: user.id, email: user.email };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    const refreshTokenHash = await bcrypt.hash(refreshToken, 12);
    await user.update({ refreshTokenHash });

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/auth/refresh",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.json({
      user: { id: user.id, email: user.email },
      accessToken,
    });
  } catch (e) {
    console.error("SIGNIN_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
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

    const payload = { sub: user.id, email: user.email };
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
