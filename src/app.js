require("dotenv").config();
const http = require("http");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { sequelize } = require("./db");
const socket = require("./socket");
require("./services/scheduler");

const authRoutes = require("./routes/auth.routes");
const { authRequired } = require("./middleware/auth.middleware");
const projectRoutes = require("./routes/projects.routes");
const adminRoutes = require("./routes/admin");
const userProfileRoutes = require("./routes/userProfile.routes");
const taskRoutes = require("./routes/tasks.routes");
require("./cron/checkProjects");
require("./cron/projectCron");
// DO NOT call checkProjects() at startup — it triggers archiveProjects() immediately.
// The cron schedule in projectCron.js handles execution (daily at 08:00).
const metabaseRoutes = require("./routes/metabase");
const commercialRoutes = require("./routes/commercial_contacts.routes");
const clientRoutes = require("./routes/client.routes");
const companyRoutes = require("./routes/company.routes");
const engineerRoutes = require("./routes/engineer.routes");
const architectRoutes = require("./routes/architect.routes");
const projectActionRoutes = require("./routes/projectActions.routes");
const notificationRoutes = require("./routes/notifications.routes");
const { syncCompaniesFromProjects } = require("./services/companySync.service");
const { syncPeopleFromProjects } = require("./services/personSync.service");
require("./cron/followup.job");

// ── CRM Pipeline Modules ──────────────────────────────────
const pipelineStageRoutes = require("./modules/pipeline/routes/pipelineStage.routes");
const kanbanRoutes = require("./modules/kanban/routes/kanban.routes");
const pipelineProjectRoutes = require("./modules/projects/routes/project.routes");
const actionTypeRoutes = require("./modules/project-actions/routes/projectActionType.routes");
const dashboardRoutes = require("./modules/dashboard/routes/dashboard.routes");
const archiveRequestRoutes = require("./modules/archive-requests/routes/archiveRequest.routes");
const crmRoutes = require("./routes/crm.routes");
const commercialContactKpiRoutes = require("./modules/commercial-contacts/routes/commercialContactKpi.routes");

const app = express();

app.use(helmet());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());

app.use(
  cors({
    origin: [
      "https://www.crmprobar.com",
      "https://crmprobar.com",
      "https://api.crmprobar.com"
      ,"http://localhost:57745"
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);


app.get("/", (req, res) => res.json({ ok: true }));

// ── CRM Pipeline ─────────────────────────────────────────
app.use("/pipeline-stages", pipelineStageRoutes);
app.use("/pipeline", kanbanRoutes);
app.use("/projects", pipelineProjectRoutes);
app.use("/action-types", actionTypeRoutes);
app.use("/dashboard", dashboardRoutes);
app.use("/archive-requests", archiveRequestRoutes);
app.use("/crm", crmRoutes);

// ── Existing routes (unchanged) ──────────────────────────
app.use("/projects", projectRoutes);
app.use("/auth", authRoutes);
app.use("/admin", adminRoutes);
app.use("/tasks", taskRoutes);
app.use("/notifications", notificationRoutes);
app.use("/utils", require("./routes/geocode.routes"));
app.use("/users", require("./routes/users.routes"));
app.use("/utils", require("./routes/utils.routes"));
app.use("/uploads", express.static("uploads"));
app.use("/users", userProfileRoutes);
app.use("/api/clients", clientRoutes);
app.use("/companies", companyRoutes);
app.use("/engineers", engineerRoutes);
app.use("/architects", architectRoutes);
app.use("/commercial-contacts", commercialContactKpiRoutes);
app.use("/commercial-contacts", commercialRoutes);
app.use("/projetactions", projectActionRoutes);
app.use("/metabase", metabaseRoutes);

app.get("/me", authRequired, (req, res) => {
  res.json({ user: req.user });
});

async function start() {
  try {
    await sequelize.authenticate();
    console.log("✅ DB connected");

    // Schema is managed by migrations only — never auto-sync in production.
    // To apply pending migrations: node src/scripts/run-pipeline-migration.js
    await syncCompaniesFromProjects();
    await syncPeopleFromProjects();

    const port = Number(process.env.PORT || 4000);
    const httpServer = http.createServer(app);
    socket.init(httpServer);
    httpServer.listen(port, () => console.log(`✅ API running on http://localhost:${port}`));
  } catch (e) {
    console.error("❌ START_ERROR:", e);
    process.exit(1);
  }
}

start();
