const express = require("express");
const router = express.Router();
const timelineController = require("../controllers/projectTimeline.controller");

router.get("/timeline/:projectId", timelineController.getTimeline);

module.exports = router;