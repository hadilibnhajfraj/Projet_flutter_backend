"use strict";

const { ROOT_ADMIN_EMAIL } = require("../config/rootAdmin");

function requireRootAdmin(req, res, next) {
  const email = (req.user?.email || "").toLowerCase().trim();
  if (email !== ROOT_ADMIN_EMAIL) {
    return res.status(403).json({ success: false, message: "Accès réservé à l'administrateur" });
  }
  return next();
}

module.exports = { requireRootAdmin };
