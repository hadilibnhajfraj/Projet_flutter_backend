"use strict";

// Bornes [start, end) calculées côté serveur pour les filtres de période de
// "Fiches de production" — même principe que
// por-promesh/repositories/porPromesh.repository.js#dateRangeWhere (bornes
// sur le jour calendaire local du serveur, jamais d'heure exacte), étendu
// aux périodes trimestre/année/personnalisée qui n'existaient pas encore.

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/**
 * @param {string|undefined} period one of: today | week | month | quarter | year | custom | undefined ("all")
 * @param {{ startDate?: string, endDate?: string }} custom bornes ISO (yyyy-MM-dd) pour period === "custom"
 * @returns {{ start: Date, end: Date } | null} null = pas de filtre de date ("Toutes les périodes")
 */
function computeDateRange(period, { startDate, endDate } = {}) {
  const now = new Date();
  const today = startOfDay(now);

  switch (period) {
    case "today":
      return { start: today, end: addDays(today, 1) };

    case "week": {
      // Lundi = 1 ... Dimanche = 7 — "cette semaine" = du lundi jusqu'à aujourd'hui inclus.
      const weekday = today.getDay() === 0 ? 7 : today.getDay();
      const startOfWeek = addDays(today, -(weekday - 1));
      return { start: startOfWeek, end: addDays(today, 1) };
    }

    case "month": {
      const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      return { start: startOfMonth, end: addDays(today, 1) };
    }

    case "quarter": {
      const quarterStartMonth = Math.floor(today.getMonth() / 3) * 3;
      const startOfQuarter = new Date(today.getFullYear(), quarterStartMonth, 1);
      return { start: startOfQuarter, end: addDays(today, 1) };
    }

    case "year": {
      const startOfYear = new Date(today.getFullYear(), 0, 1);
      return { start: startOfYear, end: addDays(today, 1) };
    }

    case "custom": {
      const start = startDate ? new Date(startDate) : null;
      const end = endDate ? new Date(endDate) : null;
      if (!start || Number.isNaN(start.getTime())) return null;
      const boundedEnd = end && !Number.isNaN(end.getTime()) ? addDays(startOfDay(end), 1) : addDays(today, 1);
      return { start: startOfDay(start), end: boundedEnd };
    }

    default:
      return null; // "all" — pas de filtre
  }
}

module.exports = { computeDateRange };
