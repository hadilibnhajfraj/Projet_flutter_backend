"use strict";

const ADMIN_KPI_ROLES = ["admin", "superadmin"];

/**
 * Middleware — bloque l'accès aux KPI globaux pour les rôles non-admin.
 * Ajoute les logs diagnostics sur chaque tentative d'accès.
 *
 * Usage :
 *   router.get("/kpi/global", kpiRoleGuard, handler);
 *   router.use("/kpi", kpiRoleGuard);
 */
function kpiRoleGuard(req, res, next) {
  const role = req.user?.role || "unknown";

  console.log("ROLE =", role);
  console.log("KPI ACCESS =", req.originalUrl);

  if (!ADMIN_KPI_ROLES.includes(role)) {
    console.warn(`[KPI GUARD] Accès refusé — role="${role}" url="${req.originalUrl}"`);
    return res.status(403).json({
      success:    false,
      message:    "Accès refusé : les KPI globaux sont réservés aux administrateurs.",
      hint:       "Utilisez GET /commercial-contacts/kpi/me pour vos statistiques personnelles.",
      yourRole:   role,
      allowedRoles: ADMIN_KPI_ROLES,
    });
  }

  next();
}

module.exports = { kpiRoleGuard };
