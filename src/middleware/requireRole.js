// middleware/requireRole.js
const { isProbarProjectManager } = require("../config/probarProjectAccess");

function requireRole(...allowed) {
  return (req, res, next) => {
    const role = req.user?.role;
    if (!role) return res.status(401).json({ message: "Unauthorized" });
    if (!allowed.includes(role)) return res.status(403).json({ success: false, code: "PERMISSION_DENIED", message: "Forbidden" });
    return next();
  };
}

// Même contrôle que requireRole, mais laisse aussi passer les comptes
// @probardistribution.com éligibles (voir config/probarProjectAccess.js).
function requireRoleOrProbarProjectManager(...allowed) {
  return (req, res, next) => {
    const role = req.user?.role;
    if (!role) return res.status(401).json({ message: "Unauthorized" });
    if (!allowed.includes(role) && !isProbarProjectManager(req.user)) {
      return res.status(403).json({ success: false, code: "PERMISSION_DENIED", message: "Forbidden" });
    }
    return next();
  };
}

module.exports = { requireRole, requireRoleOrProbarProjectManager };
