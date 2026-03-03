// src/routes/utils.routes.js
const express = require("express");
const router = express.Router();

/**
 * GET /utils/expand-maps?url=<maps share url>
 * Supports:
 * - @lat,lng
 * - q=lat,lng / query=lat,lng
 * - ll=lat,lng
 * - pb=...!3dLAT!4dLNG... or !4dLNG!3dLAT
 * - /maps/place/<NAME>/  => fallback via Nominatim (OSM)
 */
router.get("/expand-maps", async (req, res) => {
  try {
    const url = String(req.query.url || "").trim();
    if (!url) return res.status(400).json({ error: "url is required" });

    // Follow redirects
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
      lat >= -90 && lat <= 90 &&
      lng >= -180 && lng <= 180;

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

    // 5) sometimes inverted pb: !4dLNG!3dLAT
    m = finalUrl.match(/!4d(-?\d+(?:\.\d+)?)!3d(-?\d+(?:\.\d+)?)/);
    if (m) {
      const lng = Number(m[1]), lat = Number(m[2]);
      if (ok(lat, lng)) return res.json({ lat, lng, finalUrl, method: "pb_4d3d" });
    }

    // ✅ 6) FALLBACK: /maps/place/<NAME>/ => Nominatim (try 2 queries)
    const pm = finalUrl.match(/\/maps\/place\/([^\/\?]+)(?:\/|\?|$)/);
    if (pm && pm[1]) {
      const placeRaw = decodeURIComponent(pm[1]).replace(/\+/g, " ").trim();

      const tryQueries = [
        `${placeRaw}, Tunisia`, // ex: Mahdia, Tunisia
        `${placeRaw}`,          // ex: Rue Slimane El Hrairi, Tunis
      ];

      for (const q of tryQueries) {
        const nomUrl =
          "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
          encodeURIComponent(q);

        const nr = await fetch(nomUrl, {
          headers: {
            "User-Agent": "CRMProbar/1.0 (contact@cbi-tunisia.com)",
            "Accept": "application/json",
          },
        });

        if (nr.status === 429) {
          return res.status(503).json({
            error: "Nominatim rate limited (429). Retry later.",
            finalUrl,
            method: "fallback_nominatim_429",
            place: placeRaw,
            triedQuery: q,
          });
        }

        if (!nr.ok) continue;

        const list = await nr.json();
        if (Array.isArray(list) && list.length > 0) {
          const lat = Number(list[0].lat);
          const lng = Number(list[0].lon);

          if (ok(lat, lng)) {
            return res.json({
              lat,
              lng,
              finalUrl,
              method: "fallback_nominatim",
              place: placeRaw,
              nominatimQuery: q,
            });
          }
        }
      }
    }

    // If nothing matched
    return res.status(422).json({ error: "No coordinates found", finalUrl });
  } catch (e) {
    return res.status(500).json({ error: "expand failed", details: String(e) });
  }
});

module.exports = router;