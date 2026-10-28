"use strict";

const svc = require("../services/ficheApproval.service");
const logger = require("../../../utils/logger");

function handle(res, err) {
  if (err instanceof svc.FicheApprovalError) return res.status(err.status).json(err.toJSON());
  logger.error(`[FICHE-APPROVAL] ${err.stack || err.message}`);
  return res.status(500).json({ success: false, message: "Erreur lors du traitement de la validation de la fiche." });
}

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    handle(res, err);
  }
};

module.exports = {
  permissions: wrap(async (req, res) => res.json({ success: true, data: svc.permissionsFor(req.user) })),
  summary: wrap(async (req, res) => res.json({ success: true, data: await svc.summary(req.user, req.validatedQuery || {}) })),
  list: wrap(async (req, res) => {
    const { data, total } = await svc.listFiches(req.user, req.validatedQuery || {});
    res.json({ success: true, count: total, data });
  }),
  getOne: wrap(async (req, res) => res.json({ success: true, data: await svc.getDetail(req.user, req.params.type, req.params.id) })),
  approve: wrap(async (req, res) => res.json({ success: true, data: await svc.approve(req.user, req.params.type, req.params.id, req.body) })),
  reject: wrap(async (req, res) => res.json({ success: true, data: await svc.reject(req.user, req.params.type, req.params.id, req.body) })),
  resubmit: wrap(async (req, res) => res.json({ success: true, data: await svc.resubmit(req.user, req.params.type, req.params.id, req.body) })),
};
