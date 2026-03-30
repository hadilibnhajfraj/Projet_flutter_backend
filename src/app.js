require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { sequelize } = require("./db");
require("./services/scheduler");


const authRoutes = require("./routes/auth.routes");
const { authRequired } = require("./middleware/auth.middleware");
const projectRoutes = require("./routes/projects.routes");
const adminRoutes = require("./routes/admin"); // ✅ NEW
const userProfileRoutes = require("./routes/userProfile.routes");
const taskRoutes = require("./routes/tasks.routes");
require("./cron/checkProjects");
const commercialRoutes = require("./routes/commercial_contacts.routes");
const clientRoutes = require("./routes/client.routes");
const projectActionRoutes = require("./routes/projectActions.routes");
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
app.use("/tasks", taskRoutes);
app.use("/utils", require("./routes/geocode.routes"));
app.use("/users", require("./routes/users.routes"));
app.use("/utils", require("./routes/utils.routes"));
app.use("/uploads", express.static("uploads"));
app.use("/users", userProfileRoutes);
app.use("/api/clients", clientRoutes);
app.use("/commercial-contacts", commercialRoutes);
app.use("/projetactions", projectActionRoutes);
app.use("/uploads", express.static("uploads"));

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
