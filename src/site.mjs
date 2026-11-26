import { fail, requireFields, nowIso } from './util.mjs';
import {
  getUser, requireRole, getLot, getPlan, ensureSiteScope,
  requirePlanOpen, toBase,
} from './helpers.mjs';

// 站点在获准方案内登记播种、留样、损耗和退回；合计不能超过真实接收可用量。
export function registerMovement(store, actor, body) {
  const user = getUser(store.state, actor.id);
  requireRole(user, ['site']);
  requireFields(body, ['planId', 'lotId', 'kind', 'quantity', 'unit']);
  if (!['sow', 'retain', 'loss', 'return'].includes(body.kind)) {
    fail(400, 'bad_kind', '站点登记类型只能是 sow（播种）、retain（留样）、loss（损耗）、return（退回）');
  }
  const plan = getPlan(store.state, body.planId);
  ensureSiteScope(user, plan.siteId);
  // 方案终止后只允许退回（回收未用材料是结清责任的必要动作）；播种、留样、损耗等新田间动作一律拒绝。
  if (plan.status === 'terminated' && body.kind !== 'return') {
    fail(409, 'plan_terminated', `方案 ${plan.id} 已终止，不能再登记 ${body.kind}（已播种事实保留；未用材料只能退回或经核准销毁）`);
  }
  if (plan.status === 'closed') fail(409, 'plan_closed', '方案已结清，不能再登记材料动作');
  if (plan.status !== 'terminated') requirePlanOpen(plan);
  const lot = getLot(store.state, body.lotId);
  if (lot.status === 'identity_hold' && body.kind !== 'return') {
    fail(409, 'identity_hold', '批次身份更正核实中，未发部分暂停；已播种记录保留，新动作暂缓');
  }
  const qty = toBase(lot, body.quantity, body.unit, '登记数量');
  const usable = lot.siteUsable[plan.siteId] ?? 0;
  if (qty > usable) {
    fail(409, 'exceeds_received', `站点真实可用仅 ${usable} ${lot.baseUnit}（隔离量不能当作可用），登记 ${qty} 超出`);
  }
  const movement = {
    id: store.nextId('MOV'),
    planId: plan.id,
    lotId: lot.id,
    siteId: plan.siteId,
    kind: body.kind,
    quantityBase: qty,
    requestedUnit: body.unit,
    requestedQuantity: body.quantity,
    note: body.note ?? '',
    occurredAt: body.occurredAt ?? nowIso(),
    recordedAt: nowIso(),
    recordedBy: user.id,
    identityAffected: lot.status === 'identity_hold',
    recoveryId: null,
  };
  lot.siteUsable[plan.siteId] = usable - qty;
  let ledgerType;
  if (body.kind === 'sow') {
    lot.sown += qty;
    ledgerType = 'sow';
  } else if (body.kind === 'retain') {
    // 留样仍由站点持有，计入站点持有（另设 retain 桶便于责任追踪）。
    lot.siteRetained ??= {};
    lot.siteRetained[plan.siteId] = (lot.siteRetained[plan.siteId] ?? 0) + qty;
    ledgerType = 'retain';
  } else if (body.kind === 'loss') {
    lot.loss += qty;
    ledgerType = 'loss';
  } else {
    // 退回：建立回收单，材料转为回收在途。
    const recovery = {
      id: store.nextId('RCV'),
      planId: plan.id,
      lotId: lot.id,
      siteId: plan.siteId,
      seal: body.seal ?? null,
      quantityBase: qty,
      status: 'in_transit',
      createdAt: nowIso(),
      createdBy: user.id,
      history: [{ at: nowIso(), by: user.id, action: 'return_registered', detail: body.note ?? '站点登记退回' }],
    };
    if (!recovery.seal) fail(400, 'missing_seal', '退回回收必须登记回收包封签');
    store.state.recoveries[recovery.id] = recovery;
    lot.returning += qty;
    movement.recoveryId = recovery.id;
    ledgerType = 'return';
  }
  store.state.movements.push(movement);
  store.appendLedger({ type: ledgerType, lotId: lot.id, planId: plan.id, siteId: plan.siteId, quantityBase: qty, movementId: movement.id, recoveryId: movement.recoveryId, by: user.id });
  lot.history.push({ at: nowIso(), by: user.id, action: body.kind, detail: `站点 ${plan.siteId} ${body.kind} ${qty} ${lot.baseUnit}` });
  store.save();
  return { movement, recovery: movement.recoveryId ? store.state.recoveries[movement.recoveryId] : null };
}

export function siteBalance(store, actor, siteId) {
  const user = getUser(store.state, actor.id);
  ensureSiteScope(user, siteId);
  const rows = Object.values(store.state.lots).map((lot) => ({
    lotId: lot.id,
    varietyId: lot.varietyId,
    seal: lot.seal,
    baseUnit: lot.baseUnit,
    usableBase: lot.siteUsable[siteId] ?? 0,
    quarantineBase: lot.siteQuarantine[siteId] ?? 0,
    retainedBase: lot.siteRetained?.[siteId] ?? 0,
    sownBase: store.state.movements
      .filter((m) => m.lotId === lot.id && m.siteId === siteId && m.kind === 'sow')
      .reduce((sum, m) => sum + m.quantityBase, 0),
    status: lot.status,
  })).filter((row) => row.usableBase || row.quarantineBase || row.retainedBase || row.sownBase);
  return { siteId, materials: rows };
}
