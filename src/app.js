require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { sequelize } = require("./db");

// ✅ IMPORTANT: charger modèles + associations AVANT sync
require("./models/associations");

const authRoutes = require("./routes/auth.routes");
const { authRequired } = require("./middleware/auth.middleware");
const projectRoutes = require("./routes/projects.routes");
const adminRoutes = require("./routes/admin"); // ✅ NEW

const app = express();

app.use(helmet());
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.use(
  cors({
    origin: (origin, cb) => cb(null, true), // ✅ simple pour dev
    credentials: true,
  })
);

app.get("/", (req, res) => res.json({ ok: true }));

app.use("/projects", projectRoutes);
app.use("/auth", authRoutes);
app.use("/admin", adminRoutes); // ✅ NEW
app.use("/utils", require("./routes/geocode.routes"));

app.get("/me", authRequired, (req, res) => {
  res.json({ user: req.user });
});

async function start() {
  try {
    await sequelize.authenticate();
    console.log("✅ DB connected");

    // ✅ DEV ONLY: ajoute role + crée user_projects automatiquement
    await sequelize.sync({ alter: true });

    const port = Number(process.env.PORT || 4000);
    app.listen(port, () => console.log(`✅ API running on http://localhost:${port}`));
  } catch (e) {
    console.error("❌ START_ERROR:", e);
    process.exit(1);
  }
}

start();
