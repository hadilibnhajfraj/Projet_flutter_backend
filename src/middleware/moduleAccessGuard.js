const { verifyAccessToken } = require("../utils/tokens");

// Role-scoped module access — restricts a role to a fixed set of path
// prefixes regardless of which routers get mounted in app.js later.
// Decodes the JWT itself (rather than relying on req.user) because this
// guard runs before each route's own authRequired middleware.
const ALLOWED_PREFIXES_BY_ROLE = {
  responsable_logistique_achat: [
    "/por-promesh",
    "/industrial-records",
    "/hr-requests",
    "/recuperables",
    "/maintenance-requests",
    "/auth",
    "/users/me",
    "/uploads",
    "/me",
  ],
};

function moduleAccessGuard(req, res, next) {
  const header = req.headers.authorization || "";
  const [type, token] = header.split(" ");
  if (type !== "Bearer" || !token) return next();

  let decoded;
  try {
    decoded = verifyAccessToken(token);
  } catch (_) {
    return next(); // invalid/expired token — let the route's own authRequired return 401
  }

  const allowedPrefixes = ALLOWED_PREFIXES_BY_ROLE[decoded.role];
  if (!allowedPrefixes) return next(); // role has no restriction defined here

  const isAllowed = allowedPrefixes.some((prefix) => req.path.startsWith(prefix));
  if (!isAllowed) {
    return res.status(403).json({
      success: false,
      message: "Accès refusé : ce rôle n'a accès qu'au module POR PROMESH",
    });
  }
  return next();
}

module.exports = { moduleAccessGuard };
