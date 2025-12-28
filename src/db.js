const { Sequelize } = require("sequelize");

const {
  DB_HOST,
  DB_PORT,
  DB_USER,
  DB_PASSWORD,
  DB_NAME,
} = process.env;

if (!DB_HOST || !DB_PORT || !DB_USER || !DB_NAME) {
  throw new Error(
    "DB config missing in .env. Required: DB_HOST, DB_PORT, DB_USER, DB_NAME (and DB_PASSWORD if needed)."
  );
}

const sequelize = new Sequelize(DB_NAME, DB_USER, DB_PASSWORD, {
  host: DB_HOST,
  port: Number(DB_PORT),
  dialect: "postgres",
  logging: false,
  pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
});

module.exports = { sequelize };
