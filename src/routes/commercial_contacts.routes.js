const router = require("express").Router();
const { Op } = require("sequelize");
const { authRequired } = require("../middleware/auth.middleware");

const CommercialContact = require("../models/CommercialContact");
const CommercialContactProduct = require("../models/CommercialContactProduct");
const CommercialContactRelance = require("../models/CommercialContactRelance");
const CommercialContactAction = require("../models/CommercialContactAction");
const CommercialContactReminder = require("../models/CommercialContactReminder");
const User = require("../models/User");
const uploads = require("../middleware/uploads");
function mapStageToAction(stage) {
  switch (stage) {
    case "Prospect":
      return "Visite";

    case "Contacté":
      return "Plan technique";

    case "Visite":
      return "Visite";

    case "Devis envoyé":
      return "Devis envoyé";

    case "Negociation":
      return "Negociation";

    case "Gagné":
      return "Commande gagnée";

    case "Perdu":
      return "Commande perdue";

    default:
      return "Visite";
  }
}
// LIST
router.get("/", authRequired, async (req, res) => {
  try {
    const where = {};

    if (!["admin", "superadmin"].includes(req.user.role)) {
      where.createdBy = req.user.sub;
    }

    const { q, statut, dateRelance } = req.query;

    if (q && String(q).trim()) {
      const s = String(q).trim();
      where[Op.or] = [
        { nom: { [Op.iLike]: `%${s}%` } },
        { prenom: { [Op.iLike]: `%${s}%` } },
        { nomSociete: { [Op.iLike]: `%${s}%` } },
        { telephone: { [Op.iLike]: `%${s}%` } },
        { localisation: { [Op.iLike]: `%${s}%` } },
        { sujetDiscussion: { [Op.iLike]: `%${s}%` } },
      ];
    }

    if (statut && String(statut).trim()) {
      where.statut = String(statut).trim();
    }

    const include = [
      { model: CommercialContactProduct, as: "produits" },
      { model: User, as: "creator", attributes: ["id", "email"] },
      {
        model: CommercialContactRelance,
        as: "relances",
        required: false,
        ...(dateRelance
          ? {
              where: {
                dateRelance: String(dateRelance).trim(),
              },
            }
          : {}),
      },
    ];

    const rows = await CommercialContact.findAll({
      where,
      order: [["createdAt", "DESC"]],
      include,
    });

    return res.json(rows);
  } catch (e) {
    return res.status(500).json({ message: e.message || "Server error" });
  }
});
router.get("/:id/actions", authRequired, async (req, res) => {
  try {
    console.log("📥 GET ACTIONS");
    console.log("👉 Contact ID:", req.params.id);
    console.log("👉 User:", req.user);

    const actions = await CommercialContactAction.findAll({
      where: { commercialContactId: req.params.id },

      include: [
        {
          model: CommercialContactReminder,
          as: "reminders",
        },
      ],

      order: [["dateAction", "DESC"]],
    });

    console.log("✅ ACTIONS FOUND:", actions.length);

    res.json(actions);

  } catch (err) {
    console.error("❌ GET ACTIONS ERROR:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});
router.post("/:id/actions", authRequired, uploads.single("file"), async (req, res) => {
  try {
    console.log("📥 CREATE ACTION REQUEST");
    console.log("👉 Params ID:", req.params.id);
    console.log("👉 Body:", req.body);
    console.log("👉 User:", req.user);

    const { typeAction, commentaire, dateRelance } = req.body;

    // ✅ VALIDATION
    if (!typeAction) {
      console.log("❌ typeAction missing");
      return res.status(400).json({ message: "typeAction is required" });
    }

    if (!req.user?.sub) {
      console.log("❌ USER INVALID:", req.user);
      return res.status(401).json({ message: "Invalid user token" });
    }

    const fileUrl = req.file
      ? `/uploads/actions/${req.file.filename}`
      : null;

    console.log("📎 File:", fileUrl);

    // =============================
    // CREATE ACTION
    // =============================
    const action = await CommercialContactAction.create({
      commercialContactId: req.params.id,
      typeAction,
      commentaire: commentaire ?? null,
      dateAction: new Date(),
      dateRelance: dateRelance ?? null,
      statut: "A faire",
      fileUrl,
      createdBy: req.user.sub,
    });

    console.log("✅ ACTION CREATED:", action.id);

    // =============================
    // UPDATE PIPELINE
    // =============================
    let newStage = "Prospect";

    try {
      newStage = getStageFromAction(typeAction);
    } catch (e) {
      console.log("⚠️ getStageFromAction missing → fallback Prospect");
    }

    await CommercialContact.update(
      { pipelineStage: newStage },
      { where: { id: req.params.id } }
    );

    console.log("📊 PIPELINE UPDATED:", newStage);

    // =============================
    // CREATE REMINDER
    // =============================
    if (dateRelance) {
      const reminder = await CommercialContactReminder.create({
        commercialContactId: req.params.id,
        actionId: action.id,
        message: commentaire ?? "",
        dateRelance,
        createdBy: req.user.sub,
      });

      console.log("⏰ REMINDER CREATED:", reminder.id);
    }

    // =============================
    // RETURN RESULT
    // =============================
    const result = await CommercialContactAction.findByPk(action.id, {
      include: [
        {
          model: CommercialContactReminder,
          as: "reminders",
        },
      ],
    });

    console.log("📤 RETURN ACTION");

    res.status(201).json(result);

  } catch (err) {
    console.error("❌ CREATE ACTION ERROR:", err);

    res.status(500).json({
      message: "Server error",
      error: err.message,
      stack: err.stack,
    });
  }
});
// CALENDRIER DES RELANCES
router.get("/calendar/relances", authRequired, async (req, res) => {
  try {
    const where = {};

    if (!["admin", "superadmin"].includes(req.user.role)) {
      where.createdBy = req.user.sub;
    }

    const { start, end } = req.query;

    if (start && end) {
      where.dateRelance = {
        [Op.between]: [start, end],
      };
    }

    const relances = await CommercialContactRelance.findAll({
      where,
      order: [["dateRelance", "ASC"], ["heureRelance", "ASC"]],
      include: [
        {
          model: CommercialContact,
          as: "contact",
          attributes: [
            "id",
            "nom",
            "prenom",
            "nomSociete",
            "telephone",
            "statut",
            "nbAppels",
            "sujetDiscussion",
          ],
        },
      ],
    });

    return res.json(relances);
  } catch (e) {
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// CREATE CONTACT
router.post("/", authRequired, async (req, res) => {
  try {
    console.log("📥 CREATE CONTACT REQUEST");
    console.log("👉 BODY:", req.body);
    console.log("👉 USER:", req.user);

    const body = req.body || {};
    const produits = Array.isArray(body.produits) ? body.produits : [];

    // =============================
    // PAYLOAD CONTACT
    // =============================
    const payload = {
      typeClient: body.typeClient || "autre",
      nomSociete: body.nomSociete || null,
      nom: String(body.nom || "").trim(),
      prenom: String(body.prenom || "").trim(),
      localisation: body.localisation
        ? String(body.localisation).trim()
        : null,
      telephone: String(body.telephone || "").trim(),
      message: body.message ? String(body.message).trim() : null,
      statut: body.statut || "user_injoignable",
      nbAppels: Number(body.nbAppels ?? 0) || 0,
      sujetDiscussion: body.sujetDiscussion
        ? String(body.sujetDiscussion).trim()
        : null,

      // CRM
      pipelineStage: body.pipelineStage || "Prospect",
      dateAppel: body.dateAppel || new Date(),

      createdBy: req.user.sub,
    };

    // =============================
    // VALIDATION
    // =============================
    if (!payload.nom) {
      return res.status(400).json({ message: "nom obligatoire" });
    }
    if (!payload.prenom) {
      return res.status(400).json({ message: "prenom obligatoire" });
    }
    if (!payload.telephone) {
      return res.status(400).json({ message: "telephone obligatoire" });
    }

    // =============================
    // CREATE CONTACT
    // =============================
    const contact = await CommercialContact.create(payload);

    console.log("✅ CONTACT CREATED:", contact.id);

    // =============================
    // CREATE PRODUITS
    // =============================
    const items = (produits.length
      ? produits
      : [{ produit: "PROBAR", qte: 1 }]
    )
      .filter((p) => p)
      .map((p) => ({
        commercialContactId: contact.id,
        produit: String(p.produit || "PROBAR").trim() || "PROBAR",
        qte: Number(p.qte ?? 1) || 1,
      }));

    if (items.length) {
      await CommercialContactProduct.bulkCreate(items);
      console.log("📦 PRODUITS CREATED:", items.length);
    }

    // =============================
    // 🔥 CREATE ACTION AUTO (IMPORTANT)
    // =============================
    const typeAction = mapStageToAction(payload.pipelineStage);

    const action = await CommercialContactAction.create({
  commercialContactId: contact.id,
  typeAction: mapStageToAction(payload.pipelineStage),
  commentaire: "Création du contact",
  dateAction: new Date(),
  statut: "Terminé",
  createdBy: req.user.sub,
});

    console.log("🔥 ACTION AUTO CREATED:", action.id);

    // =============================
    // CREATE RELANCE
    // =============================
    if (
      ["ok", "rappeler_plus_tard"].includes(payload.statut) &&
      body.dateRelance
    ) {
      const relance = await CommercialContactRelance.create({
        commercialContactId: contact.id,
        dateRelance: body.dateRelance,
        heureRelance: body.heureRelance || null,
        commentaire:
          body.commentaire || body.commentaireRelance || null,
        createdBy: req.user.sub,
      });

      console.log("⏰ RELANCE CREATED:", relance.id);
    }

    // =============================
    // RETURN FULL DATA
    // =============================
    const full = await CommercialContact.findByPk(contact.id, {
      include: [
        { model: CommercialContactProduct, as: "produits" },
        { model: CommercialContactRelance, as: "relances" },
      ],
    });

    console.log("📤 CONTACT RESPONSE READY");

    return res.status(201).json(full);

  } catch (e) {
    console.error("❌ CREATE CONTACT ERROR:", e);

    return res.status(500).json({
      message: e.message || "Server error",
      stack: e.stack,
    });
  }
});

// UPDATE CONTACT
router.put("/:id", authRequired, async (req, res) => {
  try {
    const id = req.params.id;
    const row = await CommercialContact.findByPk(id);

    if (!row) {
      return res.status(404).json({ message: "Contact introuvable" });
    }

    if (
      !["admin", "superadmin"].includes(req.user.role) &&
      row.createdBy !== req.user.sub
    ) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const body = req.body || {};
    const up = {};

    if (body.typeClient != null) up.typeClient = body.typeClient;
    if (body.nomSociete != null) up.nomSociete = body.nomSociete || null;
    if (body.nom != null) up.nom = String(body.nom).trim();
    if (body.prenom != null) up.prenom = String(body.prenom).trim();
    if (body.localisation != null) {
      up.localisation = String(body.localisation).trim() || null;
    }
    if (body.telephone != null) up.telephone = String(body.telephone).trim();
    if (body.message != null) up.message = String(body.message).trim() || null;
    if (body.statut != null) up.statut = String(body.statut).trim();
    if (body.nbAppels != null) up.nbAppels = Number(body.nbAppels) || 0;
    if (body.sujetDiscussion != null) {
      up.sujetDiscussion = String(body.sujetDiscussion).trim() || null;
    }
    if (body.pipelineStage != null) {
  up.pipelineStage = String(body.pipelineStage).trim();
}

if (body.dateAppel != null) {
  up.dateAppel = body.dateAppel;
}
    await row.update(up);

    if (Array.isArray(body.produits)) {
      await CommercialContactProduct.destroy({
        where: { commercialContactId: id },
      });

      const items = body.produits
        .filter((p) => p)
        .map((p) => ({
          commercialContactId: id,
          produit: String(p.produit || "PROBAR").trim() || "PROBAR",
          qte: Number(p.qte ?? 1) || 1,
        }));

      if (items.length) {
        await CommercialContactProduct.bulkCreate(items);
      }
    }

    if (
      ["ok", "rappeler_plus_tard"].includes(
        body.statut != null ? String(body.statut).trim() : row.statut
      ) &&
      body.dateRelance
    ) {
      const existingRelance = await CommercialContactRelance.findOne({
        where: { commercialContactId: id },
        order: [["createdAt", "DESC"]],
      });

      if (existingRelance) {
        await existingRelance.update({
          dateRelance: body.dateRelance,
          heureRelance: body.heureRelance || null,
          commentaire: body.commentaire || body.commentaireRelance || null,
        });
      } else {
        await CommercialContactRelance.create({
          commercialContactId: id,
          dateRelance: body.dateRelance,
          heureRelance: body.heureRelance || null,
          commentaire: body.commentaire || body.commentaireRelance || null,
          createdBy: req.user.sub,
        });
      }
    }

    const full = await CommercialContact.findByPk(id, {
      include: [
        { model: CommercialContactProduct, as: "produits" },
        { model: CommercialContactRelance, as: "relances" },
      ],
    });

    return res.json(full);
  } catch (e) {
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// CREATE RELANCE
router.post("/:id/relances", authRequired, async (req, res) => {
  try {
    const id = req.params.id;
    const contact = await CommercialContact.findByPk(id);

    if (!contact) {
      return res.status(404).json({ message: "Contact introuvable" });
    }

    if (!["ok", "rappeler_plus_tard"].includes(contact.statut)) {
      return res.status(400).json({
        message:
          "Relance autorisée uniquement pour les statuts ok ou rappeler_plus_tard",
      });
    }

    if (
      !["admin", "superadmin"].includes(req.user.role) &&
      contact.createdBy !== req.user.sub
    ) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const body = req.body || {};

    if (!body.dateRelance) {
      return res.status(400).json({ message: "dateRelance obligatoire" });
    }

    const relance = await CommercialContactRelance.create({
      commercialContactId: id,
      dateRelance: body.dateRelance,
      heureRelance: body.heureRelance || null,
      commentaire: body.commentaire || null,
      createdBy: req.user.sub,
    });

    return res.status(201).json(relance);
  } catch (e) {
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// UPDATE RELANCE
router.put("/:id/relances/:relanceId", authRequired, async (req, res) => {
  try {
    const { id, relanceId } = req.params;

    const contact = await CommercialContact.findByPk(id);
    if (!contact) {
      return res.status(404).json({ message: "Contact introuvable" });
    }

    const relance = await CommercialContactRelance.findOne({
      where: { id: relanceId, commercialContactId: id },
    });

    if (!relance) {
      return res.status(404).json({ message: "Relance introuvable" });
    }

    if (
      !["admin", "superadmin"].includes(req.user.role) &&
      contact.createdBy !== req.user.sub
    ) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const body = req.body || {};
    await relance.update({
      dateRelance: body.dateRelance ?? relance.dateRelance,
      heureRelance: body.heureRelance ?? relance.heureRelance,
      commentaire: body.commentaire ?? relance.commentaire,
      statutRelance: body.statutRelance ?? relance.statutRelance,
    });

    return res.json(relance);
  } catch (e) {
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// DELETE CONTACT
router.delete("/:id", authRequired, async (req, res) => {
  try {
    const id = req.params.id;
    const row = await CommercialContact.findByPk(id);

    if (!row) {
      return res.status(404).json({ message: "Contact introuvable" });
    }

    if (
      !["admin", "superadmin"].includes(req.user.role) &&
      row.createdBy !== req.user.sub
    ) {
      return res.status(403).json({ message: "Forbidden" });
    }

    await row.destroy();
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

module.exports = router;