const { fn, col, where } = require("sequelize");
const Engineer = require("../models/Engineer");
const Architect = require("../models/Architect");

function cleanPersonName(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/\s+/g, " ");
  return cleaned || null;
}

function getPersonModel(type) {
  if (type === "engineer") return Engineer;
  if (type === "architect") return Architect;
  throw new Error("Invalid person type");
}

async function findPersonByName(type, name, transaction = undefined) {
  const cleaned = cleanPersonName(name);
  if (!cleaned) return null;

  const Model = getPersonModel(type);
  return Model.findOne({
    where: where(fn("LOWER", fn("TRIM", col("name"))), cleaned.toLowerCase()),
    transaction,
  });
}

async function findOrCreatePersonByName(type, name, data = {}, transaction = undefined) {
  const cleaned = cleanPersonName(name);
  if (!cleaned) return null;

  const existing = await findPersonByName(type, cleaned, transaction);
  if (existing) return existing;

  const Model = getPersonModel(type);
  try {
    return await Model.create(
      {
        name: cleaned,
        phone: data.phone || null,
        email: data.email || null,
      },
      { transaction }
    );
  } catch (error) {
    if (error?.name !== "SequelizeUniqueConstraintError") throw error;
    return findPersonByName(type, cleaned, transaction);
  }
}

async function resolveEngineerForProject(body = {}, transaction = undefined) {
  const engineerId = typeof body.engineerId === "string" ? body.engineerId.trim() : "";
  const customName = cleanPersonName(
    body.custom_engineer_name ??
    body.customEngineerName ??
    body.engineerCustomName ??
    body.ingenieurResponsableCustom
  );
  const engineerName = cleanPersonName(body.ingenieurResponsable);

  if (engineerId) {
    const engineer = await Engineer.findByPk(engineerId, { transaction });
    if (!engineer) {
      const error = new Error("Invalid engineerId");
      error.status = 400;
      throw error;
    }

    return {
      engineerId: engineer.id,
      ingenieurResponsable: engineer.name,
      telephoneIngenieur: body.telephoneIngenieur ?? engineer.phone ?? null,
      emailIngenieur: body.emailIngenieur ?? engineer.email ?? null,
    };
  }

  const name = customName || engineerName;
  const engineer = await findOrCreatePersonByName(
    "engineer",
    name,
    {
      phone: body.telephoneIngenieur,
      email: body.emailIngenieur,
    },
    transaction
  );

  return {
    engineerId: engineer?.id || null,
    ingenieurResponsable: engineer?.name || null,
    telephoneIngenieur: body.telephoneIngenieur ?? engineer?.phone ?? null,
    emailIngenieur: body.emailIngenieur ?? engineer?.email ?? null,
  };
}

async function resolveArchitectForProject(body = {}, transaction = undefined) {
  const architectId = typeof body.architectId === "string" ? body.architectId.trim() : "";
  const customName = cleanPersonName(
    body.custom_architect_name ??
    body.customArchitectName ??
    body.architectCustomName ??
    body.architecteCustom
  );
  const architectName = cleanPersonName(body.architecte);

  if (architectId) {
    const architect = await Architect.findByPk(architectId, { transaction });
    if (!architect) {
      const error = new Error("Invalid architectId");
      error.status = 400;
      throw error;
    }

    return {
      architectId: architect.id,
      architecte: architect.name,
      telephoneArchitecte: body.telephoneArchitecte ?? architect.phone ?? null,
      emailArchitecte: body.emailArchitecte ?? architect.email ?? null,
    };
  }

  const name = customName || architectName;
  const architect = await findOrCreatePersonByName(
    "architect",
    name,
    {
      phone: body.telephoneArchitecte,
      email: body.emailArchitecte,
    },
    transaction
  );

  return {
    architectId: architect?.id || null,
    architecte: architect?.name || null,
    telephoneArchitecte: body.telephoneArchitecte ?? architect?.phone ?? null,
    emailArchitecte: body.emailArchitecte ?? architect?.email ?? null,
  };
}

module.exports = {
  cleanPersonName,
  findPersonByName,
  findOrCreatePersonByName,
  resolveEngineerForProject,
  resolveArchitectForProject,
};
