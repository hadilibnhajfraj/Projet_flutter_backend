const express = require("express");
const { Op } = require("sequelize");
const Project = require("../models/Project");
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

  // location: {lat,lng} -> latitude/longitude
  if (b.location && (b.latitude === undefined || b.longitude === undefined)) {
    if (b.location.lat !== undefined) b.latitude = b.location.lat;
    if (b.location.lng !== undefined) b.longitude = b.location.lng;
  }

  // accept lng/long variations
  if (b.lng !== undefined && b.longitude === undefined) b.longitude = b.lng;
  if (b.lat !== undefined && b.latitude === undefined) b.latitude = b.lat;

  // comments array -> localisationCommentaire
  if (Array.isArray(b.comments) && b.localisationCommentaire === undefined) {
    const lines = b.comments
      .map((c) => {
        if (!c) return "";
        if (typeof c === "string") return c.trim();
        return reqStr(c.comment);
      })
      .filter(Boolean);

    b.localisationCommentaire = lines.join("\n");
  }

  // combine adresse + commentaire
  if (reqStr(b.adresse) && !reqStr(b.localisationCommentaire)) {
    b.localisationCommentaire = `Adresse: ${reqStr(b.adresse)}`;
  } else if (reqStr(b.adresse) && reqStr(b.localisationCommentaire)) {
    b.localisationCommentaire = `Adresse: ${reqStr(b.adresse)}\n${reqStr(b.localisationCommentaire)}`;
  }

  // trim all strings
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
    "localisationCommentaire",
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

// ---------------- CREATE ----------------
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
      localisationCommentaire: body.localisationCommentaire || null,

      entrepriseFluide: body.entrepriseFluide || null,
      entrepriseElectricite: body.entrepriseElectricite || null,
    });

    return res.status(201).json(p);
  } catch (e) {
    console.error("PROJECT_CREATE_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// ---------------- LIST ----------------
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

    const items = await Project.findAll({ where, order: [["createdAt", "DESC"]] });
    return res.json(items);
  } catch (e) {
    console.error("PROJECT_LIST_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// ---------------- GET BY ID ----------------
router.get("/:id", authRequired, async (req, res) => {
  try {
    const item = await Project.findByPk(req.params.id);
    if (!item) return res.status(404).json({ message: "Not found" });
    return res.json(item);
  } catch (e) {
    console.error("PROJECT_GET_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// ---------------- UPDATE ----------------
router.put("/:id", authRequired, async (req, res) => {
  try {
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
      "localisationCommentaire",
      "entrepriseFluide",
      "entrepriseElectricite",
    ];

    const up = {};
    for (const f of fields) {
      if (body[f] !== undefined) up[f] = body[f];
    }

    await item.update(up);
    return res.json(item);
  } catch (e) {
    console.error("PROJECT_UPDATE_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// ---------------- DELETE ----------------
router.delete("/:id", authRequired, async (req, res) => {
  try {
    const item = await Project.findByPk(req.params.id);
    if (!item) return res.status(404).json({ message: "Not found" });

    await item.destroy();
    return res.json({ message: "Deleted" });
  } catch (e) {
    console.error("PROJECT_DELETE_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

module.exports = router;
