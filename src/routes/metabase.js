const express = require("express");
const router = express.Router();
const generateMetabaseToken = require("../utils/metabaseToken");
const verifyToken = require("../middleware/verifyToken");

router.get("/token", verifyToken, (req, res) => {
  const token = generateMetabaseToken(req.user);
  res.json({ token });
});

module.exports = router;