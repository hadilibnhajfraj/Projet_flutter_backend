"use strict";

const svc = require("../services/commercialContactKpi.service");

const LOG = "[CommercialContactKPI]";

function handle(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error(`${LOG} Error:`, err);
  res.status(status).json({ success: false, message: err.message || "Internal server error" });
}

// ── GET /commercial-contacts/kpi ──────────────────────────────────────────────
// admin / superadmin → KPI globaux (tous les contacts, tous les commerciaux)
// commercial        → KPI personnels (WHERE createdBy = userId)
async function getKPI(req, res) {
  try {
    const { role: rawRole, sub: userId, email } = req.user;

    // Normaliser la casse pour éviter "Admin" vs "admin"
    const role = rawRole?.toLowerCase() ?? "unknown";

    const isAdmin = svc.ADMIN_ROLES.includes(role);
    const whereFilter = isAdmin ? "{} — aucun filtre (KPI global)" : `WHERE "createdBy" = '${userId}'`;

    console.log("========== KPI DEBUG ==========");
    console.log("ROLE RAW     =", rawRole);
    console.log("ROLE NORM    =", role);
    console.log("USER ID      =", userId);
    console.log("IS ADMIN     =", isAdmin);
    console.log("WHERE FILTER =", whereFilter);

    // ── Admin / Superadmin → KPI globaux ────────────────────────────────────
    if (isAdmin) {
      console.log("[KPI] Branche ADMIN → appel getCommercialContactKPI(null)");
      const raw = await svc.getCommercialContactKPI(null);

      console.log("CONTACTS FOUND =", raw.global.totalContacts);
      console.log("================================");

      return res.json({
        success: true,
        data: {
          isPersonalDashboard: false,
          totalContacts:       raw.global.totalContacts,
          totalCalls:          raw.global.totalCalls,
          totalCompanies:      raw.global.totalCompanies,
          totalCommercials:    raw.global.totalUsers,
          contactsByStatus:    raw.statusDistribution,
          contactsByType:      raw.typeDistribution,
          topCommercials:      raw.topUsers,
        },
      });
    }

    // ── Commercial → données filtrées sur ses propres contacts ───────────────
    console.log("[KPI] Branche COMMERCIAL → appel getPersonalKPISummary(userId)");
    const stats = await svc.getPersonalKPISummary(userId);

    console.log("CONTACTS FOUND =", stats.totalContacts);
    console.log("================================");

    return res.json({
      success: true,
      data: {
        isPersonalDashboard: true,
        commercial: {
          id:    userId,
          email: email  ?? null,
          name:  email  ? email.split("@")[0] : null,
        },
        totalContacts:    stats.totalContacts,
        totalCalls:       stats.totalCalls,
        totalCompanies:   stats.totalCompanies,
        validationRate:   stats.validationRate,
        contactsByStatus: stats.contactsByStatus,
        contactsByType:   stats.contactsByType,
      },
    });
  } catch (err) {
    handle(res, err);
  }
}

// ── GET /commercial-contacts/analytics ───────────────────────────────────────
// admin / superadmin → global ; commercial → filtré
async function getAnalytics(req, res) {
  try {
    const role   = req.user.role?.toLowerCase() ?? "unknown";
    const userId = svc.ADMIN_ROLES.includes(role) ? null : req.user.sub;
    const data   = await svc.getCommercialContactAnalytics(userId);
    res.json({ success: true, data });
  } catch (err) {
    handle(res, err);
  }
}

// ── GET /commercial-contacts/kpi/me — legacy ─────────────────────────────────
async function getKPIMe(req, res) {
  try {
    const userId = req.user.sub;
    if (!userId) return res.status(401).json({ success: false, message: "Unauthorized" });
    const data = await svc.getMyKPI(userId);
    res.json({ success: true, data });
  } catch (err) {
    handle(res, err);
  }
}

// ── GET /commercial-contacts/my-kpi — commercial uniquement ──────────────────
// ?commercialName=najeh  →  filtre par user_nom / user_nom_custom
// sans paramètre         →  filtre par createdBy = userId
async function getMyKpiEndpoint(req, res) {
  try {
    const { sub: userId, role } = req.user;
    const commercialName = req.query.commercialName
      ? String(req.query.commercialName).trim()
      : null;

    console.log("ROLE =", role);
    console.log("SELECTED COMMERCIAL =", commercialName);

    if (!userId) return res.status(401).json({ success: false, message: "Unauthorized" });

    const data = await svc.getPersonalKPISummary(userId, commercialName);

    console.log("PERSONAL CONTACTS =", data.totalContacts);

    res.json({ success: true, data });
  } catch (err) {
    handle(res, err);
  }
}

module.exports = { getKPI, getAnalytics, getKPIMe, getMyKpiEndpoint };
