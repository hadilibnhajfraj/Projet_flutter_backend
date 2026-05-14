const express = require("express");
const { authRequired } = require("../middleware/auth.middleware");
const { getAllArchitects } = require("../controllers/architect.controller");

const router = express.Router();

router.get("/all", authRequired, getAllArchitects);

module.exports = router;
