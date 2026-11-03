// middleware/requireRole.js
const { isProbarProjectManager } = require("../config/probarProjectAccess");
const { roleHasPermission, loadRolePermissions, lastLoadError } = require("../config/rolePermissions");
const { logPermissionDenied, traceAccess } = require("../utils/permissionDiagnostics");

function requireRole(...allowed) {
  return (req, res, next) => {
    const role = req.user?.role;
    if (!role) return res.status(401).json({ message: "Unauthorized" });
    if (!allowed.includes(role)) {
      traceAccess({
        middleware: "requireRole",
        decision: "DENY",
        method: req.method,
        url: req.originalUrl,
        user: req.user,
        expected: `rôle parmi [${allowed.join(", ")}]`,
        reason: `rôle « ${role} » absent de la liste`,
      });
      return res.status(403).json({ success: false, code: "PERMISSION_DENIED", message: "Forbidden" });
    }
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

// Même contrôle que requireRole, mais laisse aussi passer un rôle disposant
// de la permission nommée `permission` (config/rolePermissions.js). Réservé
// aux routes de LECTURE (ex. production.read_all sur les GET Production).
// Les attributions de permissions sont lues en base (table role_permissions).
function requireRoleOrPermission(permission, ...allowed) {
  return async (req, res, next) => {
    const role = req.user?.role;
    if (!role) return res.status(401).json({ message: "Unauthorized" });
    if (allowed.includes(role)) return next();
    await loadRolePermissions();
    const trace = { middleware: "requireRoleOrPermission", method: req.method, url: req.originalUrl, user: req.user, expected: `${permission} ou rôle parmi [${allowed.join(", ")}]` };
    if (!roleHasPermission(role, permission)) {
      const tableError = lastLoadError();
      const reason = tableError
        ? `permissions illisibles en base (role_permissions) : ${tableError}`
        : `rôle « ${role} » absent de la liste et sans la permission ${permission} en base`;
      traceAccess({ ...trace, decision: "DENY", reason });
      logPermissionDenied({ method: req.method, url: req.originalUrl, user: req.user, expected: trace.expected, reason });
      return res.status(403).json({ success: false, code: "PERMISSION_DENIED", message: "Forbidden" });
    }
    traceAccess({ ...trace, decision: "ALLOW", reason: `permission ${permission} accordée au rôle « ${role} » (role_permissions)` });
    return next();
  };
}

module.exports = { requireRole, requireRoleOrProbarProjectManager, requireRoleOrPermission };
