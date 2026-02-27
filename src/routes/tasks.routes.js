const router = require("express").Router();
const { Op } = require("sequelize");
const Task = require("../models/Task"); // ✅ CORRECT (pas {Task})
const User = require("../models/User");
const { authRequired } = require("../middleware/auth.middleware");

// ✅ LIST ?from=2026-02-01&to=2026-02-28
// ✅ LIST
router.get("/", authRequired, async (req, res) => {
  try {
    const where = {};

    // admin/superadmin => tout
    if (!["admin", "superadmin"].includes(req.user.role)) {
      where.createdBy = req.user.sub;
    }

    const { from, to } = req.query;
    if (from || to) {
      where.startAt = {};
      if (from) where.startAt[Op.gte] = new Date(from);
      if (to) where.startAt[Op.lte] = new Date(to);
    }

    const items = await Task.findAll({
      where,
      order: [["startAt", "ASC"]],
      include: [
        {
          model: User,
          as: "creator",
          attributes: ["id", "email"], // ✅ pas "name"
        },
      ],
    });

    // ✅ option: aplatir creatorEmail pour simplifier Flutter
    const out = items.map((t) => {
      const json = t.toJSON();
      return {
        ...json,
        creatorEmail: json.creator?.email ?? null,
      };
    });

    return res.json(out);
  } catch (e) {
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// ✅ CREATE
router.post("/", authRequired, async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim();
    const description = (req.body?.description ?? "").toString().trim();
    const startAt = req.body?.startAt ? new Date(req.body.startAt) : null;

    if (!title) return res.status(400).json({ message: "title obligatoire" });
    if (!startAt || isNaN(startAt.getTime()))
      return res.status(400).json({ message: "startAt invalide" });

    const row = await Task.create({
      title,
      description: description || null,
      startAt,
      createdBy: req.user.sub,
    });

    return res.status(201).json(row);
  } catch (e) {
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// ✅ UPDATE
router.put("/:id", authRequired, async (req, res) => {
  try {
    const id = req.params.id;
    const row = await Task.findByPk(id);
    if (!row) return res.status(404).json({ message: "Task introuvable" });

    if (!["admin", "superadmin"].includes(req.user.role) && row.createdBy !== req.user.sub) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const up = {};
    if (req.body?.title != null) up.title = String(req.body.title).trim();
    if (req.body?.description != null) up.description = String(req.body.description).trim() || null;

    if (req.body?.startAt != null) {
      const d = new Date(req.body.startAt);
      if (isNaN(d.getTime())) return res.status(400).json({ message: "startAt invalide" });
      up.startAt = d;
    }

    if (req.body?.status != null) up.status = req.body.status;

    await row.update(up);
    return res.json(row);
  } catch (e) {
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// ✅ DELETE
router.delete("/:id", authRequired, async (req, res) => {
  try {
    const id = req.params.id;
    const row = await Task.findByPk(id);
    if (!row) return res.status(404).json({ message: "Task introuvable" });

    if (!["admin", "superadmin"].includes(req.user.role) && row.createdBy !== req.user.sub) {
      return res.status(403).json({ message: "Forbidden" });
    }

    await row.destroy();
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

module.exports = router;