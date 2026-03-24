const router = require("express").Router();
const { Op } = require("sequelize");
const { authRequired } = require("../middleware/auth.middleware");

const CommercialContact = require("../models/CommercialContact");
const CommercialContactProduct = require("../models/CommercialContactProduct");
const CommercialContactRelance = require("../models/CommercialContactRelance");
const User = require("../models/User");

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
    const body = req.body || {};
    const produits = Array.isArray(body.produits) ? body.produits : [];

    const payload = {
  typeClient: body.typeClient || "autre",
  nomSociete: body.nomSociete || null,
  nom: String(body.nom || "").trim(),
  prenom: String(body.prenom || "").trim(),
  localisation: body.localisation ? String(body.localisation).trim() : null,
  telephone: String(body.telephone || "").trim(),
  message: body.message ? String(body.message).trim() : null,
  statut: body.statut || "user_injoignable",
  nbAppels: Number(body.nbAppels ?? 0) || 0,
  sujetDiscussion: body.sujetDiscussion
    ? String(body.sujetDiscussion).trim()
    : null,

  // ✅ NEW
  pipelineStage: body.pipelineStage || "Prospect",

  // ✅ NEW
  dateAppel: body.dateAppel || new Date(),

  createdBy: req.user.sub,
};

    if (!payload.nom) {
      return res.status(400).json({ message: "nom obligatoire" });
    }
    if (!payload.prenom) {
      return res.status(400).json({ message: "prenom obligatoire" });
    }
    if (!payload.telephone) {
      return res.status(400).json({ message: "telephone obligatoire" });
    }

    const contact = await CommercialContact.create(payload);

    const items = (produits.length ? produits : [{ produit: "PROBAR", qte: 1 }])
      .filter((p) => p)
      .map((p) => ({
        commercialContactId: contact.id,
        produit: String(p.produit || "PROBAR").trim() || "PROBAR",
        qte: Number(p.qte ?? 1) || 1,
      }));

    if (items.length) {
      await CommercialContactProduct.bulkCreate(items);
    }

    if (
      ["ok", "rappeler_plus_tard"].includes(payload.statut) &&
      body.dateRelance
    ) {
      await CommercialContactRelance.create({
        commercialContactId: contact.id,
        dateRelance: body.dateRelance,
        heureRelance: body.heureRelance || null,
        commentaire:
            body.commentaire || body.commentaireRelance || null,
        createdBy: req.user.sub,
      });
    }

    const full = await CommercialContact.findByPk(contact.id, {
      include: [
        { model: CommercialContactProduct, as: "produits" },
        { model: CommercialContactRelance, as: "relances" },
      ],
    });

    return res.status(201).json(full);
  } catch (e) {
    return res.status(500).json({ message: e.message || "Server error" });
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