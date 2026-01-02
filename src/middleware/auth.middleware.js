// middleware/auth.middleware.js
const { verifyAccessToken } = require("../utils/tokens");

function authRequired(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const [type, token] = header.split(" ");

    if (type !== "Bearer" || !token) {
      return res.status(401).json({ message: "Missing token" });
    }

    const decoded = verifyAccessToken(token);
    req.user = decoded; // { sub, email, role }
    return next();
  } catch (e) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

module.exports = { authRequired };
