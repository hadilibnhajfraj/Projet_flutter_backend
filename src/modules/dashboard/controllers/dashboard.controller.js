const svc = require("../services/dashboard.service");

async function getKPIs(req, res) {
  try {
    const data = await svc.getKPIs(req.user.sub, req.user.role);
    res.json({ data });
  } catch (err) {
    console.error("Dashboard KPI error:", err);
    res.status(500).json({ message: "Failed to load KPIs" });
  }
}

module.exports = { getKPIs };
