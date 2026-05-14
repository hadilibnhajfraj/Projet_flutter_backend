const express = require("express");
const { authRequired } = require("../middleware/auth.middleware");
const { getAllEngineers } = require("../controllers/engineer.controller");

const router = express.Router();

router.get("/all", authRequired, getAllEngineers);

module.exports = router;
