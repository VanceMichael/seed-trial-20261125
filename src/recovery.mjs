import { fail, requireFields, nowIso } from './util.mjs';
import { getUser, requireRole, getLot, ensureSiteScope } from './helpers.mjs';

function getRecovery(state, id) {
  const recovery = state.recoveries[id];
  if (!recovery) fail(404, 'recovery_not_found', `回收单不存在：${id}`);
  return recovery;
}

// 回收包到库：库管确认实际到达；身份未核实前隔离，不并入可用库存。
export function receiveRecovery(store, actor, id, body = {}) {
  const user = getUser(store.state, actor.id);
  requireRole(user, ['keeper']);
  const recovery = getRecovery(store.state, id);
  if (recovery.status !== 'in_transit') fail(409, 'recovery_not_in_transit', `回收单状态 ${recovery.status}`);
  const lot = getLot(store.state, recovery.lotId);
  lot.returning -= recovery.quantityBase;
  lot.pendingReturn += recovery.quantityBase;
  recovery.status = 'arrived_pending_identity';
  recovery.arrival = {
    seal: body.seal ?? recovery.seal,
    at: nowIso(),
    by: user.id,
    note: body.note ?? '回收包已到库，身份待核实，隔离存放',
  };
  recovery.history.push({ at: nowIso(), by: user.id, action: 'arrived', detail: '到库隔离，未并入可用库存' });
  store.appendLedger({ type: 'recovery_arrival', lotId: lot.id, recoveryId: recovery.id, planId: recovery.planId, quantityBase: recovery.quantityBase, siteId: recovery.siteId, seal: recovery.arrival.seal, by: user.id });
  store.save();
  return recovery;
}

// 身份核实：封样/来源相符才退回可用库存；不符则保持隔离待处置，不能直接入库。
export function verifyRecoveryIdentity(store, actor, id, body) {
  const user = getUser(store.state, actor.id);
  requireRole(user, ['keeper', 'quality']);
  requireFields(body, ['identityConfirmed']);
  const recovery = getRecovery(store.state, id);
  if (recovery.status !== 'arrived_pending_identity') fail(409, 'recovery_not_pending', `回收单状态 ${recovery.status}，不能核实`);
  const lot = getLot(store.state, recovery.lotId);
  lot.pendingReturn -= recovery.quantityBase;
  if (body.identityConfirmed === true) {
    lot.availableBase += recovery.quantityBase;
    recovery.status = 'verified';
    recovery.identity = { confirmed: true, at: nowIso(), by: user.id, detail: body.note ?? '封样与来源相符，退回可用库存' };
    store.appendLedger({ type: 'recovery_verified', lotId: lot.id, recoveryId: recovery.id, quantityBase: recovery.quantityBase, by: user.id });
  } else {
    lot.quarantineBase = (lot.quarantineBase ?? 0) + recovery.quantityBase;
    recovery.status = 'identity_rejected';
    recovery.identity = { confirmed: false, at: nowIso(), by: user.id, detail: body.note ?? '身份不符，隔离待核准处置' };
    store.appendLedger({ type: 'recovery_identity_rejected', lotId: lot.id, recoveryId: recovery.id, quantityBase: recovery.quantityBase, by: user.id });
  }
  recovery.history.push({ at: nowIso(), by: user.id, action: 'identity_verified', detail: JSON.stringify(recovery.identity) });
  store.save();
  return recovery;
}

// 回收包经核准销毁（身份不符或终止后无需再用）。
export function destroyRecovery(store, actor, id, body = {}) {
  const user = getUser(store.state, actor.id);
  requireRole(user, ['approver']);
  const recovery = getRecovery(store.state, id);
  if (!['identity_rejected', 'arrived_pending_identity'].includes(recovery.status)) {
    fail(409, 'recovery_not_destroyable', `回收单状态 ${recovery.status}，不能销毁`);
  }
  const lot = getLot(store.state, recovery.lotId);
  if (recovery.status === 'arrived_pending_identity') {
    lot.pendingReturn -= recovery.quantityBase;
  } else {
    lot.quarantineBase = (lot.quarantineBase ?? 0) - recovery.quantityBase;
  }
  lot.destroyed += recovery.quantityBase;
  recovery.status = 'destroyed';
  recovery.disposition = { at: nowIso(), by: user.id, reason: body.reason ?? '回收材料经核准销毁' };
  recovery.history.push({ at: nowIso(), by: user.id, action: 'destroyed', detail: recovery.disposition.reason });
  store.appendLedger({ type: 'destruction', lotId: lot.id, recoveryId: recovery.id, quantityBase: recovery.quantityBase, source: 'recovery', by: user.id, reason: recovery.disposition.reason });
  store.save();
  return recovery;
}
