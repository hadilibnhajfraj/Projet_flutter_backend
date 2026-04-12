const express = require("express");
const axios = require("axios");

const router = express.Router();

// 🔥 Désactiver cache HTTP (IMPORTANT)
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// 🔥 cache mémoire
const cache = new Map();
const TTL_MS = 60 * 1000;

function getCache(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() - v.t > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return v.data;
}

function setCache(key, data) {
  cache.set(key, { t: Date.now(), data });
}

// 🔥 villes fallback Tunisie
const TUNISIA_CITIES = [
  "tunis", "ariana", "sfax", "sousse",
  "bizerte", "nabeul", "gabes", "kairouan"
];

function extractCity(q) {
  const words = q.toLowerCase().split(" ");
  for (const w of words) {
    for (const city of TUNISIA_CITIES) {
      if (w.includes(city)) return city;
    }
  }
  return null;
}

// 🔥 appel Nominatim (corrigé)
async function geocode(q) {
  try {
    const { data } = await axios.get(
      "https://nominatim.openstreetmap.org/search",
      {
        params: {
          q,
          format: "json",
          addressdetails: 1,
          limit: 5,
          countrycodes: "tn",
        },
        timeout: 12000,
        headers: {
          "User-Agent": "CETIME-CRM/1.0 (contact@cetime.com)", // 🔥 OBLIGATOIRE
        },
      }
    );

    return (data || []).map((j) => ({
      displayName: j.display_name,
      lat: Number(j.lat),
      lon: Number(j.lon),
      type: "exact", // 🔥 NEW
    }));
  } catch (e) {
    console.error("NOMINATIM ERROR:", e.message);
    return [];
  }
}

// ==========================
// 🔥 ROUTE PRINCIPALE
// ==========================
router.get("/geocode", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();

    if (q.length < 3) return res.json([]);

    const key = q.toLowerCase();

    // 🔥 cache
    const cached = getCache(key);
    if (cached) return res.json(cached);

    let results = [];

    // ==========================
    // 1. RECHERCHE NORMALE
    // ==========================
    results = await geocode(q);

    // ==========================
    // 2. FALLBACK (VILLE)
    // ==========================
    if (results.length === 0) {
      const city = extractCity(q);

      if (city) {
        const fallbackResults = await geocode(city);

        if (fallbackResults.length > 0) {
          results = fallbackResults.map((r) => ({
            ...r,
            displayName: r.displayName + " (approx)",
            type: "approx", // 🔥 NEW
          }));
        }
      }
    }

    // ==========================
    // 3. DERNIER FALLBACK
    // ==========================
    if (results.length === 0) {
      results = [
        {
          displayName: q,
          lat: null,
          lon: null,
          type: "manual", // 🔥 NEW
        },
      ];
    }

    // 🔥 cache
    setCache(key, results);

    res.json(results);

  } catch (e) {
    console.error("GEOCODE ERROR:", e.message);

    return res.json([
      {
        displayName: "Erreur réseau",
        lat: null,
        lon: null,
        type: "error",
      },
    ]);
  }
});

module.exports = router;