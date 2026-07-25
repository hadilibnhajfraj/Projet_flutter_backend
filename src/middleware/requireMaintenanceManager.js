"use strict";

const { MAINTENANCE_MANAGER_EMAIL } = require("../config/maintenanceManager");

// Gestion complète des demandes de maintenance (accepter/refuser/affecter/
// démarrer/terminer/supprimer) — Administrateur (admin/superadmin/superadmin2),
// Responsable Maintenance historique (rôle responsable_logistique_achat) et
// le compte explicitement désigné Responsable Maintenance (accueilcbif@gmail.com).
const MAINTENANCE_MANAGER_ROLES = ["admin", "superadmin", "superadmin2", "responsable_logistique_achat"];

function isMaintenanceManager(role, email) {
  const r = (role || "").toLowerCase().trim();
  const e = (email || "").toLowerCase().trim();
  return MAINTENANCE_MANAGER_ROLES.includes(r) || e === MAINTENANCE_MANAGER_EMAIL;
}

function requireMaintenanceManager(req, res, next) {
  if (!isMaintenanceManager(req.user?.role, req.user?.email)) {
    return res.status(403).json({ success: false, message: "Accès réservé aux gestionnaires de maintenance" });
  }
  return next();
}

module.exports = { requireMaintenanceManager, isMaintenanceManager, MAINTENANCE_MANAGER_ROLES };
