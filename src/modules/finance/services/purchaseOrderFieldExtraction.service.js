"use strict";

// Extraction de champs structurés pour un BON DE COMMANDE ("Inflow of raw
// materials" — §CORRECTION — EXTRACTION AUTOMATIQUE DES BONS DE COMMANDE).
// Même architecture positionnelle (coordonnées X/Y réelles des mots, jamais
// l'ordre linéaire du texte) qu'invoiceFieldExtraction.service.js et
// deliveryNoteFieldExtraction.service.js — un document réel (NADEC,
// BCL260005) a le même bloc client SANS libellé adjacent que certaines
// factures, repéré par la FORME du code client, pas par un mot voisin.

const { PDFParse } = require("pdf-parse");
const { normalizeNumber, normalizeDate } = require("./invoiceNormalization.service");

function field(value, confidence) {
  return { value: value === undefined ? null : value, confidence: value === null || value === undefined ? 0 : confidence };
}

// ── REPLI TEXTE LINÉAIRE (documents sans mots positionnés disponibles) ──
function extractLabeled(text, labelPatterns, { maxLength = 200 } = {}) {
  for (const label of labelPatterns) {
    const re = new RegExp(`${label}\\s*[:\\-]?\\s*([^\\n]{1,${maxLength}})`, "i");
    const m = text.match(re);
    if (m) {
      const value = m[1].trim().replace(/\s{2,}/g, " ");
      if (value) return field(value, 0.9);
    }
  }
  return field(null, 0);
}

function extractOrderNumberLinear(text) {
  return extractLabeled(text, ["NUM[ÉE]RO(?!\\s*(?:DE\\s*)?T[ÉE]L)", "BON\\s*DE\\s*COMMANDE\\s*N[°ºo:]*", "N[°ºo]\\s*(?:DE\\s*)?COMMANDE"], {
    maxLength: 30,
  });
}

function extractOrderDateLinear(text) {
  const labeled = extractLabeled(text, ["DATE"], { maxLength: 20 });
  if (labeled.value) {
    const normalized = normalizeDate(labeled.value);
    if (normalized) return field(normalized, 0.9);
  }
  return field(null, 0);
}

// ── TABLEAU DE LIGNES (Référence/Désignation/Unité/Qté/PU.HT/Montant HT) ──

const COLUMN_KEYWORDS = [
  { key: "reference", patterns: ["REF", "REFERENCE"] },
  { key: "designation", patterns: ["DESIGNATION", "LIBELLE"] },
  { key: "unit", patterns: ["UNITE", "UNIT"] },
  { key: "quantity", patterns: ["QTE", "QTY", "QUANTITE"] },
  // "PU" seul est trop court (risque de faux positif dans une désignation
  // contenant "PU" par coïncidence, ex. "TUYAU PU") — seul "PUHT" (normalisé
  // depuis "PU.HT"/"P.U HT") ou le mot complet sont retenus.
  { key: "unitPriceHT", patterns: ["PUHT", "PRIXUNITAIRE"] },
  { key: "amountHT", patterns: ["MONTANT", "AMOUNT"] },
];

function normalizeHeaderCell(cell) {
  return String(cell || "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Z]/g, "");
}

function matchColumnKey(headerCell) {
  const norm = normalizeHeaderCell(headerCell);
  if (!norm || norm.length < 2) return null;
  for (const { key, patterns } of COLUMN_KEYWORDS) {
    // `norm.includes(p)` (l'en-tête contient le mot-clé) est sûr quelle que
    // soit la longueur. `p.includes(norm)` (norm est une ABRÉVIATION du
    // mot-clé) est dangereux si `norm` est très court : un code client, une
    // fois les chiffres retirés par normalizeHeaderCell, peut se réduire à
    // 2 lettres qui se trouvent être une sous-chaîne d'un mot-clé par pur
    // hasard (déjà rencontré : "C1745741E" → "CE" ⊂ "REFERENCE"). On exige
    // donc au moins 3 caractères pour cette direction.
    if (patterns.some((p) => norm.includes(p) || (norm.length >= 3 && p.includes(norm)))) return key;
  }
  return null;
}

const NUMERIC_ITEM_FIELDS = new Set(["quantity", "unitPriceHT", "amountHT"]);

function buildItemFromCells(columnKeys, cells) {
  const item = {};
  let filled = 0;
  columnKeys.forEach((key, i) => {
    if (!key) return;
    const raw = (cells[i] || "").trim();
    if (!raw) return;
    const value = NUMERIC_ITEM_FIELDS.has(key) ? normalizeNumber(raw) : raw;
    if (value !== null && value !== undefined && value !== "") {
      item[key] = value;
      filled += 1;
    }
  });
  return { item, filled };
}

// Chemin PDF texte natif : tableau bordé détecté par pdf-parse.getTable()
// (fiable pour un vrai tableau bordé) — repli si rien trouvé.
async function extractItemsFromPdfTable(filePath) {
  const fs = require("fs");
  const parser = new PDFParse({ data: fs.readFileSync(filePath) });
  try {
    const result = await parser.getTable();
    const items = [];
    for (const page of result.pages || []) {
      for (const table of page.tables || []) {
        if (!table.length) continue;
        const columnKeys = table[0].map((h) => matchColumnKey(h));
        if (!columnKeys.some(Boolean)) continue;
        for (let r = 1; r < table.length; r++) {
          const { item, filled } = buildItemFromCells(columnKeys, table[r]);
          if (filled >= 2) items.push({ ...item, confidence: Math.min(0.9, 0.4 + filled * 0.1) });
        }
      }
    }
    return items;
  } catch (_) {
    return [];
  } finally {
    await parser.destroy();
  }
}

// Reconstruction par position des mots (coordonnées X/Y réelles) — même
// algorithme que les autres modules Finance : regroupe par rangée Y, trouve
// la ligne d'en-tête (celle qui matche le plus de mots-clés colonnes), puis
// affecte chaque mot des lignes suivantes à sa colonne par position X.
function extractItemsFromWords(words) {
  if (!words || !words.length) return [];

  const sorted = [...words].sort((a, b) => a.top - b.top);
  const medianHeight = sorted.map((w) => w.height).sort((a, b) => a - b)[Math.floor(sorted.length / 2)] || 20;
  const rowTolerance = medianHeight * 0.6;

  const rows = [];
  for (const w of sorted) {
    const centerY = w.top + w.height / 2;
    let row = rows.find((r) => Math.abs(r.centerY - centerY) <= rowTolerance);
    if (!row) {
      row = { centerY, words: [] };
      rows.push(row);
    }
    row.words.push(w);
  }
  rows.forEach((r) => r.words.sort((a, b) => a.left - b.left));

  let headerIdx = -1;
  let bestMatches = 0;
  rows.forEach((row, i) => {
    const matches = row.words.filter((w) => matchColumnKey(w.text)).length;
    if (matches > bestMatches) {
      bestMatches = matches;
      headerIdx = i;
    }
  });
  if (headerIdx === -1 || bestMatches < 2) return [];

  const columns = rows[headerIdx].words
    .map((w) => ({ key: matchColumnKey(w.text), left: w.left, right: w.left + w.width }))
    .filter((c) => c.key);
  columns.sort((a, b) => a.left - b.left);
  columns.forEach((c, i) => {
    c.rangeStart = i === 0 ? -Infinity : (columns[i - 1].right + c.left) / 2;
    c.rangeEnd = i === columns.length - 1 ? Infinity : (c.right + columns[i + 1].left) / 2;
  });

  const items = [];
  const stopWords = ["TOTAL"];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const lineText = normalizeHeaderCell(rows[i].words.map((w) => w.text).join(""));
    if (stopWords.some((s) => lineText.includes(normalizeHeaderCell(s)))) break;

    const cellsByKey = {};
    for (const w of rows[i].words) {
      const center = w.left + w.width / 2;
      const col = columns.find((c) => center >= c.rangeStart && center < c.rangeEnd);
      if (!col) continue;
      cellsByKey[col.key] = cellsByKey[col.key] ? `${cellsByKey[col.key]} ${w.text}` : w.text;
    }
    const columnKeys = Object.keys(cellsByKey);
    const cells = columnKeys.map((k) => cellsByKey[k]);
    const { item, filled } = buildItemFromCells(columnKeys, cells);
    if (filled >= 2) items.push({ ...item, confidence: Math.min(0.85, 0.3 + filled * 0.12) });
  }
  return items;
}

async function extractPurchaseOrderItems({ filePath, engine, pages }) {
  if (engine === "pdf-text") {
    const items = await extractItemsFromPdfTable(filePath);
    if (items.length) return items;
  }
  const allWords = (pages || []).flatMap((p) => p.words || []);
  return extractItemsFromWords(allWords);
}

// Un libellé du document ne doit jamais se retrouver enregistré comme une
// valeur — filet de sécurité final, structurel (jamais un masquage regex
// après coup, la source du mapping ci-dessous est déjà correcte).
const KNOWN_LABELS = [
  "Numéro", "Date", "N° télécopie", "Livraison", "Adresse de livraison", "Référence",
  "Désignation", "Unité", "Qté", "PU.HT", "PU HT", "Montant HT", "TOTAL HT", "Bon de commande",
];
const NORMALIZED_KNOWN_LABELS = new Set(KNOWN_LABELS.map(normalizeHeaderCell));
function isOcrLabel(value) {
  if (!value) return false;
  return NORMALIZED_KNOWN_LABELS.has(normalizeHeaderCell(String(value)));
}
function sanitizeFieldAgainstLabels(f) {
  if (f && typeof f.value === "string" && isOcrLabel(f.value)) return field(null, 0);
  return f;
}
function looksLikeConcatenatedHeaderRow(value) {
  if (!value) return false;
  const tokens = String(value).split(/[\s\t]+/).filter(Boolean);
  if (tokens.length < 2) return false;
  return tokens.filter((t) => matchColumnKey(t)).length >= 2;
}
function sanitizeItemAgainstLabels(item) {
  const clean = { ...item };
  for (const key of ["reference", "designation", "unit"]) {
    if (typeof clean[key] !== "string") continue;
    if (isOcrLabel(clean[key]) || looksLikeConcatenatedHeaderRow(clean[key])) delete clean[key];
  }
  return clean;
}
function hasEnoughRealItemFields(item) {
  return Object.keys(item).filter((k) => k !== "confidence").length >= 2;
}

// ══════════════════════════════════════════════════════════════════════
// EXTRACTION POSITIONNELLE (coordonnées X/Y réelles) — stratégie PRINCIPALE
// ══════════════════════════════════════════════════════════════════════

const POSITIONAL_LABELS = {
  orderNumber: /BON\s*DE\s*COMMANDE\s*N[°ºo:]*|N[°ºo]\s*(?:DE\s*)?COMMANDE|NUM[ÉE]RO(?!\s*(?:DE\s*)?T[ÉE]L)/i,
  orderDate: /^DATE$/i,
  fax: /N[°ºo]\s*T[ÉE]L[ÉE]?COPIE|^FAX$/i,
  deliveryAddress: /ADRESSE\s*(?:DE\s*)?LIVRAISON|^LIVRAISON$/i,
  totalHT: /^TOTAL\s*HT$/i,
};
const POSITIONAL_SECTION_MARKERS = [
  /^BON\s*DE\s*COMMANDE$/i,
  /^PAGE$/i,
  /SAGE/i,
];

// Certains BC impriment "Libellé:"/"Libellé =" en mot séparé de sa valeur,
// d'autres "Libellé: Valeur" comme UNE SEULE chaîne — seule la partie AVANT
// le premier séparateur doit être testée contre les patterns de libellé.
function positionalLabelPrefix(text) {
  if (!text) return "";
  const trimmed = text.trim().replace(/[:=]\s*$/, "");
  const sepIdx = trimmed.search(/[:=]/);
  return sepIdx === -1 ? trimmed : trimmed.slice(0, sepIdx).trim();
}

function isPositionalLabel(text) {
  if (!text) return false;
  const normalized = positionalLabelPrefix(text);
  if (Object.values(POSITIONAL_LABELS).some((re) => re.test(normalized))) return true;
  if (POSITIONAL_SECTION_MARKERS.some((re) => re.test(normalized))) return true;
  return Boolean(matchColumnKey(normalized));
}

function findAllPositionalLabels(words) {
  return words.filter((w) => isPositionalLabel(w.text));
}

// PASSE 1 — paires "libellé : valeur" sur la MÊME rangée.
function claimPositionalSameRowValues(words, labels, claimed) {
  const result = new Map();
  for (const label of labels) {
    const hasRowSiblings = labels.some((o) => o !== label && Math.abs(o.top - label.top) < 20);
    const maxGap = hasRowSiblings ? 70 : Infinity;

    const sameRow = words
      .filter((w) => !claimed.has(w) && w !== label && !isPositionalLabel(w.text))
      .filter((w) => Math.abs(w.top - label.top) <= 2.5 && w.left > label.left + label.width - 5)
      .filter((w) => w.left - (label.left + label.width) <= maxGap)
      .sort((a, b) => a.left - b.left);
    if (!sameRow.length) continue;

    const group = [sameRow[0]];
    for (let i = 1; i < sameRow.length; i++) {
      const prevEnd = group[group.length - 1].left + group[group.length - 1].width;
      if (sameRow[i].left - prevEnd > 20) break;
      group.push(sameRow[i]);
    }
    result.set(label, group.map((w) => w.text).join(" "));
    group.forEach((w) => claimed.add(w));
  }
  return result;
}

// PASSE 2 — pour les libellés sans valeur "même rangée" : cherche EN
// DESSOUS dans la même colonne, bornée par le PROCHAIN libellé de cette
// colonne et par la compétition avec les libellés "voisins".
function findPositionalValueLines(words, labelWord, allLabels, claimed, { xTolerance = 150, maxGapY = 40, maxLines = 6 } = {}) {
  if (!labelWord) return [];

  const nextLabelBelow = allLabels
    .filter((o) => o !== labelWord && o.top > labelWord.top + 5 && Math.abs(o.left - labelWord.left) <= 35)
    .sort((a, b) => a.top - b.top)[0];
  const yCeiling = nextLabelBelow ? nextLabelBelow.top - 2 : Infinity;

  const siblingLabels = allLabels.filter((o) => o !== labelWord && Math.abs(o.top - labelWord.top) < 20);

  const candidates = words
    .filter((w) => !claimed.has(w) && w !== labelWord)
    .filter((w) => w.top > labelWord.top + labelWord.height * 0.3)
    .filter((w) => w.top < yCeiling)
    .filter((w) => Math.abs(w.left - labelWord.left) <= xTolerance)
    .filter((w) => {
      const myDist = Math.abs(w.left - labelWord.left);
      return siblingLabels.every((other) => Math.abs(w.left - other.left) >= myDist);
    })
    .sort((a, b) => a.top - b.top);

  const rows = [];
  for (const w of candidates) {
    let row = rows.find((r) => Math.abs(r.top - w.top) <= 4);
    if (!row) {
      row = { top: w.top, items: [] };
      rows.push(row);
    }
    row.items.push(w);
  }
  rows.forEach((r) => r.items.sort((a, b) => a.left - b.left));
  rows.sort((a, b) => a.top - b.top);

  const lines = [];
  let lastY = labelWord.top;
  for (const row of rows) {
    if (row.top - lastY > maxGapY) break;
    if (row.items.some((it) => isPositionalLabel(it.text))) break;
    const text = row.items.map((it) => it.text).join(" ");
    if (!/^VIDE$/i.test(text)) lines.push(text);
    row.items.forEach((it) => claimed.add(it));
    lastY = row.top;
    if (lines.length >= maxLines) break;
  }
  return lines;
}

function buildPositionalExtractor(words, claimed) {
  const allLabels = findAllPositionalLabels(words);
  const sameRowValues = claimPositionalSameRowValues(words, allLabels, claimed);

  return function extractPositionalField(pattern, opts) {
    opts = opts || {};
    const candidateLabels = opts.beforeY != null ? allLabels.filter((w) => w.top < opts.beforeY) : allLabels;
    const label = candidateLabels.find((w) => pattern.test(positionalLabelPrefix(w.text)));
    if (!label) return field(null, 0);

    const embeddedMatch = label.text.match(/[:=]\s*(\S.*)$/);
    if (embeddedMatch) {
      const embedded = embeddedMatch[1].trim();
      return /^VIDE$/i.test(embedded) ? field(null, 0) : field(embedded, 0.9);
    }

    if (sameRowValues.has(label)) {
      const v = sameRowValues.get(label);
      return /^VIDE$/i.test(v) ? field(null, 0) : field(v, 0.9);
    }
    const lines = findPositionalValueLines(words, label, allLabels, claimed, opts);
    return lines.length ? field(lines.join("\n"), 0.85) : field(null, 0);
  };
}

// Bloc client SANS libellé adjacent (ex. "F0031422Q\nNADEC\nZi Sidi Rezig,
// Rue Du Plastique\n2033 Ben Arous" positionné en haut à droite) — repéré
// par la FORME du code client (une lettre + ≥5 chiffres + éventuelles
// lettres finales), pas par un libellé voisin. Les codes vus sur les
// factures de ce projet commencent par "C" ; ce Bon de Commande en montre un
// commençant par "F" — le motif reste donc générique sur la lettre.
function extractCustomerBlockPositional(words, claimed) {
  const empty = { code: field(null, 0), name: field(null, 0), address: field(null, 0) };
  const codeWord = words.find((w) => !claimed.has(w) && /^[A-Z]\d{5,}[A-Z]{0,3}$/i.test(w.text.trim()));
  if (!codeWord) return empty;

  const sameColumn = words
    .filter((w) => !claimed.has(w) && w !== codeWord)
    .filter((w) => w.top > codeWord.top)
    .filter((w) => Math.abs(w.left - codeWord.left) <= 40)
    .sort((a, b) => a.top - b.top);

  const rows = [];
  for (const w of sameColumn) {
    let row = rows.find((r) => Math.abs(r.top - w.top) <= 4);
    if (!row) {
      row = { top: w.top, items: [] };
      rows.push(row);
    }
    row.items.push(w);
  }
  rows.forEach((r) => r.items.sort((a, b) => a.left - b.left));
  rows.sort((a, b) => a.top - b.top);

  const lines = [];
  const claimedHere = [codeWord];
  let lastY = codeWord.top;
  for (const row of rows) {
    if (row.top - lastY > 30) break;
    if (row.items.some((it) => isPositionalLabel(it.text))) break;
    lines.push(row.items.map((it) => it.text).join(" "));
    claimedHere.push(...row.items);
    lastY = row.top;
    if (lines.length >= 4) break;
  }
  if (!lines.length) return empty;

  claimedHere.forEach((w) => claimed.add(w));
  const name = field(lines[0], 0.85);
  const address = lines.length > 1 ? field(lines.slice(1).join(", "), 0.8) : field(null, 0);
  return { code: field(codeWord.text.trim(), 0.85), name, address };
}

async function extractPurchaseOrderFieldsPositional(page1Words, { filePath, engine, pages }) {
  const claimed = new Set();
  const extractPositionalField = buildPositionalExtractor(page1Words, claimed);

  const orderNumber = extractPositionalField(POSITIONAL_LABELS.orderNumber, {});
  const rawDate = extractPositionalField(POSITIONAL_LABELS.orderDate, {});
  const orderDate = rawDate.value ? field(normalizeDate(rawDate.value), rawDate.confidence) : field(null, 0);

  const block = extractCustomerBlockPositional(page1Words, claimed);
  const customer = { code: block.code, name: block.name, address: block.address };

  const deliveryAddress = extractPositionalField(POSITIONAL_LABELS.deliveryAddress, { maxGapY: 45 });

  const totalHTRaw = extractPositionalField(POSITIONAL_LABELS.totalHT, {});
  const totalHT = field(totalHTRaw.value ? normalizeNumber(totalHTRaw.value) : null, totalHTRaw.confidence);

  const items = await extractPurchaseOrderItems({ filePath, engine, pages });

  return {
    orderNumber: sanitizeFieldAgainstLabels(orderNumber),
    orderDate,
    customer: {
      code: sanitizeFieldAgainstLabels(customer.code),
      name: sanitizeFieldAgainstLabels(customer.name),
      address: sanitizeFieldAgainstLabels(customer.address),
    },
    delivery: { address: sanitizeFieldAgainstLabels(deliveryAddress) },
    totalHT,
    items: items.map(sanitizeItemAgainstLabels).filter(hasEnoughRealItemFields),
  };
}

async function extractPurchaseOrderFieldsLinear({ fullText, filePath, engine, pages }) {
  const orderNumber = sanitizeFieldAgainstLabels(extractOrderNumberLinear(fullText));
  const orderDate = extractOrderDateLinear(fullText);
  const items = await extractPurchaseOrderItems({ filePath, engine, pages });
  return {
    orderNumber,
    orderDate,
    customer: { code: field(null, 0), name: field(null, 0), address: field(null, 0) },
    delivery: { address: field(null, 0) },
    totalHT: field(null, 0),
    items: items.map(sanitizeItemAgainstLabels).filter(hasEnoughRealItemFields),
  };
}

async function extractPurchaseOrderFields({ fullText, filePath, engine, pages }) {
  const page1Words = pages && pages[0] && pages[0].words ? pages[0].words : [];
  if (page1Words.length) {
    const positional = await extractPurchaseOrderFieldsPositional(page1Words, { filePath, engine, pages });
    if (positional.orderNumber.value) return positional;
  }
  return extractPurchaseOrderFieldsLinear({ fullText, filePath, engine, pages });
}

module.exports = {
  extractPurchaseOrderFields,
  extractPurchaseOrderFieldsLinear,
  extractPurchaseOrderItems,
};
