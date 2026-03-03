// routes/utils.routes.js
const express = require("express");
const router = express.Router();

router.get("/expand-maps", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "url is required" });

    const r = await fetch(url, { redirect: "follow" });
    const finalUrl = r.url || "";

    const m1 = finalUrl.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    if (m1) return res.json({ lat: Number(m1[1]), lng: Number(m1[2]), finalUrl });

    const m2 = finalUrl.match(/(?:query=|q=)(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
    if (m2) return res.json({ lat: Number(m2[1]), lng: Number(m2[2]), finalUrl });

    return res.status(422).json({ error: "No coordinates found", finalUrl });
  } catch (e) {
    return res.status(500).json({ error: "expand failed", details: String(e) });
  }
});

module.exports = router;