const { Op, fn, col, where } = require("sequelize");
const Company = require("../models/Company");

function cleanCompanyName(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/\s+/g, " ");
  return cleaned || null;
}

async function findCompanyByName(name, transaction = undefined) {
  const cleaned = cleanCompanyName(name);
  if (!cleaned) return null;

  return Company.findOne({
    where: where(fn("LOWER", fn("TRIM", col("name"))), cleaned.toLowerCase()),
    transaction,
  });
}

async function findOrCreateCompanyByName(name, transaction = undefined) {
  const cleaned = cleanCompanyName(name);
  if (!cleaned) return null;

  const existing = await findCompanyByName(cleaned, transaction);
  if (existing) return existing;

  try {
    return await Company.create({ name: cleaned }, { transaction });
  } catch (error) {
    if (error?.name !== "SequelizeUniqueConstraintError") throw error;
    return findCompanyByName(cleaned, transaction);
  }
}

async function resolveCompanyForProject(body = {}, transaction = undefined) {
  const companyId = typeof body.companyId === "string" ? body.companyId.trim() : "";
  const customName = cleanCompanyName(
    body.custom_company_name ??
    body.customCompanyName ??
    body.entrepriseCustom ??
    body.customEntreprise ??
    body.otherEntreprise ??
    body.autreEntreprise ??
    body.companyCustomName
  );
  const entreprise = cleanCompanyName(body.entreprise);

  if (companyId) {
    const company = await Company.findByPk(companyId, { transaction });
    if (!company) {
      const error = new Error("Invalid companyId");
      error.status = 400;
      throw error;
    }

    return {
      companyId: company.id,
      entreprise: company.name,
    };
  }

  const selectedOther = entreprise && ["other", "autre"].includes(entreprise.toLowerCase());
  const name = selectedOther ? customName : (customName || entreprise);
  const company = await findOrCreateCompanyByName(name, transaction);

  return {
    companyId: company?.id || null,
    entreprise: company?.name || null,
  };
}

module.exports = {
  cleanCompanyName,
  findCompanyByName,
  findOrCreateCompanyByName,
  resolveCompanyForProject,
};
