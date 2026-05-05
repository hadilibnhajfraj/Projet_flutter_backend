const router = require("express").Router();
const Notification = require("../models/Notification");
const { authRequired } = require("../middleware/auth.middleware");
const emailService = require("../services/emailService");
// =========================
// 🔥 GET MY NOTIFICATIONS
// =========================
router.get("/", authRequired, async (req, res) => {
  try {
    const userId = req.user.sub;

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const { count, rows } = await Notification.findAndCountAll({
      where: { userId },
      order: [["createdAt", "DESC"]],
      limit,
      offset,
    });

    const unreadCount = await Notification.count({
      where: { userId, isRead: false },
    });

    res.json({
      items: rows,
      unreadCount,
      total: count,
      page,
      totalPages: Math.ceil(count / limit),
    });

  } catch (err) {
    console.error("❌ GET NOTIFICATIONS ERROR:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});
// =========================
// 🔥 SEND EMAIL + CREATE NOTIFICATION
// =========================
router.post("/send-email", async (req, res) => {
  try {
    const {
      toUserId,
      emailTo,
      fromName,
      subject,
      message,
      type = "CONTACT_CREATED",
    } = req.body;

    // 1. envoyer email
    await emailService.send({
      to: emailTo,
      subject,
      text: message,
    });

    // 2. créer notification
    const notification = await Notification.create({
      userId: toUserId,
      type,
      title: subject || "Nouvel email reçu",
      message: `${fromName ? fromName + " : " : ""}${message}`,
      isRead: false,
    });

    return res.json({
      success: true,
      notification,
    });

  } catch (error) {
    console.error("❌ SEND EMAIL + NOTIFICATION ERROR:", error.message);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
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