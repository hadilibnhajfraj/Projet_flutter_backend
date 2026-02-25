// routes/projects.routes.js
const express = require("express");
const { Op, fn, col, where } = require("sequelize");
const { User, Project, UserProject, ProjectComment } = require("../models/associations");
const { authRequired } = require("../middleware/auth.middleware");
const { sequelize } = require("../db");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const ProjectDevis = require("../models/ProjectDevis"); // adapte selon ton export
const ProjectBonDeCommande = require("../models/ProjectBonDeCommande");
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

function validatePayload(body, isUpdate = false) {
  const errors = [];

  const required = [
    "nomProjet",
    "dateDemarrage",
    "typeAdresseChantier",
    "ingenieurResponsable",
    "telephoneIngenieur",


    "entreprise",

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

  if (body.validationStatut !== undefined && body.validationStatut !== null) {
    const allowed = ["Validé", "Non validé"];
    if (!allowed.includes(body.validationStatut)) {
      errors.push("validationStatut invalide (Validé | Non validé)");
    }
  }

  if (body.pourcentageReussite !== undefined && body.pourcentageReussite !== null) {
    if (Number.isNaN(body.pourcentageReussite)) errors.push("pourcentageReussite doit être un nombre");
    else if (body.pourcentageReussite < 0 || body.pourcentageReussite > 100) {
      errors.push("pourcentageReussite doit être entre 0 et 100");
    }
  }

  if (body.surfaceProspectee !== undefined && body.surfaceProspectee !== null) {
    if (Number.isNaN(body.surfaceProspectee)) errors.push("surfaceProspectee doit être un nombre");
    else if (body.surfaceProspectee < 0) errors.push("surfaceProspectee doit être >= 0");
  }

  return errors;
}

// ✅ permission helper
async function getPermission(user, projectId) {
  if (["admin", "superadmin"].includes(user.role)) return "owner";

  const link = await UserProject.findOne({
    where: { userId: user.sub, projectId },
  });

  return link?.permission || "viewer";
}
// routes/projects.routes.js (or equivalent file where routes are defined)

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
function getStatusColor(statut, validationStatut) {
  if (statut === 'En cours') {
    return 'red'; // Red for "En cours"
  } else if (statut === 'Préparation') {
    return 'blue'; // Blue for "Préparation"
  } else if (statut === 'Terminé' && validationStatut === 'Validé') {
    return 'green'; // Green for "Terminé" and "Validé"
  } else if (statut === 'Terminé' && validationStatut === 'Non validé') {
    return 'orange'; // Orange for "Terminé" and "Non validé"
  }
  return 'gray'; // Default color for other cases
}

/* ============================================================
   ✅ KPI ROUTES (IMPORTANT: BEFORE "/:id")
   ============================================================ */

router.get("/user-kpi", authRequired, async (req, res) => {
  try {
    const totalUsers = await User.count();
    const activeUsers = await User.count({ where: { isActive: true } });
    const activePercentage = totalUsers === 0 ? 0 : Number(((activeUsers / totalUsers) * 100).toFixed(2));
    res.json({ activeUsers, totalUsers, activePercentage });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/kpi/validation-summary", authRequired, async (req, res) => {
  try {
    const totalProjects = await Project.count();
    const validatedProjects = await Project.count({ where: { validationStatut: "Validé" } });

    const validatedPercentage =
      totalProjects === 0 ? 0 : Number(((validatedProjects / totalProjects) * 100).toFixed(2));

    res.json({ totalProjects, validatedProjects, validatedPercentage });
  } catch (err) {
    res.status(500).json({ error: "KPI_VALIDATION_SUMMARY_ERROR", details: err.message });
  }
});

router.get("/kpi/validation-by-surface", authRequired, async (req, res) => {
  try {
    const rows = await Project.findAll({
      attributes: [
        "surfaceProspectee",
        [sequelize.fn("COUNT", sequelize.col("id")), "totalProjects"],
        [
          sequelize.fn(
            "SUM",
            sequelize.literal(`CASE WHEN "validationStatut" = 'Validé' THEN 1 ELSE 0 END`)
          ),
          "validatedProjects",
        ],
        // ✅ moyenne du pourcentage de réussite
        [
          sequelize.fn("AVG", sequelize.cast(sequelize.col("pourcentageReussite"), "float")),
          "avgReussite",
        ],
      ],
      group: ["surfaceProspectee"],
      order: [[sequelize.col("surfaceProspectee"), "ASC"]],
      raw: true,
    });

    const result = rows.map((r) => {
      const total = Number(r.totalProjects || 0);
      const validated = Number(r.validatedProjects || 0);
      const avgReussite = r.avgReussite == null ? null : Number(Number(r.avgReussite).toFixed(2));

      return {
        surfaceProspectee: r.surfaceProspectee,
        totalProjects: total,
        validatedProjects: validated,

        // ✅ ton ancien % (validationStatut)
        validatedPercentage: total === 0 ? 0 : Number(((validated / total) * 100).toFixed(2)),

        // ✅ le vrai % que tu veux (pourcentageReussite)
        avgReussite,
      };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "KPI_VALIDATION_BY_SURFACE_ERROR", details: err.message });
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
    const rows = await Project.findAll({
      attributes: [
        "validationStatut",
        [sequelize.fn("COUNT", sequelize.col("id")), "projectCount"],
      ],
      group: ["validationStatut"],
      raw: true,
    });

    res.json(
      rows.map((r) => ({
        validationStatut: r.validationStatut ?? "Non défini",
        projectCount: Number(r.projectCount || 0),
      }))
    );
  } catch (err) {
    res.status(500).json({ error: "KPI_VALIDATION_STATUS_COUNT_ERROR", details: err.message });
  }
});
router.get("/kpi/dashboard", authRequired, async (req, res) => {
  try {
    const totalProjects = await Project.count();
    const validatedProjects = await Project.count({
      where: { validationStatut: "Validé" },
    });
    const nonValidatedProjects = totalProjects - validatedProjects;

    const validatedPercentage =
      totalProjects === 0
        ? 0
        : Number(((validatedProjects / totalProjects) * 100).toFixed(2));

    // ✅ Validation status count
    const validationStatusCount = await Project.findAll({
      attributes: [
        "validationStatut",
        [sequelize.fn("COUNT", sequelize.col("id")), "projectCount"],
      ],
      group: ["validationStatut"],
      raw: true,
    });

    // ✅ Validation by surface
    const bySurfaceRows = await Project.findAll({
      attributes: [
        "surfaceProspectee",
        [sequelize.fn("COUNT", sequelize.col("id")), "totalProjects"],
        [
          sequelize.fn(
            "SUM",
            sequelize.literal(
              `CASE WHEN "validationStatut" = 'Validé' THEN 1 ELSE 0 END`
            )
          ),
          "validatedProjects",
        ],
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
        validatedPercentage:
          total === 0 ? 0 : Number(((validated / total) * 100).toFixed(2)),
      };
    });

    // ✅ Map projects
    const mapProjects = await Project.findAll({
      attributes: [
        "id",
        "nomProjet",
        "latitude",
        "longitude",
        "validationStatut",
        "statut",
        "adresse",
        "localisationCommentaire",
        "createdAt",
      ],
      where: {
        latitude: { [Op.ne]: null },
        longitude: { [Op.ne]: null },
      },
      order: [["createdAt", "DESC"]],
      limit: 200,
      raw: true,
    });

    // ✅ Projects per user
    const projectsPerUser = await UserProject.findAll({
      attributes: [
        "userId",
        [sequelize.fn("COUNT", sequelize.col("projectId")), "projectsCount"],
      ],
      group: ["userId"],
      raw: true,
    });

    const userIds = projectsPerUser.map((x) => x.userId).filter(Boolean);

    // ✅ IMPORTANT: sélectionner uniquement les colonnes existantes dans User
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

    const users = userIds.length
      ? await User.findAll({
          where: { id: userIds },
          attributes: safeAttrs.length ? safeAttrs : ["id"], // fallback
          raw: true,
        })
      : [];

    const userMap = new Map(users.map((u) => [u.id, u]));

    const displayName = (u) =>
      u.firstname ||
      u.firstName ||
      u.prenom ||
      u.lastname ||
      u.lastName ||
      u.nom ||
      u.username ||
      u.name ||
      u.fullName ||
      u.email ||
      "Inconnu";

    const topUsers = projectsPerUser
      .map((x) => {
        const u = userMap.get(x.userId);
        return {
          userId: x.userId,
          projectsCount: Number(x.projectsCount || 0),
          user: u ? { ...u, displayName: displayName(u) } : null,
        };
      })
      .sort((a, b) => b.projectsCount - a.projectsCount)
      .slice(0, 5);

    // ✅ latest projects
    const latestProjects = await Project.findAll({
      order: [["createdAt", "DESC"]],
      limit: 5,
      attributes: [
        "id",
        "nomProjet",
        "validationStatut",
        "statut",
        "createdAt",
        "latitude",
        "longitude",
      ],
      raw: true,
    });

    return res.json({
      summary: {
        totalProjects,
        validatedProjects,
        nonValidatedProjects,
        validatedPercentage,
      },
      validationStatusCount: validationStatusCount.map((r) => ({
        validationStatut: r.validationStatut ?? "Non défini",
        projectCount: Number(r.projectCount || 0),
      })),
      bySurface,
      mapProjects,
      topUsers,
      latestProjects,
    });
  } catch (err) {
    console.error("KPI_DASHBOARD_ERROR:", err);
    return res
      .status(500)
      .json({ error: "KPI_DASHBOARD_ERROR", details: err.message });
  }
});

router.get("/kpi/map-projects", authRequired, async (req, res) => {
  try {
    const items = await Project.findAll({
      attributes: [
        "id",
        "nomProjet",
        "latitude",
        "longitude",
        "validationStatut",
        "statut",
        "adresse",
        "localisationCommentaire",
        "createdAt",
      ],
      where: {
        latitude: { [Op.ne]: null },
        longitude: { [Op.ne]: null },
      },
      order: [["createdAt", "DESC"]],
      raw: true,
    });

    res.json(items);
  } catch (err) {
    res.status(500).json({ error: "KPI_MAP_PROJECTS_ERROR", details: err.message });
  }
});

// Nouvelle route pour récupérer le nombre de projets par statut
router.get("/kpi/projects-by-status", authRequired, async (req, res) => {
  try {
    const rows = await Project.findAll({
      attributes: [
        "statut", // Le statut des projets
        [sequelize.fn("COUNT", sequelize.col("id")), "projectCount"], // Nombre de projets pour chaque statut
      ],
      group: ["statut"], // Groupé par statut
      raw: true,
    });

    const result = rows.map((r) => ({
      statut: r.statut, // "En cours", "Préparation", ou "Terminé"
      projectCount: Number(r.projectCount || 0), // Nombre de projets pour chaque statut
    }));

    res.json(result); // Retourne les résultats au frontend
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
// ✅ Projets groupés par mois (dateDemarrage) avec % validé + moyenne pourcentageReussite
router.get("/kpi/projects-by-month", authRequired, async (req, res) => {
  try {
    // monthKey: 2026-01, 2026-02 ...
    const rows = await Project.findAll({
      attributes: [
        [sequelize.fn("to_char", sequelize.col("dateDemarrage"), "YYYY-MM"), "monthKey"],
        [sequelize.fn("COUNT", sequelize.col("id")), "totalProjects"],
        [
          sequelize.fn("SUM", sequelize.literal(`CASE WHEN "validationStatut" = 'Validé' THEN 1 ELSE 0 END`)),
          "validatedProjects",
        ],
        [sequelize.fn("AVG", sequelize.cast(sequelize.col("pourcentageReussite"), "float")), "avgReussite"],
      ],
      group: [sequelize.fn("to_char", sequelize.col("dateDemarrage"), "YYYY-MM")],
      order: [[sequelize.fn("to_char", sequelize.col("dateDemarrage"), "YYYY-MM"), "ASC"]],
      raw: true,
    });

    const result = rows.map((r) => {
      const total = Number(r.totalProjects || 0);
      const validated = Number(r.validatedProjects || 0);
      const validatedPercentage = total === 0 ? 0 : Number(((validated / total) * 100).toFixed(2));
      const avgReussite = r.avgReussite == null ? 0 : Number(Number(r.avgReussite).toFixed(2));

      return {
        month: String(r.monthKey),            // "2026-01"
        totalProjects: total,
        validatedProjects: validated,
        validatedPercentage,
        avgReussite,
      };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "KPI_PROJECTS_BY_MONTH_ERROR", details: err.message });
  }
});
router.get("/kpi/latest-projects", authRequired, async (req, res) => {
  try {
    const items = await Project.findAll({
      order: [["createdAt", "DESC"]],
      limit: 15,
      attributes: ["id", "nomProjet", "dateDemarrage", "validationStatut", "statut", "createdAt"],
      include: [
        {
          model: UserProject,
          required: false,
          attributes: ["permission", "userId"],
          where: { permission: "owner" },
          include: [{ model: User, attributes: ["id", "username", "email"] }],
        },
      ],
    });

    const out = items.map((p) => {
      const j = p.toJSON();
      const ownerLink = j.UserProjects?.[0];
      const ownerUser = ownerLink?.User;

      return {
        ...j,
        owner: ownerUser
          ? { id: ownerUser.id, username: ownerUser.username, email: ownerUser.email }
          : null,
        permission: (["admin","superadmin"].includes(req.user.role)) ? "owner" : "viewer",
        // NOTE: si tu veux vraie permission utilisateur connecté, fais une query UserProject sur req.user.sub
      };
    });

    res.json(out);
  } catch (err) {
    res.status(500).json({ error: "KPI_LATEST_PROJECTS_ERROR", details: err.message });
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
      where[Op.or] = [
        { nomProjet: { [Op.iLike]: `%${s}%` } },
        { entreprise: { [Op.iLike]: `%${s}%` } },
        { promoteur: { [Op.iLike]: `%${s}%` } },
        { adresse: { [Op.iLike]: `%${s}%` } },
        { typeProjet: { [Op.iLike]: `%${s}%` } },
        { validationStatut: { [Op.iLike]: `%${s}%` } },
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

/* ============================================================
   ✅ CRUD ROUTES
   ============================================================ */

// ---------------- CREATE ----------------
router.post("/", authRequired, async (req, res) => {
  try {
    const body = normalizePayload(req.body);

    const errors = validatePayload(body, false);
    if (errors.length) return res.status(400).json({ message: "Validation error", errors });

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

    if (lat == null || lng == null) {
      return res.status(400).json({
        message: "Validation error",
        errors: ["latitude/longitude est obligatoire"],
      });
    }

    const nomProjet = String(body.nomProjet || "").trim();
    if (!nomProjet) {
      return res.status(400).json({ message: "Validation error", errors: ["nomProjet est obligatoire"] });
    }

    // ✅ Unicité (par user) case-insensitive : on vérifie via la table pivot
    const exists = await UserProject.findOne({
      where: { userId: req.user.sub },
      include: [
        {
          model: Project,
          required: true,
          attributes: ["id", "nomProjet"],
          where: where(fn("lower", col("Project.nomProjet")), nomProjet.toLowerCase()),
        },
      ],
    });

    if (exists) {
      return res.status(409).json({
        message: "Project name already exists",
        errors: ["Un projet avec ce nom existe déjà."],
      });
    }

    const p = await Project.create({
      nomProjet,
      dateDemarrage: body.dateDemarrage,
      statut: body.statut || null,
      typeAdresseChantier: String(body.typeAdresseChantier || "").trim(),

      ingenieurResponsable: String(body.ingenieurResponsable || "").trim(),
      telephoneIngenieur: String(body.telephoneIngenieur || "").trim(),

      architecte: body.architecte?.trim() ? body.architecte.trim() : null,
      telephoneArchitecte: body.telephoneArchitecte?.trim() ? body.telephoneArchitecte.trim() : null,

      matriculeFiscale: body.matriculeFiscale?.trim() ? body.matriculeFiscale.trim() : null,

      entreprise: String(body.entreprise || "").trim(),
      promoteur: body.promoteur?.trim() ? body.promoteur.trim() : null,
      bureauEtude: body.bureauEtude?.trim() ? body.bureauEtude.trim() : null,

      bureauControle: String(body.bureauControle || "").trim(),

      adresse: body.adresse?.trim() ? body.adresse.trim() : null,

      latitude: lat,
      longitude: lng,

      localisationCommentaire: body.localisationCommentaire?.trim()
        ? body.localisationCommentaire.trim()
        : null,

      entrepriseFluide: body.entrepriseFluide?.trim() ? body.entrepriseFluide.trim() : null,
      entrepriseElectricite: body.entrepriseElectricite?.trim() ? body.entrepriseElectricite.trim() : null,

      pourcentageReussite: body.pourcentageReussite ?? null,
      validationStatut: body.validationStatut ?? "Non validé",
      typeProjet: body.typeProjet?.trim() ? body.typeProjet.trim() : null,
      surfaceProspectee: body.surfaceProspectee ?? null,
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
// ---------------- LIST ----------------
router.get("/", authRequired, async (req, res) => {
  try {
    const { q } = req.query;
    const where = {};

    if (typeof q === "string" && q.trim()) {
      const s = q.trim();
      where[Op.or] = [
        { nomProjet: { [Op.iLike]: `%${s}%` } },
        { entreprise: { [Op.iLike]: `%${s}%` } },
        { promoteur: { [Op.iLike]: `%${s}%` } },
        { adresse: { [Op.iLike]: `%${s}%` } },
        { typeProjet: { [Op.iLike]: `%${s}%` } },
        { validationStatut: { [Op.iLike]: `%${s}%` } },
      ];
    }

    // ✅ safe attrs user
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
          attributes: ["permission", "userId", "createdAt"],
          include: [{ model: User, attributes: userAttrs }],
        },
      ],
      order: [["createdAt", "DESC"]],
      attributes: {
        include: [
          [
            sequelize.literal(
              `(SELECT COUNT(*) FROM project_comments pc WHERE pc."projectId" = "Project"."id")`
            ),
            "commentCount",
          ],

          // ✅ NEW: devisCount
          [
            sequelize.literal(
              `(SELECT COUNT(*) FROM project_devis d WHERE d."projectId" = "Project"."id")`
            ),
            "devisCount",
          ],

          // ✅ NEW: bonCommandeCount (⚠️ change table name if needed)
          [
            sequelize.literal(
              `(SELECT COUNT(*) FROM project_bon_de_commande bc WHERE bc."projectId" = "Project"."id")`
            ),
            "bonCommandeCount",
          ],
        ],
      },
    });

    const displayName = (u) =>
      u?.username ||
      u?.firstname ||
      u?.firstName ||
      u?.prenom ||
      u?.lastname ||
      u?.lastName ||
      u?.nom ||
      u?.name ||
      u?.fullName ||
      u?.email ||
      "Inconnu";

    const out = items.map((p) => {
      const json = p.toJSON();

      // ✅ permission utilisateur connecté
      const meLink = (json.UserProjects || []).find((up) => up.userId === req.user.sub);
      const perm = ["admin", "superadmin"].includes(req.user.role)
        ? "owner"
        : (meLink?.permission || "viewer");

      // ✅ owner (créateur) = permission owner
      const ownerLink = (json.UserProjects || []).find((up) => up.permission === "owner");
      const ownerName = ownerLink?.User ? displayName(ownerLink.User) : "";

      delete json.UserProjects;

      return {
        ...json,
        permission: perm,
        ownerName,

        // ✅ ensure numbers (sometimes literal returns string)
        devisCount: Number(json.devisCount || 0),
        bonCommandeCount: Number(json.bonCommandeCount || 0),
      };
    });

    return res.json(out);
  } catch (e) {
    console.error("PROJECT_LIST_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

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
          include: [{ model: User, attributes: ["id", "email", ...(User.rawAttributes?.username ? ["username"] : [])] }],
        },
      ],
    });

    if (!item) return res.status(404).json({ message: "Not found" });

    const json = item.toJSON();
    const permission = await getPermission(req.user, req.params.id);

    const ownerLink = (json.UserProjects || []).find((up) => up.permission === "owner");
    const ownerName =
      ownerLink?.User?.username ||
      ownerLink?.User?.email ||
      "";

    delete json.UserProjects;

    return res.json({ ...json, permission, ownerName });
  } catch (e) {
    console.error("PROJECT_GET_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});

// ---------------- UPDATE ----------------
router.put("/:id", authRequired, async (req, res) => {
  try {
    if (!isUUID(req.params.id)) {
      return res.status(400).json({ message: "Invalid project id (UUID required)" });
    }

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
      "localisationCommentaire",
      "entrepriseFluide",
      "entrepriseElectricite",
      "pourcentageReussite",
      "validationStatut",
      "typeProjet",
      "matriculeFiscale",
      "surfaceProspectee",
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
router.delete("/:id", authRequired, async (req, res) => {
  try {
    if (!isUUID(req.params.id)) {
      return res.status(400).json({ message: "Invalid project id (UUID required)" });
    }

    // ✅ Autoriser uniquement admin / superadmin
    if (!["admin", "superadmin"].includes(req.user.role)) {
      return res.status(403).json({ message: "Only admin/superadmin can delete projects" });
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

// ---------------- COMMENTS ----------------
router.get("/:id/comments", authRequired, async (req, res) => {
  try {
    const projectId = req.params.id;
    if (!isUUID(projectId)) return res.status(400).json({ message: "Invalid project id (UUID required)" });

    const project = await Project.findByPk(projectId);
    if (!project) return res.status(404).json({ message: "Not found" });

    const all = await ProjectComment.findAll({
      where: { projectId },
      include: [{ model: User, attributes: ["id", "email"] }],
      order: [["createdAt", "ASC"]],
    });

    const map = new Map();
    const roots = [];

    const toJson = (c) => {
      const j = c.toJSON();
      return { ...j, authorName: j.User?.email ?? "Inconnu", replies: [] };
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
module.exports = router;
