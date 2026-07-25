"use strict";

const svc = require("../services/adminDashboard.service");
const logger = require("../../../utils/logger");

async function getStats(req, res) {
  try {
    const data = await svc.getFullDashboard();
    res.json({ success: true, data });
  } catch (err) {
    logger.error("AdminDashboard error:", err);
    res.status(err.status || 500).json({
      success: false,
      message: err.message || "Internal server error",
    });
  }
}

module.exports = { getStats };
