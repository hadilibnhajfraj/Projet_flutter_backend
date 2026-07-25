// routes/users.routes.js
const express = require("express");
const { Op } = require("sequelize");
const { authRequired } = require("../middleware/auth.middleware");
const UserProfile = require("../models/UserProfile");
const User = require("../models/User");
const { NON_COMMERCIAL_ROLES } = require("../constants/commercialRoles");
const { resolveFullName } = require("../utils/userDisplay");
const upload = require("../middleware/upload.middleware");
const router = express.Router();

// Réponse complète et cohérente pour /me/profile — fusionne UserProfile
// (name, phone, birthday, ...) avec les champs qui vivent sur User
// (email, role). Utilisé par GET et PUT pour que le frontend reçoive
// toujours l'objet profil complet, jamais un sous-ensemble partiel.
function shapeMyProfile(profile, user) {
  return {
    ...profile.toJSON(),
    email: user?.email || "",
    role: user?.role || "",
    isActive: user?.isActive ?? true,
  };
}

// GET /users/commercials — utilisateurs sélectionnables comme "Commercial"
// dans le module Follow-up CRM. Chargé dynamiquement depuis la table users
// à chaque appel (aucune liste codée en dur de noms/emails) ; exclut
// uniquement les rôles admin-tier et techniques/opérationnels listés dans
// NON_COMMERCIAL_ROLES — tout autre rôle (commercial, user, et tout futur
// rôle commercial) est inclus automatiquement. Accessible à tout utilisateur
// connecté (pas admin-only), car c'est le commercial/l'opérateur lui-même
// qui doit pouvoir peupler ce menu déroulant.
router.get("/commercials", authRequired, async (req, res) => {
  try {
    const users = await User.findAll({
      where: {
        role: { [Op.notIn]: NON_COMMERCIAL_ROLES },
        isActive: true,
      },
      attributes: ["id", "email", "role"],
      include: [
        { model: UserProfile, as: "profile", attributes: ["name", "nom", "prenom"], required: false },
      ],
      order: [["email", "ASC"]],
    });

    const items = users.map((u) => ({
      id: u.id,
      fullName: resolveFullName(u),
      email: u.email,
      role: u.role,
    }));

    return res.json(items);
  } catch (err) {
    console.error("GET_COMMERCIALS_ERROR:", err);
    return res.status(500).json({ message: err.message || "Server error" });
  }
});

// GET /users/me/profile  ✅ récupérer profil du user connecté
router.get("/me/profile", authRequired, async (req, res) => {
  try {
    const userId = req.user.sub;

    let profile = await UserProfile.findOne({ where: { userId } });
    if (!profile) profile = await UserProfile.create({ userId });
    const user = await User.findByPk(userId, { attributes: ["id", "email", "role", "isActive"] });

    return res.json(shapeMyProfile(profile, user));
  } catch (e) {
    console.error("GET_PROFILE_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// PUT /users/me/profile ✅ update profil du user connecté
// upload.single("avatar") : accepte aussi bien un body JSON classique (pas de
// fichier envoyé, req.file est alors undefined et ne change rien) qu'un
// multipart/form-data avec un fichier "avatar" — voir _pickAvatar côté Flutter.
router.put("/me/profile", authRequired, upload.single("avatar"), async (req, res) => {
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
      // Champs RH — auto-remplissage du module "Demandes" (renseignés par un admin)
      "nom",
      "prenom",
      "matricule",
      "qualification",
      "departement",
      "service",
    ];

    // Ne mettre à jour QUE les champs réellement envoyés — jamais écraser un
    // champ absent par null/undefined (Object.assign/spread aveugle interdit).
    const data = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) data[k] = req.body[k];
    }

    // Avatar uploadé (multipart) — prioritaire sur un éventuel avatarUrl texte.
    if (req.file) {
      data.avatarUrl = `/uploads/avatars/${req.file.filename}`;
    }

    let profile = await UserProfile.findOne({ where: { userId } });
    if (!profile) profile = await UserProfile.create({ userId });

    console.log("UPDATE_PROFILE_REQUEST_BODY:", { ...req.body, hasFile: !!req.file });
    await profile.update(data);
    await profile.reload();

    const user = await User.findByPk(userId, { attributes: ["id", "email", "role", "isActive"] });
    const shaped = shapeMyProfile(profile, user);
    console.log("UPDATE_PROFILE_SAVED_USER:", shaped);

    return res.json(shaped);
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
    if (!["admin", "superadmin", "superadmin2"].includes(role)) {
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

// ── Administration — profil RH d'un autre utilisateur ─────────────────────
// Un admin/superadmin renseigne matricule/qualification/departement/service
// (+ nom/prenom) pour permettre l'auto-remplissage du module "Demandes" —
// l'employé ne saisit jamais ces informations lui-même.
function requireAdmin(req, res, next) {
  const role = (req.user?.role || "").toLowerCase();
  if (!["admin", "superadmin", "superadmin2"].includes(role)) {
    return res.status(403).json({ message: "Access denied" });
  }
  return next();
}

const HR_PROFILE_FIELDS = [
  "name",
  "designation",
  "phone",
  "nom",
  "prenom",
  "matricule",
  "qualification",
  "departement",
  "service",
];

router.get("/:id/profile", authRequired, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const user = await User.findByPk(userId, { attributes: ["id", "email", "role"] });
    if (!user) return res.status(404).json({ message: "Utilisateur introuvable" });

    let profile = await UserProfile.findOne({ where: { userId } });
    if (!profile) profile = await UserProfile.create({ userId });

    return res.json({ ...profile.toJSON(), email: user.email, role: user.role });
  } catch (e) {
    console.error("GET_USER_PROFILE_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

router.put("/:id/profile", authRequired, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const user = await User.findByPk(userId, { attributes: ["id"] });
    if (!user) return res.status(404).json({ message: "Utilisateur introuvable" });

    const data = {};
    for (const k of HR_PROFILE_FIELDS) {
      if (req.body[k] !== undefined) data[k] = req.body[k];
    }

    let profile = await UserProfile.findOne({ where: { userId } });
    if (!profile) profile = await UserProfile.create({ userId });
    await profile.update(data);

    return res.json(profile);
  } catch (e) {
    console.error("UPDATE_USER_PROFILE_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

module.exports = router;
