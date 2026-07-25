const router = require("express").Router();
const { Op } = require("sequelize");
const { authRequired } = require("../middleware/auth.middleware");

const CommercialContact = require("../models/CommercialContact");
const CommercialProject = require("../models/CommercialProject");
const CommercialContactProduct = require("../models/CommercialContactProduct");
const CommercialContactRelance = require("../models/CommercialContactRelance");
const CommercialContactAction = require("../models/CommercialContactAction");
const CommercialContactReminder = require("../models/CommercialContactReminder");
const User = require("../models/User");
const UserProfile = require("../models/UserProfile");
const CommercialContactStatusHistory = require("../models/CommercialContactStatusHistory");
const uploads = require("../middleware/uploads");
const { runFollowupAutomation } = require("../services/followupAutomation.service");
const { recordStatusChange } = require("../services/commercialContactHistory.service");
const { isCommercialEligibleRole } = require("../constants/commercialRoles");
const { resolveFullName } = require("../utils/userDisplay");
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

// ═══════════════════════════════════════════════════════════════════════
// AUTOMATISATION FOLLOW-UP — calendrier / notifications / email / WhatsApp
// Déclenchée uniquement quand l'utilisateur connecté est
// info@probardistribution.com ET que le Follow-up a date + heure.
// Ne modifie rien pour tous les autres comptes (comportement inchangé).
// ═══════════════════════════════════════════════════════════════════════
const FOLLOWUP_AUTOMATION_EMAIL = "info@probardistribution.com";

function _isFollowupAutomationActor(req) {
  return (req.user?.email || "").toLowerCase().trim() === FOLLOWUP_AUTOMATION_EMAIL;
}

// Retourne un message d'erreur si le champ "Commercial" est obligatoire et
// manquant, sinon null. N'exige rien pour les comptes autres qu'info@.
function _validateCommercialField(req, body) {
  if (!_isFollowupAutomationActor(req)) return null;
  if (!(body.dateRelance && body.heureRelance)) return null;
  if (!body.commercialId) return "Commercial requis";
  return null;
}

// Résout commercialName/commercialEmail côté serveur à partir de
// commercialId — ne fait jamais confiance à un nom/email envoyé par le
// client. Accepte tout utilisateur éligible (voir NON_COMMERCIAL_ROLES),
// pas seulement role==="commercial" — cohérent avec GET /users/commercials.
async function _resolveCommercial(commercialId) {
  if (!commercialId) return null;
  const user = await User.findOne({
    where: { id: commercialId },
    attributes: ["id", "email", "role"],
    include: [{ model: UserProfile, as: "profile", attributes: ["name", "nom", "prenom"], required: false }],
  });
  if (!user || !isCommercialEligibleRole(user.role)) return null;
  return { id: user.id, email: user.email || null, name: resolveFullName(user) };
}

// Point d'entrée unique appelé après la création/mise à jour d'une relance.
// No-op silencieux pour tout le monde sauf info@probardistribution.com.
async function _maybeRunFollowupAutomation(req, contact, relance) {
  if (!_isFollowupAutomationActor(req)) return null;
  if (!(relance.dateRelance && relance.heureRelance)) return null;

  try {
    return await runFollowupAutomation({
      relance,
      contact,
      actorUser: { id: req.user.sub, email: req.user.email },
    });
  } catch (err) {
    console.error("❌ [FollowupAutomation] Erreur inattendue:", err.message);
    return null;
  }
}

router.get("/user-names/list", authRequired, async (req, res) => {
  try {
    const DEFAULT_USERS = ["najeh", "mooemen", "mayssa", "wajdi"];

    const rows = await CommercialContact.findAll({
      attributes: ["user_nom", "user_nom_custom"],
    });

    const dbUsers = [];
    rows.forEach((r) => {
      if (r.user_nom) dbUsers.push(r.user_nom);
      if (r.user_nom_custom) dbUsers.push(r.user_nom_custom);
    });

    const allNames = [...new Set([...DEFAULT_USERS, ...dbUsers])];

    return res.json(allNames);
  } catch (err) {
    console.error("❌ GET USER NAMES ERROR:", err);
    res.status(500).json({ message: err.message });
  }
});

// NOTE: la liste des commerciaux pour le dropdown Follow-up est servie par
// GET /users/commercials (users.routes.js) — chargée dynamiquement depuis
// la table users, sans filtre restreint à role==="commercial".

router.post("/select-commercial", authRequired, async (req, res) => {
  try {
    const { commercialName } = req.body;

    console.log("ROLE =", req.user.role);
    console.log("SELECTED COMMERCIAL =", commercialName);

    if (!commercialName || !String(commercialName).trim()) {
      return res.status(400).json({ message: "commercialName is required" });
    }

    const name = String(commercialName).trim();
    const DEFAULT_USERS = ["najeh", "mooemen", "mayssa", "wajdi"];

    let exists = DEFAULT_USERS.includes(name);

    if (!exists) {
      const ENUM_USERS = ["najeh", "mooemen", "mayssa"];
      const conditions = [{ user_nom_custom: name }];
      if (ENUM_USERS.includes(name)) conditions.push({ user_nom: name });

      const row = await CommercialContact.findOne({
        where: { [Op.or]: conditions },
        attributes: ["id"],
      });
      exists = !!row;
    }

    if (!exists) {
      return res.status(404).json({ message: `Commercial '${name}' introuvable` });
    }

    return res.json({ success: true, commercialName: name });
  } catch (err) {
    console.error("❌ SELECT COMMERCIAL ERROR:", err);
    res.status(500).json({ message: err.message });
  }
});
// Rôles voyant TOUJOURS l'intégralité des contacts, sans aucun filtre de
// périmètre. superadmin2 est le rôle technique utilisé pour les comptes
// "superadmin1"/"superadmin2" côté métier — même enum, même traitement.
const PRIVILEGED_ROLES = ["admin", "superadmin", "superadmin2"];

// LIST
router.get("/", authRequired, async (req, res) => {
  const reqId = Math.random().toString(36).slice(2, 8);
  try {
    const where = {};

    const { q, statut, dateRelance, user_nom, typeClient } = req.query;

    // =============================
    // 🔥 USER FILTER PRIORITY
    // =============================
    // NOTE : le filtre createdBy a été retiré de la liste.
    // Il appartient uniquement à GET /commercial-contacts/kpi/me.
    // La liste est accessible à tous les rôles ; le filtrage se fait via user_nom.
    console.log(`\n========== GET /commercial-contacts [${reqId}] ==========`);
    console.log("ROLE =", req.user.role);
    console.log("USER =", req.user.sub);

    if (user_nom && user_nom.trim()) {
      const cleanUser = user_nom.trim();
      const allowedUsers = ["najeh", "mooemen", "mayssa"];
      if (allowedUsers.includes(cleanUser)) {
        where.user_nom = cleanUser;
      } else {
        where.user_nom_custom = cleanUser;
      }
    }

    // =============================
    // 🔍 SEARCH
    // =============================
    if (q && String(q).trim()) {
      const s = String(q).trim();

      where[Op.and] = [
        ...(where[Op.and] || []),
        {
          [Op.or]: [
            { nom: { [Op.iLike]: `%${s}%` } },
            { prenom: { [Op.iLike]: `%${s}%` } },
            { nomSociete: { [Op.iLike]: `%${s}%` } },
            { telephone: { [Op.iLike]: `%${s}%` } },
            { localisation: { [Op.iLike]: `%${s}%` } },
            { sujetDiscussion: { [Op.iLike]: `%${s}%` } },
            { matriculeFiscale: { [Op.iLike]: `%${s}%` } },
          ],
        },
      ];
    }

    // =============================
    // 🔥 TYPE FILTER
    // =============================
    if (typeClient && typeClient.trim()) {
      where.typeClient = typeClient.trim();
    }

    // =============================
    // 🔥 STATUT
    // =============================
    if (statut && statut.trim()) {
      where.statut = statut.trim();
    }

    // NOTE audit : JSON.stringify() n'affiche PAS les clés Symbol (Op.and,
    // Op.in, ...) — ce log est donc volontairement complété plus bas par un
    // log texte explicite du filtre id/commercial réellement appliqué, et
    // par le SQL généré (voir "SQL GENERATED"), seule source 100% fiable.
    console.log("WHERE BEFORE =", JSON.stringify(where, null, 2));

    // =============================
    // 🔐 SCOPE PAR RÔLE — logique définitive
    //
    // - admin / superadmin / superadmin2 : vue complète, aucun filtre de
    //   périmètre (comportement historique, jamais touché).
    // - commercial : voit l'UNION (OR) de 3 critères, JAMAIS un seul :
    //     1) createdBy   == utilisateur connecté (contacts qu'il a créés)
    //     2) commercialId == utilisateur connecté (affectation directe et
    //        persistante, colonne commercial_contacts.commercialId —
    //        posée par le backfill historique ou par l'action admin
    //        "Affecter des contacts")
    //     3) id IN (assignedContactIds) (affectation via au moins une
    //        relance CommercialContactRelance.commercialId)
    //   Si assignedContactIds est vide, on NE court-circuite JAMAIS : les
    //   critères 1) et 2) restent évalués normalement par la requête SQL.
    //   where={} reste interdit pour ce rôle (toujours au moins le OR
    //   ci-dessus), mais l'absence de résultat n'est plus jamais décidée
    //   en dehors de la base — c'est Postgres qui tranche.
    // - tout autre rôle (user, accueil, ...) : vue complète, comportement
    //   historique inchangé (aucune restriction définie pour eux ici).
    // =============================
    let assignedContactIds = null; // null = non applicable à ce rôle

    if (req.user.role === "commercial") {
      const relanceRows = await CommercialContactRelance.findAll({
        where: { commercialId: req.user.sub },
        attributes: ["commercialContactId"],
      });
      assignedContactIds = [
        ...new Set(relanceRows.map((r) => r.commercialContactId).filter(Boolean)),
      ];

      console.log("assignedContactIds =", assignedContactIds);

      const orConditions = [
        { createdBy: req.user.sub },
        { commercialId: req.user.sub },
      ];
      if (assignedContactIds.length) {
        orConditions.push({ id: { [Op.in]: assignedContactIds } });
      }

      where[Op.and] = [...(where[Op.and] || []), { [Op.or]: orConditions }];
    } else if (PRIVILEGED_ROLES.includes(req.user.role)) {
      console.log("assignedContactIds = N/A (rôle privilégié — vue complète)");
    } else {
      console.log(`assignedContactIds = N/A (rôle "${req.user.role}" non restreint ici — vue complète, comportement historique)`);
    }

    console.log(
      "WHERE AFTER =",
      JSON.stringify(where, null, 2),
      req.user.role === "commercial"
        ? `+ OR[createdBy=${req.user.sub}, commercialId=${req.user.sub}${assignedContactIds.length ? `, id IN (${assignedContactIds.length} ids)` : ""}]`
        : ""
    );

    // =============================
    // FETCH DATA
    // =============================
    const rows = await CommercialContact.findAll({
      where,
      order: [["createdAt", "DESC"]],
      include: [
        { model: CommercialContactProduct, as: "produits" },
        { model: CommercialProject, as: "projects" },
        { model: User, as: "creator", attributes: ["id", "email"] },
        {
          model: CommercialContactRelance,
          as: "relances",
          required: false,
        },
      ],
      logging: (sql) => console.log("SQL GENERATED =", sql),
    });

    console.log("CONTACTS FOUND =", rows.length);
    console.log(`========== FIN [${reqId}] ==========\n`);

    const result = rows.map((row) => {
  const r = row.toJSON();

  // 🔥 FUSION USER
  r.user_nom = r.user_nom || r.user_nom_custom;

  return r;
});

return res.json(result);

  } catch (e) {
    console.error("❌ GET CONTACTS ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ADMIN — "Affecter des contacts" : attribue en masse une liste de
// contacts à un commercial (renseigne commercial_contacts.commercialId).
// Réservé aux rôles privilégiés (admin/superadmin/superadmin2).
// ═══════════════════════════════════════════════════════════════════════
router.post("/assign", authRequired, async (req, res) => {
  try {
    console.log("ROLE =", req.user.role);
    console.log("USER =", req.user.sub);

    if (!PRIVILEGED_ROLES.includes(req.user.role)) {
      return res.status(403).json({ message: "Réservé aux administrateurs" });
    }

    const { contactIds, commercialId } = req.body || {};

    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      return res.status(400).json({ message: "contactIds requis (liste non vide)" });
    }
    if (!commercialId || typeof commercialId !== "string") {
      return res.status(400).json({ message: "commercialId requis" });
    }

    const commercial = await User.findOne({
      where: { id: commercialId },
      attributes: ["id", "role"],
    });
    if (!commercial || !isCommercialEligibleRole(commercial.role)) {
      return res.status(400).json({ message: "Commercial invalide ou introuvable" });
    }

    console.log("ASSIGN — contactIds:", contactIds.length, "→ commercialId:", commercialId);

    const [updatedCount] = await CommercialContact.update(
      { commercialId },
      { where: { id: { [Op.in]: contactIds } } }
    );

    console.log(`✅ ASSIGN CONTACTS — ${updatedCount}/${contactIds.length} contact(s) mis à jour`);

    return res.json({ ok: true, updatedCount, requested: contactIds.length });
  } catch (e) {
    console.error("❌ ASSIGN CONTACTS ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// GET /commercial-contacts/:id — fiche complète d'un contact, avec
// l'historique des statuts (statusHistory), le plus récent en premier.
router.get("/:id", authRequired, async (req, res) => {
  try {
    const contact = await CommercialContact.findByPk(req.params.id, {
      include: [
        { model: CommercialContactProduct, as: "products" },
        { model: CommercialContactRelance, as: "relances" },
        { model: CommercialProject, as: "projects" },
        {
          model: CommercialContactStatusHistory,
          as: "statusHistory",
          separate: true, // nécessaire pour que `order` s'applique à ce hasMany
          order: [["createdAt", "DESC"]],
        },
      ],
    });

    if (!contact) {
      return res.status(404).json({ message: "Contact introuvable" });
    }

    return res.json(contact);
  } catch (e) {
    console.error("❌ GET CONTACT ERROR:", e);
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

    if (!["admin", "superadmin", "superadmin2"].includes(req.user.role)) {
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
            "email",
            "localisation",
            "statut",
            "nbAppels",
            "sujetDiscussion",
          ],
        },
      ],
    });

    // Nom du projet le plus ancien par contact — même règle que
    // resolveProjectName() (followupAutomation.service.js), en une seule
    // requête groupée pour éviter le N+1 sur la liste calendrier.
    const contactIds = [...new Set(relances.map((r) => r.commercialContactId).filter(Boolean))];
    const projects = contactIds.length
      ? await CommercialProject.findAll({
          where: { commercialContactId: contactIds },
          order: [["createdAt", "ASC"]],
          attributes: ["commercialContactId", "nomProjet"],
        })
      : [];

    const projectNameByContact = {};
    for (const p of projects) {
      if (!projectNameByContact[p.commercialContactId]) {
        projectNameByContact[p.commercialContactId] = p.nomProjet;
      }
    }

    const result = relances.map((r) => {
      const json = r.toJSON();
      json.projectName = projectNameByContact[r.commercialContactId] || null;
      return json;
    });

    return res.json(result);
  } catch (e) {
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// CREATE CONTACT
router.post("/", authRequired, async (req, res) => {
  try {
    console.log("📥 CREATE CONTACT REQUEST =====================");
    console.log("👉 BODY:", JSON.stringify(req.body, null, 2));
    console.log("👉 USER:", req.user);

    const body = req.body || {};

    // 🔥 DEBUG PRODUITS
    console.log("📦 RAW PRODUCTS:", body.products);

    // 🔥 DEBUG PROJECTS
    console.log("🏗️ RAW PROJECTS:", body.projects);

    const produits = Array.isArray(body.products) ? body.products : [];
    const projects = Array.isArray(body.projects) ? body.projects : [];

    console.log("📦 PARSED PRODUCTS:", produits);
    console.log("🏗️ PARSED PROJECTS:", projects);
    // =============================
// USER NOM LOGIC 🔥
// =============================
const DEFAULT_USERS = ["najeh", "mooemen", "mayssa"];

let user_nom = null;
let user_nom_custom = null;

if (body.user_nom) {
  const cleanUser = String(body.user_nom).trim();

  if (DEFAULT_USERS.includes(cleanUser)) {
    user_nom = cleanUser; // ENUM
  } else {
    user_nom_custom = cleanUser; // STRING
  }
}

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
      matriculeFiscale: body.matriculeFiscale
  ? String(body.matriculeFiscale).trim()
  : null,
      message: body.message ? String(body.message).trim() : null,
      statut: body.statut || "user_injoignable",
      nbAppels: Number(body.nbAppels ?? 0) || 0,
      sujetDiscussion: body.sujetDiscussion
        ? String(body.sujetDiscussion).trim()
        : null,
      pipelineStage: body.pipelineStage || "Prospect",
      dateAppel: body.dateAppel || new Date(),
       // 🔥 IMPORTANT
       email: body.email && body.email.trim() !== "" 
  ? body.email.trim() 
  : null,
  user_nom,
  user_nom_custom,
      createdBy: req.user.sub,
    };

    console.log("📄 CONTACT PAYLOAD:", payload);

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
    // HISTORIQUE STATUT INITIAL — une SEULE entrée type=CREATED (toujours
    // présente, même si le contact n'est jamais modifié ensuite).
    // =============================
    await recordStatusChange({
      contactId: contact.id,
      field: "statut",
      oldValue: null,
      newValue: payload.statut,
      actorUserId: req.user.sub,
      type: "CREATED",
      commentaire: "Création du contact",
    });

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
        produit: String(p.produit || "PROBAR").trim(),
        qte: Number(p.qte ?? 1) || 1,
      }));

    console.log("📦 FINAL PRODUCTS TO INSERT:", items);

    if (items.length) {
      await CommercialContactProduct.bulkCreate(items);
      console.log("📦 PRODUITS CREATED:", items.length);
    }

    // =============================
    // CREATE PROJECTS 🔥 DEBUG
    // =============================
    if (projects.length) {
      console.log("🏗️ PROJECTS BEFORE FILTER:", projects);

      const projectItems = projects
        .filter(p => p && p.nomProjet && p.nomProjet.trim() !== "")
        .map((p) => ({
          commercialContactId: contact.id,
          nomProjet: String(p.nomProjet).trim(),
          localisation: p.localisation || null,
          typeProjet: p.typeProjet || null,
          description: p.description || null,
          createdBy: req.user.sub,
        }));

      console.log("🏗️ PROJECTS TO INSERT:", projectItems);

      if (projectItems.length) {
        await CommercialProject.bulkCreate(projectItems);
        console.log("🏗️ PROJECTS CREATED:", projectItems.length);
      } else {
        console.log("⚠️ NO VALID PROJECTS AFTER FILTER");
      }
    } else {
      console.log("⚠️ NO PROJECTS RECEIVED FROM FRONT");
    }

    // =============================
    // VERIFY INSERT 🔥
    // =============================
    const savedProjects = await CommercialProject.findAll({
      where: { commercialContactId: contact.id },
    });

    console.log("🧪 PROJECTS IN DB:", savedProjects);

    // =============================
    // CREATE ACTION AUTO
    // =============================
    const action = await CommercialContactAction.create({
      commercialContactId: contact.id,
      typeAction: mapStageToAction(payload.pipelineStage),
      commentaire: "Création du contact",
      dateAction: new Date(),
      statut: "Terminé",
      createdBy: req.user.sub,
    });

    console.log("🔥 ACTION CREATED:", action.id);

    // =============================
    // RETURN FULL DATA
    // =============================
    const full = await CommercialContact.findByPk(contact.id, {
      include: [
        { model: CommercialContactProduct, as: "products" },
        { model: CommercialContactRelance, as: "relances" },
        { model: CommercialProject, as: "projects" },
      ],
    });

    console.log("📤 FINAL RESPONSE:", JSON.stringify(full, null, 2));

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

    // 🔐 SECURITY
    if (
      !["admin", "superadmin", "superadmin2"].includes(req.user.role) &&
      row.createdBy !== req.user.sub
    ) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const body = req.body || {};

    // ── Commercial obligatoire (info@probardistribution.com uniquement),
    // validé avant toute écriture pour éviter un état partiel.
    const commercialValidationError = _validateCommercialField(req, body);
    if (commercialValidationError) {
      return res.status(400).json({ message: commercialValidationError });
    }

    const up = {};

    // =============================
    // UPDATE FIELDS
    // =============================
    if (body.typeClient != null) up.typeClient = body.typeClient;
    if (body.nomSociete != null) up.nomSociete = body.nomSociete || null;
    if (body.nom != null) up.nom = String(body.nom).trim();
    if (body.prenom != null) up.prenom = String(body.prenom).trim();

    if (body.localisation != null) {
      up.localisation = String(body.localisation).trim() || null;
    }

    if (body.telephone != null) {
      up.telephone = String(body.telephone).trim();
    }
    if (body.email != null) {
      up.email = String(body.email).trim();
    }

    if (body.message != null) {
      up.message = String(body.message).trim() || null;
    }

    if (body.statut != null) {
      up.statut = String(body.statut).trim();
    }

    if (body.nbAppels != null) {
      up.nbAppels = Number(body.nbAppels) || 0;
    }
   if (body.matriculeFiscale !== undefined) {
  const mf = String(body.matriculeFiscale).trim();
  up.matriculeFiscale = mf === "" ? null : mf;
}
    if (body.sujetDiscussion != null) {
      up.sujetDiscussion = String(body.sujetDiscussion).trim() || null;
    }

    if (body.pipelineStage != null) {
      up.pipelineStage = String(body.pipelineStage).trim();
    }

    if (body.dateAppel != null) {
      up.dateAppel = body.dateAppel;
    }

    // 🔥 NEW
   if (body.user_nom != null) {
// =============================
// 🔥 USER NOM LOGIC (FIX)
// =============================
const DEFAULT_USERS = ["najeh", "mooemen", "mayssa"];

if (body.user_nom !== undefined) {
  const cleanUser = String(body.user_nom).trim();

  console.log("USER REÇU =>", cleanUser);

  if (DEFAULT_USERS.includes(cleanUser)) {
    up.user_nom = cleanUser;
    up.user_nom_custom = null;
  } else {
    up.user_nom = null;
    up.user_nom_custom = cleanUser;
  }
}
}

    // Snapshot AVANT écriture — seule façon fiable de savoir si statut/
    // pipelineStage changent réellement (comparaison après row.update()
    // donnerait toujours "égal" puisque l'instance serait déjà mutée).
    const oldStatut = row.statut;
    const oldPipelineStage = row.pipelineStage;

    await row.update(up);

    // =============================
    // HISTORIQUE STATUT — une ligne par champ réellement modifié, jamais
    // si le statut ne change pas (comparaison stricte ancien/nouveau).
    // =============================
    const statusChangeComment =
      body.statusComment || body.commentaire || body.commentaireRelance || null;

    if (up.statut != null) {
      await recordStatusChange({
        contactId: id,
        field: "statut",
        oldValue: oldStatut,
        newValue: up.statut,
        actorUserId: req.user.sub,
        commentaire: statusChangeComment,
        type: "STATUS_CHANGED",
      });
    }
    if (up.pipelineStage != null) {
      await recordStatusChange({
        contactId: id,
        field: "pipelineStage",
        oldValue: oldPipelineStage,
        newValue: up.pipelineStage,
        actorUserId: req.user.sub,
        commentaire: statusChangeComment,
        type: "STATUS_CHANGED",
      });
    }

    // =============================
    // UPDATE PRODUCTS
    // =============================
    if (Array.isArray(body.products)) {
      await CommercialContactProduct.destroy({
        where: { commercialContactId: id },
      });

      const items = body.products
        .filter((p) => p)
        .map((p) => ({
          commercialContactId: id,
          produit: String(p.produit || "PROBAR").trim(),
          qte: Number(p.qte ?? 1) || 1,
        }));

      if (items.length) {
        await CommercialContactProduct.bulkCreate(items);
      }
    }

    // =============================
    // 🔥 UPDATE PROJECTS (NEW)
    // =============================
    if (Array.isArray(body.projects)) {
      await CommercialProject.destroy({
        where: { commercialContactId: id },
      });

      const projectItems = body.projects.map((p) => ({
        commercialContactId: id,
        nomProjet: String(p.nomProjet || "").trim(),
        localisation: p.localisation || null,
        typeProjet: p.typeProjet || null,
        description: p.description || null,
      }));

      if (projectItems.length) {
        await CommercialProject.bulkCreate(projectItems);
      }
    }

    // =============================
    // UPDATE RELANCE
    // =============================
    let automationResult = null;
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

      const commercial = await _resolveCommercial(body.commercialId);
      const commercialFields = commercial
        ? {
            commercialId: commercial.id,
            commercialName: commercial.name,
            commercialEmail: commercial.email,
          }
        : {};

      let savedRelance;
      if (existingRelance) {
        await existingRelance.update({
          dateRelance: body.dateRelance,
          heureRelance: body.heureRelance || null,
          commentaire: body.commentaire || body.commentaireRelance || null,
          ...commercialFields,
        });
        savedRelance = existingRelance;
      } else {
        savedRelance = await CommercialContactRelance.create({
          commercialContactId: id,
          dateRelance: body.dateRelance,
          heureRelance: body.heureRelance || null,
          commentaire:
            body.commentaire || body.commentaireRelance || null,
          createdBy: req.user.sub,
          ...commercialFields,
        });
      }

      automationResult = await _maybeRunFollowupAutomation(req, row, savedRelance);
    }

    // =============================
    // RETURN FULL DATA
    // =============================
    const full = await CommercialContact.findByPk(id, {
      include: [
        { model: CommercialContactProduct, as: "products" },
        { model: CommercialContactRelance, as: "relances" },
        { model: CommercialProject, as: "projects" }, // 🔥 NEW
      ],
    });

    // `automation` est un champ additif — n'affecte pas le parsing existant
    // côté Flutter, qui ignore les clés qu'il ne connaît pas.
    return res.json({ ...full.toJSON(), automation: automationResult });

  } catch (e) {
    console.error("❌ UPDATE CONTACT ERROR:", e);

    return res.status(500).json({
      message: e.message || "Server error",
      stack: e.stack,
    });
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
      !["admin", "superadmin", "superadmin2"].includes(req.user.role) &&
      contact.createdBy !== req.user.sub
    ) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const body = req.body || {};

    if (!body.dateRelance) {
      return res.status(400).json({ message: "dateRelance obligatoire" });
    }

    const commercialValidationError = _validateCommercialField(req, body);
    if (commercialValidationError) {
      return res.status(400).json({ message: commercialValidationError });
    }

    const commercial = await _resolveCommercial(body.commercialId);

    const relance = await CommercialContactRelance.create({
      commercialContactId: id,
      dateRelance: body.dateRelance,
      heureRelance: body.heureRelance || null,
      commentaire: body.commentaire || null,
      createdBy: req.user.sub,
      ...(commercial
        ? {
            commercialId: commercial.id,
            commercialName: commercial.name,
            commercialEmail: commercial.email,
          }
        : {}),
    });

    const automation = await _maybeRunFollowupAutomation(req, contact, relance);

    // Forme de réponse rétro-compatible : les champs de la relance restent
    // au premier niveau (comme avant), `automation` est purement additif.
    return res.status(201).json({ ...relance.toJSON(), automation });
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
      !["admin", "superadmin", "superadmin2"].includes(req.user.role) &&
      contact.createdBy !== req.user.sub
    ) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const body = req.body || {};

    const commercialValidationError = _validateCommercialField(req, body);
    if (commercialValidationError) {
      return res.status(400).json({ message: commercialValidationError });
    }

    const commercial = body.commercialId ? await _resolveCommercial(body.commercialId) : null;

    await relance.update({
      dateRelance: body.dateRelance ?? relance.dateRelance,
      heureRelance: body.heureRelance ?? relance.heureRelance,
      commentaire: body.commentaire ?? relance.commentaire,
      statutRelance: body.statutRelance ?? relance.statutRelance,
      ...(commercial
        ? {
            commercialId: commercial.id,
            commercialName: commercial.name,
            commercialEmail: commercial.email,
          }
        : {}),
    });

    const automation = await _maybeRunFollowupAutomation(req, contact, relance);

    // Forme de réponse rétro-compatible : les champs de la relance restent
    // au premier niveau (comme avant), `automation` est purement additif.
    return res.json({ ...relance.toJSON(), automation });
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
      !["admin", "superadmin", "superadmin2"].includes(req.user.role) &&
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