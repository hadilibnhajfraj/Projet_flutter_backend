// src/routes/utils.routes.js
const express = require("express");
const router = express.Router();

router.get("/expand-maps", async (req, res) => {
  try {
    const url = String(req.query.url || "").trim();
    if (!url) return res.status(400).json({ error: "url is required" });

    // 1) follow redirects from short URL
    const r = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; CRMProbarBot/1.0)",
        "Accept": "text/html,*/*",
      },
    });

    let finalUrl = r.url || "";
    if (!finalUrl) {
      return res.status(422).json({ error: "Could not resolve finalUrl", finalUrl: "" });
    }

    const ok = (lat, lng) =>
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      lat >= -90 && lat <= 90 &&
      lng >= -180 && lng <= 180;

    const tryParseFromUrl = (u) => {
      let m;

      // @lat,lng
      m = u.match(/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
      if (m) {
        const lat = Number(m[1]), lng = Number(m[2]);
        if (ok(lat, lng)) return { lat, lng, method: "at" };
      }

      // q=lat,lng or query=lat,lng
      m = u.match(/(?:[?&](?:q|query)=)(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
      if (m) {
        const lat = Number(m[1]), lng = Number(m[2]);
        if (ok(lat, lng)) return { lat, lng, method: "q" };
      }

      // ll=lat,lng
      m = u.match(/(?:[?&]ll=)(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
      if (m) {
        const lat = Number(m[1]), lng = Number(m[2]);
        if (ok(lat, lng)) return { lat, lng, method: "ll" };
      }

      // pb !3dLAT!4dLNG
      m = u.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
      if (m) {
        const lat = Number(m[1]), lng = Number(m[2]);
        if (ok(lat, lng)) return { lat, lng, method: "pb_3d4d" };
      }

      // pb inverted !4dLNG!3dLAT
      m = u.match(/!4d(-?\d+(?:\.\d+)?)!3d(-?\d+(?:\.\d+)?)/);
      if (m) {
        const lng = Number(m[1]), lat = Number(m[2]);
        if (ok(lat, lng)) return { lat, lng, method: "pb_4d3d" };
      }

      return null;
    };

    // 2) parse directly from finalUrl
    const direct = tryParseFromUrl(finalUrl);
    if (direct) return res.json({ ...direct, finalUrl });

    // ✅ 3) If /maps/place/<NAME>/, try GOOGLE search redirect first (super efficace)
    const pm = finalUrl.match(/\/maps\/place\/([^\/\?]+)(?:\/|\?|$)/);
    if (pm && pm[1]) {
      const placeRaw = decodeURIComponent(pm[1]).replace(/\+/g, " ").trim();

      // 3-a) Google Maps search redirect => often returns @lat,lng or pb coords
      try {
        const searchUrl =
          "https://www.google.com/maps/search/?api=1&query=" +
          encodeURIComponent(placeRaw);

        const rr = await fetch(searchUrl, {
          redirect: "follow",
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; CRMProbarBot/1.0)",
            "Accept": "text/html,*/*",
          },
        });

        const redirected = rr.url || "";
        if (redirected) {
          const parsed2 = tryParseFromUrl(redirected);
          if (parsed2) {
            return res.json({
              ...parsed2,
              finalUrl,
              method: "google_search_redirect",
              place: placeRaw,
              redirectedUrl: redirected,
            });
          }
        }
      } catch (_) {
        // ignore
      }

      // 3-b) Nominatim fallback (try 2 queries)
      const tryQueries = [`${placeRaw}, Tunisia`, `${placeRaw}`];

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

    return res.status(422).json({ error: "No coordinates found", finalUrl });
  } catch (e) {
    return res.status(500).json({ error: "expand failed", details: String(e) });
  }
});

module.exports = router;