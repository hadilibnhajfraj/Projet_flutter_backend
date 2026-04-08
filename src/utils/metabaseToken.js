const jwt = require("jsonwebtoken");

function generateMetabaseToken(user) {
  const payload = {
    resource: { dashboard: parseInt(process.env.METABASE_DASHBOARD_ID) },
    params: { owner: user.name }, // filtre par utilisateur connecté
    exp: Math.floor(Date.now() / 1000) + 60 * 60, // 1h
  };

  return jwt.sign(payload, process.env.METABASE_SECRET_KEY);
}

module.exports = generateMetabaseToken;