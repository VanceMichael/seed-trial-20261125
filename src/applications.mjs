import { isValidId, fail, requireFields, nowIso } from './util.mjs';
import {
  getUser, requireRole, getLot, getPlan, requireLotHealthy, requirePlanOpen,
  ensureSiteScope, toBase, checkEligibility,
} from './helpers.mjs';
import { checkPlanForLot } from './plans.mjs';

// 站点（或项目核准人代站点）提交发种申请；自批在核准环节拒绝。
export function createApplication(store, actor, body) {
  const user = getUser(store.state, actor.id);
  requireRole(user, ['site', 'approver']);
  requireFields(body, ['planId', 'lotId', 'quantity', 'unit']);
  const plan = getPlan(store.state, body.planId);
  if (user.role === 'site') ensureSiteScope(user, plan.siteId);
  requirePlanOpen(plan);
  const lot = getLot(store.state, body.lotId);
  requireLotHealthy(lot);
  const quantityBase = toBase(lot, body.quantity, body.unit, '申请数量');
  // 提交阶段只确认库里曾有该实物；两个申请的库存竞争在核准时按已承诺量裁决。
  if (quantityBase > lot.availableBase + lot.committed) {
    fail(409, 'insufficient_stock', `批次 ${lot.id} 总量 ${lot.availableBase + lot.committed} ${lot.baseUnit}，申请 ${quantityBase} 超出`);
  }
  // 重复申请：同一方案+同一批次已有待批/已批准未结清的申请，直接拒绝。
  const duplicate = Object.values(store.state.applications).find((application) =>
    application.planId === plan.id
    && application.lotId === lot.id
    && ['submitted', 'approved'].includes(application.status));
  if (duplicate) fail(409, 'duplicate_application', `重复申请：申请 ${duplicate.id} 仍在 ${duplicate.status} 状态`);
  const application = {
    id: store.nextId('APP'),
    planId: plan.id,
    lotId: lot.id,
    siteId: plan.siteId,
    quantityBase,
    requestedUnit: body.unit,
    requestedQuantity: body.quantity,
    status: 'submitted',
    applicant: user.id,
    createdAt: nowIso(),
    history: [{ at: nowIso(), by: user.id, action: 'submitted', detail: `申请 ${body.quantity} ${body.unit}（折合 ${quantityBase} ${lot.baseUnit}）` }],
  };
  store.state.applications[application.id] = application;
  store.save();
  return application;
}

// 核准人决定用途和方案；发种申请人不能批准自己的申请。
export function decideApplication(store, actor, id, body = {}) {
  const user = getUser(store.state, actor.id);
  requireRole(user, ['approver']);
  const application = store.state.applications[id];
  if (!application) fail(404, 'application_not_found', `申请不存在：${id}`);
  if (application.status !== 'submitted') fail(409, 'application_decided', `申请已是 ${application.status} 状态`);
  if (application.applicant === user.id) fail(403, 'self_approval', '发种申请人不能批准自己的申请');
  const plan = getPlan(store.state, application.planId);
  const lot = getLot(store.state, application.lotId);
  if (body.decision === 'reject') {
    application.status = 'rejected';
    application.history.push({ at: nowIso(), by: user.id, action: 'rejected', detail: body.reason ?? '核准人驳回' });
    store.save();
    return application;
  }
  if (body.decision && body.decision !== 'approve') fail(400, 'bad_decision', 'decision 只能是 approve 或 reject');
  requirePlanOpen(plan);
  requireLotHealthy(lot);
  const permit = checkPlanForLot(store.state, plan, lot);
  // 两个站点竞争同一批库存：已经承诺的种子不能重复分配。
  const free = lot.availableBase - lot.committed;
  if (application.quantityBase > free) {
    fail(409, 'stock_already_committed', `库存竞争失败：已承诺 ${lot.committed}，可分配仅剩 ${free} ${lot.baseUnit}`);
  }
  const commitment = {
    id: store.nextId('CMM'),
    applicationId: application.id,
    planId: plan.id,
    lotId: lot.id,
    siteId: plan.siteId,
    quantityBase: application.quantityBase,
    shippedBase: 0,
    status: 'committed',
    permitId: permit.id,
    createdAt: nowIso(),
    history: [{ at: nowIso(), by: user.id, action: 'committed', detail: `核准用途 ${plan.purpose}，许可 ${permit.id}` }],
  };
  store.state.commitments[commitment.id] = commitment;
  application.status = 'approved';
  application.commitmentId = commitment.id;
  application.history.push({ at: nowIso(), by: user.id, action: 'approved', detail: `承诺 ${commitment.id}` });
  lot.committed += application.quantityBase;
  lot.history.push({ at: nowIso(), by: user.id, action: 'committed', detail: `${application.quantityBase} ${lot.baseUnit} 承诺给方案 ${plan.id}（站点 ${plan.siteId}）` });
  store.save();
  return { application, commitment };
}
