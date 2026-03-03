// routes/utils.routes.js
const express = require("express");
const router = express.Router();

/**
 * GET /utils/expand-maps?url=<google_maps_share_url>
 * - Follows redirects (maps.app.goo.gl / goo.gl/maps)
 * - Extracts coordinates from multiple final URL formats:
 *   1) .../@lat,lng,zoom
 *   2) ...?q=lat,lng or ...?query=lat,lng
 *   3) ...?ll=lat,lng
 *   4) ...pb=...!3dLAT!4dLNG... (very common from mobile share)
 *   5) fallback: extract first pair of numbers that look like lat/lng (safe-ish)
 */
router.get("/expand-maps", async (req, res) => {
  try {
    const url = String(req.query.url || "").trim();
    if (!url) return res.status(400).json({ error: "url is required" });

    // ✅ Follow redirects
    const r = await fetch(url, {
      redirect: "follow",
      headers: {
        // helps some google responses
        "User-Agent": "Mozilla/5.0 (compatible; CRMProbarBot/1.0)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    const finalUrl = r.url || "";
    if (!finalUrl) {
      return res.status(422).json({ error: "Could not resolve finalUrl", finalUrl: "" });
    }

    // Helper: validate lat/lng ranges
    const ok = (lat, lng) =>
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180;

    // Try patterns in order
    let m;

    // 1) .../@lat,lng
    m = finalUrl.match(/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (ok(lat, lng)) return res.json({ lat, lng, finalUrl });
    }

    // 2) ...?q=lat,lng  or  ...?query=lat,lng
    m = finalUrl.match(/(?:[?&](?:q|query)=)(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (ok(lat, lng)) return res.json({ lat, lng, finalUrl });
    }

    // 3) ...?ll=lat,lng
    m = finalUrl.match(/(?:[?&]ll=)(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (ok(lat, lng)) return res.json({ lat, lng, finalUrl });
    }

    // 4) pb=...!3dLAT!4dLNG...  (mobile share often)
    m = finalUrl.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (ok(lat, lng)) return res.json({ lat, lng, finalUrl });
    }

    // 5) Sometimes inverted order exists: !4dLNG!3dLAT
    m = finalUrl.match(/!4d(-?\d+(?:\.\d+)?)!3d(-?\d+(?:\.\d+)?)/);
    if (m) {
      const lng = Number(m[1]);
      const lat = Number(m[2]);
      if (ok(lat, lng)) return res.json({ lat, lng, finalUrl });
    }

    // 6) Fallback: find first plausible lat,lng pair in URL (conservative)
    // looks for "...<lat>,<lng>..." anywhere
    m = finalUrl.match(/(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (ok(lat, lng)) return res.json({ lat, lng, finalUrl });
    }

    return res.status(422).json({ error: "No coordinates found", finalUrl });
  } catch (e) {
    return res.status(500).json({ error: "expand failed", details: String(e) });
  }
});

module.exports = router;