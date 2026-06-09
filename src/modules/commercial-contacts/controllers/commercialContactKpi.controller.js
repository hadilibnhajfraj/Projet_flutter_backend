"use strict";

const svc = require("../services/commercialContactKpi.service");

const LOG = "[CommercialContactKPI]";

function handle(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error(`${LOG} Error:`, err);
  res.status(status).json({ success: false, message: err.message || "Internal server error" });
}

// Retourne null pour admin/superadmin (toutes données), userId pour commercial (ses données)
function _scopeUserId(req) {
  return svc.ADMIN_ROLES.includes(req.user.role) ? null : req.user.sub;
}

async function getKPI(req, res) {
  try {
    const { role, sub: userId, email } = req.user;

    console.log("ROLE =", role);
    console.log("USER =", email);

    // ── Commercial → dashboard personnel ─────────────────────────────────────
    if (!svc.ADMIN_ROLES.includes(role)) {
      const stats = await svc.getPersonalKPISummary(userId);

      console.log("PERSONAL CONTACTS =", stats.totalContacts);

      return res.json({
        success: true,
        data: {
          isPersonalDashboard: true,
          commercial: {
            id:    userId,
            email: email ?? null,
            name:  email ? email.split("@")[0] : null,
          },
          stats,
        },
      });
    }

    // ── Admin / superadmin → statistiques globales ───────────────────────────
    const data = await svc.getCommercialContactKPI(null);
    res.json({ success: true, data: { isPersonalDashboard: false, ...data } });
  } catch (err) {
    handle(res, err);
  }
}

async function getAnalytics(req, res) {
  try {
    const data = await svc.getCommercialContactAnalytics(_scopeUserId(req));
    res.json({ success: true, data });
  } catch (err) {
    handle(res, err);
  }
}

// Vue personnelle — toujours filtrée sur l'utilisateur connecté
async function getMyKPI(req, res) {
  try {
    const userId = req.user.sub;
    if (!userId) return res.status(401).json({ success: false, message: "Unauthorized" });
    const data = await svc.getMyKPI(userId);
    res.json({ success: true, data });
  } catch (err) {
    handle(res, err);
  }
}

module.exports = { getKPI, getAnalytics, getMyKPI };
