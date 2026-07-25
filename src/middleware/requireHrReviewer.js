"use strict";

const { HR_MANAGER_EMAIL } = require("../config/hrManager");

// Gestion complète des demandes RH (accepter/refuser/commenter/marquer
// traité) — Administrateur (admin/superadmin/superadmin2) et le compte
// explicitement désigné Responsable RH (manegerofficecbi@gmail.com).
const HR_REVIEWER_ROLES = ["admin", "superadmin", "superadmin2"];

function isHrReviewer(role, email) {
  const r = (role || "").toLowerCase().trim();
  const e = (email || "").toLowerCase().trim();
  return HR_REVIEWER_ROLES.includes(r) || e === HR_MANAGER_EMAIL;
}

function requireHrReviewer(req, res, next) {
  if (!isHrReviewer(req.user?.role, req.user?.email)) {
    return res.status(403).json({ success: false, message: "Accès réservé au Responsable RH" });
  }
  return next();
}

module.exports = { requireHrReviewer, isHrReviewer, HR_REVIEWER_ROLES };
