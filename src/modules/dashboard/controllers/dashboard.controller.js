"use strict";

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

async function getKPIByRole(req, res) {
  try {
    const userId = req.user.sub;
    const role   = req.user.role;

    console.log("ROLE=", role);
    console.log("USER=", userId);

    const data = await svc.getKPIByRole(userId, role);

    console.log("TOTAL PROJECTS=", data.stats?.totalProjects ?? data.stats?.myProjects);

    res.json(data);
  } catch (err) {
    console.error("Dashboard KPIByRole error:", err);
    res.status(500).json({ message: "Failed to load KPIs" });
  }
}

async function getProfessionalDashboard(req, res) {
  try {
    const userId = req.user.sub;
    const role   = req.user.role;

    console.log("ROLE=", role);
    console.log("USER=", userId);

    const data = await svc.getProfessionalKPIs(userId, role);

    console.log("TOTAL PROJECTS=", data.summary.totalProjects);

    res.json(data);
  } catch (err) {
    console.error("Dashboard professional error:", err);
    res.status(500).json({ message: "Failed to load professional dashboard" });
  }
}

// GET /dashboard/user — KPI BI personnels (n'importe quel rôle authentifié,
// toujours scopé à req.user.sub — jamais de paramètre userId côté client).
async function getUserDashboard(req, res) {
  try {
    const data = await svc.getUserDashboard(req.user.sub);
    res.json(data);
  } catch (err) {
    console.error("Dashboard getUserDashboard error:", err);
    res.status(500).json({ message: "Failed to load user dashboard" });
  }
}

module.exports = { getKPIs, getKPIByRole, getProfessionalDashboard, getUserDashboard };
