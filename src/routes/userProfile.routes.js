// src/routes/userProfile.routes.js
const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth.middleware");
const UserProfile = require("../models/UserProfile");
const upload = require("../middleware/upload.middleware");
const User = require("../models/User");
// GET /users/me/profile
router.get("/me/profile", authRequired, async (req, res) => {
  try {
    const userId = req.user?.sub || req.user?.id;

    const profile = await UserProfile.findOne({ where: { userId } });
    const user = await User.findByPk(userId); // ✅ récupérer user

    if (!profile) {
      return res.status(404).json({ message: "Profile not found" });
    }

    // ✅ fusion profile + user
    return res.json({
      ...profile.toJSON(),
      email: user?.email || "",   // ✅ AJOUT IMPORTANT
      role: user?.role || "",     // (optionnel)
      isActive: user?.isActive ?? true // (optionnel)
    });

  } catch (e) {
    console.error("GET_PROFILE_ERROR:", e);
    return res.status(500).json({ message: "Server error" });
  }
});

// PUT /users/me/profile
router.put(
  "/me/profile",
  authRequired,
  upload.single("avatar"), // ✅ IMPORTANT
  async (req, res) => {
    try {
      const userId = req.user?.sub || req.user?.id;

      const allowed = [
        "name",
        "designation",
        "birthday",
        "phone",
        "country",
        "state",
        "address",
        "about",
      ];

      const payload = {};

      for (const k of allowed) {
        if (req.body?.[k] !== undefined) payload[k] = req.body[k];
      }

      // ✅ gérer avatar upload
      if (req.file) {
        payload.avatarUrl = `/uploads/avatars/${req.file.filename}`;
      }

      const [count] = await UserProfile.update(payload, {
        where: { userId },
      });

      if (!count)
        return res.status(404).json({ message: "Profile not found" });

      const updated = await UserProfile.findOne({
        where: { userId },
      });

      return res.json(updated);
    } catch (e) {
      console.error("UPDATE_PROFILE_ERROR:", e);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

module.exports = router; // ✅ OBLIGATOIRE (pas exports.router)
