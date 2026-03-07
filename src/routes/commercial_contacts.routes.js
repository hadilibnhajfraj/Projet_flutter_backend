const router = require("express").Router();
const { Op } = require("sequelize");
const { authRequired } = require("../middleware/auth.middleware");

const CommercialContact = require("../models/CommercialContact");
const CommercialContactProduct = require("../models/CommercialContactProduct");
const User = require("../models/User");

// ✅ LIST (admin/superadmin => tout, sinon seulement createdBy)
router.get("/", authRequired, async (req, res) => {
  try {
    const where = {};

    if (!["admin", "superadmin"].includes(req.user.role)) {
      where.createdBy = req.user.sub;
    }

    const { q } = req.query;
    if (q && String(q).trim()) {
      const s = String(q).trim();
      where[Op.or] = [
        { nom: { [Op.iLike]: `%${s}%` } },
        { prenom: { [Op.iLike]: `%${s}%` } },
        { nomSociete: { [Op.iLike]: `%${s}%` } },
        { telephone: { [Op.iLike]: `%${s}%` } },
        { localisation: { [Op.iLike]: `%${s}%` } },
      ];
    }

    const rows = await CommercialContact.findAll({
      where,
      order: [["createdAt", "DESC"]],
      include: [
        { model: CommercialContactProduct, as: "produits" },
        { model: User, as: "creator", attributes: ["id", "email"] },
      ],
    });

    return res.json(rows);
  } catch (e) {
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// ✅ CREATE (avec produits[])
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
      createdBy: req.user.sub,
    };

    if (!payload.nom) return res.status(400).json({ message: "nom obligatoire" });
    if (!payload.prenom) return res.status(400).json({ message: "prenom obligatoire" });
    if (!payload.telephone) return res.status(400).json({ message: "telephone obligatoire" });

    const contact = await CommercialContact.create(payload);

    // insert produits
    if (produits.length) {
      const items = produits
        .filter((p) => p && p.produit)
        .map((p) => ({
          commercialContactId: contact.id,
          produit: String(p.produit).trim(),
          qte: Number(p.qte ?? 1) || 1,
        }));

      if (items.length) await CommercialContactProduct.bulkCreate(items);
    }

    const full = await CommercialContact.findByPk(contact.id, {
      include: [{ model: CommercialContactProduct, as: "produits" }],
    });

    return res.status(201).json(full);
  } catch (e) {
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// ✅ UPDATE (contact + replace produits)
router.put("/:id", authRequired, async (req, res) => {
  try {
    const id = req.params.id;
    const row = await CommercialContact.findByPk(id);
    if (!row) return res.status(404).json({ message: "Contact introuvable" });

    if (!["admin", "superadmin"].includes(req.user.role) && row.createdBy !== req.user.sub) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const body = req.body || {};
    const up = {};

    if (body.typeClient != null) up.typeClient = body.typeClient;
    if (body.nomSociete != null) up.nomSociete = body.nomSociete || null;
    if (body.nom != null) up.nom = String(body.nom).trim();
    if (body.prenom != null) up.prenom = String(body.prenom).trim();
    if (body.localisation != null) up.localisation = String(body.localisation).trim() || null;
    if (body.telephone != null) up.telephone = String(body.telephone).trim();
    if (body.message != null) up.message = String(body.message).trim() || null;

    await row.update(up);

    // produits: si fournis, on remplace
    if (Array.isArray(body.produits)) {
      await CommercialContactProduct.destroy({ where: { commercialContactId: id } });

      const items = body.produits
        .filter((p) => p && p.produit)
        .map((p) => ({
          commercialContactId: id,
          produit: String(p.produit).trim(),
          qte: Number(p.qte ?? 1) || 1,
        }));

      if (items.length) await CommercialContactProduct.bulkCreate(items);
    }

    const full = await CommercialContact.findByPk(id, {
      include: [{ model: CommercialContactProduct, as: "produits" }],
    });

    return res.json(full);
  } catch (e) {
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// ✅ DELETE
router.delete("/:id", authRequired, async (req, res) => {
  try {
    const id = req.params.id;
    const row = await CommercialContact.findByPk(id);
    if (!row) return res.status(404).json({ message: "Contact introuvable" });

    if (!["admin", "superadmin"].includes(req.user.role) && row.createdBy !== req.user.sub) {
      return res.status(403).json({ message: "Forbidden" });
    }

    await row.destroy(); // cascade supprime produits
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

module.exports = router;