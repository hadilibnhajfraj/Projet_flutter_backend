"use strict";

// Abstraction "lecture de document" — PDF (texte natif ou scanné) et images
// (jpg/jpeg/png/webp) → texte + mots positionnés (bbox), pour que
// l'extraction de champs/tableau en aval reste indépendante du moteur
// utilisé. Aujourd'hui : `pdf-parse` (texte + rendu PNG, aucune dépendance
// native — pas de poppler/ImageMagick nécessaire, vérifié en direct dans cet
// environnement) + `tesseract.js` (OCR WASM, idem). Pour brancher un autre
// moteur (OCR local différent, service externe, modèle vision/LLM) : ne
// changer QUE ce fichier, l'interface `extractDocumentText()` ne bouge pas.

const fs = require("fs");
const path = require("path");
const { PDFParse } = require("pdf-parse");
const { createWorker } = require("tesseract.js");
const logger = require("../../../utils/logger");

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const MAX_OCR_PAGES = 5;
// En-dessous de ce nombre de caractères par page, le texte natif d'un PDF
// est considéré trop pauvre pour être fiable (PDF scanné/image) → bascule
// sur le rendu image + OCR.
const MIN_CHARS_PER_PAGE = 20;

let pdfjsLibPromise = null;
function getPdfjsLib() {
  // `pdfjs-dist` est le moteur ESM utilisé en interne par `pdf-parse` —
  // déclaré ici comme dépendance directe pour y accéder nous-mêmes, car
  // `pdf-parse` n'expose QUE du texte aplati (`getText()`), jamais les
  // coordonnées X/Y par mot de sa propre extraction interne.
  if (!pdfjsLibPromise) pdfjsLibPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsLibPromise;
}

// Coordonnées RÉELLES (x/y/largeur/hauteur) de chaque bloc de texte d'un PDF
// à texte natif, une page à la fois — même forme que les mots OCR Tesseract
// ({text,left,top,width,height}) pour que la reconstruction de zones
// (colonnes/tableaux) fonctionne indifféremment du moteur. Indispensable
// pour les mises en page à plusieurs colonnes : `pdf-parse.getText()`
// aplatit tout en un flux linéaire qui entrelace les colonnes dans le
// désordre (un libellé d'une colonne se retrouve juste avant la valeur
// d'une AUTRE colonne, sans rapport) — seules les coordonnées permettent de
// rattacher chaque libellé à sa vraie valeur.
async function extractWordsFromNativePdf(filePath) {
  const pdfjsLib = await getPdfjsLib();
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjsLib.getDocument({
    data,
    disableWorker: true,
    useWorkerFetch: false,
    isEvalSupported: false,
  }).promise;
  try {
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      const words = textContent.items
        .filter((it) => it.str && it.str.trim())
        .map((it) => ({
          text: it.str.trim(),
          left: it.transform[4],
          top: viewport.height - it.transform[5],
          width: it.width,
          height: it.height,
        }));
      pages.push(words);
      page.cleanup();
    }
    return pages;
  } finally {
    await doc.destroy();
  }
}

let workerPromise = null;
// Worker Tesseract partagé (singleton paresseux) — sa création coûte ~1-2s,
// on ne veut pas la payer à chaque upload. Langues eng+fra (factures
// tunisiennes en français, chiffres/latin).
function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker(["eng", "fra"], 1, { logger: () => {} });
  }
  return workerPromise;
}

function parseWordsFromTsv(tsv) {
  if (!tsv) return [];
  const words = [];
  for (const line of tsv.split("\n")) {
    const cols = line.split("\t");
    if (cols.length < 12) continue;
    const level = Number(cols[0]);
    if (level !== 5) continue; // niveau 5 = mot (standard Tesseract TSV)
    const [, , , , , , left, top, width, height, conf, ...textParts] = cols;
    const text = textParts.join("\t").trim();
    if (!text) continue;
    words.push({
      text,
      left: Number(left) || 0,
      top: Number(top) || 0,
      width: Number(width) || 0,
      height: Number(height) || 0,
      confidence: Number(conf) || 0,
    });
  }
  return words;
}

async function ocrImageBuffer(buffer, pageNumber) {
  const worker = await getWorker();
  const { data } = await worker.recognize(buffer, {}, { tsv: true });
  const words = parseWordsFromTsv(data.tsv);
  logger.info(`[INVOICE OCR] Page ${pageNumber} OCR'd (confidence=${Math.round(data.confidence)}, words=${words.length})`);
  return { pageNumber, text: data.text || "", words, confidence: data.confidence || 0 };
}

async function extractFromPdf(filePath) {
  const buffer = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: buffer });
  try {
    const textResult = await parser.getText();
    const numPages = textResult.pages ? textResult.pages.length : textResult.numpages || 1;
    const avgCharsPerPage = (textResult.text || "").length / Math.max(1, numPages);

    if (avgCharsPerPage >= MIN_CHARS_PER_PAGE) {
      logger.info(`[INVOICE OCR] PDF text layer used (${numPages} page(s), ${textResult.text.length} chars)`);
      let wordsPerPage = [];
      try {
        wordsPerPage = await extractWordsFromNativePdf(filePath);
      } catch (err) {
        logger.error("[INVOICE OCR] Native PDF word-position extraction failed:", err.message);
      }
      const pages = (textResult.pages || [{ text: textResult.text }]).map((p, i) => ({
        pageNumber: i + 1,
        text: p.text || "",
        words: wordsPerPage[i] || [],
        confidence: 100,
      }));
      return { pages, fullText: textResult.text || "", engine: "pdf-text" };
    }

    logger.info(`[INVOICE OCR] PDF text layer too sparse (${avgCharsPerPage.toFixed(0)} chars/page) — rendering pages for OCR`);
    const pageCount = Math.min(numPages, MAX_OCR_PAGES);
    const screenshot = await parser.getScreenshot({ scale: 2, partial: Array.from({ length: pageCount }, (_, i) => i + 1) });
    const pages = [];
    for (const page of screenshot.pages) {
      pages.push(await ocrImageBuffer(page.data, page.pageNumber || pages.length + 1));
    }
    const fullText = pages.map((p) => p.text).join("\n");
    return { pages, fullText, engine: "tesseract-pdf-render" };
  } finally {
    await parser.destroy();
  }
}

async function extractFromImage(filePath) {
  const buffer = fs.readFileSync(filePath);
  const page = await ocrImageBuffer(buffer, 1);
  return { pages: [page], fullText: page.text, engine: "tesseract-image" };
}

// { filePath, mimeType, originalName, logTag } → { pages: [{pageNumber,text,words,confidence}], fullText, engine }
// `logTag` permet aux appelants (ex: deliveryNoteOcr.service.js) de garder
// le préfixe de log attendu par leur propre spec (ex: "[DELIVERY OCR]")
// tout en réutilisant ce même moteur d'extraction générique.
async function extractDocumentText({ filePath, mimeType, originalName, logTag = "INVOICE OCR" }) {
  logger.info(`[${logTag}] File received (${originalName}, ${mimeType})`);
  const ext = path.extname(originalName || filePath).toLowerCase();

  let result;
  if (mimeType === "application/pdf" || ext === ".pdf") {
    result = await extractFromPdf(filePath);
  } else if (IMAGE_EXTENSIONS.has(ext) || (mimeType || "").startsWith("image/")) {
    result = await extractFromImage(filePath);
  } else {
    // Formats non lisibles par OCR (xls/xlsx/doc/docx/csv/txt) — aucune
    // extraction possible, la facture sera créée en NEEDS_REVIEW.
    logger.info(`[${logTag}] Format not OCR-able (${mimeType}) — no text extracted`);
    return { pages: [], fullText: "", engine: "none" };
  }

  logger.info(`[${logTag}] Text extracted (engine=${result.engine}, chars=${result.fullText.length})`);
  return result;
}

async function shutdownWorker() {
  if (workerPromise) {
    const worker = await workerPromise;
    await worker.terminate();
    workerPromise = null;
  }
}

module.exports = { extractDocumentText, extractWordsFromNativePdf, shutdownWorker };
