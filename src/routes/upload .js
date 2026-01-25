const { upload } = require("../middleware/upload");

router.post("/me/avatar", authRequired, upload.single("avatar"), async (req, res) => {
  try {
    const userId = req.user.sub;
    if (!req.file) return res.status(400).json({ message: "avatar is required" });

    const url = `/uploads/avatars/${req.file.filename}`;

    let profile = await UserProfile.findOne({ where: { userId } });
    if (!profile) profile = await UserProfile.create({ userId });

    await profile.update({ avatarUrl: url });

    return res.json({ avatarUrl: url, profile });
  } catch (e) {
    console.error("UPLOAD_AVATAR_ERROR:", e);
    return res.status(500).json({ message: e.message || "Server error" });
  }
});
