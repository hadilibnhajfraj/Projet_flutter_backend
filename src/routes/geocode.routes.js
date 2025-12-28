const express = require("express");
const axios = require("axios");

const router = express.Router();

// cache simple
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

function isLikelyUrl(s) {
  return /^https?:\/\//i.test(s);
}

function extractCoordsFromGoogleUrl(url) {
  // .../@lat,lng,....
  const m1 = url.match(/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
  if (m1) return { lat: Number(m1[1]), lon: Number(m1[2]) };

  // ...!3dlat!4dlng...
  const m2 = url.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (m2) return { lat: Number(m2[1]), lon: Number(m2[2]) };

  return null;
}

async function resolveFinalUrl(inputUrl) {
  const resp = await axios.get(inputUrl, {
    maxRedirects: 8,
    timeout: 12000,
    headers: { Accept: "text/html,application/json" },
    validateStatus: () => true,
  });

  return (
    resp?.request?.res?.responseUrl ||
    resp?.request?._redirectable?._currentUrl ||
    inputUrl
  );
}

function normalizeResultsFromNominatim(data) {
  const arr = Array.isArray(data) ? data : [];
  return arr
    .map((j) => ({
      displayName: String(j?.display_name || ""),
      lat: Number(j?.lat),
      lon: Number(j?.lon),
    }))
    .filter((x) => x.displayName && Number.isFinite(x.lat) && Number.isFinite(x.lon));
}

async function geocodeNominatim(q) {
  const { data } = await axios.get("https://nominatim.openstreetmap.org/search", {
    params: { q, format: "json", addressdetails: 1, limit: 8 },
    timeout: 12000,
    headers: { Accept: "application/json" }, // ✅ sans UA
    validateStatus: () => true,
  });

  return normalizeResultsFromNominatim(data);
}

// GET /utils/geocode?q=...
router.get("/geocode", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    if (q.length < 3) return res.json([]);

    const key = q.toLowerCase();
    const cached = getCache(key);
    if (cached) return res.json(cached);

    // 1) lien Google Maps
    if (isLikelyUrl(q) && (q.includes("maps.app.goo.gl") || q.includes("google.com/maps"))) {
      const finalUrl = await resolveFinalUrl(q);
      const coords = extractCoordsFromGoogleUrl(finalUrl);

      if (coords) {
        const out = [{ displayName: "Google Maps link", lat: coords.lat, lon: coords.lon }];
        setCache(key, out);
        return res.json(out);
      }
    }

    // 2) adresse normale
    const r = await geocodeNominatim(q);
    setCache(key, r);
    return res.json(r);
  } catch (e) {
    console.error("GEOCODE_ERROR:", e?.response?.status || e.message);
    return res.status(200).json([]);
  }
});

module.exports = router;
