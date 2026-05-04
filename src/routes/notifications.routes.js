const router = require("express").Router();
const Notification = require("../models/Notification");
const { authRequired } = require("../middleware/auth.middleware");

// =========================
// 🔥 GET MY NOTIFICATIONS
// =========================
router.get("/", authRequired, async (req, res) => {
  try {
    const userId = req.user.sub; // ✅ FIX ICI

    const items = await Notification.findAll({
      where: { userId },
      order: [["createdAt", "DESC"]],
      limit: 50,
    });

    const unreadCount = await Notification.count({
      where: { userId, isRead: false },
    });

    res.json({
      items,
      unreadCount,
    });
  } catch (err) {
    console.error("❌ GET NOTIFICATIONS ERROR:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

// =========================
// 🔥 MARK ALL READ
// =========================
router.put("/read-all", authRequired, async (req, res) => {
  try {
    const userId = req.user.sub; // ✅ FIX

    await Notification.update(
      { isRead: true },
      { where: { userId, isRead: false } }
    );

    res.json({ success: true });
  } catch (err) {
    console.error("❌ MARK ALL READ ERROR:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

// =========================
// 🔥 MARK ONE READ
// =========================
router.put("/:id/read", authRequired, async (req, res) => {
  try {
    const userId = req.user.sub; // ✅ FIX
    const { id } = req.params;

    const notification = await Notification.findOne({
      where: { id, userId },
    });

    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }

    notification.isRead = true;
    await notification.save();

    res.json({ success: true });
  } catch (err) {
    console.error("❌ MARK ONE READ ERROR:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

// =========================
// 🔥 DELETE
// =========================
router.delete("/:id", authRequired, async (req, res) => {
  try {
    const userId = req.user.sub; // ✅ FIX
    const { id } = req.params;

    const deleted = await Notification.destroy({
      where: { id, userId },
    });

    if (!deleted) {
      return res.status(404).json({ message: "Notification not found" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("❌ DELETE NOTIFICATION ERROR:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;