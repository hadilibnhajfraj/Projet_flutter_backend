const router = require("express").Router();
const { ProjectComment } = require("../models");
const { notifyProjectComment } = require("../services/notification.service");
const { requireAuth } = require("../middleware/auth"); // ton middleware JWT

router.post("/:projectId/comments", requireAuth, async (req, res) => {
  try {
    const { projectId } = req.params;
    const { body, parentId = null } = req.body;

    if (!body || !body.trim()) {
      return res.status(400).json({ message: "body is required" });
    }

    const comment = await ProjectComment.create({
      projectId,
      authorId: req.user.id, // depuis JWT
      parentId,
      body: body.trim(),
    });

    // ✅ créer notifications pour les autres
    await notifyProjectComment({
      projectId,
      commentId: comment.id,
      authorId: req.user.id,
      body: comment.body,
    });

    return res.status(201).json(comment);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "server error" });
  }
});

module.exports = router;
