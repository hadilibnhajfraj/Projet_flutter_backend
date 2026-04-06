const express = require("express");
const multer = require("multer");
const fs = require("fs");
const XLSX = require("xlsx");
const Client = require("../models/client.model");
const { authRequired } = require("../middleware/auth.middleware");
const router = express.Router();
const upload = multer({ dest: "uploads/" });
const { sequelize } = require("../db");
function cleanValue(value) {
  if (value === undefined || value === null) return null;

  const v = String(value).trim();

  if (v === "" || v === "*" || v === "null" || v === "undefined") {
    return null;
  }

  return v;
}

function parseDate(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  // Cas 1 : date Excel numérique
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return null;

    const year = parsed.y;
    const month = String(parsed.m).padStart(2, "0");
    const day = String(parsed.d).padStart(2, "0");

    return `${year}-${month}-${day}`;
  }

  const str = String(value).trim();

  // Cas 2 : format JJ/MM/AAAA
  let match = str.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (match) {
    const [, day, month, year] = match;
    return `${year}-${month}-${day}`;
  }

  // Cas 3 : format JJ-MM-AAAA
  match = str.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (match) {
    const [, day, month, year] = match;
    return `${year}-${month}-${day}`;
  }

  // Cas 4 : format YYYY-MM-DD
  match = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    return str;
  }

  // Cas 5 : format YY-MM-DD => on transforme en 20YY-MM-DD
  match = str.match(/^(\d{2})-(\d{2})-(\d{2})$/);
  if (match) {
    const [, yy, month, day] = match;
    return `20${yy}-${month}-${day}`;
  }

  return null;
}
function normalize(str) {
  return str
    ?.toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
router.post("/import-csv", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "Aucun fichier envoyé." });
    }

    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    // lecture brute en tableau
    const rows = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: "",
      raw: true,
    });

    if (!rows || rows.length === 0) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ message: "Le fichier est vide." });
    }

    // En-têtes selon ta capture
    // Ligne Excel visible = ligne 1, mais dans JS index = 0
    const headers = rows[0].map((h) => String(h).trim());

    const dataRows = rows.slice(1);

    const clients = dataRows.map((row) => {
      const rowObj = {};
      headers.forEach((header, index) => {
        rowObj[header] = row[index];
      });

      return {
        code: cleanValue(rowObj["Code"]),
        raisonSociale: cleanValue(rowObj["Raison sociale"]),
        adresse: cleanValue(rowObj["Adresse"]),
        codePostal: cleanValue(rowObj["Code postal"]),
        region: cleanValue(rowObj["Région"]),
        creeLe: parseDate(rowObj["Créé le"]),
        regime: cleanValue(rowObj["Régime"]),
        matriculeFiscal: cleanValue(rowObj["Matricule fiscal"]),
        identifiantUnique: cleanValue(rowObj["Identifiant unique"]),
        contact: cleanValue(rowObj["Contacte"]),
      };
    });

    // supprimer les lignes totalement vides
    const filteredClients = clients.filter((item) =>
      Object.values(item).some((val) => val !== null && val !== "")
    );

    if (filteredClients.length === 0) {
      fs.unlinkSync(req.file.path);
      return res.status(200).json({
        message: "Aucune donnée exploitable trouvée dans le fichier.",
        total: 0,
      });
    }

    await Client.bulkCreate(filteredClients);

    fs.unlinkSync(req.file.path);

    return res.status(200).json({
      message: "Import Excel terminé avec succès.",
      total: filteredClients.length,
    });
  } catch (error) {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    return res.status(500).json({
      message: "Erreur lors de l'import du fichier Excel.",
      error: error.message,
    });
  }
});
router.get("/all", authRequired, async (req, res) => {
  try {
    const clients = await Client.findAll({
      attributes: [
        "id",
        "code",
        "raisonSociale",
        "adresse",
        "codePostal",
        "region",
        "creeLe",
        "regime",
        "matriculeFiscal",
        "identifiantUnique",
        "contact",
        "derniereFacturation", // ✅ AJOUT ICI
      ],
      order: [["id", "ASC"]],
    });

    return res.status(200).json(clients);
  } catch (error) {
    return res.status(500).json({
      message: "Erreur lors de la récupération des clients",
      error: error.message,
    });
  }
});
router.post("/import-factures", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "Aucun fichier envoyé." });
    }

    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    const rows = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: "",
      raw: true,
    });

    const headers = rows[0].map((h) => String(h).trim());
    const dataRows = rows.slice(1);

    let updated = 0;
    let created = 0;

    for (const row of dataRows) {
      const rowObj = {};
      headers.forEach((header, index) => {
        rowObj[header] = row[index];
      });

      const raisonSociale = cleanValue(rowObj["Raison sociale"]);
      const dateFacture = parseDate(rowObj["Date"]);

      if (!raisonSociale || !dateFacture) continue;

      // 🔍 chercher client existant
     let client = await Client.findOne({
  where: sequelize.where(
    sequelize.fn("LOWER", sequelize.col("raisonSociale")),
    normalize(raisonSociale)
  ),
});

      if (client) {
        // ✅ UPDATE
        await client.update({
          derniereFacturation: dateFacture,
        });
        updated++;
      } else {
        // ➕ CREATE (client minimal)
        await Client.create({
          raisonSociale,
          derniereFacturation: dateFacture,
          contact: null,
        });
        created++;
      }
    }

    fs.unlinkSync(req.file.path);

    return res.status(200).json({
      message: "Import factures terminé",
      updated,
      created,
    });
  } catch (error) {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    return res.status(500).json({
      message: "Erreur import factures",
      error: error.message,
    });
  }
});
module.exports = router;