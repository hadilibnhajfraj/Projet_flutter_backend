// routes/admin.routes.js
const express = require("express");
const User = require("../models/User");
const { Project, UserProject } = require("../models/associations");
const { authRequired } = require("../middleware/auth.middleware");
const { requireRole } = require("../middleware/requireRole");

const router = express.Router();

// ✅ Liste users
router.get("/users", authRequired, requireRole("admin", "superadmin"), async (req, res) => {
  const users = await User.findAll({
    attributes: ["id", "email", "role", "isActive", "createdAt", "updatedAt"],
    order: [["createdAt", "DESC"]],
  });
  return res.json(users);
});

// ✅ Activer / désactiver
router.put("/users/:id/active", authRequired, requireRole("admin", "superadmin"), async (req, res) => {
  const { active } = req.body || {};
  if (typeof active !== "boolean") return res.status(400).json({ message: "active must be boolean" });

  const user = await User.findByPk(req.params.id);
  if (!user) return res.status(404).json({ message: "User not found" });

  if (req.user.role !== "superadmin" && user.role === "superadmin") {
    return res.status(403).json({ message: "Cannot modify superadmin" });
  }

  await user.update({ isActive: active });
  return res.json({ message: "Updated", user: { id: user.id, email: user.email, isActive: user.isActive } });
});

// ✅ Changer rôle (superadmin only)
router.put("/users/:id/role", authRequired, requireRole("superadmin"), async (req, res) => {
  const { role } = req.body || {};
  if (!["user", "admin", "superadmin"].includes(role)) return res.status(400).json({ message: "Invalid role" });

  const user = await User.findByPk(req.params.id);
  if (!user) return res.status(404).json({ message: "User not found" });

  await user.update({ role });
  return res.json({ message: "Role updated", user: { id: user.id, email: user.email, role: user.role } });
});

// ✅ Liste projets
router.get("/projects", authRequired, requireRole("admin", "superadmin"), async (req, res) => {
  const projects = await Project.findAll({ order: [["createdAt", "DESC"]] });
  return res.json(projects);
});

// ✅ Grant accès
router.post("/users/:userId/projects/grant", authRequired, requireRole("admin", "superadmin"), async (req, res) => {
  const { projectId, permission } = req.body || {};
  if (!projectId) return res.status(400).json({ message: "projectId required" });
  if (permission && !["viewer", "editor", "owner"].includes(permission)) {
    return res.status(400).json({ message: "Invalid permission" });
  }

  const user = await User.findByPk(req.params.userId);
  if (!user) return res.status(404).json({ message: "User not found" });

  const project = await Project.findByPk(projectId);
  if (!project) return res.status(404).json({ message: "Project not found" });

  const [link] = await UserProject.findOrCreate({
    where: { userId: user.id, projectId: project.id },
    defaults: { permission: permission || "viewer" },
  });

  if (permission && link.permission !== permission) await link.update({ permission });

  return res.json({ message: "Granted", userId: user.id, projectId: project.id, permission: link.permission });
});

// ✅ Revoke
router.post("/users/:userId/projects/revoke", authRequired, requireRole("admin", "superadmin"), async (req, res) => {
  const { projectId } = req.body || {};
  if (!projectId) return res.status(400).json({ message: "projectId required" });

  await UserProject.destroy({ where: { userId: req.params.userId, projectId } });
  return res.json({ message: "Revoked", userId: req.params.userId, projectId });
});

// ✅ Voir droits user
router.get("/users/:userId/projects", authRequired, requireRole("admin", "superadmin"), async (req, res) => {
  const links = await UserProject.findAll({
    where: { userId: req.params.userId },
    order: [["createdAt", "DESC"]],
  });
  return res.json(links);
});

module.exports = router;
