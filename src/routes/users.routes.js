// routes/users.routes.js
const express = require("express");
const { authRequired } = require("../middleware/auth.middleware");
const UserProfile = require("../models/UserProfile");
const User = require("../models/User");
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
router.get("/", authRequired, async (req, res) => {
  try {
    console.log("USER CONNECTED:", req.user);

    const role = (req.user?.role || "").toLowerCase();

    // 🔒 sécurité : seul admin/superadmin peut voir la liste
    if (!["admin", "superadmin"].includes(role)) {
      return res.status(403).json({
        message: "Access denied",
      });
    }

    // 🔥 option filtre par role (ex: ?role=user)
    const { role: roleFilter } = req.query;

    const where = {};

    if (roleFilter) {
      where.role = roleFilter.toLowerCase();
    }

    const users = await User.findAll({
      where,
      attributes: ["id", "email", "role"],
      order: [["email", "ASC"]],
    });

    res.json(users);

  } catch (err) {
    console.error("USERS ERROR:", err);
    res.status(500).json({
      message: err.message || "Server error",
    });
  }
});
module.exports = router;
