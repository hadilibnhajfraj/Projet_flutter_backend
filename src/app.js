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
const { moduleAccessGuard } = require("./middleware/moduleAccessGuard");
const projectRoutes = require("./routes/projects.routes");
const adminRoutes = require("./routes/admin");
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
const { ensureSuperadmin2 } = require("./scripts/bootstrapSuperadmin2");
const { resumePendingEmailQueue } = require("./services/emailQueue.service");
// Follow-up automation cron (email du jour même + rappels 24h/1h/15min) —
// même garde-fou que les autres crons : ne s'exécute que si
// AUTO_EMAIL_JOBS_ENABLED=true dans .env (désactivé par défaut).
require("./cron/followup.job");
// Renouvellement des canaux push Google Calendar (sync entrante, Phase B) —
// même garde-fou AUTO_EMAIL_JOBS_ENABLED.
require("./cron/googleCalendarChannelRenewal.job");
// Verrouillage automatique des fiches PROBAR/PROMESH 24h après création —
// actif par défaut (AUTO_VALIDATION_ENABLED=false pour désactiver).
require("./cron/ficheAutoValidation.job");

// ── CRM Pipeline Modules ──────────────────────────────────
const pipelineStageRoutes = require("./modules/pipeline/routes/pipelineStage.routes");
const kanbanRoutes = require("./modules/kanban/routes/kanban.routes");
const pipelineProjectRoutes = require("./modules/projects/routes/project.routes");
const actionTypeRoutes = require("./modules/project-actions/routes/projectActionType.routes");
const dashboardRoutes = require("./modules/dashboard/routes/dashboard.routes");
const archiveRequestRoutes = require("./modules/archive-requests/routes/archiveRequest.routes");
const maintenanceRequestRoutes = require("./modules/maintenance-requests/routes/maintenanceRequest.routes");
const crmRoutes = require("./routes/crm.routes");
const commercialContactKpiRoutes = require("./modules/commercial-contacts/routes/commercialContactKpi.routes");
const googleCalendarRoutes = require("./routes/googleCalendar.routes");
const porPromeshRoutes = require("./modules/por-promesh/routes/porPromesh.routes");
const industrialRecordRoutes = require("./modules/industrial-records/routes/industrialRecord.routes");
const productionRecordsRoutes = require("./modules/production-records/routes/productionRecords.routes");
const hrRequestRoutes = require("./modules/hr-requests/routes/hrRequest.routes");
const recuperableRoutes = require("./modules/recuperables/routes/recuperable.routes");
const adminDashboardRoutes = require("./modules/admin-dashboard/routes/adminDashboard.routes");
const financeRoutes = require("./modules/finance/routes/finance.routes");

const app = express();

// ⚠️ MFA / rate-limiting — action manuelle requise si l'app tourne derrière
// un reverse proxy (nginx, load balancer) en production : sans
// `app.set("trust proxy", N)`, `req.ip` renvoie l'IP du proxy pour TOUT LE
// MONDE, ce qui casse la détection MFA "nouvelle adresse IP"
// (services/mfa.service.js) et rend les rate-limiters IP existants
// (signin, forgot-password, ...) inefficaces en prod. Je ne l'active pas
// moi-même ici : l'activer à tort (pas de proxy réel devant l'app) permet à
// un client de FALSIFIER son IP via l'en-tête X-Forwarded-For et de
// contourner tous les rate-limiters — à confirmer/activer uniquement après
// vérification de la topologie réseau réelle en prod.
// app.set("trust proxy", 1); // décommenter si (et seulement si) un proxy de confiance est bien en amont

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
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);


app.use(moduleAccessGuard);

app.get("/", (req, res) => res.json({ ok: true }));

// ── CRM Pipeline ─────────────────────────────────────────
app.use("/pipeline-stages", pipelineStageRoutes);
app.use("/pipeline", kanbanRoutes);
app.use("/projects", pipelineProjectRoutes);
app.use("/action-types", actionTypeRoutes);
app.use("/dashboard", dashboardRoutes);
app.use("/archive-requests", archiveRequestRoutes);
app.use("/maintenance-requests", maintenanceRequestRoutes);
app.use("/crm", crmRoutes);
app.use("/por-promesh", porPromeshRoutes);
app.use("/industrial-records", industrialRecordRoutes);
app.use("/production-records", productionRecordsRoutes);
app.use("/hr-requests", hrRequestRoutes);
app.use("/recuperables", recuperableRoutes);
app.use("/admin-dashboard", adminDashboardRoutes);
app.use("/finance", financeRoutes);

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
app.use("/api/clients", clientRoutes);
app.use("/companies", companyRoutes);
app.use("/engineers", engineerRoutes);
app.use("/architects", architectRoutes);
app.use("/commercial-contacts", commercialContactKpiRoutes);
app.use("/commercial-contacts", commercialRoutes);
app.use("/google-calendar", googleCalendarRoutes);
app.use("/projetactions", projectActionRoutes);
app.use("/metabase", metabaseRoutes);

app.get("/me", authRequired, (req, res) => {
  res.json({ user: req.user });
});

// Diagnostic démarrage — compteurs de référence pour détecter tout écart
// de filtrage sur le module Commercial Contacts (voir audit). Non bloquant :
// une erreur ici n'empêche jamais le serveur de démarrer.
async function logStartupDiagnostics() {
  try {
    const { Op } = require("sequelize");
    const CommercialContact = require("./models/CommercialContact");
    const User = require("./models/User");
    const CommercialContactRelance = require("./models/CommercialContactRelance");

    const [contactsCount, usersCount, assignedRelancesCount] = await Promise.all([
      CommercialContact.count(),
      User.count(),
      CommercialContactRelance.count({ where: { commercialId: { [Op.ne]: null } } }),
    ]);

    console.log("\n========== DIAGNOSTIC DÉMARRAGE ==========");
    console.log("SELECT COUNT(*) FROM commercial_contacts =", contactsCount);
    console.log("SELECT COUNT(*) FROM users =", usersCount);
    // La table "contact_assignments" n'existe pas dans ce schéma — les
    // affectations commercial <-> contact vivent sur
    // commercial_contact_relances.commercialId. Équivalent réel affiché :
    console.log(
      "SELECT COUNT(*) FROM commercial_contact_relances WHERE \"commercialId\" IS NOT NULL =",
      assignedRelancesCount
    );
    console.log("===========================================\n");
  } catch (e) {
    console.error("⚠️ Diagnostic démarrage échoué (non bloquant):", e.message);
  }
}

async function start() {
  try {
    await sequelize.authenticate();
    console.log("✅ DB connected");

    await logStartupDiagnostics();

    // Schema is managed by migrations only — never auto-sync in production.
    // To apply pending migrations: node src/scripts/run-pipeline-migration.js
    await syncCompaniesFromProjects();
    await syncPeopleFromProjects();
    await ensureSuperadmin2();

    // Reprend les emails PENDING/RETRYING laissés par un précédent process
    // (ex: forgot-password bloqué en retry SMTP au moment d'un redémarrage/
    // déploiement) — jamais exécuté sous Jest, `start()` n'est appelé que
    // lorsque ce fichier est lancé directement (voir garde plus bas).
    await resumePendingEmailQueue();

    const port = Number(process.env.PORT || 4000);
    const httpServer = http.createServer(app);
    socket.init(httpServer);
    httpServer.listen(port, () => {
      console.log(`✅ API running on http://localhost:${port}`);
      // DIAGNOSTIC TEMPORAIRE (audit MFA "wrong_code") — permet de repérer
      // un second process Node encore actif (ancien nodemon non arrêté, port
      // différent, etc.) qui répondrait avec un code/état différent de celui
      // attendu. À retirer une fois l'audit terminé.
      console.log(
        `[MFA-DIAG][Express] PID=${process.pid} PORT=${port} STARTED_AT=${new Date().toISOString()}`
      );
    });
  } catch (e) {
    console.error("❌ START_ERROR:", e);
    process.exit(1);
  }
}

// Ne démarre le serveur (connexion DB + listen) que lorsque ce fichier est
// exécuté directement (`node src/app.js`, voir package.json scripts
// start/dev) — pas lorsqu'il est importé par les tests (Jest + Supertest),
// qui n'ont besoin que de l'instance `app` pour piloter les routes.
if (require.main === module) {
  start();
}

module.exports = app;
