import { fail, requireFields, nowIso } from './util.mjs';
import {
  getUser, requireRole, getLot, getPlan, ensureSiteScope, requirePlanOpen,
} from './helpers.mjs';

// 采收所得材料关联原播种批次；原用途限制随材料延续。
export function registerHarvest(store, actor, body) {
  const user = getUser(store.state, actor.id);
  requireRole(user, ['site']);
  requireFields(body, ['planId', 'sourceLotId', 'quantity', 'unit', 'seal']);
  const plan = getPlan(store.state, body.planId);
  ensureSiteScope(user, plan.siteId);
  const lot = getLot(store.state, body.sourceLotId);
  const sown = store.state.movements
    .filter((m) => m.planId === plan.id && m.lotId === lot.id && m.kind === 'sow')
    .reduce((sum, m) => sum + m.quantityBase, 0);
  if (sown <= 0) fail(409, 'no_sowing', `方案 ${plan.id} 没有批次 ${lot.id} 的播种记录，不能登记采收`)
  ;
  if (!Number.isInteger(body.quantity) || body.quantity <= 0) fail(400, 'bad_quantity', '采收数量必须是正整数');
  if (!['grams', 'seeds'].includes(body.unit)) fail(400, 'bad_unit', '计量单位只能是 grams 或 seeds');
  const harvest = {
    id: store.nextId('HRV'),
    planId: plan.id,
    sourceLotId: lot.id,
    siteId: plan.siteId,
    seal: body.seal,
    quantity: body.quantity,
    unit: body.unit,
    restrictedPurpose: lot.purpose,
    status: 'held_at_site',
    handover: null,
    createdAt: nowIso(),
    createdBy: user.id,
    history: [{ at: nowIso(), by: user.id, action: 'registered', detail: `关联原播种批次 ${lot.id}，用途限制 ${lot.purpose}` }],
  };
  store.state.harvests[harvest.id] = harvest;
  store.appendLedger({ type: 'harvest_registered', harvestId: harvest.id, planId: plan.id, sourceLotId: lot.id, siteId: plan.siteId, quantity: body.quantity, unit: body.unit, seal: body.seal, restrictedPurpose: lot.purpose, by: user.id });
  store.save();
  return harvest;
}

// 换包装登记：新封签必须保留与原播种批次的关联，不能因换包装摆脱用途限制。
export function repackHarvest(store, actor, id, body) {
  const user = getUser(store.state, actor.id);
  requireRole(user, ['site']);
  const harvest = store.state.harvests[id];
  if (!harvest) fail(404, 'harvest_not_found', `采收材料不存在：${id}`);
  ensureSiteScope(user, harvest.siteId);
  requireFields(body, ['newSeal']);
  const oldSeal = harvest.seal;
  harvest.seal = body.newSeal;
  harvest.history.push({ at: nowIso(), by: user.id, action: 'repack', detail: `封签 ${oldSeal} → ${body.newSeal}，原播种批次 ${harvest.sourceLotId} 关联与用途限制不变` });
  store.appendLedger({ type: 'harvest_repack', harvestId: harvest.id, oldSeal, newSeal: body.newSeal, sourceLotId: harvest.sourceLotId, restrictedPurpose: harvest.restrictedPurpose, by: user.id });
  store.save();
  return harvest;
}

// 对外交接：核准人确认交接对象仍接受原用途限制；无许可/商业推广一律拒绝。
export function handoverHarvest(store, actor, id, body) {
  const user = getUser(store.state, actor.id);
  requireRole(user, ['approver']);
  const harvest = store.state.harvests[id];
  if (!harvest) fail(404, 'harvest_not_found', `采收材料不存在：${id}`);
  if (harvest.status === 'handover') fail(409, 'already_handover', '该采收材料已完成交接');
  requireFields(body, ['recipient', 'purpose']);
  if (body.purpose !== harvest.restrictedPurpose) {
    fail(409, 'purpose_restriction', `采收材料仍受 ${harvest.restrictedPurpose} 用途限制，不能按 ${body.purpose} 交接；科研材料不得商业推广`);
  }
  harvest.status = 'handover';
  harvest.handover = { recipient: body.recipient, purpose: body.purpose, at: nowIso(), by: user.id, note: body.note ?? '' };
  harvest.history.push({ at: nowIso(), by: user.id, action: 'handover', detail: `交接给 ${body.recipient}，用途 ${body.purpose}` });
  store.appendLedger({ type: 'harvest_handover', harvestId: harvest.id, sourceLotId: harvest.sourceLotId, recipient: body.recipient, purpose: body.purpose, by: user.id });
  store.save();
  return harvest;
}
