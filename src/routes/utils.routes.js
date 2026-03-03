// routes/utils.routes.js
const express = require("express");
const router = express.Router();

/**
 * Extract coordinates from Google Maps URL or short share URL.
 * Supports:
 * - @lat,lng
 * - q=lat,lng / query=lat,lng
 * - ll=lat,lng
 * - pb=...!3dLAT!4dLNG...
 * - place/<NAME>/  => fallback via /utils/geocode?q=<NAME>
 */

router.get("/expand-maps", async (req, res) => {
  try {
    const url = String(req.query.url || "").trim();
    if (!url) return res.status(400).json({ error: "url is required" });

    // follow redirects
    const r = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; CRMProbarBot/1.0)",
        "Accept": "text/html,*/*",
      },
    });

    const finalUrl = r.url || "";
    if (!finalUrl) {
      return res.status(422).json({ error: "Could not resolve finalUrl", finalUrl: "" });
    }

    const ok = (lat, lng) =>
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180;

    let m;

    // 1) .../@lat,lng
    m = finalUrl.match(/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
    if (m) {
      const lat = Number(m[1]), lng = Number(m[2]);
      if (ok(lat, lng)) return res.json({ lat, lng, finalUrl, method: "at" });
    }

    // 2) ...?q=lat,lng or query=lat,lng
    m = finalUrl.match(/(?:[?&](?:q|query)=)(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
    if (m) {
      const lat = Number(m[1]), lng = Number(m[2]);
      if (ok(lat, lng)) return res.json({ lat, lng, finalUrl, method: "q" });
    }

    // 3) ...?ll=lat,lng
    m = finalUrl.match(/(?:[?&]ll=)(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
    if (m) {
      const lat = Number(m[1]), lng = Number(m[2]);
      if (ok(lat, lng)) return res.json({ lat, lng, finalUrl, method: "ll" });
    }

    // 4) pb=...!3dLAT!4dLNG...
    m = finalUrl.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
    if (m) {
      const lat = Number(m[1]), lng = Number(m[2]);
      if (ok(lat, lng)) return res.json({ lat, lng, finalUrl, method: "pb_3d4d" });
    }

    // 5) sometimes inverted
    m = finalUrl.match(/!4d(-?\d+(?:\.\d+)?)!3d(-?\d+(?:\.\d+)?)/);
    if (m) {
      const lng = Number(m[1]), lat = Number(m[2]);
      if (ok(lat, lng)) return res.json({ lat, lng, finalUrl, method: "pb_4d3d" });
    }

    // ✅ 6) FALLBACK: extract place name and geocode it
    // example: https://www.google.com/maps/place/Mahdia/data=...
    const pm = finalUrl.match(/\/maps\/place\/([^\/\?]+)\//);
    if (pm && pm[1]) {
      const place = decodeURIComponent(pm[1]).replace(/\+/g, " ").trim();

      // call your own geocode route (same server) => /utils/geocode?q=place
      const base = `${req.protocol}://${req.get("host")}`;
      const geoUrl = `${base}/utils/geocode?q=${encodeURIComponent(place)}`;

      try {
        const gr = await fetch(geoUrl, { headers: { "Accept": "application/json" } });
        if (gr.ok) {
          const list = await gr.json();
          if (Array.isArray(list) && list.length > 0) {
            const best = list[0];
            const lat = Number(best.lat);
            const lng = Number(best.lon ?? best.lng);

            if (ok(lat, lng)) {
              return res.json({
                lat,
                lng,
                finalUrl,
                method: "fallback_geocode",
                place,
                geocodeUrl: geoUrl,
              });
            }
          }
        }
      } catch (_) {
        // ignore
      }
    }

    return res.status(422).json({ error: "No coordinates found", finalUrl });
  } catch (e) {
    return res.status(500).json({ error: "expand failed", details: String(e) });
  }
});

module.exports = router;