/**
 * test-product-family-diameter.js
 *
 * Regression smoke test for the "Product Family / Diameter" feature on
 * Project (see docs/product-family-diameter.md). This repo has no
 * Jest/Mocha/Supertest setup — following the existing convention in
 * src/scripts/ (standalone Node scripts run manually or in CI via `node`),
 * this script drives the REAL HTTP API of an already-running dev server
 * with a signed JWT, then asserts on the responses. It creates its own
 * test rows and deletes them again — safe to re-run.
 *
 * Prerequisites:
 *   - The Backend Master dev server must already be running
 *     (npm run dev / npm start), reachable at API_BASE_URL below.
 *   - A user row for TEST_USER_EMAIL must exist (any role NOT restricted
 *     by moduleAccessGuard.js — "responsable_logistique_achat" is blocked
 *     from /projects and will fail this test).
 *
 * Usage:
 *   node src/scripts/test-product-family-diameter.js
 *
 * Exit code 0 = all assertions passed, 1 = failure.
 */

require("dotenv").config();
const axios = require("axios");
const { sequelize } = require("../db");
const User = require("../models/User");
const Project = require("../models/Project");
const { signAccessToken } = require("../utils/tokens");

const API_BASE_URL = process.env.TEST_API_BASE_URL || `http://localhost:${process.env.PORT || 4000}`;
const TEST_USER_EMAIL = process.env.TEST_USER_EMAIL || "manegerofficecbi@gmail.com";
const NAME_PREFIX = "Test PFD Automated";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}`);
  }
}

async function run() {
  console.log("\n🧪  Product Family / Diameter — smoke test\n");

  const user = await User.findOne({ where: { email: TEST_USER_EMAIL } });
  if (!user) {
    throw new Error(
      `TEST_USER_EMAIL '${TEST_USER_EMAIL}' not found — seed it first or set TEST_USER_EMAIL to an existing unrestricted user.`
    );
  }

  const token = signAccessToken({ sub: user.id, email: user.email, role: user.role });
  const http = axios.create({
    baseURL: API_BASE_URL,
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true, // we assert on status ourselves
  });

  const createdIds = [];

  try {
    // ── 1. Create with a VALID family/diameter combo ─────────────────────
    const validCreate = await http.post("/projects", {
      nomProjet: `${NAME_PREFIX} valid ${Date.now()}`,
      dateDemarrage: "2026-07-21",
      typeAdresseChantier: "Chantier",
      firstAction: "Visite",
      dateVisite: "2026-07-21",
      latitude: 36.8,
      longitude: 10.2,
      projectModele: "project",
      productFamily: "PROBAR",
      diameterMm: 12,
    });
    assert(validCreate.status === 201 || validCreate.status === 200,
      `Create (PROBAR/Ø12) → HTTP ${validCreate.status}`);
    const created = validCreate.data?.project || validCreate.data;
    if (created?.id) createdIds.push(created.id);
    assert(created?.productFamily === "PROBAR", "Create → productFamily persisted as 'PROBAR'");
    assert(created?.diameterMm === 12, "Create → diameterMm persisted as integer 12 (not string)");

    // ── 2. Create with an INVALID combo (diameter not in family's list) ──
    const invalidCreate = await http.post("/projects", {
      nomProjet: `${NAME_PREFIX} invalid ${Date.now()}`,
      dateDemarrage: "2026-07-21",
      typeAdresseChantier: "Chantier",
      firstAction: "Visite",
      dateVisite: "2026-07-21",
      latitude: 36.8,
      longitude: 10.2,
      projectModele: "project",
      productFamily: "PROMESH",
      diameterMm: 12, // valid for PROBAR, NOT valid for PROMESH
    });
    assert(invalidCreate.status === 400,
      `Create (PROMESH/Ø12 — invalid combo) → HTTP ${invalidCreate.status} (expected 400)`);

    // ── 3. Update to a valid combo ────────────────────────────────────────
    if (created?.id) {
      const validUpdate = await http.put(`/projects/${created.id}`, {
        productFamily: "PROMESH",
        diameterMm: 8,
      });
      assert(validUpdate.status === 200, `Update → PROMESH/Ø8 → HTTP ${validUpdate.status}`);

      const afterValid = await Project.findByPk(created.id);
      assert(afterValid?.productFamily === "PROMESH", "Update → productFamily persisted as 'PROMESH'");
      assert(afterValid?.diameterMm === 8, "Update → diameterMm persisted as integer 8 (not string)");

      // ── 4. Update to a mismatched combo → rejected, previous value kept ──
      const invalidUpdate = await http.put(`/projects/${created.id}`, {
        productFamily: "PROMESH",
        diameterMm: 32, // valid for PROBAR, NOT valid for PROMESH
      });
      assert(invalidUpdate.status === 400,
        `Update (PROMESH/Ø32 — invalid combo) → HTTP ${invalidUpdate.status} (expected 400)`);

      const afterInvalid = await Project.findByPk(created.id);
      assert(afterInvalid?.diameterMm === 8,
        "Rejected update did not mutate diameterMm (still 8)");
    }

    // ── 5. List endpoint filters by productFamily ────────────────────────
    const list = await http.get("/projects", { params: { productFamily: "PROMESH", limit: 200 } });
    assert(list.status === 200, `GET /projects?productFamily=PROMESH → HTTP ${list.status}`);
    const items = list.data?.items || list.data?.data || (Array.isArray(list.data) ? list.data : []);
    const allPromesh = items.every((p) => p.productFamily === "PROMESH");
    assert(allPromesh, "GET /projects?productFamily=PROMESH → every row has productFamily === 'PROMESH'");

  } finally {
    // ── Cleanup — the API's DELETE is restricted to "main superadmin",
    //     so remove test rows directly via the model instead. ────────────
    for (const id of createdIds) {
      await Project.destroy({ where: { id } });
    }
    await sequelize.close();
  }

  console.log(`\n${passed} passed, ${failed} failed.\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("\n❌  Test script crashed:", err.message || err);
  console.error(err);
  process.exit(1);
});
