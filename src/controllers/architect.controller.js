const { Op, fn, col, where } = require("sequelize");
const Architect = require("../models/Architect");

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

function normalizeSearch(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function parseLimit(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

async function getAllArchitects(req, res) {
  try {
    const search = normalizeSearch(req.query.search);
    const limit = parseLimit(req.query.limit);
    const conditions = [where(fn("TRIM", col("name")), { [Op.ne]: "" })];

    if (search) {
      conditions.push(
        where(fn("LOWER", fn("TRIM", col("name"))), {
          [Op.like]: `%${search.toLowerCase()}%`,
        })
      );
    }

    const rows = await Architect.findAll({
      attributes: ["id", [fn("TRIM", col("name")), "name"]],
      where: {
        name: { [Op.ne]: null },
        [Op.and]: conditions,
      },
      order: [[fn("LOWER", fn("TRIM", col("name"))), "ASC"]],
      limit,
      raw: true,
    });

    return res.json(rows.map((row) => ({ id: row.id, name: row.name })));
  } catch (error) {
    console.error("ARCHITECTS_LIST_ERROR:", error);
    return res.status(500).json({ message: "Unable to fetch architects" });
  }
}

module.exports = {
  getAllArchitects,
};
