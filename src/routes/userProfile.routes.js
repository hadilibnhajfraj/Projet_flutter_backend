// src/routes/userProfile.routes.js
const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth.middleware");
const UserProfile = require("../models/UserProfile");

// GET /users/me/profile
router.get("/me/profile", authRequired, async (req, res) => {
  try {
    const userId = req.user?.sub || req.user?.id; // selon ton middleware
    const profile = await UserProfile.findOne({ where: { userId } });
    if (!profile) return res.status(404).json({ message: "Profile not found" });
    return res.json(profile);
  } catch (e) {
    console.error("GET_PROFILE_ERROR:", e);
    return res.status(500).json({ message: "Server error" });
  }
});

// PUT /users/me/profile
router.put("/me/profile", authRequired, async (req, res) => {
  try {
    const userId = req.user?.sub || req.user?.id;

    const allowed = ["name", "designation", "birthday", "phone", "country", "state", "address", "about", "avatarUrl"];
    const payload = {};
    for (const k of allowed) {
      if (req.body?.[k] !== undefined) payload[k] = req.body[k];
    }

    const [count] = await UserProfile.update(payload, { where: { userId } });
    if (!count) return res.status(404).json({ message: "Profile not found" });

    const updated = await UserProfile.findOne({ where: { userId } });
    return res.json(updated);
  } catch (e) {
    console.error("UPDATE_PROFILE_ERROR:", e);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router; // ✅ OBLIGATOIRE (pas exports.router)
