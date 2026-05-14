const express = require("express");
const { authRequired } = require("../middleware/auth.middleware");
const { getAllCompanies } = require("../controllers/company.controller");

const router = express.Router();

router.get("/all", authRequired, getAllCompanies);

module.exports = router;
