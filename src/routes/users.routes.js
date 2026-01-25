// routes/users.routes.js
const express = require("express");
const { authRequired } = require("../middleware/auth.middleware");
const UserProfile = require("../models/UserProfile");

const router = express.Router();

// GET /users/me/profile  ✅ récupérer profil du user connecté
router.get("/me/profile", authRequired, async (req, res) => {
  try {
    const userId = req.user.sub;

    let profile = await UserProfile.findOne({ where: { userId } });
    if (!profile) profile = await UserProfile.create({ userId });

    return res.json(profile);
  } catch (e) {
    console.error("GET_PROFILE_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// PUT /users/me/profile ✅ update profil du user connecté
router.put("/me/profile", authRequired, async (req, res) => {
  try {
    const userId = req.user.sub;

    const allowed = [
      "name",
      "designation",
      "birthday",
      "phone",
      "country",
      "state",
      "address",
      "about",
      "avatarUrl",
    ];

    const data = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) data[k] = req.body[k];
    }

    let profile = await UserProfile.findOne({ where: { userId } });
    if (!profile) profile = await UserProfile.create({ userId });

    await profile.update(data);

    return res.json(profile);
  } catch (e) {
    console.error("UPDATE_PROFILE_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

module.exports = router;
