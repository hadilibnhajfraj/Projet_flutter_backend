const express = require("express");
const { Op } = require("sequelize");
const { Project, UserProject, ProjectComment } = require("../models/associations");
const { authRequired } = require("../middleware/auth.middleware");

const router = express.Router();

// ---------------- Helpers ----------------
function reqStr(v) {
  return typeof v === "string" ? v.trim() : "";
}

function isValidPhone(v) {
  const s = reqStr(v);
  return s.length >= 6 && s.length <= 30 && /^[0-9+\s\-()]+$/.test(s);
}

function isValidDateOnly(v) {
  const s = reqStr(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isValidLatLng(lat, lng) {
  const la = Number(lat);
  const lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return false;
  return la >= -90 && la <= 90 && lo >= -180 && lo <= 180;
}

// ✅ normalize payload (flutter-friendly)
function normalizePayload(body = {}) {
  const b = { ...body };

  // support: location:{lat,lng}
  if (b.location && (b.latitude === undefined || b.longitude === undefined)) {
    if (b.location.lat !== undefined) b.latitude = b.location.lat;
    if (b.location.lng !== undefined) b.longitude = b.location.lng;
  }

  if (b.lng !== undefined && b.longitude === undefined) b.longitude = b.lng;
  if (b.lat !== undefined && b.latitude === undefined) b.latitude = b.lat;

  const stringFields = [
    "nomProjet",
    "dateDemarrage",
    "statut",
    "typeAdresseChantier",
    "ingenieurResponsable",
    "telephoneIngenieur",
    "architecte",
    "telephoneArchitecte",
    "entreprise",
    "promoteur",
    "bureauEtude",
    "bureauControle",
    "adresse",
    "entrepriseFluide",
    "entrepriseElectricite",
  ];

  for (const f of stringFields) {
    if (b[f] !== undefined && b[f] !== null) {
      b[f] = reqStr(b[f]);
      if (b[f] === "") b[f] = null;
    }
  }

  return b;
}

function validatePayload(body, isUpdate = false) {
  const errors = [];

  const required = [
    "nomProjet",
    "dateDemarrage",
    "typeAdresseChantier",
    "ingenieurResponsable",
    "telephoneIngenieur",
    "architecte",
    "telephoneArchitecte",
    "entreprise",
    "promoteur",
    "bureauEtude",
    "bureauControle",
    "latitude",
    "longitude",
  ];

  if (!isUpdate) {
    for (const k of required) {
      if (body[k] === undefined || body[k] === null || reqStr(String(body[k])) === "") {
        errors.push(`${k} est obligatoire`);
      }
    }
  }

  if (body.dateDemarrage !== undefined && body.dateDemarrage !== null && !isValidDateOnly(body.dateDemarrage)) {
    errors.push("dateDemarrage doit être au format YYYY-MM-DD");
  }

  if (body.telephoneIngenieur !== undefined && body.telephoneIngenieur !== null && !isValidPhone(body.telephoneIngenieur)) {
    errors.push("telephoneIngenieur invalide");
  }

  if (body.telephoneArchitecte !== undefined && body.telephoneArchitecte !== null && !isValidPhone(body.telephoneArchitecte)) {
    errors.push("telephoneArchitecte invalide");
  }

  if (
    (body.latitude !== undefined || body.longitude !== undefined) &&
    (body.latitude !== null || body.longitude !== null) &&
    !isValidLatLng(body.latitude, body.longitude)
  ) {
    errors.push("latitude/longitude invalides");
  }

  if (body.statut !== undefined && body.statut !== null) {
    const allowed = ["En cours", "Préparation", "Terminé"];
    if (!allowed.includes(body.statut)) {
      errors.push("statut invalide (En cours | Préparation | Terminé)");
    }
  }

  return errors;
}

// ✅ permission helper: retourne "viewer" si pas de lien
async function getPermission(user, projectId) {
  if (["admin", "superadmin"].includes(user.role)) return "owner";

  const link = await UserProject.findOne({
    where: { userId: user.sub, projectId },
  });

  return link?.permission || "viewer";
}

// ---------------- CREATE ----------------
// creator becomes owner
router.post("/", authRequired, async (req, res) => {
  try {
    const body = normalizePayload(req.body);

    const errors = validatePayload(body, false);
    if (errors.length) return res.status(400).json({ message: "Validation error", errors });

    const p = await Project.create({
      nomProjet: body.nomProjet,
      dateDemarrage: body.dateDemarrage,
      statut: body.statut || null,
      typeAdresseChantier: body.typeAdresseChantier,

      ingenieurResponsable: body.ingenieurResponsable,
      telephoneIngenieur: body.telephoneIngenieur,

      architecte: body.architecte,
      telephoneArchitecte: body.telephoneArchitecte,

      entreprise: body.entreprise,
      promoteur: body.promoteur,
      bureauEtude: body.bureauEtude,
      bureauControle: body.bureauControle,

      adresse: body.adresse || null,

      latitude: body.latitude,
      longitude: body.longitude,

      entrepriseFluide: body.entrepriseFluide || null,
      entrepriseElectricite: body.entrepriseElectricite || null,
    });

    await UserProject.findOrCreate({
      where: { userId: req.user.sub, projectId: p.id },
      defaults: { permission: "owner" },
    });

    return res.status(201).json({ ...p.toJSON(), permission: "owner" });
  } catch (e) {
    console.error("PROJECT_CREATE_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// ---------------- LIST ----------------
// ✅ Tous les users voient TOUS les projets
// ✅ permission = viewer si pas de lien user_projects, sinon editor/owner
router.get("/", authRequired, async (req, res) => {
  try {
    const { q } = req.query;
    const where = {};

    if (typeof q === "string" && q.trim()) {
      where[Op.or] = [
        { nomProjet: { [Op.iLike]: `%${q.trim()}%` } },
        { entreprise: { [Op.iLike]: `%${q.trim()}%` } },
        { promoteur: { [Op.iLike]: `%${q.trim()}%` } },
        { adresse: { [Op.iLike]: `%${q.trim()}%` } },
      ];
    }

    // admin => tout owner
    if (["admin", "superadmin"].includes(req.user.role)) {
      const items = await Project.findAll({ where, order: [["createdAt", "DESC"]] });
      return res.json(items.map((p) => ({ ...p.toJSON(), permission: "owner" })));
    }

    const items = await Project.findAll({
      where,
      include: [
        {
          model: UserProject,
          required: false, // ✅ LEFT JOIN
          where: { userId: req.user.sub },
          attributes: ["permission"],
        },
      ],
      order: [["createdAt", "DESC"]],
    });

    const out = items.map((p) => {
      const json = p.toJSON();
      const perm = (json.UserProjects?.[0]?.permission) || "viewer";
      delete json.UserProjects;
      return { ...json, permission: perm };
    });

    return res.json(out);
  } catch (e) {
    console.error("PROJECT_LIST_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// ---------------- GET BY ID ----------------
// ✅ viewer autorisé (permission par défaut viewer)
router.get("/:id", authRequired, async (req, res) => {
  try {
    const item = await Project.findByPk(req.params.id);
    if (!item) return res.status(404).json({ message: "Not found" });

    const permission = await getPermission(req.user, req.params.id);
    return res.json({ ...item.toJSON(), permission });
  } catch (e) {
    console.error("PROJECT_GET_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// ---------------- UPDATE ----------------
// viewer forbidden
router.put("/:id", authRequired, async (req, res) => {
  try {
    const permission = await getPermission(req.user, req.params.id);

    if (!["admin", "superadmin"].includes(req.user.role) && !["editor", "owner"].includes(permission)) {
      return res.status(403).json({ message: "Need editor permission" });
    }

    const body = normalizePayload(req.body);
    const errors = validatePayload(body, true);
    if (errors.length) return res.status(400).json({ message: "Validation error", errors });

    const item = await Project.findByPk(req.params.id);
    if (!item) return res.status(404).json({ message: "Not found" });

    const fields = [
      "nomProjet",
      "dateDemarrage",
      "statut",
      "typeAdresseChantier",
      "ingenieurResponsable",
      "telephoneIngenieur",
      "architecte",
      "telephoneArchitecte",
      "entreprise",
      "promoteur",
      "bureauEtude",
      "bureauControle",
      "adresse",
      "latitude",
      "longitude",
      "entrepriseFluide",
      "entrepriseElectricite",
    ];

    const up = {};
    for (const f of fields) {
      if (body[f] !== undefined) up[f] = body[f];
    }

    await item.update(up);
    return res.json({ ...item.toJSON(), permission });
  } catch (e) {
    console.error("PROJECT_UPDATE_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// ---------------- DELETE ----------------
// only owner/admin
router.delete("/:id", authRequired, async (req, res) => {
  try {
    const permission = await getPermission(req.user, req.params.id);

    if (!["admin", "superadmin"].includes(req.user.role) && permission !== "owner") {
      return res.status(403).json({ message: "Need owner permission" });
    }

    const item = await Project.findByPk(req.params.id);
    if (!item) return res.status(404).json({ message: "Not found" });

    await item.destroy();
    await UserProject.destroy({ where: { projectId: req.params.id } });

    return res.json({ message: "Deleted" });
  } catch (e) {
    console.error("PROJECT_DELETE_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// ---------------- COMMENTS ----------------
// ✅ list comments
router.get("/:id/comments", authRequired, async (req, res) => {
  try {
    const projectId = req.params.id;

    const project = await Project.findByPk(projectId);
    if (!project) return res.status(404).json({ message: "Not found" });

    const list = await ProjectComment.findAll({
      where: { projectId },
      order: [["createdAt", "ASC"]],
    });

    return res.json(list);
  } catch (e) {
    console.error("PROJECT_COMMENTS_LIST_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// ✅ add comment or reply
router.post("/:id/comments", authRequired, async (req, res) => {
  try {
    const projectId = req.params.id;
    const body = reqStr(req.body?.body);
    const parentId = req.body?.parentId || null;

    if (!body) return res.status(400).json({ message: "body est obligatoire" });

    const project = await Project.findByPk(projectId);
    if (!project) return res.status(404).json({ message: "Not found" });

    if (parentId) {
      const parent = await ProjectComment.findByPk(parentId);
      if (!parent || parent.projectId !== projectId) {
        return res.status(400).json({ message: "parentId invalide" });
      }
    }

    const c = await ProjectComment.create({
      projectId,
      authorId: req.user.sub,
      parentId,
      body,
    });

    return res.status(201).json(c);
  } catch (e) {
    console.error("PROJECT_COMMENT_CREATE_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// ---------------- SHARE ----------------
// owner/admin can assign user as viewer/editor (optionnel)
router.post("/:id/share", authRequired, async (req, res) => {
  try {
    const { userId, permission } = req.body || {};
    if (!userId) return res.status(400).json({ message: "userId is required" });

    const perm = ["viewer", "editor"].includes(permission) ? permission : "viewer";

    // seul owner/admin peut partager
    const currentPerm = await getPermission(req.user, req.params.id);
    if (!["admin", "superadmin"].includes(req.user.role) && currentPerm !== "owner") {
      return res.status(403).json({ message: "Owner required" });
    }

    await UserProject.upsert({
      userId,
      projectId: req.params.id,
      permission: perm,
    });

    return res.json({ message: "User assigned", userId, projectId: req.params.id, permission: perm });
  } catch (e) {
    console.error("PROJECT_SHARE_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

module.exports = router;
