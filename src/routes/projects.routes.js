// routes/projects.routes.js
const express = require("express");
const { Op, fn, col, where, literal } = require("sequelize");
const { User, Project, UserProject, ProjectComment, UserProfile, PipelineStage } = require("../models/associations");
const { authRequired } = require("../middleware/auth.middleware");
const { sequelize } = require("../db");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { actionUpload } = require("../middleware/actionUpload.middleware");
const { handleUploadError } = require("../middleware/projectAction.validation");
const ProjectDevis = require("../models/ProjectDevis"); // adapte selon ton export
const ProjectBonDeCommande = require("../models/ProjectBonDeCommande");
const ProjectAction = require("../models/ProjectAction");
const ProjectReminder = require("../models/ProjectReminder");
const CommercialContact = require("../models/CommercialContact");
const { resolveCompanyForProject } = require("../services/company.service");
const {
  resolveEngineerForProject,
  resolveArchitectForProject,
} = require("../services/person.service");
const LocationService = require("../services/location.service");
const router = express.Router();
const ADMIN_ROLES = ["admin", "superadmin"];
const uploads = require("../middleware/uploads");

// ---------------- Helpers ----------------
function reqStr(v) {
  return typeof v === "string" ? v.trim() : "";
}
function getUserDisplayName(u) {
  return (
    u?.firstname ||
    u?.firstName ||
    u?.prenom ||
    u?.lastname ||
    u?.lastName ||
    u?.nom ||
    u?.username ||
    u?.name ||
    u?.fullName ||
    u?.email ||
    "Inconnu"
  );
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

function toNumberOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function isUUID(v) {
  const s = String(v || "");
  // UUID v1-v5
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

// ✅ normalize payload (flutter-friendly)
function normalizePayload(body = {}) {
  const b = { ...body };

  // Use LocationService for coordinate normalization
  const coords = LocationService.normalizeCoordinates(b);
  if (coords.valid) {
    b.latitude = coords.lat;
    b.longitude = coords.lng;
  }

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
    "validationStatut",
    "typeProjet",
    "localisationCommentaire",
  ];

  for (const f of stringFields) {
    if (b[f] !== undefined && b[f] !== null) {
      b[f] = reqStr(b[f]);
      if (b[f] === "") b[f] = null;
    }
  }

  if (b.pourcentageReussite !== undefined) b.pourcentageReussite = toNumberOrNull(b.pourcentageReussite);
  if (b.surfaceProspectee !== undefined) b.surfaceProspectee = toNumberOrNull(b.surfaceProspectee);

  return b;
}

const ACTION_TO_STAGE = {
  "Visite": "Prospect",
  "Plan technique": "Prospect",        // ✅ IMPORTANT
  "Echantillonnage": "Prospect",
  "Devis envoyé": "Devis envoyé",
  "Negociation": "Negociation",
  "Commande gagnée": "Commande gagnée",
  "Commande perdue": "Commande perdue",
  "Fidélisation": "Fidélisation"
};

function getStageFromAction(action) {
  return ACTION_TO_STAGE[action] || "Prospect";
}
function isValidEmail(email) {
  if (!email) return false;

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePayload(body, isUpdate = false) {
  const errors = [];

  const mode = body.projectModele || "project";

  const isRevendeur = mode === "revendeur";
  const isApplicateur = mode === "applicateur";

  // 🔥 SEUL PROJECT = chantier
  const isChantier = !isRevendeur && !isApplicateur;

  if (!isUpdate) {
    if (!body.nomProjet || reqStr(body.nomProjet) === "") {
      errors.push("nomProjet est obligatoire");
    }

    if (isChantier) {
      if (!body.dateDemarrage || reqStr(body.dateDemarrage) === "") {
        errors.push("dateDemarrage est obligatoire");
      }

      if (!body.typeAdresseChantier || reqStr(body.typeAdresseChantier) === "") {
        errors.push("typeAdresseChantier est obligatoire");
      }
    }
  }

  // =========================
  // 📍 GEO VALIDATION
  // =========================
  const coordinateErrors = LocationService.validateCoordinateInput(body, isChantier && !isUpdate);
  errors.push(...coordinateErrors);

  // =========================
  // MODE SPECIFIC
  // =========================
  if (!isUpdate) {

    // =========================
    // 🟠 REVENDEUR (NON BLOQUANT)
    // =========================
    if (isRevendeur) {

      // ❌ SUPPRIMÉ : comptoir obligatoire

      if (body.telephoneComptoir && !isValidPhone(body.telephoneComptoir)) {
        errors.push("telephoneComptoir invalide");
      }

      if (body.revendeurEmail && !isValidEmail(body.revendeurEmail)) {
        errors.push("revendeurEmail invalide");
      }
    }

    // =========================
    // 🔵 APPLICATEUR
    // =========================
    if (isApplicateur) {

      if (!body.dallagiste || reqStr(body.dallagiste) === "") {
        errors.push("dallagiste est obligatoire");
      }

      if (!body.telephoneDallagiste || reqStr(body.telephoneDallagiste) === "") {
        errors.push("telephoneDallagiste est obligatoire");
      }
    }
  }

  // =========================
  // FORMAT DATE
  // =========================
  if (
    isChantier &&
    body.dateDemarrage &&
    !isValidDateOnly(body.dateDemarrage)
  ) {
    errors.push("dateDemarrage doit être au format YYYY-MM-DD");
  }

  // =========================
  // CRM REQUIRED
  // =========================
  if (!isUpdate) {

    if (!body.firstAction || reqStr(body.firstAction) === "") {
      errors.push("firstAction est obligatoire");
    }

    if (!body.dateVisite) {
      errors.push("dateVisite est obligatoire");
    }
  }

  // =========================
  // PHONE VALIDATION
  // =========================
  if (body.telephoneIngenieur && !isValidPhone(body.telephoneIngenieur)) {
    errors.push("telephoneIngenieur invalide");
  }

  if (body.telephoneArchitecte && !isValidPhone(body.telephoneArchitecte)) {
    errors.push("telephoneArchitecte invalide");
  }

  if (body.telephoneComptoir && !isValidPhone(body.telephoneComptoir)) {
    errors.push("telephoneComptoir invalide");
  }

  if (body.telephoneComptoir2 && !isValidPhone(body.telephoneComptoir2)) {
    errors.push("telephoneComptoir2 invalide");
  }

  if (body.telephoneDallagiste && !isValidPhone(body.telephoneDallagiste)) {
    errors.push("telephoneDallagiste invalide");
  }

  // =========================
  // EMAIL VALIDATION
  // =========================
  if (body.emailDallagiste && !isValidEmail(body.emailDallagiste)) {
    errors.push("emailDallagiste invalide");
  }

  // =========================
  // OPTIONAL STRING
  // =========================
  if (body.entreprise !== undefined && body.entreprise !== null) {
    if (reqStr(body.entreprise) === "") {
      errors.push("entreprise invalide");
    }
  }

  if (body.bureauControle !== undefined && body.bureauControle !== null) {
    if (reqStr(body.bureauControle) === "") {
      errors.push("bureauControle invalide");
    }
  }

  // statut validation is done dynamically inside the handler (per projectModele)

  if (body.validationStatut !== undefined && body.validationStatut !== null) {
    const allowed = ["Validé", "Non validé"];
    if (!allowed.includes(body.validationStatut)) {
      errors.push("validationStatut invalide");
    }
  }

  // =========================
  // NUMERIC
  // =========================
  if (body.pourcentageReussite !== undefined && body.pourcentageReussite !== null) {
    const val = Number(body.pourcentageReussite);
    if (isNaN(val)) {
      errors.push("pourcentageReussite doit être un nombre");
    } else if (val < 0 || val > 100) {
      errors.push("pourcentageReussite doit être entre 0 et 100");
    }
  }

  if (body.surfaceProspectee !== undefined && body.surfaceProspectee !== null) {
    const val = Number(body.surfaceProspectee);
    if (isNaN(val)) {
      errors.push("surfaceProspectee doit être un nombre");
    } else if (val < 0) {
      errors.push("surfaceProspectee doit être >= 0");
    }
  }

  return errors;
}

function isGlobalKpiUser(user) {
  return ["admin", "superadmin"].includes(user?.role);
}

async function getAccessibleProjectIds(user) {
  if (isGlobalKpiUser(user)) return null; // null => pas de filtre

  const links = await UserProject.findAll({
    where: { userId: user.sub },
    attributes: ["projectId"],
    raw: true,
  });

  return links.map(l => l.projectId).filter(Boolean);
}

function buildProjectWhere(accessibleIds) {
  if (accessibleIds === null) return {};

  if (!accessibleIds.length) {
    return {
      id: { [Op.in]: ["00000000-0000-0000-0000-000000000000"] },
    };
  }

  return { id: { [Op.in]: accessibleIds } };
}
// ✅ permission helper
async function getPermission(user, projectId) {
  if (["admin", "superadmin"].includes(user.role)) return "owner";

  const link = await UserProject.findOne({
    where: { userId: user.sub, projectId },
  });

  return link?.permission || "viewer";
}
// ✅ middleware admin (si tu as déjà isAdminRole utilise-le)
function adminOnly(req, res, next) {
  const role = (req.user?.role || "").toLowerCase();
  if (role === "admin" || role === "superadmin") return next();
  return res.status(403).json({ message: "Forbidden" });
}
// routes/projects.routes.js (or equivalent file where routes are defined)
router.get("/applicateur", async (req, res) => {
  try {
    const { page = 1, limit = 10, q } = req.query;

    const currentPage = Math.max(parseInt(page) || 1, 1);
    const currentLimit = Math.max(parseInt(limit) || 10, 1);
    const offset = (currentPage - 1) * currentLimit;

    const where = {
      projectModele: "applicateur",
    };

    if (q) {
      where[Op.or] = [
        { nomProjet: { [Op.iLike]: `%${q}%` } },
        { dallagiste: { [Op.iLike]: `%${q}%` } },
        { adresse: { [Op.iLike]: `%${q}%` } },
      ];
    }

    const { count, rows } = await Project.findAndCountAll({
      where,
      limit: currentLimit,
      offset,
      order: [["createdAt", "DESC"]],
    });

    res.json({
      items: rows,
      total: count,
      page: currentPage,
      totalPages: Math.ceil(count / currentLimit),
    });

  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

router.get("/revendeur", async (req, res) => {
  const data = await Project.findAll({
    where: { projectModele: "revendeur" },
  });

  res.json(data);
});
router.get("/calendar", authRequired, async (req, res) => {
  try {
    const projects = await Project.findAll({
      attributes: ['id', 'nomProjet', 'dateDemarrage', 'statut', 'validationStatut'],
    });

    const calendarProjects = projects.map(project => {
      const statusColor = getStatusColor(project.statut, project.validationStatut);
      return {
        id: project.id,
        nomProjet: project.nomProjet,
        dateDemarrage: project.dateDemarrage,
        statut: project.statut,
        validationStatut: project.validationStatut,
        color: statusColor,
      };
    });

    res.json(calendarProjects);
  } catch (error) {
    console.error("Error fetching projects:", error);
    res.status(500).json({ message: 'Error fetching projects' });
  }
});

// Helper function to return color based on project status
function getStatusColor(status, validationStatus) {

  const s = (status || "").toLowerCase();
  const v = (validationStatus || "").toLowerCase();

  // =========================
  // 🔥 PRIORITY: COMPLETED STATUS
  // =========================
  if (s === "completed" || s === "terminé") {
    if (v === "valid" || v === "validé") return "green";
    if (v === "not valid" || v === "non validé") return "orange";
    return "blue"; // completed but no validation
  }

  // =========================
  // 🔥 PIPELINE STATUS
  // =========================
  switch (s) {
    case "identification":
      return "blue";

    case "technical proposal":
    case "proposition technique":
      return "purple";

    case "commercial proposal":
    case "proposition commerciale":
      return "indigo";

    case "negotiation":
    case "négociation":
      return "red";

    case "delivery":
    case "livraison":
      return "green";

    case "loyalty":
    case "fidélisation":
      return "teal";

    // 🔥 legacy statuses (compatibility)
    case "preparation":
    case "préparation":
      return "blue";

    case "in progress":
    case "en cours":
      return "orange";

    default:
      return "gray";
  }
}
function getNextAction(stage) {

  const map = {
    prospect: "Visite",
    visite: "Plan technique",
    plan: "Devis",
    devis: "Relance",
    relance: "Commande",
    commande: "Suivi chantier"
  };

  return map[stage] || null;
}
function getProjectColor(stage){

  const map = {

    prospect: "blue",
    visite: "orange",
    devis: "purple",
    relance: "red",
    commande: "green"

  };

  return map[stage] || "grey";
}
/* ============================================================
   ✅ KPI ROUTES (IMPORTANT: BEFORE "/:id")
   ============================================================ */

router.get("/user-kpi", authRequired, async (req, res) => {
  try {
    console.log("ROUTE CALLED");
    console.log(req.originalUrl);

    const totalUsers = await User.count();
    const activeUsers = await User.count({ where: { isActive: true } });
    const activePercentage = totalUsers === 0 ? 0 : Number(((activeUsers / totalUsers) * 100).toFixed(2));

    const response = { activeUsers, totalUsers, activePercentage };
    console.log("KPI RESPONSE");
    console.log(JSON.stringify(response, null, 2));
    res.json(response);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/kpi/validation-summary", authRequired, async (req, res) => {
  try {
    const accessibleIds = await getAccessibleProjectIds(req.user);
    const where = buildProjectWhere(accessibleIds);

    const totalProjects = await Project.count({ where });
    const validatedProjects = await Project.count({
      where: { ...where, validationStatut: "Validé" },
    });

    const validatedPercentage =
      totalProjects === 0 ? 0 : Number(((validatedProjects / totalProjects) * 100).toFixed(2));

    res.json({ totalProjects, validatedProjects, validatedPercentage });
  } catch (err) {
    res.status(500).json({ error: "KPI_VALIDATION_SUMMARY_ERROR", details: err.message });
  }
});

router.get("/kpi/validation-by-surface", authRequired, async (req, res) => {
  try {
    const accessibleIds = await getAccessibleProjectIds(req.user);
    const where = buildProjectWhere(accessibleIds);

    const rows = await Project.findAll({
      where,
      attributes: [
        "id",
        "nomProjet", // 🔥 nom projet (important)
        "surfaceProspectee",
        "validationStatut",
        "pourcentageReussite",
      ],
      order: [["surfaceProspectee", "ASC"]],
      raw: true,
    });

    const result = rows.map((r) => ({
      id: r.id,
      projectName: r.nomProjet, // 🔥 standard frontend
      surfaceProspectee: r.surfaceProspectee,
      statut: r.validationStatut,
      successPercentage: r.pourcentageReussite
        ? Number(r.pourcentageReussite)
        : 0,
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({
      error: "PROJECTS_BY_SURFACE_ERROR",
      details: err.message,
    });
  }
});

router.get("/kpi/validation-by-location", authRequired, async (req, res) => {
  try {
    // précision clustering (3 => ~110m). change à 2 si tu veux regrouper plus.
    const PRECISION = 3;

    const latExpr = sequelize.literal(`ROUND(CAST("latitude" AS numeric), ${PRECISION})`);
    const lngExpr = sequelize.literal(`ROUND(CAST("longitude" AS numeric), ${PRECISION})`);

    const zoneExpr = sequelize.literal(`
      COALESCE(NULLIF(TRIM("adresse"), ''), NULLIF(TRIM("localisationCommentaire"), ''), '')
    `);

    const rows = await Project.findAll({
      attributes: [
        [latExpr, "lat"],
        [lngExpr, "lng"],
        [sequelize.fn("COUNT", sequelize.col("id")), "totalProjects"],
        [
          sequelize.fn(
            "SUM",
            sequelize.literal(`CASE WHEN "validationStatut" = 'Validé' THEN 1 ELSE 0 END`)
          ),
          "validatedProjects",
        ],
        [zoneExpr, "zoneFromDb"],
      ],
      group: [latExpr, lngExpr, zoneExpr],
      raw: true,
    });

    const result = rows.map((r) => {
      const total = Number(r.totalProjects || 0);
      const validated = Number(r.validatedProjects || 0);

      const lat = Number(r.lat);
      const lng = Number(r.lng);

      // zone: si vide => fallback lat,lng
      const zone = (r.zoneFromDb && String(r.zoneFromDb).trim())
        ? String(r.zoneFromDb).trim()
        : `${lat}, ${lng}`;

      return {
        zone,
        latitude: lat,
        longitude: lng,
        totalProjects: total,
        validatedProjects: validated,
        validatedPercentage: total === 0 ? 0 : Number(((validated / total) * 100).toFixed(2)),
      };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "KPI_VALIDATION_BY_LOCATION_ERROR", details: err.message });
  }
});
router.get("/kpi/validation-status-count", authRequired, async (req, res) => {
  try {
    console.log("ROUTE CALLED");
    console.log(req.originalUrl);

    const isAdmin = ADMIN_ROLES.includes(req.user?.role);
    const ownerWhere = isAdmin ? {} : { ownerId: req.user.sub };

    const rows = await Project.findAll({
      where: ownerWhere,
      attributes: [
        "validationStatut",
        [sequelize.fn("COUNT", sequelize.col("id")), "projectCount"],
      ],
      group: ["validationStatut"],
      raw: true,
    });

    const response = rows.map((r) => ({
      validationStatut: r.validationStatut ?? "Non défini",
      projectCount: Number(r.projectCount || 0),
    }));
    console.log("KPI RESPONSE");
    console.log(JSON.stringify(response, null, 2));
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: "KPI_VALIDATION_STATUS_COUNT_ERROR", details: err.message });
  }
});
router.get("/kpi/dashboard", authRequired, async (req, res) => {
  try {
    console.log("ROUTE CALLED");
    console.log(req.originalUrl);

    const global     = isGlobalKpiUser(req.user);
    const ownerWhere = global ? {} : { ownerId: req.user.sub };
    const where      = { ...ownerWhere, isArchived: false };

    const totalProjects = await Project.count({ where });
    const validatedProjects = await Project.count({ where: { ...where, validationStatut: "Validé" } });
    const nonValidatedProjects = totalProjects - validatedProjects;

    const validatedPercentage =
      totalProjects === 0 ? 0 : Number(((validatedProjects / totalProjects) * 100).toFixed(2));

    const validationStatusCount = await Project.findAll({
      where,
      attributes: ["validationStatut", [sequelize.fn("COUNT", sequelize.col("id")), "projectCount"]],
      group: ["validationStatut"],
      raw: true,
    });

    const bySurfaceRows = await Project.findAll({
      where,
      attributes: [
        "surfaceProspectee",
        [sequelize.fn("COUNT", sequelize.col("id")), "totalProjects"],
        [sequelize.fn("SUM", sequelize.literal(`CASE WHEN "validationStatut" = 'Validé' THEN 1 ELSE 0 END`)), "validatedProjects"],
      ],
      group: ["surfaceProspectee"],
      order: [[sequelize.col("surfaceProspectee"), "ASC"]],
      raw: true,
    });

    const bySurface = bySurfaceRows.map((r) => {
      const total = Number(r.totalProjects || 0);
      const validated = Number(r.validatedProjects || 0);
      return {
        surfaceProspectee: r.surfaceProspectee,
        totalProjects: total,
        validatedProjects: validated,
        validatedPercentage: total === 0 ? 0 : Number(((validated / total) * 100).toFixed(2)),
      };
    });

    const mapProjects = await Project.findAll({
      where: {
        ...where,
        latitude: { [Op.ne]: null },
        longitude: { [Op.ne]: null },
      },
      attributes: ["id","nomProjet","latitude","longitude","validationStatut","statut","adresse","localisationCommentaire","createdAt"],
      order: [["createdAt", "DESC"]],
      limit: 200,
      raw: true,
    });

    // ✅ topUsers : global => vrai top 5 ; non-global => seulement user connecté
    let topUsers = [];
    if (global) {
      const projectsPerUser = await UserProject.findAll({
        attributes: ["userId", [sequelize.fn("COUNT", sequelize.col("projectId")), "projectsCount"]],
        group: ["userId"],
        raw: true,
      });

      const userIds = projectsPerUser.map((x) => x.userId).filter(Boolean);

      const users = userIds.length
        ? await User.findAll({ where: { id: userIds }, attributes: ["id", "email"], raw: true })
        : [];

      const userMap = new Map(users.map((u) => [u.id, u]));
      topUsers = projectsPerUser
        .map((x) => ({ userId: x.userId, projectsCount: Number(x.projectsCount || 0), user: userMap.get(x.userId) || null }))
        .sort((a, b) => b.projectsCount - a.projectsCount)
        .slice(0, 5);
    } else {
      const myCount = await UserProject.count({ where: { userId: req.user.sub } });
      topUsers = [{ userId: req.user.sub, projectsCount: myCount, user: { id: req.user.sub } }];
    }

    const latestProjects = await Project.findAll({
      where,
      order: [["createdAt", "DESC"]],
      limit: 5,
      attributes: ["id", "nomProjet", "validationStatut", "statut", "createdAt", "latitude", "longitude"],
      raw: true,
    });

    const archivedProjects = await Project.count({ where: { ...ownerWhere, isArchived: true } });
    const pendingProjects  = await Project.count({
      where: { ...ownerWhere, isArchived: false, statut: { [Op.notIn]: ["Gagné", "Perdu"] } },
    });
    const successRate = totalProjects > 0
      ? Number(((validatedProjects / totalProjects) * 100).toFixed(2))
      : 0;

    const response = {
      summary: {
        totalProjects,
        validatedProjects,
        nonValidatedProjects,
        validatedPercentage,
        archivedProjects,
        pendingProjects,
        successRate,
      },
      validationStatusCount: validationStatusCount.map((r) => ({
        validationStatut: r.validationStatut ?? "Non défini",
        projectCount: Number(r.projectCount || 0),
      })),
      bySurface,
      mapProjects,
      topUsers,
      latestProjects,
      scope: global ? "GLOBAL" : "USER_ONLY",
    };
    console.log("KPI RESPONSE");
    console.log(JSON.stringify(response.summary, null, 2));
    return res.json(response);
  } catch (err) {
    console.error("KPI_DASHBOARD_ERROR:", err);
    return res.status(500).json({ error: "KPI_DASHBOARD_ERROR", details: err.message });
  }
});

router.get("/kpi/map-projects", authRequired, async (req, res) => {
  try {
    console.log("ROUTE CALLED");
    console.log(req.originalUrl);

    const isAdmin = ADMIN_ROLES.includes(req.user?.role);
    const ownerWhere = isAdmin ? {} : { ownerId: req.user.sub };

    const items = await Project.findAll({
      attributes: ["id", "nomProjet", "latitude", "longitude", "validationStatut", "statut", "adresse", "localisationCommentaire", "createdAt"],
      where: {
        ...ownerWhere,
        latitude:  { [Op.ne]: null },
        longitude: { [Op.ne]: null },
        isArchived: false,
      },
      order: [["createdAt", "DESC"]],
      raw: true,
    });

    console.log("KPI RESPONSE — map-projects count:", items.length);
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: "KPI_MAP_PROJECTS_ERROR", details: err.message });
  }
});

router.get("/kpi/projects-by-status", authRequired, async (req, res) => {
  try {
    console.log("ROUTE CALLED");
    console.log(req.originalUrl);

    const isAdmin = ADMIN_ROLES.includes(req.user?.role);
    const ownerWhere = isAdmin ? {} : { ownerId: req.user.sub };

    const rows = await Project.findAll({
      where: { ...ownerWhere, isArchived: false },
      attributes: [
        "statut",
        [sequelize.fn("COUNT", sequelize.col("id")), "projectCount"],
      ],
      group: ["statut"],
      raw: true,
    });

    const response = rows.map((r) => ({
      statut: r.statut ?? "Sans statut",
      projectCount: Number(r.projectCount || 0),
    }));
    console.log("KPI RESPONSE");
    console.log(JSON.stringify(response, null, 2));
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: "KPI_PROJECTS_BY_STATUS_ERROR", details: err.message });
  }
});
// Nouvelle route pour récupérer les projets par validationStatut et dateDemarrage
router.get("/kpi/projects-by-status-and-date", authRequired, async (req, res) => {
  try {
    // Récupérer les projets groupés par validationStatut et dateDemarrage
    const rows = await Project.findAll({
      attributes: [
        "validationStatut", // Le statut de validation
        "dateDemarrage", // La date de démarrage
        [sequelize.fn("COUNT", sequelize.col("id")), "projectCount"], // Nombre de projets pour chaque combinaison
      ],
      group: ["validationStatut", "dateDemarrage"], // Grouper par validationStatut et dateDemarrage
      order: [["dateDemarrage", "ASC"], ["validationStatut", "ASC"]], // Trier par dateDemarrage et validationStatut
      raw: true,
    });

    // Transformer les résultats
    const result = rows.map((r) => ({
      validationStatut: r.validationStatut, // "Validé" ou "Non validé"
      dateDemarrage: r.dateDemarrage, // La date de démarrage
      projectCount: Number(r.projectCount || 0), // Nombre de projets pour chaque combinaison
    }));

    res.json(result); // Retourner les résultats au frontend
  } catch (err) {
    res.status(500).json({ error: "KPI_PROJECTS_BY_STATUS_AND_DATE_ERROR", details: err.message });
  }
});
router.get("/kpi/projects-by-month", authRequired, async (req, res) => {
  try {
    console.log("ROUTE CALLED");
    console.log(req.originalUrl);

    const isAdmin = ADMIN_ROLES.includes(req.user?.role);
    const ownerClause = isAdmin ? "" : `AND "ownerId" = :userId`;
    const userId = req.user.sub;

    // Groups by createdAt month (12 months rolling window) with role filter
    const ago12 = new Date();
    ago12.setMonth(ago12.getMonth() - 11);
    ago12.setDate(1);
    ago12.setHours(0, 0, 0, 0);

    const rows = await sequelize.query(
      `SELECT TO_CHAR(DATE_TRUNC('month', "createdAt"), 'YYYY-MM') AS month,
              COUNT(*)::int AS "totalProjects",
              COUNT(*) FILTER (WHERE "validationStatut" = 'Validé')::int AS "validatedProjects",
              COALESCE(AVG(CAST("pourcentageReussite" AS float)) FILTER (WHERE "pourcentageReussite" IS NOT NULL), 0)::float AS "avgReussite"
       FROM projects
       WHERE "isArchived" = false
         AND "createdAt" >= :ago12
         ${ownerClause}
       GROUP BY DATE_TRUNC('month', "createdAt")
       ORDER BY DATE_TRUNC('month', "createdAt") ASC`,
      { replacements: { userId, ago12 }, type: "SELECT" }
    );

    const response = rows.map((r) => {
      const total     = Number(r.totalProjects || 0);
      const validated = Number(r.validatedProjects || 0);
      return {
        month:              String(r.month),
        totalProjects:      total,
        validatedProjects:  validated,
        validatedPercentage: total === 0 ? 0 : Number(((validated / total) * 100).toFixed(2)),
        avgReussite:        Number(Number(r.avgReussite || 0).toFixed(2)),
      };
    });

    console.log("KPI RESPONSE — projects-by-month rows:", response.length);
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: "KPI_PROJECTS_BY_MONTH_ERROR", details: err.message });
  }
});
router.get("/kpi/latest-projects", authRequired, async (req, res) => {
  try {
    console.log("ROUTE CALLED");
    console.log(req.originalUrl);

    const isAdmin = ADMIN_ROLES.includes(req.user?.role);
    const ownerWhere = isAdmin ? {} : { ownerId: req.user.sub };

    const items = await Project.findAll({
      where: { ...ownerWhere, isArchived: false },
      order: [["createdAt", "DESC"]],
      limit: 15,
      attributes: ["id", "nomProjet", "dateDemarrage", "validationStatut", "statut", "createdAt", "ownerId"],
      include: [
        {
          model: User,
          as: "owner",
          required: false,
          attributes: ["id", "email"],
          include: [{ model: UserProfile, as: "profile", attributes: ["name", "avatarUrl"], required: false }],
        },
      ],
    });

    const response = items.map((p) => {
      const j = p.toJSON();
      const ownerRaw = j.owner;
      return {
        id:               j.id,
        nomProjet:        j.nomProjet,
        dateDemarrage:    j.dateDemarrage,
        validationStatut: j.validationStatut,
        statut:           j.statut,
        createdAt:        j.createdAt,
        owner: ownerRaw ? {
          id:       ownerRaw.id,
          email:    ownerRaw.email,
          name:     ownerRaw.profile?.name || ownerRaw.email,
          avatarUrl: ownerRaw.profile?.avatarUrl || null,
        } : null,
      };
    });

    console.log("KPI RESPONSE — latest-projects count:", response.length);
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: "KPI_LATEST_PROJECTS_ERROR", details: err.message });
  }
});
router.get("/dashboard/kpi", authRequired, async (req, res) => {
  try {
    const role         = (req.user?.role || "").toLowerCase();
    const isAdmin      = role === "admin" || role === "superadmin";
    const selectedUser = req.query.userId;
    const userId       = req.user.sub;

    console.log("ROUTE CALLED", req.originalUrl);
    console.log("USER_ID", userId);
    console.log("ROLE", role);
    console.log("IS_ADMIN", isAdmin);

    // Admin can optionally scope to a selectedUser via ?userId=
    const effectiveOwnerId =
      isAdmin && selectedUser ? selectedUser
      : isAdmin               ? null   // no owner filter → all projects
      :                         userId;

    // ownerClause uses "ownerId" column directly (no table alias needed in flat queries)
    const ownerClause  = effectiveOwnerId ? `AND "ownerId" = :ownerId`   : "";
    // ownerClauseP uses table alias "p" for JOIN queries
    const ownerClauseP = effectiveOwnerId ? `AND p."ownerId" = :ownerId` : "";
    const replacements = { ownerId: effectiveOwnerId };

    console.log("EFFECTIVE_OWNER_ID", effectiveOwnerId);

    // ══════════════════════════════════════════════════════════════════════
    // CORE KPI COUNTS — NO isArchived filter
    // User wants COUNT(*) across ALL projects (archived + active)
    // archivedProjects is tracked separately as COUNT(isArchived=true)
    // ══════════════════════════════════════════════════════════════════════
    const [
      [totalRow],
      [validatedRow],
      [archivedRow],
      [surfaceRow],
      [successRow],
    ] = await Promise.all([

      // totalProjects = COUNT(*) — ALL projects regardless of archive status
      // SQL: SELECT COUNT(*)::int AS count FROM projects WHERE "ownerId" = :ownerId
      sequelize.query(
        `SELECT COUNT(*)::int AS count FROM projects WHERE 1=1 ${ownerClause}`,
        { replacements, type: "SELECT" }
      ),

      // validatedProjects = COUNT(validationStatut = 'Validé') — no archive filter
      // SQL: SELECT COUNT(*)::int AS count FROM projects WHERE "validationStatut" = 'Validé' AND "ownerId" = :ownerId
      sequelize.query(
        `SELECT COUNT(*)::int AS count FROM projects
         WHERE "validationStatut" = 'Validé' ${ownerClause}`,
        { replacements, type: "SELECT" }
      ),

      // archivedProjects = COUNT(isArchived = true)
      // SQL: SELECT COUNT(*)::int AS count FROM projects WHERE "isArchived" = true AND "ownerId" = :ownerId
      sequelize.query(
        `SELECT COUNT(*)::int AS count FROM projects
         WHERE "isArchived" = true ${ownerClause}`,
        { replacements, type: "SELECT" }
      ),

      // surfaceTotal = SUM(surfaceProspectee) — no archive filter
      // SQL: SELECT COALESCE(SUM("surfaceProspectee"),0)::float AS total FROM projects WHERE "ownerId" = :ownerId
      sequelize.query(
        `SELECT COALESCE(SUM("surfaceProspectee"), 0)::float AS total FROM projects
         WHERE 1=1 ${ownerClause}`,
        { replacements, type: "SELECT" }
      ),

      // successRate = AVG(pourcentageReussite) — no archive filter
      // SQL: SELECT COALESCE(AVG("pourcentageReussite"::float),0)::float AS avg FROM projects WHERE "ownerId" = :ownerId
      sequelize.query(
        `SELECT COALESCE(AVG("pourcentageReussite"::float), 0)::float AS avg FROM projects
         WHERE "pourcentageReussite" IS NOT NULL ${ownerClause}`,
        { replacements, type: "SELECT" }
      ),
    ]);

    const totalProjects     = Number(totalRow?.count   || 0);
    const validatedProjects = Number(validatedRow?.count || 0);
    const archivedProjects  = Number(archivedRow?.count  || 0);
    const activeProjects    = totalProjects - archivedProjects;
    const surfaceTotal      = parseFloat(surfaceRow?.total || 0);
    const successRate       = parseFloat(Number(successRow?.avg || 0).toFixed(2));

    console.log("PROJECTS_FOUND",    totalProjects);
    console.log("ACTIVE_PROJECTS",   activeProjects);
    console.log("ARCHIVED_PROJECTS", archivedProjects);
    console.log("VALIDATIONS_FOUND", validatedProjects);
    console.log("SURFACE_TOTAL",     surfaceTotal);
    console.log("SUCCESS_RATE_AVG",  successRate);

    // ══════════════════════════════════════════════════════════════════════
    // STATUT DISTRIBUTION — GROUP BY statut, no isArchived filter
    // SQL: SELECT COALESCE(NULLIF(statut,''),'Sans statut') AS statut,
    //             COUNT(*)::int AS count,
    //             SUM(CASE WHEN "isArchived"=true THEN 1 ELSE 0 END)::int AS archived
    //      FROM projects WHERE "ownerId" = :ownerId
    //      GROUP BY ... ORDER BY count DESC
    // ══════════════════════════════════════════════════════════════════════
    const statutStats = await sequelize.query(
      `SELECT
         COALESCE(NULLIF(statut, ''), 'Sans statut') AS statut,
         COUNT(*)::int                               AS count,
         SUM(CASE WHEN "isArchived" = true  THEN 1 ELSE 0 END)::int AS archived,
         SUM(CASE WHEN "isArchived" = false THEN 1 ELSE 0 END)::int AS active
       FROM projects
       WHERE 1=1 ${ownerClause}
       GROUP BY COALESCE(NULLIF(statut, ''), 'Sans statut')
       ORDER BY count DESC`,
      { replacements, type: "SELECT" }
    );

    console.log("STATUT_STATS rows =", statutStats.length);

    // ══════════════════════════════════════════════════════════════════════
    // MODEL DISTRIBUTION — no isArchived filter
    // ══════════════════════════════════════════════════════════════════════
    const modelStats = await sequelize.query(
      `SELECT
         "projectModele"::text AS "projectModele",
         COUNT(*)::int         AS count,
         SUM(CASE WHEN "isArchived" = true  THEN 1 ELSE 0 END)::int AS archived,
         SUM(CASE WHEN "isArchived" = false THEN 1 ELSE 0 END)::int AS active
       FROM projects
       WHERE 1=1 ${ownerClause}
       GROUP BY "projectModele"::text
       ORDER BY count DESC`,
      { replacements, type: "SELECT" }
    );

    // ══════════════════════════════════════════════════════════════════════
    // USER STATS — admin only, no isArchived filter
    // ══════════════════════════════════════════════════════════════════════
    let userStats = [];
    if (isAdmin) {
      userStats = await sequelize.query(
        `SELECT
           p."ownerId"       AS "userId",
           u.email           AS "userName",
           up.name           AS "displayName",
           COUNT(p.id)::int  AS count,
           SUM(CASE WHEN p."isArchived" = true THEN 1 ELSE 0 END)::int AS archived
         FROM projects p
         INNER JOIN users u          ON u.id         = p."ownerId"
         LEFT  JOIN user_profiles up ON up."userId"  = u.id
         GROUP BY p."ownerId", u.email, up.name
         ORDER BY count DESC`,
        { type: "SELECT" }
      );
    }

    // ══════════════════════════════════════════════════════════════════════
    // RELANCES — from project_actions, no isArchived filter
    // SQL: SELECT COUNT(*)::int AS count
    //      FROM project_actions pa INNER JOIN projects p ON p.id = pa."projectId"
    //      WHERE pa."dateRelance" IS NOT NULL AND pa."dateRelance" >= :today
    //        AND p."ownerId" = :ownerId
    // ══════════════════════════════════════════════════════════════════════
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const weekEnd = new Date(today);
    weekEnd.setDate(weekEnd.getDate() + 7);

    const relRepl = { ownerId: effectiveOwnerId, today, weekEnd };

    const [
      [relUpcomingRow], [relTodayRow], [relWeekRow], [relLateRow],
    ] = await Promise.all([
      sequelize.query(
        `SELECT COUNT(*)::int AS count
         FROM project_actions pa
         INNER JOIN projects p ON p.id = pa."projectId"
         WHERE pa."dateRelance" IS NOT NULL
           AND pa."dateRelance" >= :today
           ${ownerClauseP}`,
        { replacements: relRepl, type: "SELECT" }
      ),
      sequelize.query(
        `SELECT COUNT(*)::int AS count
         FROM project_actions pa
         INNER JOIN projects p ON p.id = pa."projectId"
         WHERE pa."dateRelance" IS NOT NULL
           AND DATE(pa."dateRelance") = CURRENT_DATE
           ${ownerClauseP}`,
        { replacements: relRepl, type: "SELECT" }
      ),
      sequelize.query(
        `SELECT COUNT(*)::int AS count
         FROM project_actions pa
         INNER JOIN projects p ON p.id = pa."projectId"
         WHERE pa."dateRelance" IS NOT NULL
           AND pa."dateRelance" >= :today
           AND pa."dateRelance" <= :weekEnd
           ${ownerClauseP}`,
        { replacements: relRepl, type: "SELECT" }
      ),
      sequelize.query(
        `SELECT COUNT(*)::int AS count
         FROM project_actions pa
         INNER JOIN projects p ON p.id = pa."projectId"
         WHERE pa."dateRelance" IS NOT NULL
           AND pa."dateRelance" < :today
           ${ownerClauseP}`,
        { replacements: relRepl, type: "SELECT" }
      ),
    ]);

    const relances = {
      upcoming: Number(relUpcomingRow?.count || 0),
      today:    Number(relTodayRow?.count    || 0),
      week:     Number(relWeekRow?.count     || 0),
      late:     Number(relLateRow?.count     || 0),
    };

    console.log("RELANCES_FOUND", relances.upcoming,
      "| today:", relances.today,
      "| week:", relances.week,
      "| late:", relances.late
    );

    const response = {
      totalProjects,
      activeProjects,
      validatedProjects,
      archivedProjects,
      surfaceTotal,
      successRate,
      statutStats,
      modelStats,
      userStats,
      relances,
    };

    console.log("KPI RESPONSE", JSON.stringify({
      totalProjects, activeProjects, validatedProjects, archivedProjects,
      surfaceTotal, successRate,
      statutStatsCount: statutStats.length,
      modelStatsCount:  modelStats.length,
      userStatsCount:   userStats.length,
      relances,
    }, null, 2));

    return res.json(response);

  } catch (e) {
    console.error("KPI_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});
router.get("/kpis/overview", authRequired, async (req, res) => {
  try {
    console.log("ROUTE CALLED");
    console.log(req.originalUrl);

    const { role, sub } = req.user;
    const isAdmin    = ["admin", "superadmin"].includes(role);
    const ownerWhere = isAdmin ? {} : { ownerId: sub };
    const ownerClause = isAdmin ? "" : `AND "ownerId" = :userId`;

    const [
      totalProjects,
      activeProjects,
      archivedProjects,
      validatedProjects,
      totalContacts,
    ] = await Promise.all([
      Project.count({ where: ownerWhere }),
      Project.count({ where: { ...ownerWhere, isArchived: false } }),
      Project.count({ where: { ...ownerWhere, isArchived: true } }),
      Project.count({ where: { ...ownerWhere, isArchived: false, validationStatut: "Validé" } }),
      isAdmin
        ? CommercialContact.count()
        : CommercialContact.count({ where: { createdBy: sub } }),
    ]);

    const nonValidatedProjects = activeProjects - validatedProjects;
    const validationRate = activeProjects > 0
      ? Number(((validatedProjects / activeProjects) * 100).toFixed(2))
      : 0;

    // Projects grouped by validationStatut — filtered by role via ownerId
    const projectsByStatus = await sequelize.query(
      `SELECT COALESCE("validationStatut"::text, 'Non défini') AS "validationStatut",
              COUNT(*)::int AS count
       FROM projects
       WHERE "isArchived" = false ${ownerClause}
       GROUP BY "validationStatut"::text`,
      { replacements: { userId: sub }, type: "SELECT" }
    );

    const contactsByStatus = await CommercialContact.findAll({
      where: isAdmin ? {} : { createdBy: sub },
      attributes: ["statut", [sequelize.fn("COUNT", sequelize.col("id")), "count"]],
      group: ["statut"],
      raw: true,
    });

    const response = {
      totals: {
        projects:          totalProjects,
        activeProjects,
        archivedProjects,
        validatedProjects,
        nonValidatedProjects,
        validationRate,
        commercialContacts: totalContacts,
        global:            totalProjects + totalContacts,
      },
      breakdown: {
        projectsByStatus,
        contactsByStatus,
      },
    };
    console.log("KPI RESPONSE");
    console.log(JSON.stringify(response.totals, null, 2));
    return res.json(response);
  } catch (e) {
    console.error("KPI_ERROR:", e);
    return res.status(500).json({ message: e.message });
  }
});
// ---------------- LIST ----------------
// ✅ LIST projects + users linked (owner + members)
// GET /projects/projectsusers?q=...
router.get("/projectsusers", authRequired, async (req, res) => {
  try {
    const { q } = req.query;
    const where = {};

    if (typeof q === "string" && q.trim()) {
      const s = q.trim();
      // validationStatut is an ENUM — never use ILIKE on it
      where[Op.or] = [
        { nomProjet: { [Op.iLike]: `%${s}%` } },
        { entreprise: { [Op.iLike]: `%${s}%` } },
        { promoteur: { [Op.iLike]: `%${s}%` } },
        { adresse: { [Op.iLike]: `%${s}%` } },
        { typeProjet: { [Op.iLike]: `%${s}%` } },
      ];
    }

    // ✅ safe user attrs (avoid "username doesn't exist")
    const wanted = [
      "id",
      "email",
      "username",
      "firstname",
      "lastname",
      "firstName",
      "lastName",
      "prenom",
      "nom",
      "name",
      "fullName",
    ];
    const safeAttrs = wanted.filter((a) => !!User.rawAttributes?.[a]);
    const userAttrs = safeAttrs.length ? safeAttrs : ["id", "email"];

    const items = await Project.findAll({
      where,
      include: [
        {
          model: UserProject,
          required: false,
          attributes: ["id", "userId", "projectId", "permission", "createdAt"],
          include: [
            {
              model: User,
              attributes: userAttrs,
            },
          ],
        },
      ],
      order: [["createdAt", "DESC"]],
    });

    const displayName = (u) =>
      u?.firstname ||
      u?.firstName ||
      u?.prenom ||
      u?.lastname ||
      u?.lastName ||
      u?.nom ||
      u?.username ||
      u?.name ||
      u?.fullName ||
      u?.email ||
      "Inconnu";

    const out = items.map((p) => {
      const json = p.toJSON();

      // all linked users (members)
      const members =
        (json.UserProjects || [])
          .map((up) => ({
            userId: up.userId,
            permission: up.permission,
            user: up.User
              ? {
                  id: up.User.id,
                  email: up.User.email,
                  displayName: displayName(up.User),
                }
              : null,
          }))
          .filter((x) => x.user) || [];

      // owner = first userProject with permission owner
      const owner = members.find((m) => m.permission === "owner") || null;

      // clean
      delete json.UserProjects;

      return {
        ...json,
        owner: owner ? owner.user : null,
        members: members.map((m) => ({
          permission: m.permission,
          ...m.user,
        })),
      };
    });

    return res.json(out);
  } catch (e) {
    console.error("PROJECTS_USERS_LIST_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});
router.get("/admin/users-projects-count", authRequired, adminOnly, async (req, res) => {
  try {
    // ✅ safe attrs (comme tu as fait)
    const wanted = ["id","email","username","firstname","lastname","firstName","lastName","prenom","nom","name","fullName"];
    const safeAttrs = wanted.filter((a) => !!User.rawAttributes?.[a]);
    const userAttrs = safeAttrs.length ? safeAttrs : ["id", "email"];

    const rows = await UserProject.findAll({
      attributes: [
        "userId",
        [fn("COUNT", col("projectId")), "projectsCount"],
      ],
      include: [
        {
          model: User,
          attributes: userAttrs,
          required: true,
        },
      ],
      group: ["userId", ...userAttrs.map((a) => col(`User.${a}`))], // Sequelize OK
      order: [[literal('"projectsCount"'), "DESC"]],
      raw: false,
    });

    const displayName = (u) =>
      u?.firstname ||
      u?.firstName ||
      u?.prenom ||
      u?.lastname ||
      u?.lastName ||
      u?.nom ||
      u?.username ||
      u?.name ||
      u?.fullName ||
      u?.email ||
      "Inconnu";

    const out = rows.map((r) => ({
      userId: r.userId,
      projectsCount: Number(r.get("projectsCount") || 0),
      email: r.User?.email || "",
      displayName: displayName(r.User),
    }));

    return res.json(out);
  } catch (e) {
    console.error("PROJECT FILTER ERROR", e);
    return res.status(500).json({ success: false, message: e.message || "Server error" });
  }
});
router.get("/admin/user/:userId/projects", authRequired, adminOnly, async (req, res) => {
  try {
    // ✅ UUID/string (NE PAS Number)
    const userId = (req.params.userId || "").toString().trim();
    if (!userId) return res.status(400).json({ message: "Invalid userId" });

    const { q } = req.query;
    const where = {};

    if (typeof q === "string" && q.trim()) {
      const s = q.trim();
      // validationStatut is an ENUM — never use ILIKE on it
      where[Op.or] = [
        { nomProjet: { [Op.iLike]: `%${s}%` } },
        { entreprise: { [Op.iLike]: `%${s}%` } },
        { promoteur: { [Op.iLike]: `%${s}%` } },
        { adresse: { [Op.iLike]: `%${s}%` } },
        { typeProjet: { [Op.iLike]: `%${s}%` } },
      ];
    }

    // ✅ safe user attrs
    const wanted = ["id","email","username","firstname","lastname","firstName","lastName","prenom","nom","name","fullName"];
    const safeAttrs = wanted.filter((a) => !!User.rawAttributes?.[a]);
    const userAttrs = safeAttrs.length ? safeAttrs : ["id", "email"];

    const items = await Project.findAll({
      where,
      include: [
        {
          model: UserProject,
          required: true,
          where: { userId }, // ✅ string UUID OK
          attributes: ["id", "userId", "projectId", "permission", "createdAt"],
          include: [{ model: User, attributes: userAttrs }],
        },
      ],
      order: [["createdAt", "DESC"]],
    });

    const displayName = (u) =>
      u?.firstname ||
      u?.firstName ||
      u?.prenom ||
      u?.lastname ||
      u?.lastName ||
      u?.nom ||
      u?.username ||
      u?.name ||
      u?.fullName ||
      u?.email ||
      "Inconnu";

    const out = items.map((p) => {
      const json = p.toJSON();

      const members =
        (json.UserProjects || [])
          .map((up) => ({
            userId: up.userId,
            permission: up.permission,
            user: up.User
              ? { id: up.User.id, email: up.User.email, displayName: displayName(up.User) }
              : null,
          }))
          .filter((x) => x.user) || [];

      const owner = members.find((m) => m.permission === "owner") || null;
      delete json.UserProjects;

      return {
        ...json,
        owner: owner ? owner.user : null,
        members: members.map((m) => ({ permission: m.permission, ...m.user })),
      };
    });

    return res.json(out);
  } catch (e) {
    console.error("PROJECT FILTER ERROR", e);
    return res.status(500).json({ success: false, message: e.message || "Server error" });
  }
});
/* ============================================================
   ✅ CRUD ROUTES
   ============================================================ */

// ---------------- CREATE ----------------
router.post("/", authRequired, async (req, res) => {
  try {
    const body = normalizePayload(req.body);

    const errors = validatePayload(body, false);
    if (errors.length) {
      return res.status(400).json({ message: "Validation error", errors });
    }

    const isRevendeur = body.projectModele === "revendeur";
    const isApplicateur = body.projectModele === "applicateur";

    // =========================
    // 📍 GEO (UNIQUEMENT PROJECT)
    // =========================
    const lat =
      body?.location?.lat ??
      body?.location?.latitude ??
      body?.lat ??
      body?.latitude;

    const lng =
      body?.location?.lng ??
      body?.location?.lon ??
      body?.location?.longitude ??
      body?.lng ??
      body?.longitude;

    if (!isRevendeur && !isApplicateur && (lat == null || lng == null)) {
      return res.status(400).json({
        message: "Validation error",
        errors: ["latitude/longitude est obligatoire"],
      });
    }

    // =========================
    // 🧼 CLEAN
    // =========================
    const clean = (val) =>
      val !== undefined && val !== null && String(val).trim() !== ""
        ? String(val).trim()
        : null;

    let nomProjet = clean(body.nomProjet);

    // 🔥 REVendeur → nom = comptoir
    if (isRevendeur) {
      nomProjet =
        clean(body.comptoir) ||
        clean(body.ingenieurResponsable) ||
        nomProjet;
    }

    if (!nomProjet) {
      return res.status(400).json({
        message: "Validation error",
        errors: ["nomProjet est obligatoire"],
      });
    }

    // =========================
    // 🔁 DUPLICATE CHECK
    // =========================
    let exists = null;

    if (!isRevendeur) {
      const normalizedName = nomProjet.toLowerCase().trim();

      exists = await UserProject.findOne({
        where: { userId: req.user.sub },
        include: [
          {
            model: Project,
            required: true,
            where: sequelize.where(
              sequelize.fn("lower", sequelize.col("Project.nomProjet")),
              normalizedName
            ),
          },
        ],
      });
    }

    if (exists) {
      return res.status(409).json({
        message: "Project name already exists",
        errors: ["Un projet avec ce nom existe déjà."],
      });
    }

    // =========================
    // 📅 DEADLINE CRM
    // =========================
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + 7);
    const companySelection = !isRevendeur
      ? await resolveCompanyForProject(body)
      : { companyId: null, entreprise: null };
    const engineerSelection = !isRevendeur && !isApplicateur
      ? await resolveEngineerForProject(body)
      : {
          engineerId: null,
          ingenieurResponsable: null,
          telephoneIngenieur: null,
          emailIngenieur: null,
        };
    const architectSelection = !isRevendeur
      ? await resolveArchitectForProject(body)
      : {
          architectId: null,
          architecte: null,
          telephoneArchitecte: null,
          emailArchitecte: null,
        };

    // =========================
    // 🚀 CREATE
    // =========================
    console.log("BODY =", req.body);
    console.log("DATE DEMARRAGE =", body.dateDemarrage || body.startDate);
    const p = await Project.create({
      nomProjet,
      ownerId: req.user.sub,
      projectModele: body.projectModele || "project",

      // =========================
      // 🟠 REVENDEUR
      // =========================
      comptoir: isRevendeur ? clean(body.comptoir) : null,
      telephoneComptoir: isRevendeur ? clean(body.telephoneComptoir) : null,
      telephoneComptoir2: isRevendeur ? clean(body.telephoneComptoir2) : null,
      registreCommerce: isRevendeur ? clean(body.registreCommerce) : null,
      fonction: isRevendeur ? clean(body.fonction) : null,

      revendeurNom: isRevendeur ? clean(body.revendeurNom) : null,
      revendeurPrenom: isRevendeur ? clean(body.revendeurPrenom) : null,
      revendeurEmail: isRevendeur ? clean(body.revendeurEmail) : null,
      revendeurStatut: isRevendeur
        ? body.revendeurStatut || "prospect"
        : null,

      adresseRevendeur: isRevendeur ? clean(body.adresseRevendeur) : null,

      // =========================
      // 🔵 APPLICATEUR
      // =========================
      dallagiste: isApplicateur ? clean(body.dallagiste) : null,
      telephoneDallagiste: isApplicateur
        ? clean(body.telephoneDallagiste)
        : null,
      emailDallagiste: isApplicateur ? clean(body.emailDallagiste) : null,
      serviceTechnique: isApplicateur
        ? clean(body.serviceTechnique)
        : null,

      matriculeFiscale: isApplicateur
        ? clean(body.matriculeFiscale)
        : null,

      registreCommerce: isApplicateur
        ? clean(body.registreCommerce)
        : null,

      adresse: isApplicateur ? clean(body.adresse) : null,

      // =========================
      // ⚪ PROJECT NORMAL
      // =========================
      dateDemarrage: body.dateDemarrage || body.startDate || null,

      statut: !isRevendeur && !isApplicateur
        ? body.statut || "Identification"
        : null,

      typeAdresseChantier: !isRevendeur && !isApplicateur
        ? clean(body.typeAdresseChantier)
        : null,

      ingenieurResponsable: !isRevendeur && !isApplicateur
        ? engineerSelection.ingenieurResponsable
        : null,

      engineerId: engineerSelection.engineerId,

      telephoneIngenieur: !isRevendeur && !isApplicateur
        ? clean(engineerSelection.telephoneIngenieur)
        : null,

      emailIngenieur: !isRevendeur
        ? clean(engineerSelection.emailIngenieur)
        : null,

      architecte: !isRevendeur ? architectSelection.architecte : null,
      architectId: architectSelection.architectId,
      telephoneArchitecte: !isRevendeur
        ? clean(architectSelection.telephoneArchitecte)
        : null,
      emailArchitecte: !isRevendeur
        ? clean(architectSelection.emailArchitecte)
        : null,

      companyId: companySelection.companyId,
      entreprise: companySelection.entreprise,
      promoteur: !isRevendeur ? clean(body.promoteur) : null,
      bureauEtude: !isRevendeur ? clean(body.bureauEtude) : null,
      bureauControle: !isRevendeur ? clean(body.bureauControle) : null,

      latitude: !isRevendeur && !isApplicateur ? lat : null,
      longitude: !isRevendeur && !isApplicateur ? lng : null,
      // 🔥 AJOUT
user_nom: body.user_nom || null,
user_nom_custom: body.user_nom_custom || null,
      // =========================
      // 💰 NOUVEAU
      // =========================
      montantMarche:
        (isRevendeur || isApplicateur)
          ? body.montantMarche ?? null
          : null,

      // =========================
      // AUTRES
      // =========================
      pourcentageReussite: !isRevendeur
        ? body.pourcentageReussite
        : null,

      validationStatut: body.validationStatut ?? "Non validé",

      pipelineStage: body.pipelineStage ?? "Prospect",
      localisationCommentaire: LocationService.generateLocalizationComment(
        !isRevendeur && !isApplicateur ? lat : null,
        !isRevendeur && !isApplicateur ? lng : null,
        clean(body.localisationCommentaire)
      ),

      dateLimiteIngenieur: deadline,
      isArchived: false,
    });

    // =========================
    // 🧠 ACTION CRM
    // =========================
    if (body.firstAction) {
     await ProjectAction.create({
  projectId: p.id,

  typeAction_legacy:
    body.firstAction || "Visite",

  commentaire:
    clean(body.commentaireAction),

  createdBy:
    req.user.sub,

  dateAction:
    body.dateVisite ?? new Date(),

  statut: "A faire",
});
    }

    // =========================
    // 🔗 LINK USER
    // =========================
    await UserProject.findOrCreate({
      where: {
        userId: req.user.sub,
        projectId: p.id,
      },
      defaults: { permission: "owner" },
    });

    // Reload with owner + profile so Flutter gets the full owner shape immediately
    const created = await Project.findByPk(p.id, {
      include: [
        {
          model: User,
          as: "owner",
          attributes: ["id", "email"],
          include: [
            { model: UserProfile, as: "profile", attributes: ["name", "avatarUrl"], required: false },
          ],
          required: false,
        },
      ],
    });

    const createdJson = created.toJSON();
    const ownerProfile = createdJson.owner?.profile || {};

    return res.status(201).json({
      ...createdJson,
      permission: "owner",
      title: createdJson.nomProjet || createdJson.comptoir || null,
      owner: createdJson.owner ? {
        id: createdJson.owner.id,
        email: createdJson.owner.email,
        fullName: ownerProfile.name || createdJson.owner.email || null,
        avatarUrl: ownerProfile.avatarUrl || null,
      } : null,
    });

  } catch (e) {
    console.error("PROJECT_CREATE_ERROR:", e);

    return res.status(e.status || 500).json({
      message: e.message || "Server error",
    });
  }
});

// ---------------- LIST ----------------
router.get("/", authRequired, async (req, res) => {
  try {
    console.log("SELECTED USER");
    console.log(req.query.userId);

    const { q } = req.query;

    // ── Pagination ────────────────────────────────────────
    const page  = Math.max(parseInt(req.query.page)  || 1,  1);
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const offset = (page - 1) * limit;

    // ── Base where clause ─────────────────────────────────
    const whereClause = {};

    // User filter — applied BEFORE count, pagination, stats, and export
    if (req.query.userId) {
      whereClause.ownerId = req.query.userId;
    }

    if (typeof q === "string" && q.trim()) {
      const s = q.trim();
      whereClause[Op.or] = [
        { nomProjet: { [Op.iLike]: `%${s}%` } },
        { entreprise: { [Op.iLike]: `%${s}%` } },
        { promoteur: { [Op.iLike]: `%${s}%` } },
        { adresse: { [Op.iLike]: `%${s}%` } },
        { typeProjet: { [Op.iLike]: `%${s}%` } },
      ];
    }

    // projectModele filter
    if (req.query.projectModele?.trim()) {
      whereClause.projectModele = req.query.projectModele.trim();
    }

    // Archive filter — if not supplied return ALL projects (archived + non-archived)
    if (req.query.isArchived === "true") {
      whereClause.isArchived = true;
    } else if (req.query.isArchived === "false") {
      whereClause.isArchived = false;
    }

    // ── Stats (computed from same user filter, ignoring isArchived page param) ──
    const statsBase = { ...whereClause };
    delete statsBase.isArchived; // stats always span all archive states

    const [totalProjects, activeProjects, archivedProjects] = await Promise.all([
      Project.count({ where: statsBase }),
      Project.count({ where: { ...statsBase, isArchived: false } }),
      Project.count({ where: { ...statsBase, isArchived: true } }),
    ]);

    const pendingProjects = await Project.count({
      where: {
        ...statsBase,
        isArchived: false,
        statut: { [Op.notIn]: ["Gagné", "Perdu"] },
      },
    });

    console.log("PROJECT COUNT AFTER FILTER");
    console.log("total:", totalProjects, "| active:", activeProjects, "| archived:", archivedProjects, "| pending:", pendingProjects);

    // ── safe attrs for user includes ──────────────────────
    const wanted = ["id", "email", "username", "firstname", "lastname", "firstName", "lastName", "prenom", "nom", "name", "fullName"];
    const safeAttrs = wanted.filter((a) => !!User.rawAttributes?.[a]);
    const userAttrs = safeAttrs.length ? safeAttrs : ["id", "email"];

    // ── Paginated query ───────────────────────────────────
    const { count, rows } = await Project.findAndCountAll({
      where: whereClause,
      include: [
        {
          model: UserProject,
          required: false,
          attributes: ["permission", "userId", "createdAt"],
          include: [{ model: User, attributes: userAttrs }],
        },
        {
          model: User,
          as: "owner",
          required: false,
          attributes: ["id", "email"],
          include: [{
            model: UserProfile,
            as: "profile",
            attributes: ["name", "avatarUrl"],
            required: false,
          }],
        },
      ],
      order: [["createdAt", "DESC"]],
      limit,
      offset,
      distinct: true,
      attributes: {
        include: [
          [sequelize.literal(`(SELECT COUNT(*) FROM project_comments pc WHERE pc."projectId" = "Project"."id")`), "commentCount"],
          [sequelize.literal(`(SELECT COUNT(*) FROM tasks t WHERE t."projectId" = "Project"."id")`), "taskCount"],
          [sequelize.literal(`(SELECT COUNT(*) FROM project_devis d WHERE d."projectId" = "Project"."id")`), "devisCount"],
          [sequelize.literal(`(SELECT COUNT(*) FROM project_bon_de_commande bc WHERE bc."projectId" = "Project"."id")`), "bonCommandeCount"],
        ],
      },
    });

    const displayName = (u) =>
      u?.username || u?.firstname || u?.firstName || u?.prenom ||
      u?.lastname || u?.lastName || u?.nom || u?.name ||
      u?.fullName || u?.email || "Inconnu";

    const out = rows.map((p) => {
      const json = p.toJSON();

      const meLink = (json.UserProjects || []).find((up) => up.userId === req.user.sub);
      const perm = ["admin", "superadmin"].includes(req.user.role) ? "owner" : meLink?.permission || "viewer";
      const ownerLink = (json.UserProjects || []).find((up) => up.permission === "owner");

      const ownerName = ownerLink?.User
        ? displayName(ownerLink.User)
        : (json.user_nom_custom || json.user_nom || "Inconnu");

      const ownerRaw = json.owner;
      const ownerProfile = ownerRaw?.profile || {};
      const fullName =
        (ownerProfile.name || "").trim() ||
        ownerRaw?.email ||
        json.user_nom_custom ||
        json.user_nom ||
        null;

      const owner = ownerRaw
        ? { id: ownerRaw.id, email: ownerRaw.email, fullName, name: fullName, avatar: ownerProfile.avatarUrl || null }
        : (json.user_nom_custom || json.user_nom
            ? { id: null, email: null, fullName: json.user_nom_custom || json.user_nom, name: json.user_nom_custom || json.user_nom, avatar: null }
            : null);

      delete json.UserProjects;
      delete json.owner;

      return {
        ...json,
        title: json.nomProjet || json.comptoir || null,
        owner,
        ownerName: fullName || ownerName,
        permission: perm,
        isEditable: ADMIN_ROLES.includes(req.user.role) || json.ownerId === req.user.sub,
        isArchived: json.isArchived || false,
        devisCount: Number(json.devisCount || 0),
        bonCommandeCount: Number(json.bonCommandeCount || 0),
        taskCount: Number(json.taskCount || 0),
      };
    });

    return res.json({
      items: out,
      total: count,
      page,
      totalPages: Math.ceil(count / limit),
      limit,
      stats: {
        totalProjects,
        activeProjects,
        archivedProjects,
        pendingProjects,
      },
    });
  } catch (e) {
    console.error("PROJECT FILTER ERROR", e);
    return res.status(500).json({ success: false, message: e.message || "Server error" });
  }
});

// =======================================================
// DASHBOARD COMMERCIAL
// =======================================================

router.get("/dashboard/commercial", authRequired, async (req,res)=>{

  try{

    const users = await User.findAll({

      attributes:["id","email"],

      include:[
        {
          model:Project,
          attributes:[
            "id",
            "nomProjet",
            "pipelineStage",
            "surfaceProspectee",
            "entreprise"
          ],
          through:{attributes:[]}
        }
      ]

    });

    const result = users.map(user=>{

      const projects = user.Projects;

      const totalProjects = projects.length;

      const totalSurface =
        projects.reduce((sum,p)=>sum+(Number(p.surfaceProspectee)||0),0);

      const won =
        projects.filter(p=>p.pipelineStage==="Gagné").length;

      const lost =
        projects.filter(p=>p.pipelineStage==="Perdu").length;

      return {

        id:user.id,
        name:user.name,
        email:user.email,

        totalProjects,
        totalSurface,
        won,
        lost,

        projects

      };

    });

    res.json(result);

  }
  catch(err){

    console.error(err);

    res.status(500).json({message:"Server error"});

  }

});


// =======================================================
// PROJETS PAR USER
// =======================================================

router.get("/:id/projects", authRequired, async (req,res)=>{

  try{

    const user = await User.findByPk(req.params.id,{

      attributes:["id","email"],

      include:[
        {
          model:Project,
          attributes:[
            "id",
            "nomProjet",
            "entreprise",
            "pipelineStage"
          ],
          through:{attributes:[]}
        }
      ]

    });

    res.json({

      user,
      totalProjects:user.Projects.length,
      projects:user.Projects

    });

  }
  catch(err){

    console.error(err);

    res.status(500).json({message:"Server error"});

  }

});
router.get("/my-projects", authRequired, async (req, res) => {
  try {
    const {
      architecte,
      promoteur,
      ingenieur,
      societe,
      entreprise,
      createdBy,
      projectModele,
      isArchived,
      page = 1,
      limit = 1000,
      q,
    } = req.query;

   const currentPage = Math.max(parseInt(page, 1000) || 1, 1);
const currentLimit = Math.max(parseInt(limit, 1000) || 1000, 1);
    const offset = (currentPage - 1) * currentLimit;

    const role = (req.user?.role || "").toLowerCase();

    const where = {};

    /// 🔍 GLOBAL SEARCH
    if (q?.trim()) {
      where[Op.or] = [
        { nomProjet: { [Op.iLike]: `%${q}%` } },
        { architecte: { [Op.iLike]: `%${q}%` } },
        { promoteur: { [Op.iLike]: `%${q}%` } },
        { ingenieurResponsable: { [Op.iLike]: `%${q}%` } },
        { entreprise: { [Op.iLike]: `%${q}%` } },
        { bureauControle: { [Op.iLike]: `%${q}%` } },
        { adresse: { [Op.iLike]: `%${q}%` } },
      ];
    }

    /// 🔍 FILTERS
    if (architecte?.trim()) {
      where.architecte = { [Op.iLike]: `%${architecte}%` };
    }

    if (promoteur?.trim()) {
      where.promoteur = { [Op.iLike]: `%${promoteur}%` };
    }

    if (ingenieur?.trim()) {
      where.ingenieurResponsable = {
        [Op.iLike]: `%${ingenieur}%`,
      };
    }

    const societeValue = societe?.trim() || entreprise?.trim() || null;

    if (societeValue) {
      where.entreprise = { [Op.iLike]: `%${societeValue}%` };
    }

   if (projectModele?.trim()) {
  where.projectModele = projectModele.trim();
} else {
  where.projectModele = "project"; // 🔥 DEFAULT
}

    // Archive filter — optional; no filter = return ALL (archived + non-archived)
    if (isArchived === "true") {
      where.isArchived = true;
    } else if (isArchived === "false") {
      where.isArchived = false;
    }

    /// =========================
    /// 🔥 INCLUDE COMMUN
    /// =========================
    const includeBase = [
      {
        model: UserProject,
        required: role !== "admin" && role !== "superadmin",
        where:
          role === "admin" || role === "superadmin"
            ? undefined
            : { userId: req.user.sub },
        attributes: ["userId", "permission"],
        include: [
          {
            model: User,
            attributes: ["id", "email", "role"],
          },
        ],
      },
    ];

    /// 🔥 ADMIN FILTER BY USER
    if ((role === "admin" || role === "superadmin") && createdBy) {
      includeBase[0].required = true;
      includeBase[0].where = { userId: createdBy };
    }

    const { count, rows } = await Project.findAndCountAll({
      where,
      order: [["createdAt", "DESC"]],
      limit: currentLimit,
      offset,
      include: includeBase,
      distinct: true,
    });

    /// =========================
    /// 🔥 FORMAT RESULT
    /// =========================
    const formatted = rows.map((p) => {
      const json = p.toJSON();

      return {
        ...json,

        /// ✅ CREATED BY (IMPORTANT)
        createdByName:
          json.UserProjects?.[0]?.User?.email || "-",

        createdById:
          json.UserProjects?.[0]?.User?.id || null,

        isEditable: ADMIN_ROLES.includes(req.user.role) || json.ownerId === req.user.sub,
        isArchived: json.isArchived || false,
      };
    });

    return res.json({
      total: count,
      page: currentPage,
      limit: currentLimit,
      totalPages: Math.ceil(count / currentLimit),
      filters: {
        architecte: architecte || null,
        promoteur: promoteur || null,
        ingenieur: ingenieur || null,
        societe: societeValue || null,
        projectModele: projectModele || null,
        createdBy: createdBy || null,
        q: q || null,
      },
      items: formatted,
    });

  } catch (e) {
    console.error("MY_PROJECTS_FILTER_ERROR:", e);
    return res.status(500).json({
      message: e.message || "Server error",
    });
  }
});
router.get("/myprojects", authRequired, async (req, res) => {
  try {

    const {
      architecte,
      promoteur,
      ingenieur,
      societe,
      entreprise,
      createdBy,
      page = 1,
      limit = 1000, // 🔥 IMPORTANT → 100 pour pipeline
      q,
    } = req.query;

    const currentPage = Math.max(parseInt(page, 1000) || 1, 1);
    const currentLimit = Math.max(parseInt(limit, 1000) || 1000, 1);
    const offset = (currentPage - 1) * currentLimit;

    const role = (req.user?.role || "").toLowerCase();

    const where = {};

    /// 🔍 SEARCH GLOBAL
    if (q?.trim()) {
      where[Op.or] = [
        { nomProjet: { [Op.iLike]: `%${q}%` } },
        { architecte: { [Op.iLike]: `%${q}%` } },
        { promoteur: { [Op.iLike]: `%${q}%` } },
        { ingenieurResponsable: { [Op.iLike]: `%${q}%` } },
        { entreprise: { [Op.iLike]: `%${q}%` } },
        { bureauControle: { [Op.iLike]: `%${q}%` } },
        { adresse: { [Op.iLike]: `%${q}%` } },
      ];
    }

    /// 🔍 FILTERS
    if (architecte?.trim()) {
      where.architecte = { [Op.iLike]: `%${architecte}%` };
    }

    if (promoteur?.trim()) {
      where.promoteur = { [Op.iLike]: `%${promoteur}%` };
    }

    if (ingenieur?.trim()) {
      where.ingenieurResponsable = {
        [Op.iLike]: `%${ingenieur}%`,
      };
    }

    const societeValue =
      societe?.trim() || entreprise?.trim() || null;

    if (societeValue) {
      where.entreprise = { [Op.iLike]: `%${societeValue}%` };
    }

    /// =========================
    /// 🔥 INCLUDE COMMUN
    /// =========================
    const includeBase = [

      {
        model: UserProject,
        required: role !== "admin" && role !== "superadmin",
        where:
          role === "admin" || role === "superadmin"
            ? undefined
            : { userId: req.user.sub },
        attributes: ["userId", "permission"],
        include: [
          {
            model: User,
            attributes: ["id", "email", "role"],
          },
        ],
      },

      /// 🔥 IMPORTANT → LAST ACTION
      {
        model: ProjectAction,
        as: "actions",
        required: false,
        separate: true,
        limit: 1,
        order: [["dateAction", "DESC"]],
      },
    ];

    /// 🔥 ADMIN FILTER
    if ((role === "admin" || role === "superadmin") && createdBy) {
      includeBase[0].required = true;
      includeBase[0].where = { userId: createdBy };
    }

    const { count, rows } = await Project.findAndCountAll({
      where,
      order: [["createdAt", "DESC"]],
      limit: currentLimit,
      offset,
      include: includeBase,
      distinct: true,
    });

    /// =========================
    /// 🔥 TRANSFORM LAST ACTION
    /// =========================
    const formatted = rows.map((p) => {

      const json = p.toJSON();

      return {
        ...json,

        /// 🔥 IMPORTANT POUR FLUTTER
        lastAction: json.actions?.[0] || null,
        lastActionId: json.actions?.[0]?.id || null,
      };
    });

    return res.json({
      total: count,
      page: currentPage,
      limit: currentLimit,
      totalPages: Math.ceil(count / currentLimit),
      items: formatted,
    });

  } catch (e) {

    console.error("MY_PROJECTS_ERROR:", e);

    return res.status(500).json({
      message: e.message || "Server error",
    });
  }
});
// ===============================
// GET PROJECT CRM ACTIONS
// ===============================

router.get("/:id/actions", authRequired, async (req, res) => {

  try {

    const actions = await ProjectAction.findAll({

      where: { projectId: req.params.id },

      include: [
        {
          model: ProjectReminder,
          as: "reminders"
        }
      ],

      order: [["dateAction", "DESC"]]

    });

    res.json(actions);

  } catch (err) {

    console.error("PROJECT_ACTIONS_ERROR:", err);

    res.status(500).json({
      message: "Server error",
    });

  }

});
// ===============================
// ADD CRM ACTION
// ===============================
// actionUpload stores to uploads/actions/ (served by express.static).
// Multer must run before the handler so req.body is populated from
// multipart/form-data. handleUploadError converts Multer rejections to 400.
router.post(
  "/:id/actions",
  authRequired,
  actionUpload.single("file"),
  handleUploadError,
  async (req, res) => {
    console.log("📥 CREATE ACTION REQUEST");
    console.log("BODY =", req.body);
    console.log("FILE =", req.file);

    try {
      const body = req.body || {};
      const projectId = req.params.id;

      // Resolve action type from all accepted field names
      const actionType =
        (body.typeAction        || "").trim() ||
        (body.typeAction_legacy || "").trim() ||
        (body.firstAction       || "").trim();

      if (!actionType) {
        return res.status(400).json({
          success: false,
          message: "Action type is required (typeAction, typeAction_legacy, or firstAction)",
        });
      }

      const commentaire = body.commentaire || null;
      const dateAction  = body.dateAction ? new Date(body.dateAction) : new Date();
      const dateRelance = body.dateRelance ? new Date(body.dateRelance) : null;
      const statut      = body.statut || "A faire";

      // ── Duplicate detection ─────────────────────────────────────────────
      const dayStart = new Date(dateAction); dayStart.setHours(0, 0, 0, 0);
      const dayEnd   = new Date(dateAction); dayEnd.setHours(23, 59, 59, 999);
      const { Op } = require("sequelize");
      const commentaireWhere = commentaire
        ? { commentaire }
        : { [Op.or]: [{ commentaire: null }, { commentaire: "" }] };

      const existing = await ProjectAction.findOne({
        where: {
          projectId,
          typeAction_legacy: actionType,
          ...commentaireWhere,
          dateAction: { [Op.between]: [dayStart, dayEnd] },
        },
      });

      if (existing) {
        console.log("DUPLICATE ACTION BLOCKED:", existing.id);
        return res.status(409).json({
          success: false,
          message: "This action already exists for this project on this date",
        });
      }

      const fileUrl = req.file ? `/uploads/actions/${req.file.filename}` : null;

      // ── Create action ───────────────────────────────────────────────────
      const action = await ProjectAction.create({
        projectId,
        typeAction_legacy: actionType,  // correct column name post-migration-005
        commentaire,
        dateAction,
        dateRelance,
        statut,
        fileUrl,
        createdBy: req.user.sub,
      });

      console.log("✅ ACTION CREATED:", action.id);

      // ── Update pipeline stage ───────────────────────────────────────────
      const newStage = getStageFromAction(actionType);
      await Project.update(
        { pipelineStage: newStage },
        { where: { id: projectId } }
      );
      console.log("📊 PIPELINE UPDATED:", newStage);

      // ── Create reminder ─────────────────────────────────────────────────
      if (dateRelance) {
        const reminder = await ProjectReminder.create({
          projectId,
          actionId:   action.id,
          message:    commentaire || `Relance - ${actionType}`,
          dateRelance,
          createdBy:  req.user.sub,
        });
        console.log("⏰ REMINDER CREATED:", reminder.id);
      }

      // ── Return full action ──────────────────────────────────────────────
      const result = await ProjectAction.findByPk(action.id, {
        include: [{ model: ProjectReminder, as: "reminders" }],
      });

      return res.status(201).json({ success: true, data: result });

    } catch (err) {
      console.error("❌ CREATE ACTION ERROR:", err);

      // Surface DB unique-constraint violations as 409 instead of 500
      if (err.name === "SequelizeUniqueConstraintError") {
        return res.status(409).json({
          success: false,
          message: "This action already exists for this project on this date",
        });
      }

      return res.status(500).json({ success: false, message: err.message || "Server error" });
    }
  }
);
router.delete("/actions/:actionId", authRequired, async (req, res) => {

  try {

    const action = await ProjectAction.findByPk(req.params.actionId);

    if (!action) {
      return res.status(404).json({ message: "Action not found" });
    }

    // supprimer les reminders liés
    await ProjectReminder.destroy({
      where: { actionId: req.params.actionId }
    });

    await action.destroy();

    res.json({
      message: "Action deleted successfully"
    });

  } catch (err) {

    console.error(err);
    res.status(500).json({ message: "Server error" });

  }

});
// ===============================
// ADD REMINDER
// ===============================
router.post("/actions/:actionId/reminders", authRequired, async (req, res) => {

  try {

    const action = await ProjectAction.findByPk(req.params.actionId);

    if (!action) {
      return res.status(404).json({
        message: "Action not found"
      });
    }

    const reminder = await ProjectReminder.create({

      projectId: action.projectId,
      actionId: req.params.actionId,
      message: req.body.message ?? "",
      dateRelance: req.body.dateRelance,
      createdBy: req.user.sub

    });

    res.json(reminder);

  } catch (err) {

    console.error(err);

    res.status(500).json({
      message: "Server error"
    });

  }

});
// ===============================
// DELETE REMINDER
// ===============================
router.delete("/reminders/:id", authRequired, async (req, res) => {

  try {

    const reminder = await ProjectReminder.findByPk(req.params.id);

    if (!reminder) {
      return res.status(404).json({
        message: "Reminder not found"
      });
    }

    await reminder.destroy();

    res.json({
      message: "Reminder deleted"
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      message: "Server error"
    });

  }

});
// ===============================
// UPDATE ACTION (PIPELINE DRAG)
// ===============================
// Multer must run before the handler so req.body is populated from
// multipart/form-data. handleUploadError converts Multer rejections to 400.
router.put(
  "/actions/:actionId",
  authRequired,
  actionUpload.single("file"),
  handleUploadError,
  async (req, res) => {
    console.log("BODY =", req.body);
    console.log("FILE =", req.file);
    console.log("HEADERS content-type =", req.headers["content-type"]);

    try {
      const action = await ProjectAction.findByPk(req.params.actionId);

      if (!action) {
        return res.status(404).json({ success: false, message: "Action not found" });
      }

      // Safe field access — never destructure req.body directly when it may be
      // undefined (multipart requests require Multer to parse first).
      const body = req.body || {};

      const typeAction =
        (body.typeAction || "").trim() ||
        (body.typeAction_legacy || "").trim() ||
        null;

      const commentaire = body.commentaire !== undefined ? body.commentaire : action.commentaire;
      const statut      = body.statut      || action.statut;
      const dateAction  = body.dateAction  ? new Date(body.dateAction)  : action.dateAction;
      const dateRelance = body.dateRelance  ? new Date(body.dateRelance) : action.dateRelance;

      // Keep the existing attachment unless a new file is uploaded.
      const fileUrl = req.file
        ? `/uploads/actions/${req.file.filename}`
        : action.fileUrl;

      await action.update({
        typeAction_legacy: typeAction || action.typeAction_legacy,
        commentaire,
        statut,
        dateAction,
        dateRelance,
        fileUrl,
      });

      return res.json({ success: true, data: action });

    } catch (err) {
      console.error("UPDATE ACTION ERROR:", err);
      return res.status(500).json({
        success: false,
        message: err.message || "Server error",
      });
    }
  }
);
// ---------------- GET BY ID ----------------
// ---------------- GET BY ID ----------------
router.get("/:id", authRequired, async (req, res) => {
  try {
    if (!isUUID(req.params.id)) {
      return res.status(400).json({ message: "Invalid project id (UUID required)" });
    }

    const item = await Project.findByPk(req.params.id, {
      include: [
        {
          model: UserProject,
          required: false,
          attributes: ["permission", "userId", "createdAt"],
          include: [
            {
              model: User,
              attributes: [
                "id",
                "email",
                ...(User.rawAttributes?.username ? ["username"] : []),
              ],
            },
          ],
        },
      ],
      attributes: {
        include: [
          [
            sequelize.literal(`(
              SELECT COUNT(*) FROM project_comments pc 
              WHERE pc."projectId" = "Project"."id"
            )`),
            "commentCount",
          ],
          [
            sequelize.literal(`(
              SELECT COUNT(*) FROM project_devis d 
              WHERE d."projectId" = "Project"."id"
            )`),
            "devisCount",
          ],
          [
            sequelize.literal(`(
              SELECT COUNT(*) FROM project_bon_de_commande bc 
              WHERE bc."projectId" = "Project"."id"
            )`),
            "bonCommandeCount",
          ],
        ],
      },
    });

    if (!item) {
      return res.status(404).json({ message: "Not found" });
    }

    const userRole = (req.user?.role || "").toLowerCase();

    // 🔥 BLOQUER SI ARCHIVÉ
    if (item.isArchived && !["admin", "superadmin"].includes(userRole)) {
      return res.status(403).json({
        message: "Projet archivé non accessible",
      });
    }

    const json = item.toJSON();

    // =========================
    // 🔥 LOGIQUE MODE
    // =========================
    const mode = json.projectModele || "project";

    const isRevendeur = mode === "revendeur";
    const isApplicateur = mode === "applicateur";
    const isChantier = !isRevendeur && !isApplicateur;

    

    if (!isRevendeur) {
      json.comptoir = null;
      json.telephoneComptoir = null;
      json.telephoneComptoir2 = null;
      json.revendeurNom = null;
      json.revendeurPrenom = null;
      json.revendeurEmail = null;
      json.revendeurStatut = null;
      json.adresseRevendeur = null;
    }

    if (!isApplicateur) {
      json.dallagiste = null;
      json.telephoneDallagiste = null;
      json.emailDallagiste = null;
      json.serviceTechnique = null;
    }
    // =========================
// 📍 LOCATION (ONLY PROJECT)
// =========================
if (!isChantier) {
  json.latitude = null;
  json.longitude = null;
  json.adresse = null;
  json.localisationCommentaire = null;
}

    // =========================
    // 🔐 PERMISSION
    // =========================
    const permission = await getPermission(req.user, req.params.id);

    const ownerLink = (json.UserProjects || []).find(
      (up) => up.permission === "owner"
    );

    const ownerName =
      ownerLink?.User?.username || ownerLink?.User?.email || "";

    delete json.UserProjects;

    // =========================
    // 🧠 LAST ACTION
    // =========================
   const lastAction = await ProjectAction.findOne({
  where: { projectId: item.id },
  order: [["dateAction", "DESC"]],
  include: [
    {
      model: ProjectReminder,
      as: "reminders"
    }
  ]
});
const nextAction = lastAction
  ? getNextAction(lastAction.typeAction)
  : null;

const dateRelance =
  lastAction?.reminders?.[0]?.dateRelance ||
  lastAction?.dateRelance ||
  null;
    return res.json({
      ...json,
      permission,
      ownerName,

      devisCount: Number(json.devisCount || 0),
      bonCommandeCount: Number(json.bonCommandeCount || 0),
      startDate: json.dateDemarrage ?? lastAction?.dateAction ?? null,
      localisationCommentaire: json.localisationCommentaire ?? null,
      dateVisite: lastAction?.dateAction ?? null,
      nextAction: lastAction?.typeAction ?? null,
      commentaireAction: lastAction?.commentaire ?? null,
        nextAction,
  dateRelance,
      color: getProjectColor(json.pipelineStage),
    });

  } catch (e) {
    console.error("PROJECT_GET_ERROR:", e);

    return res.status(500).json({
      message: e.message || "Server error",
    });
  }
});
// ---------------- UPDATE ----------------
router.put("/:id", authRequired, async (req, res) => {
  try {

    if (!isUUID(req.params.id)) {
      return res.status(400).json({ message: "Invalid project id (UUID required)" });
    }

    const userRole = (req.user?.role || "").toLowerCase();
    const permission = await getPermission(req.user, req.params.id);

    if (
      !["admin", "superadmin"].includes(userRole) &&
      !["editor", "owner"].includes(permission)
    ) {
      return res.status(403).json({
        message: "You are not allowed to edit this project",
      });
    }

    const item = await Project.findByPk(req.params.id);

    if (!item) {
      return res.status(404).json({ message: "Project not found" });
    }

    // 🔥 BLOQUER SI ARCHIVÉ
    if (item.isArchived) {
      return res.status(403).json({
        message: "Projet archivé, modification interdite",
      });
    }

    const body = normalizePayload(req.body);

    const errors = validatePayload(body, true);
    if (errors.length) {
      return res.status(400).json({ message: "Validation error", errors });
    }

    // =========================
    // 🧼 CLEAN
    // =========================
    const clean = (val) =>
      val !== undefined && val !== null && String(val).trim() !== ""
        ? String(val).trim()
        : null;

    // =========================
    // 🔥 MODE LOGIC
    // =========================
    const mode = body.projectModele || item.projectModele;

    const isRevendeur = mode === "revendeur";
    const isApplicateur = mode === "applicateur";
    const isChantier = !isRevendeur && !isApplicateur;
    const hasCompanyInput =
      body.companyId !== undefined ||
      body.custom_company_name !== undefined ||
      body.customCompanyName !== undefined ||
      body.entrepriseCustom !== undefined ||
      body.customEntreprise !== undefined ||
      body.otherEntreprise !== undefined ||
      body.autreEntreprise !== undefined ||
      body.companyCustomName !== undefined ||
      body.entreprise !== undefined;
    const hasEngineerInput =
      body.engineerId !== undefined ||
      body.custom_engineer_name !== undefined ||
      body.customEngineerName !== undefined ||
      body.engineerCustomName !== undefined ||
      body.ingenieurResponsableCustom !== undefined ||
      body.ingenieurResponsable !== undefined;
    const hasArchitectInput =
      body.architectId !== undefined ||
      body.custom_architect_name !== undefined ||
      body.customArchitectName !== undefined ||
      body.architectCustomName !== undefined ||
      body.architecteCustom !== undefined ||
      body.architecte !== undefined;

    // Normalize Flutter aliases before processing fields
    if (body.startDate !== undefined && body.dateDemarrage === undefined) {
      body.dateDemarrage = body.startDate || null;
    }
    console.log("DATE DEMARRAGE =", body.dateDemarrage);

    // Validate statut against per-model allowed list
    if (body.statut !== undefined) {
      const PROJECT_STATUSES = ["Identification","Prospect","Contacté","Visite","Plan technique","Echantillonnage","Devis envoyé","Négociation","Gagné","Perdu","Fidélisation"];
      const REVENDEUR_STATUSES = ["Prospect","Offre","Actif","Raté"];

      const rawModele = body.projectModele || item.projectModele || "project";
      const modele = (rawModele || "").toLowerCase().trim();
      console.log("PROJECT MODELE =", item.projectModele, "| MODELE NORMALIZED =", modele);
      console.log("STATUT RECU =", body.statut);

      let allowedStatuses;
      if (modele === "revendeur") {
        allowedStatuses = REVENDEUR_STATUSES;
      } else if (modele === "applicateur") {
        allowedStatuses = [];
      } else {
        allowedStatuses = PROJECT_STATUSES;
      }
      console.log("ALLOWED STATUSES =", allowedStatuses);

      if (allowedStatuses.length > 0 && !allowedStatuses.includes(body.statut)) {
        return res.status(400).json({
          success: false,
          message: `Statut invalide pour ${rawModele}. Valeurs acceptées : ${allowedStatuses.join(", ")}`,
          allowedStatuses,
        });
      }
    }

    const fields = [
      "nomProjet",
      "dateDemarrage",
      "dateProspection",
      "statut",
      "typeAdresseChantier",
      "ingenieurResponsable",
      "engineerId",
      "telephoneIngenieur",
      "emailIngenieur",
      "architecte",
      "architectId",
      "telephoneArchitecte",
      "emailArchitecte",
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
      "pourcentageReussite",
      "validationStatut",
      "typeProjet",
      "matriculeFiscale",
      "surfaceProspectee",
      "pipelineStage",
      "projectModele",
      "comptoir",
      "telephoneComptoir",
      "telephoneComptoir2",
      "registreCommerce",
      "fonction",
      "revendeurNom",
      "revendeurPrenom",
      "revendeurEmail",
      "revendeurStatut",
      "adresseRevendeur",
      "dallagiste",
      "telephoneDallagiste",
      "emailDallagiste",
      "serviceTechnique",
      "montantMarche",
    ];

    const up = {};

    for (const f of fields) {
      if (body[f] === undefined) continue;

      // =========================
      // 🟠 REVENDEUR
      // =========================
      if (isRevendeur) {
        const allowed = [
          "nomProjet",
          "projectModele",
          "dateDemarrage",
          "comptoir",
          "telephoneComptoir",
          "telephoneComptoir2",
          "registreCommerce",
          "fonction",
          "revendeurNom",
          "revendeurPrenom",
          "revendeurEmail",
          "revendeurStatut",
          "adresseRevendeur",
          "validationStatut",
          "pipelineStage",
          "montantMarche",
          "pourcentageReussite",
        ];

        if (allowed.includes(f)) {
          up[f] = clean(body[f]);
        }
        continue;
      }

      // =========================
      // 🔵 APPLICATEUR
      // =========================
      if (isApplicateur) {
        const allowed = [
          "nomProjet",
          "projectModele",
          "dateDemarrage",
          "dallagiste",
          "telephoneDallagiste",
          "emailDallagiste",
          "serviceTechnique",
          "matriculeFiscale",
          "registreCommerce",
          "adresse",
          "validationStatut",
          "pipelineStage",
          "montantMarche",
          "pourcentageReussite",
        ];

        if (allowed.includes(f)) {
          up[f] = clean(body[f]);
        }
        continue;
      }

      // =========================
      // 🔵 PROJECT NORMAL
      // =========================
      if (isChantier) {
        up[f] = clean(body[f]);
      }
    }

    // =========================
    // 🔥 RESET CHAMPS SI PAS CHANTIER
    // =========================
    if (!isChantier) {
      up.typeAdresseChantier = null;
      up.latitude = null;
      up.longitude = null;
      up.ingenieurResponsable = null;
      up.engineerId = null;
      up.telephoneIngenieur = null;
      up.emailIngenieur = null;
      up.architecte = null;
      up.architectId = null;
      up.telephoneArchitecte = null;
      up.emailArchitecte = null;
      up.companyId = null;
      up.entreprise = null;
    }

    // =========================
    // 📍 AUTO-GENERATE LOCALISATION COMMENTAIRE
    // =========================
    if (isChantier && (body.latitude !== undefined || body.longitude !== undefined || body.localisationCommentaire !== undefined)) {
      const finalLat = body.latitude !== undefined ? body.latitude : item.latitude;
      const finalLng = body.longitude !== undefined ? body.longitude : item.longitude;
      const finalComment = body.localisationCommentaire !== undefined ? clean(body.localisationCommentaire) : item.localisationCommentaire;

      up.localisationCommentaire = LocationService.generateLocalizationComment(finalLat, finalLng, finalComment);
    }

    if (isChantier && hasCompanyInput) {
      const companySelection = await resolveCompanyForProject(body);
      up.companyId = companySelection.companyId;
      up.entreprise = companySelection.entreprise;
    }

    if (isChantier && hasEngineerInput) {
      const engineerSelection = await resolveEngineerForProject(body);
      up.engineerId = engineerSelection.engineerId;
      up.ingenieurResponsable = engineerSelection.ingenieurResponsable;
      up.telephoneIngenieur = clean(engineerSelection.telephoneIngenieur);
      up.emailIngenieur = clean(engineerSelection.emailIngenieur);
    }

    if (!isRevendeur && hasArchitectInput) {
      const architectSelection = await resolveArchitectForProject(body);
      up.architectId = architectSelection.architectId;
      up.architecte = architectSelection.architecte;
      up.telephoneArchitecte = clean(architectSelection.telephoneArchitecte);
      up.emailArchitecte = clean(architectSelection.emailArchitecte);
    }

    // =========================
    // 🔥 DEADLINE RESET
    // =========================
    if (body.ingenieurResponsable) {
      up.dateLimiteIngenieur = null;
    }

    await item.update(up);

    // Reload with all relations so Flutter gets the full owner/stage shape
    const [updated, lastAction, devisCount, bonCommandeCount] = await Promise.all([
      Project.findByPk(item.id, {
        include: [
          {
            model: User,
            as: "owner",
            attributes: ["id", "email"],
            include: [{ model: UserProfile, as: "profile", attributes: ["name", "avatarUrl"], required: false }],
            required: false,
          },
          {
            model: PipelineStage,
            as: "stage",
            attributes: ["id", "name", "color", "icon", "position", "isWonStage", "isLostStage"],
            required: false,
          },
        ],
      }),
      ProjectAction.findOne({ where: { projectId: item.id }, order: [["dateAction", "DESC"]] }),
      ProjectDevis.count({ where: { projectId: item.id } }),
      ProjectBonDeCommande.count({ where: { projectId: item.id } }),
    ]);

    const updatedJson = updated.toJSON();
    const ownerProfile = updatedJson.owner?.profile || {};

    return res.json({
      ...updatedJson,
      permission,
      devisCount,
      bonCommandeCount,
      title:             updatedJson.nomProjet || updatedJson.comptoir || null,
      dateDemarrage:     updatedJson.dateDemarrage ?? null,
      startDate:         updatedJson.dateDemarrage ?? null,
      owner: updatedJson.owner ? {
        id:       updatedJson.owner.id,
        email:    updatedJson.owner.email,
        fullName: ownerProfile.name || updatedJson.owner.email || null,
        avatarUrl: ownerProfile.avatarUrl || null,
      } : null,
      dateVisite:        lastAction?.dateAction ?? null,
      nextAction:        lastAction?.typeAction_legacy ?? lastAction?.typeAction ?? null,
      nextActionId:      lastAction?.actionTypeId ?? null,
      commentaireAction: lastAction?.commentaire ?? null,
    });

  } catch (e) {
    console.error("PROJECT_UPDATE_ERROR:", e);
    return res.status(e.status || 500).json({
      message: e.message || "Server error",
    });
  }
});

// ---------------- DELETE ----------------
router.delete("/:id", authRequired, async (req, res) => {
  try {
    if (!isUUID(req.params.id)) {
      return res.status(400).json({ message: "Invalid project id (UUID required)" });
    }

   if (req.user.email !== process.env.SUPERADMIN_EMAIL) {
  return res.status(403).json({
    message: "Only main superadmin can delete projects",
  });
}

    const item = await Project.findByPk(req.params.id);
    if (!item) return res.status(404).json({ message: "Not found" });

    // ✅ supprimer d'abord les relations (si FK constraints)
    await UserProject.destroy({ where: { projectId: req.params.id } });

    await item.destroy();

    return res.json({ message: "Deleted" });
  } catch (e) {
    console.error("PROJECT_DELETE_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

router.post("/:id/reminders", authRequired, async (req, res) => {

  try {

    const { actionId, dateRelance, message } = req.body;

    const reminder = await ProjectReminder.create({

      projectId: req.params.id,
      actionId,
      message: message ?? null,
      dateRelance,
      createdBy: req.user.sub

    });

    return res.status(201).json(reminder);

  } catch (e) {

    console.error("REMINDER_CREATE_ERROR:", e);

    return res.status(500).json({
      message: e.message || "Server error"
    });

  }

});
// ---------------- COMMENTS ----------------
router.get("/:id/comments", authRequired, async (req, res) => {
  try {

    const projectId = req.params.id;

    if (!isUUID(projectId))
      return res.status(400).json({ message: "Invalid project id (UUID required)" });

    const project = await Project.findByPk(projectId);

    if (!project)
      return res.status(404).json({ message: "Not found" });

    const all = await ProjectComment.findAll({
      where: { projectId },
      include: [
        {
          model: User,
          as: "user",   // ✅ IMPORTANT
          attributes: ["id", "email"],
        },
      ],
      order: [["createdAt", "ASC"]],
    });

    const map = new Map();
    const roots = [];

    const toJson = (c) => {
      const j = c.toJSON();

      return {
        ...j,
        authorName: j.user?.email ?? "Inconnu", // ⚠️ alias ici aussi
        replies: [],
      };
    };

    for (const c of all) map.set(c.id, toJson(c));

    for (const c of map.values()) {
      if (c.parentId) {
        const parent = map.get(c.parentId);
        if (parent) parent.replies.push(c);
        else roots.push(c);
      } else {
        roots.push(c);
      }
    }

    return res.json(roots);

  } catch (e) {
    console.error("PROJECT_COMMENTS_LIST_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

router.post("/:id/comments", authRequired, async (req, res) => {
  try {
    const projectId = req.params.id;
    if (!isUUID(projectId)) return res.status(400).json({ message: "Invalid project id (UUID required)" });

    const body = reqStr(req.body?.body);
    const parentId = req.body?.parentId || null;

    if (!body) return res.status(400).json({ message: "body est obligatoire" });

    const project = await Project.findByPk(projectId);
    if (!project) return res.status(404).json({ message: "Not found" });

    if (parentId) {
      if (!isUUID(parentId)) return res.status(400).json({ message: "parentId invalide (UUID required)" });
      const parent = await ProjectComment.findByPk(parentId);
      if (!parent || parent.projectId !== projectId) return res.status(400).json({ message: "parentId invalide" });
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
router.post("/:id/share", authRequired, async (req, res) => {
  try {
    const projectId = req.params.id;
    if (!isUUID(projectId)) return res.status(400).json({ message: "Invalid project id (UUID required)" });

    const { userId, permission } = req.body || {};
    if (!userId) return res.status(400).json({ message: "userId is required" });

    const perm = ["viewer", "editor"].includes(permission) ? permission : "viewer";

    const currentPerm = await getPermission(req.user, projectId);
    if (!["admin", "superadmin"].includes(req.user.role) && currentPerm !== "owner") {
      return res.status(403).json({ message: "Owner required" });
    }

    await UserProject.upsert({
      userId,
      projectId,
      permission: perm,
    });

    return res.json({ message: "User assigned", userId, projectId, permission: perm });
  } catch (e) {
    console.error("PROJECT_SHARE_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// ✅ update comment
router.put("/:id/comments/:commentId", authRequired, async (req, res) => {
  try {
    const { id: projectId, commentId } = req.params;
    if (!isUUID(projectId)) return res.status(400).json({ message: "Invalid project id (UUID required)" });
    if (!isUUID(commentId)) return res.status(400).json({ message: "Invalid comment id (UUID required)" });

    const body = reqStr(req.body?.body);
    if (!body) return res.status(400).json({ message: "body est obligatoire" });

    const c = await ProjectComment.findOne({ where: { id: commentId, projectId } });
    if (!c) return res.status(404).json({ message: "Commentaire introuvable" });

    const isAdmin = ["admin", "superadmin"].includes(req.user.role);
    const isOwner = c.authorId === req.user.sub;
    if (!isAdmin && !isOwner) return res.status(403).json({ message: "Accès interdit" });

    await c.update({ body });
    return res.json(c);
  } catch (e) {
    console.error("PROJECT_COMMENT_UPDATE_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// ✅ delete comment + replies
router.delete("/:id/comments/:commentId", authRequired, async (req, res) => {
  try {
    const { id: projectId, commentId } = req.params;
    if (!isUUID(projectId)) return res.status(400).json({ message: "Invalid project id (UUID required)" });
    if (!isUUID(commentId)) return res.status(400).json({ message: "Invalid comment id (UUID required)" });

    const c = await ProjectComment.findOne({ where: { id: commentId, projectId } });
    if (!c) return res.status(404).json({ message: "Commentaire introuvable" });

    const isAdmin = ["admin", "superadmin"].includes(req.user.role);
    const isOwner = c.authorId === req.user.sub;
    if (!isAdmin && !isOwner) return res.status(403).json({ message: "Accès interdit" });

    await ProjectComment.destroy({ where: { parentId: commentId } });
    await c.destroy();

    return res.json({ message: "Supprimé" });
  } catch (e) {
    console.error("PROJECT_COMMENT_DELETE_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// =======================
// ✅ DEVIS ROUTES (UPLOAD/LIST/UPDATE/MULTI)
// =======================

const UPLOAD_DIR = path.join(process.cwd(), "uploads", "devis");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const safe = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, safe);
  },
});

const fileFilter = (req, file, cb) => {
  const ok = ["application/pdf", "image/png", "image/jpeg"].includes(file.mimetype);
  cb(ok ? null : new Error("FORMAT_NOT_ALLOWED"), ok);
};

// ✅ support single + multiple in same endpoint
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

router.get("/:id/devis", authRequired, async (req, res) => {
  try {
    const projectId = req.params.id;
    if (!isUUID(projectId)) return res.status(400).json({ message: "Invalid project id" });

    const rows = await ProjectDevis.findAll({
      where: { projectId },
      order: [["createdAt", "DESC"]],
    });

    return res.json(rows); // [] si aucun devis
  } catch (e) {
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// ✅ POST upload (single OR multi)
// Fields accepted:
// - nomDevis (string) required
// - file (single) OR files[] (multi)
// ⚠️ remplace upload.single("file") par upload.array("files", 10)
router.post("/:id/devis", authRequired, upload.array("files", 10), async (req, res) => {
  try {
    const projectId = req.params.id;
    if (!isUUID(projectId)) return res.status(400).json({ message: "Invalid project id (UUID required)" });

    const nomDevis = String(req.body?.nomDevis || "").trim();
    if (!nomDevis) return res.status(400).json({ message: "nomDevis est obligatoire" });

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ message: "Fichier est obligatoire" });

    const permission = await getPermission(req.user, projectId);
    if (!["admin", "superadmin"].includes(req.user.role) && !["editor", "owner"].includes(permission)) {
      return res.status(403).json({ message: "Need editor permission" });
    }

    const rows = await Promise.all(
      files.map((f) =>
        ProjectDevis.create({
          projectId,
          nomDevis, // même nom pour tous (ou tu peux gérer nomDevis[] plus tard)
          fileUrl: `/uploads/devis/${f.filename}`,
          mimeType: f.mimetype,
          originalName: f.originalname,
        })
      )
    );

    return res.status(201).json(rows);
  } catch (e) {
    if (e?.message === "FORMAT_NOT_ALLOWED") {
      return res.status(400).json({ message: "Format interdit (PDF/PNG/JPG seulement)" });
    }
    console.error("PROJECT_DEVIS_UPLOAD_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// ✅ PUT update devis by devisId (optional file)
router.put(
  "/:id/devis/:devisId",
  authRequired,
  upload.single("file"),
  async (req, res) => {
    try {
      const projectId = req.params.id;
      const devisId = req.params.devisId;

      if (!isUUID(projectId)) return res.status(400).json({ message: "Invalid project id (UUID required)" });
      if (!isUUID(devisId)) return res.status(400).json({ message: "Invalid devis id (UUID required)" });

      const permission = await getPermission(req.user, projectId);
      if (!["admin", "superadmin"].includes(req.user.role) && !["editor", "owner"].includes(permission)) {
        return res.status(403).json({ message: "Need editor permission" });
      }

      const row = await ProjectDevis.findOne({ where: { id: devisId, projectId } });
      if (!row) return res.status(404).json({ message: "Devis introuvable" });

      const nomDevis = (req.body?.nomDevis ?? "").toString().trim();
      const up = {};
      if (nomDevis) up.nomDevis = nomDevis;

      if (req.file) {
        up.fileUrl = `/uploads/devis/${req.file.filename}`;
        up.mimeType = req.file.mimetype;
        up.originalName = req.file.originalname;
      }

      await row.update(up);
      return res.json(row);
    } catch (e) {
      if (e?.message === "FORMAT_NOT_ALLOWED") {
        return res.status(400).json({ message: "Format interdit (PDF/PNG/JPG seulement)" });
      }
      console.error("PROJECT_DEVIS_UPDATE_ERROR:", e);
      return res.status(500).json({ message: e.message || "Server error" });
    }
  }
);
// ✅ PUT update devis by devisId (optional file + optional nomDevis)
router.put(
  "/:id/devis/:devisId",
  authRequired,
  upload.single("file"),
  async (req, res) => {
    try {
      const projectId = req.params.id;
      const devisId = req.params.devisId;

      if (!isUUID(projectId)) return res.status(400).json({ message: "Invalid project id (UUID required)" });
      if (!isUUID(devisId)) return res.status(400).json({ message: "Invalid devis id (UUID required)" });

      const permission = await getPermission(req.user, projectId);
      if (!["admin", "superadmin"].includes(req.user.role) && !["editor", "owner"].includes(permission)) {
        return res.status(403).json({ message: "Need editor permission" });
      }

      const row = await ProjectDevis.findOne({ where: { id: devisId, projectId } });
      if (!row) return res.status(404).json({ message: "Devis introuvable" });

      const nomDevis = (req.body?.nomDevis ?? "").toString().trim();
      const up = {};

      if (nomDevis) up.nomDevis = nomDevis;

      if (req.file) {
        up.fileUrl = `/uploads/devis/${req.file.filename}`;
        up.mimeType = req.file.mimetype;
        up.originalName = req.file.originalname;
      }

      await row.update(up);
      return res.json(row);
    } catch (e) {
      if (e?.message === "FORMAT_NOT_ALLOWED") {
        return res.status(400).json({ message: "Format interdit (PDF/PNG/JPG seulement)" });
      }
      console.error("PROJECT_DEVIS_UPDATE_ERROR:", e);
      return res.status(500).json({ message: e.message || "Server error" });
    }
  }
);
router.delete("/:id/devis/:devisId", authRequired, async (req, res) => {
  try {
    const projectId = req.params.id;
    const devisId = req.params.devisId;

    if (!isUUID(projectId)) return res.status(400).json({ message: "Invalid project id (UUID required)" });
    if (!isUUID(devisId)) return res.status(400).json({ message: "Invalid devis id (UUID required)" });

    const permission = await getPermission(req.user, projectId);
    if (!["admin", "superadmin"].includes(req.user.role) && !["editor", "owner"].includes(permission)) {
      return res.status(403).json({ message: "Need editor permission" });
    }

    const row = await ProjectDevis.findOne({ where: { id: devisId, projectId } });
    if (!row) return res.status(404).json({ message: "Devis introuvable" });

    // ✅ supprimer le fichier physique si existe
    if (row.fileUrl) {
      const filename = row.fileUrl.split("/").pop(); // uploads/devis/<name>
      const full = path.join(UPLOAD_DIR, filename || "");
      try {
        if (filename && fs.existsSync(full)) fs.unlinkSync(full);
      } catch (_) {}
    }

    await row.destroy();
    return res.json({ ok: true });
  } catch (e) {
    console.error("PROJECT_DEVIS_DELETE_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});
// =======================
// ✅ BON DE COMMANDE ROUTES (UPLOAD/LIST/UPDATE/MULTI/DELETE)
// =======================

const BDC_UPLOAD_DIR = path.join(process.cwd(), "uploads", "bondecommande");
fs.mkdirSync(BDC_UPLOAD_DIR, { recursive: true });

const bdcStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, BDC_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const safe = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, safe);
  },
});

const bdcFileFilter = (req, file, cb) => {
  const ok = ["application/pdf", "image/png", "image/jpeg"].includes(file.mimetype);
  cb(ok ? null : new Error("FORMAT_NOT_ALLOWED"), ok);
};

const bdcUpload = multer({
  storage: bdcStorage,
  fileFilter: bdcFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});
router.get("/:id/bondecommande", authRequired, async (req, res) => {
  try {
    const projectId = req.params.id;
    if (!isUUID(projectId)) return res.status(400).json({ message: "Invalid project id" });

    const rows = await ProjectBonDeCommande.findAll({
      where: { projectId },
      order: [["createdAt", "DESC"]],
    });

    return res.json(rows);
  } catch (e) {
    return res.status(500).json({ message: e.message || "Server error" });
  }
});
router.get("/:id/bondecommande", authRequired, async (req, res) => {
  try {
    const projectId = req.params.id;
    if (!isUUID(projectId)) return res.status(400).json({ message: "Invalid project id" });

    const rows = await ProjectBonDeCommande.findAll({
      where: { projectId },
      order: [["createdAt", "DESC"]],
    });

    return res.json(rows);
  } catch (e) {
    return res.status(500).json({ message: e.message || "Server error" });
  }
});
router.post("/:id/bondecommande", authRequired, bdcUpload.array("files", 10), async (req, res) => {
  try {
    const projectId = req.params.id;
    if (!isUUID(projectId)) return res.status(400).json({ message: "Invalid project id (UUID required)" });

    const nomBonDeCommande = String(req.body?.nomBonDeCommande || "").trim();
    if (!nomBonDeCommande) return res.status(400).json({ message: "nomBonDeCommande est obligatoire" });

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ message: "Fichier est obligatoire" });

    const permission = await getPermission(req.user, projectId);
    if (!["admin", "superadmin"].includes(req.user.role) && !["editor", "owner"].includes(permission)) {
      return res.status(403).json({ message: "Need editor permission" });
    }

    const rows = await Promise.all(
      files.map((f) =>
        ProjectBonDeCommande.create({
          projectId,
          nomBonDeCommande,
          fileUrl: `/uploads/bondecommande/${f.filename}`,
          mimeType: f.mimetype,
          originalName: f.originalname,
        })
      )
    );

    return res.status(201).json(rows);
  } catch (e) {
    if (e?.message === "FORMAT_NOT_ALLOWED") {
      return res.status(400).json({ message: "Format interdit (PDF/PNG/JPG seulement)" });
    }
    console.error("PROJECT_BDC_UPLOAD_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});
router.put("/:id/bondecommande/:bdcId", authRequired, bdcUpload.single("file"), async (req, res) => {
  try {
    const projectId = req.params.id;
    const bdcId = req.params.bdcId;

    if (!isUUID(projectId)) return res.status(400).json({ message: "Invalid project id (UUID required)" });
    if (!isUUID(bdcId)) return res.status(400).json({ message: "Invalid bdc id (UUID required)" });

    const permission = await getPermission(req.user, projectId);
    if (!["admin", "superadmin"].includes(req.user.role) && !["editor", "owner"].includes(permission)) {
      return res.status(403).json({ message: "Need editor permission" });
    }

    const row = await ProjectBonDeCommande.findOne({ where: { id: bdcId, projectId } });
    if (!row) return res.status(404).json({ message: "Bon de commande introuvable" });

    const nomBonDeCommande = (req.body?.nomBonDeCommande ?? "").toString().trim();
    const up = {};
    if (nomBonDeCommande) up.nomBonDeCommande = nomBonDeCommande;

    if (req.file) {
      up.fileUrl = `/uploads/bondecommande/${req.file.filename}`;
      up.mimeType = req.file.mimetype;
      up.originalName = req.file.originalname;
    }

    await row.update(up);
    return res.json(row);
  } catch (e) {
    if (e?.message === "FORMAT_NOT_ALLOWED") {
      return res.status(400).json({ message: "Format interdit (PDF/PNG/JPG seulement)" });
    }
    console.error("PROJECT_BDC_UPDATE_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});
router.delete("/:id/bondecommande/:bdcId", authRequired, async (req, res) => {
  try {
    const projectId = req.params.id;
    const bdcId = req.params.bdcId;

    if (!isUUID(projectId)) return res.status(400).json({ message: "Invalid project id (UUID required)" });
    if (!isUUID(bdcId)) return res.status(400).json({ message: "Invalid bdc id (UUID required)" });

    const permission = await getPermission(req.user, projectId);
    if (!["admin", "superadmin"].includes(req.user.role) && !["editor", "owner"].includes(permission)) {
      return res.status(403).json({ message: "Need editor permission" });
    }

    const row = await ProjectBonDeCommande.findOne({ where: { id: bdcId, projectId } });
    if (!row) return res.status(404).json({ message: "Bon de commande introuvable" });

    if (row.fileUrl) {
      const filename = row.fileUrl.split("/").pop();
      const full = path.join(BDC_UPLOAD_DIR, filename || "");
      try {
        if (filename && fs.existsSync(full)) fs.unlinkSync(full);
      } catch (_) {}
    }

    await row.destroy();
    return res.json({ ok: true });
  } catch (e) {
    console.error("PROJECT_BDC_DELETE_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});
router.get("/kpi/projects-per-user-daily", authRequired, async (req, res) => {
  try {
    const wanted = [
      "id",
      "email",
      "username",
      "firstname",
      "lastname",
      "firstName",
      "lastName",
      "prenom",
      "nom",
      "name",
      "fullName",
    ];
    const safeAttrs = wanted.filter((a) => !!User.rawAttributes?.[a]);
    const userAttrs = safeAttrs.length ? safeAttrs : ["id", "email"];

    const rows = await UserProject.findAll({
      where: { permission: "owner" },
      attributes: [
        "userId",
        [sequelize.fn("DATE", sequelize.col("Project.createdAt")), "day"],
        [sequelize.fn("COUNT", sequelize.col("Project.id")), "projectsCount"],
      ],
      include: [
        {
          model: User,
          attributes: userAttrs,
          required: true,
        },
        {
          model: Project,
          attributes: [],
          required: true,
        },
      ],
      group: [
        "userId",
        sequelize.fn("DATE", sequelize.col("Project.createdAt")),
        ...userAttrs.map((a) => col(`User.${a}`)),
      ],
      order: [
        [sequelize.fn("DATE", sequelize.col("Project.createdAt")), "DESC"],
        [literal('"projectsCount"'), "DESC"],
      ],
      raw: false,
    });

    const result = rows.map((r) => ({
      userId: r.userId,
      email: r.User?.email || "",
      displayName: getUserDisplayName(r.User),
      day: r.get("day"), // ex: 2026-03-06
      projectsCount: Number(r.get("projectsCount") || 0),
    }));

    return res.json(result);
  } catch (e) {
    console.error("KPI_PROJECTS_PER_USER_DAILY_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});
router.get("/kpi/projects-per-user-weekly", authRequired, async (req, res) => {
  try {
    const wanted = [
      "id",
      "email",
      "username",
      "firstname",
      "lastname",
      "firstName",
      "lastName",
      "prenom",
      "nom",
      "name",
      "fullName",
    ];
    const safeAttrs = wanted.filter((a) => !!User.rawAttributes?.[a]);
    const userAttrs = safeAttrs.length ? safeAttrs : ["id", "email"];

    const weekExpr = sequelize.literal(`DATE_TRUNC('week', "Project"."createdAt")::date`);

    const rows = await UserProject.findAll({
      where: { permission: "owner" },
      attributes: [
        "userId",
        [weekExpr, "weekStart"],
        [sequelize.fn("COUNT", sequelize.col("Project.id")), "projectsCount"],
      ],
      include: [
        {
          model: User,
          attributes: userAttrs,
          required: true,
        },
        {
          model: Project,
          attributes: [],
          required: true,
        },
      ],
      group: [
        "userId",
        weekExpr,
        ...userAttrs.map((a) => col(`User.${a}`)),
      ],
      order: [
        [weekExpr, "DESC"],
        [literal('"projectsCount"'), "DESC"],
      ],
      raw: false,
    });

    const result = rows.map((r) => ({
      userId: r.userId,
      email: r.User?.email || "",
      displayName: getUserDisplayName(r.User),
      weekStart: r.get("weekStart"), // ex: 2026-03-02
      projectsCount: Number(r.get("projectsCount") || 0),
    }));

    return res.json(result);
  } catch (e) {
    console.error("KPI_PROJECTS_PER_USER_WEEKLY_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});
router.get("/kpi/projects-per-user-monthly", authRequired, async (req, res) => {
  try {
    const wanted = [
      "id",
      "email",
      "username",
      "firstname",
      "lastname",
      "firstName",
      "lastName",
      "prenom",
      "nom",
      "name",
      "fullName",
    ];
    const safeAttrs = wanted.filter((a) => !!User.rawAttributes?.[a]);
    const userAttrs = safeAttrs.length ? safeAttrs : ["id", "email"];

    const monthExpr = sequelize.fn("to_char", sequelize.col("Project.createdAt"), "YYYY-MM");

    const rows = await UserProject.findAll({
      where: { permission: "owner" },
      attributes: [
        "userId",
        [monthExpr, "month"],
        [sequelize.fn("COUNT", sequelize.col("Project.id")), "projectsCount"],
      ],
      include: [
        {
          model: User,
          attributes: userAttrs,
          required: true,
        },
        {
          model: Project,
          attributes: [],
          required: true,
        },
      ],
      group: [
        "userId",
        monthExpr,
        ...userAttrs.map((a) => col(`User.${a}`)),
      ],
      order: [
        [monthExpr, "DESC"],
        [literal('"projectsCount"'), "DESC"],
      ],
      raw: false,
    });

    const result = rows.map((r) => ({
      userId: r.userId,
      email: r.User?.email || "",
      displayName: getUserDisplayName(r.User),
      month: r.get("month"), // ex: 2026-03
      projectsCount: Number(r.get("projectsCount") || 0),
    }));

    return res.json(result);
  } catch (e) {
    console.error("KPI_PROJECTS_PER_USER_MONTHLY_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});
router.get("/kpi/projects-per-user-summary", authRequired, async (req, res) => {
  try {
    const wanted = [
      "id",
      "email",
      "username",
      "firstname",
      "lastname",
      "firstName",
      "lastName",
      "prenom",
      "nom",
      "name",
      "fullName",
    ];
    const safeAttrs = wanted.filter((a) => !!User.rawAttributes?.[a]);
    const userAttrs = safeAttrs.length ? safeAttrs : ["id", "email"];

    const users = await User.findAll({
      attributes: userAttrs,
      raw: true,
    });

    const dailyRows = await UserProject.findAll({
      where: { permission: "owner" },
      attributes: [
        "userId",
        [sequelize.fn("DATE", sequelize.col("Project.createdAt")), "period"],
        [sequelize.fn("COUNT", sequelize.col("Project.id")), "projectsCount"],
      ],
      include: [{ model: Project, attributes: [], required: true }],
      group: ["userId", sequelize.fn("DATE", sequelize.col("Project.createdAt"))],
      raw: true,
    });

    const weeklyRows = await UserProject.findAll({
      where: { permission: "owner" },
      attributes: [
        "userId",
        [sequelize.literal(`DATE_TRUNC('week', "Project"."createdAt")::date`), "period"],
        [sequelize.fn("COUNT", sequelize.col("Project.id")), "projectsCount"],
      ],
      include: [{ model: Project, attributes: [], required: true }],
      group: ["userId", sequelize.literal(`DATE_TRUNC('week', "Project"."createdAt")::date`)],
      raw: true,
    });

    const monthlyRows = await UserProject.findAll({
      where: { permission: "owner" },
      attributes: [
        "userId",
        [sequelize.fn("to_char", sequelize.col("Project.createdAt"), "YYYY-MM"), "period"],
        [sequelize.fn("COUNT", sequelize.col("Project.id")), "projectsCount"],
      ],
      include: [{ model: Project, attributes: [], required: true }],
      group: ["userId", sequelize.fn("to_char", sequelize.col("Project.createdAt"), "YYYY-MM")],
      raw: true,
    });

    const totalRows = await UserProject.findAll({
      where: { permission: "owner" },
      attributes: [
        "userId",
        [sequelize.fn("COUNT", sequelize.col("projectId")), "projectsCount"],
      ],
      group: ["userId"],
      raw: true,
    });

    const totalMap = new Map(totalRows.map((r) => [r.userId, Number(r.projectsCount || 0)]));
    const dailyMap = new Map();
    const weeklyMap = new Map();
    const monthlyMap = new Map();

    for (const r of dailyRows) {
      if (!dailyMap.has(r.userId)) dailyMap.set(r.userId, []);
      dailyMap.get(r.userId).push({
        day: r.period,
        projectsCount: Number(r.projectsCount || 0),
      });
    }

    for (const r of weeklyRows) {
      if (!weeklyMap.has(r.userId)) weeklyMap.set(r.userId, []);
      weeklyMap.get(r.userId).push({
        weekStart: r.period,
        projectsCount: Number(r.projectsCount || 0),
      });
    }

    for (const r of monthlyRows) {
      if (!monthlyMap.has(r.userId)) monthlyMap.set(r.userId, []);
      monthlyMap.get(r.userId).push({
        month: r.period,
        projectsCount: Number(r.projectsCount || 0),
      });
    }

    const result = users.map((u) => ({
      userId: u.id,
      email: u.email || "",
      displayName: getUserDisplayName(u),
      totalProjects: totalMap.get(u.id) || 0,
      daily: dailyMap.get(u.id) || [],
      weekly: weeklyMap.get(u.id) || [],
      monthly: monthlyMap.get(u.id) || [],
    }));

    return res.json(result);
  } catch (e) {
    console.error("KPI_PROJECTS_PER_USER_SUMMARY_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});
router.get("/reminders/upcoming", authRequired, async (req, res) => {

  const today = new Date();

  const reminders = await ProjectReminder.findAll({
    where: {
      dateRelance: {
        [Op.gte]: today
      }
    },
    include: [Project]
  });

  res.json(reminders);

});
exports.updatePipeline = async (req, res) => {
  try {

    const project = await Project.findByPk(req.params.id);

    project.pipelineStage = req.body.pipelineStage;

    await project.save();

    res.json(project);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ---------------- NEARBY PROJECTS ----------------
router.get("/nearby", authRequired, async (req, res) => {
  try {
    const { lat, lng, radius = 50, limit = 50 } = req.query;

    // Validate required parameters
    if (lat === undefined || lng === undefined) {
      return res.status(400).json({
        message: "Validation error",
        errors: ["lat and lng parameters are required"]
      });
    }

    const centerLat = Number(lat);
    const centerLng = Number(lng);
    const searchRadius = Math.min(Math.max(Number(radius) || 50, 1), 500); // 1-500km
    const maxLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100); // 1-100 results

    // Validate coordinates
    if (!LocationService.validateCoordinates(centerLat, centerLng)) {
      return res.status(400).json({
        message: "Validation error",
        errors: ["Invalid latitude or longitude values"]
      });
    }

    // Get accessible project IDs for the user
    const accessibleIds = await getAccessibleProjectIds(req.user);

    // Find nearby projects
    const nearbyProjects = await LocationService.findNearbyProjects(
      centerLat,
      centerLng,
      searchRadius,
      maxLimit,
      accessibleIds
    );

    // Format for map integration
    const mapReadyProjects = nearbyProjects.map((project) =>
      LocationService.formatForMap(project)
    );

    return res.json({
      center: { lat: centerLat, lng: centerLng },
      radiusKm: searchRadius,
      count: mapReadyProjects.length,
      projects: mapReadyProjects
    });

  } catch (e) {
    console.error("PROJECT_NEARBY_ERROR:", e);
    return res.status(e.status || 500).json({
      message: e.message || "Server error",
    });
  }
});

module.exports = router;
