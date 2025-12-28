const { verifyAccessToken } = require("../utils/tokens");

function authRequired(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const parts = header.split(" ");
    const token = parts.length === 2 ? parts[1] : null;

    if (!token) return res.status(401).json({ message: "Missing token" });

    const decoded = verifyAccessToken(token);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

module.exports = { authRequired };
