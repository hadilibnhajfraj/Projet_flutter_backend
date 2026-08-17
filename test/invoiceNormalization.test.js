"use strict";

// Tests unitaires purs (aucune DB/réseau) des règles de normalisation OCR
// exactement telles que spécifiées par l'utilisateur.

const {
  normalizeNumber,
  normalizeDate,
  normalizeMeshSize,
  normalizeDiameter,
} = require("../src/modules/finance/services/invoiceNormalization.service");

describe("invoiceNormalization.service", () => {
  describe("normalizeNumber", () => {
    test.each([
      ["2 500", 2500],
      ["2.500", 2500], // contexte français : point = séparateur de milliers
      ["2 500,50", 2500.5],
      ["1 250,50", 1250.5],
      ["1.250,50", 1250.5],
      ["1250,50", 1250.5],
      ["12.50", 12.5], // décimal réel, jamais confondu avec un séparateur de milliers
      ["31250,00", 31250],
    ])("%s -> %s", (input, expected) => {
      expect(normalizeNumber(input)).toBeCloseTo(expected, 2);
    });

    test.each([[null], [undefined], [""], ["   "], ["abc"]])("valeur illisible (%s) -> null, jamais 0", (input) => {
      expect(normalizeNumber(input)).toBeNull();
    });
  });

  describe("normalizeDate", () => {
    test("14/08/2026 -> 2026-08-14", () => {
      expect(normalizeDate("14/08/2026")).toBe("2026-08-14");
    });
    test("14-08-2026 -> 2026-08-14", () => {
      expect(normalizeDate("14-08-2026")).toBe("2026-08-14");
    });
    test("14.08.2026 -> 2026-08-14", () => {
      expect(normalizeDate("14.08.2026")).toBe("2026-08-14");
    });
    test("déjà ISO -> inchangé", () => {
      expect(normalizeDate("2026-08-14")).toBe("2026-08-14");
    });
    test("texte non-date -> null, jamais devinée", () => {
      expect(normalizeDate("pas une date")).toBeNull();
    });
    test("mois/jour hors bornes -> null", () => {
      expect(normalizeDate("32/13/2026")).toBeNull();
    });
  });

  describe("normalizeMeshSize", () => {
    test.each([
      ["100/100", "100X100"],
      ["85/50", "85X50"],
      ["85*50", "85X50"],
      ["85 x 50", "85X50"],
      ["85×50", "85X50"],
    ])("%s -> %s", (input, expected) => {
      expect(normalizeMeshSize(input)).toBe(expected);
    });

    test("format non reconnu -> null", () => {
      expect(normalizeMeshSize("n'importe quoi")).toBeNull();
    });
  });

  describe("normalizeDiameter", () => {
    test('"Ø 6" -> "6"', () => {
      expect(normalizeDiameter("Ø 6")).toBe("6");
    });
    test('"6 mm" -> "6"', () => {
      expect(normalizeDiameter("6 mm")).toBe("6");
    });
    test("vide -> null", () => {
      expect(normalizeDiameter("")).toBeNull();
    });
  });
});
