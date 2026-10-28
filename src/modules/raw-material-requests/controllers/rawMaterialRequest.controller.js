"use strict";

const svc = require("../services/rawMaterialRequest.service");
const { buildRequestsExcel } = require("../services/rawMaterialRequestExport");
const logger = require("../../../utils/logger");

function handle(res, err) {
  if (err instanceof svc.RawMaterialRequestError) return res.status(err.status).json(err.toJSON());
  logger.error(`[RAW-MATERIAL-REQUEST] ${err.stack || err.message}`);
  return res.status(500).json({ success: false, message: "Erreur lors du traitement de la demande de matières premières." });
}

async function requirement(req, res) {
  try {
    const { module, poste } = req.query;
    res.json({ success: true, data: await svc.requirementFor(req.user, { module, poste }) });
  } catch (err) {
    handle(res, err);
  }
}

async function sessionRequirement(req, res) {
  try {
    res.json({ success: true, data: await svc.sessionRequirement(req.user) });
  } catch (err) {
    handle(res, err);
  }
}

async function create(req, res) {
  try {
    const { request, created } = await svc.createRequest(req.user, req.body);
    if (created) {
      logger.info(`[RAW-MATERIAL-REQUEST] created ${request.requestNumber} id=${request.id} user=${request.userEmail} module=${request.module} poste=${request.poste}`);
    }
    res.status(created ? 201 : 200).json({ success: true, alreadyExisting: !created, data: request });
  } catch (err) {
    handle(res, err);
  }
}

function permissions(req, res) {
  res.json({ success: true, data: svc.permissionsFor(req.user) });
}

async function list(req, res) {
  try {
    const { data, total } = await svc.listRequests(req.user, req.validatedQuery || {});
    res.json({ success: true, count: total, data });
  } catch (err) {
    handle(res, err);
  }
}

async function requesters(req, res) {
  try {
    res.json({ success: true, data: await svc.listRequesters(req.user) });
  } catch (err) {
    handle(res, err);
  }
}

async function exportExcel(req, res) {
  try {
    const filters = req.validatedQuery || {};
    const rows = await svc.exportRows(req.user, filters);
    const buffer = await buildRequestsExcel(rows, { material: filters.material });
    const name = `matieres-premieres-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    res.send(Buffer.from(buffer));
  } catch (err) {
    handle(res, err);
  }
}

async function pendingSummary(req, res) {
  try {
    res.json({ success: true, data: await svc.pendingSummary(req.user) });
  } catch (err) {
    handle(res, err);
  }
}

async function resubmit(req, res) {
  try {
    const data = await svc.resubmitRequest(req.user, req.params.id, req.body);
    logger.info(`[RAW-MATERIAL-REQUEST] resubmitted ${data.requestNumber} by ${req.user.email}`);
    res.json({ success: true, data });
  } catch (err) {
    handle(res, err);
  }
}

async function eveningAccept(req, res) {
  try {
    const data = await svc.eveningAccept(req.user, req.params.id, req.body);
    logger.info(`[RAW-MATERIAL-REQUEST] evening accepted ${data.requestNumber} by ${req.user.email}`);
    res.json({ success: true, data });
  } catch (err) {
    handle(res, err);
  }
}

async function eveningRefuse(req, res) {
  try {
    const data = await svc.eveningRefuse(req.user, req.params.id, req.body);
    logger.info(`[RAW-MATERIAL-REQUEST] evening refused ${data.requestNumber} by ${req.user.email}`);
    res.json({ success: true, data });
  } catch (err) {
    handle(res, err);
  }
}

async function getOne(req, res) {
  try {
    res.json({ success: true, data: await svc.getRequest(req.user, req.params.id) });
  } catch (err) {
    handle(res, err);
  }
}

async function changeStatus(req, res) {
  try {
    const data = await svc.changeStatus(req.user, req.params.id, req.body);
    const last = data.history?.[data.history.length - 1];
    logger.info(`[RAW-MATERIAL-REQUEST] status ${data.requestNumber} ${last?.fromStatus} -> ${last?.toStatus} by ${req.user.email}`);
    res.json({ success: true, data });
  } catch (err) {
    handle(res, err);
  }
}

module.exports = {
  requirement,
  sessionRequirement,
  create,
  permissions,
  list,
  requesters,
  pendingSummary,
  exportExcel,
  getOne,
  changeStatus,
  resubmit,
  eveningAccept,
  eveningRefuse,
};
