const router = require("express").Router();
const { Notification } = require("../models");
const { requireAuth } = require("../middleware/auth");

// GET my notifications
router.get("/", requireAuth, async (req, res) => {
  const userId = req.user.id;

  const items = await Notification.findAll({
    where: { userId },
    order: [["createdAt", "DESC"]],
    limit: 30,
  });

  const unreadCount = await Notification.count({
    where: { userId, isRead: false },
  });

  res.json({ items, unreadCount });
});

// mark all read
router.put("/mark-all-read", requireAuth, async (req, res) => {
  const userId = req.user.id;
  await Notification.update({ isRead: true }, { where: { userId, isRead: false } });
  res.json({ ok: true });
});

// mark one read
router.put("/:id/read", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  const n = await Notification.findOne({ where: { id, userId } });
  if (!n) return res.status(404).json({ message: "not found" });

  n.isRead = true;
  await n.save();

  res.json({ ok: true });
});

module.exports = router;
