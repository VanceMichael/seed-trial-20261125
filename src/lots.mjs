import { isValidId, fail, requireFields, nowIso, positiveInt } from './util.mjs';
import { checkPlanForLot } from './plans.mjs';
import {
  getUser, requireRole, getLot, getVariety, requireLotHealthy,
  getPlan, ensureSiteScope,
} from './helpers.mjs';
import { toBase } from './helpers.mjs';

function emptyBuckets() {
  return {
    siteUsable: {},
    siteQuarantine: {},
    returning: 0,
    pendingReturn: 0,
    preparedStock: 0,
    inTransit: 0,
    committed: 0,
    sown: 0,
    destroyed: 0,
    loss: 0,
  };
}

// 种子按批次记录品种、封样、可用数量、适用生态区和准许用途。
export function createLot(store, actor, body) {
  const user = getUser(store.state, actor.id);
  requireRole(user, ['approver', 'keeper']);
  requireFields(body, ['id', 'varietyId', 'seal', 'regions', 'purpose']);
  if (!isValidId(body.id)) fail(400, 'bad_id', '批次编号格式不符');
  if (store.state.lots[body.id]) fail(409, 'lot_exists', '批次编号已存在');
  const variety = getVariety(store.state, body.varietyId);
  if (!Array.isArray(body.regions) || !body.regions.length) fail(400, 'bad_regions', '适用生态区至少一项');
  if (!['research', 'commercial'].includes(body.purpose)) fail(400, 'bad_purpose', '准许用途只能是 research 或 commercial');
  const baseUnit = body.baseUnit ?? (body.grams !== undefined ? 'grams' : 'seeds');
  if (!['grams', 'seeds'].includes(baseUnit)) fail(400, 'bad_unit', '基准计量只能是 grams 或 seeds');
  const rawQuantity = baseUnit === 'grams' ? body.grams : body.seeds;
  positiveInt(rawQuantity, '可用数量');
  if (baseUnit === 'grams' && body.seeds !== undefined) fail(400, 'bad_unit', '克为基准计量时建批数量请填 grams');
  if (baseUnit === 'seeds' && body.grams !== undefined) fail(400, 'bad_unit', '粒为基准计量时建批数量请填 seeds');
  const availableBase = rawQuantity;
  const conversionBasis = body.conversionBasis
    ? validateBasis(body.conversionBasis, baseUnit)
    : null;
  const lot = {
    id: body.id,
    varietyId: variety.id,
    seal: body.seal,
    baseUnit,
    totalBase: availableBase,
    availableBase,
    purpose: body.purpose,
    regions: [...body.regions],
    status: 'active',
    conversionBasis,
    identityNote: null,
    ...emptyBuckets(),
    history: [{ at: nowIso(), by: user.id, action: 'created', detail: `封样 ${body.seal}，可用 ${availableBase} ${baseUnit}` }],
  };
  store.state.lots[lot.id] = lot;
  store.appendLedger({ type: 'lot_registered', lotId: lot.id, baseUnit, quantityBase: availableBase, seal: body.seal, by: user.id });
  store.save();
  return lot;
}

function validateBasis(basis, lotBaseUnit) {
  if (!basis || !['grams', 'seeds'].includes(basis.fromUnit) || !['grams', 'seeds'].includes(basis.toUnit)) {
    fail(400, 'bad_basis', '换算依据需声明 fromUnit/toUnit（grams/seeds）');
  }
  if (basis.fromUnit === basis.toUnit) fail(400, 'bad_basis', '同口径不需要换算依据');
  if (basis.toUnit !== lotBaseUnit) fail(400, 'bad_basis', '换算依据的目标口径必须与批次基准计量一致');
  if (!Number.isInteger(basis.factorNumerator) || !Number.isInteger(basis.factorDenominator)
    || basis.factorNumerator <= 0 || basis.factorDenominator <= 0) {
    fail(400, 'bad_basis', '换算因子必须是正整数（factorNumerator/factorDenominator）');
  }
  return {
    fromUnit: basis.fromUnit,
    toUnit: basis.toUnit,
    factorNumerator: basis.factorNumerator,
    factorDenominator: basis.factorDenominator,
    approvedBy: basis.approvedBy ?? null,
    approvedAt: nowIso(),
  };
}

// 批次中一部分受潮：只隔离受影响数量，余下合格部分不自动报废。
export function reportQualityEvent(store, actor, body) {
  const user = getUser(store.state, actor.id);
  requireRole(user, ['quality', 'keeper']);
  requireFields(body, ['lotId', 'quantity', 'unit', 'event']);
  const lot = getLot(store.state, body.lotId);
  requireLotHealthy(lot);
  const qty = toBase(lot, body.quantity, body.unit, '受影响数量');
  const source = body.source ?? 'available';
  if (!['available', 'siteUsable'].includes(source)) fail(400, 'bad_source', '受潮来源只能是 available（库内可用）或 siteUsable（站点可用）');
  if (source === 'available') {
    if (lot.availableBase < qty) fail(409, 'insufficient_stock', `库内可用 ${lot.availableBase} ${lot.baseUnit}，不足隔离 ${qty}`);
    if (qty > lot.availableBase - lot.committed) {
      fail(409, 'stock_reserved', `其中 ${lot.committed} ${lot.baseUnit} 已承诺给试验点，不能对已承诺部分直接隔离；请先调整对应承诺`);
    }
    lot.availableBase -= qty;
    lot.quarantineBase = (lot.quarantineBase ?? 0) + qty;
  } else {
    requireFields(body, ['siteId']);
    ensureSiteScope(user, body.siteId);
    const have = lot.siteUsable[body.siteId] ?? 0;
    if (have < qty) fail(409, 'insufficient_stock', `站点 ${body.siteId} 可用 ${have} ${lot.baseUnit}，不足隔离 ${qty}`);
    lot.siteUsable[body.siteId] = have - qty;
    lot.siteQuarantine[body.siteId] = (lot.siteQuarantine[body.siteId] ?? 0) + qty;
  }
  const event = {
    id: store.nextId('QE'),
    lotId: lot.id,
    event: body.event,
    quantityBase: qty,
    unit: body.unit,
    source,
    siteId: body.siteId ?? null,
    status: 'quarantined',
    note: body.note ?? '',
    at: nowIso(),
    by: user.id,
  };
  (lot.qualityEvents ??= []).push(event);
  lot.history.push({ at: nowIso(), by: user.id, action: 'quality_quarantine', detail: `${event.event} 隔离 ${qty} ${lot.baseUnit}（${source}）` });
  store.appendLedger({ type: 'quality_quarantine', lotId: lot.id, quantityBase: qty, source, siteId: event.siteId, qualityEventId: event.id, by: user.id });
  store.save();
  return event;
}

// 隔离部分的使用仍需有权人员对适用部分明确放行；也可销毁受潮部分。
export function releaseQuarantine(store, actor, body) {
  const user = getUser(store.state, actor.id);
  requireRole(user, ['approver']);
  requireFields(body, ['lotId', 'quantity', 'unit', 'decision']);
  const lot = getLot(store.state, body.lotId);
  const qty = toBase(lot, body.quantity, body.unit, '放行数量');
  const scope = body.scope ?? 'warehouse';
  if (!['warehouse', 'site'].includes(scope)) fail(400, 'bad_scope', '放行范围只能是 warehouse 或 site');
  if (scope === 'warehouse') {
    if ((lot.quarantineBase ?? 0) < qty) fail(409, 'insufficient_quarantine', `库内隔离 ${lot.quarantineBase ?? 0} ${lot.baseUnit}，不足 ${qty}`);
    lot.quarantineBase -= qty;
    if (body.decision === 'release_usable') lot.availableBase += qty;
    else if (body.decision === 'destroy') {
      lot.destroyed += qty;
      store.appendLedger({ type: 'destruction', lotId: lot.id, quantityBase: qty, source: 'warehouse_quarantine', by: user.id, reason: body.reason ?? '受潮销毁' });
    } else fail(400, 'bad_decision', 'decision 只能是 release_usable 或 destroy');
  } else {
    requireFields(body, ['siteId']);
    ensureSiteScope(user, body.siteId);
    const have = lot.siteQuarantine[body.siteId] ?? 0;
    if (have < qty) fail(409, 'insufficient_quarantine', `站点隔离 ${have} ${lot.baseUnit}，不足 ${qty}`);
    lot.siteQuarantine[body.siteId] = have - qty;
    if (body.decision === 'release_usable') lot.siteUsable[body.siteId] = (lot.siteUsable[body.siteId] ?? 0) + qty;
    else if (body.decision === 'destroy') {
      lot.destroyed += qty;
      store.appendLedger({ type: 'destruction', lotId: lot.id, quantityBase: qty, source: 'site_quarantine', siteId: body.siteId, by: user.id, reason: body.reason ?? '受潮销毁' });
    } else fail(400, 'bad_decision', 'decision 只能是 release_usable 或 destroy');
  }
  lot.history.push({ at: nowIso(), by: user.id, action: 'quarantine_decision', detail: `${scope} ${body.decision} ${qty} ${lot.baseUnit}` });
  store.save();
  return { lotId: lot.id, decision: body.decision, quantityBase: qty, scope, siteId: body.siteId ?? null };
}

// 批次更正身份：影响已承诺的试验点；未发部分暂停核实，已播种保持真实记录并标记受影响范围。
export function correctIdentity(store, actor, body) {
  const user = getUser(store.state, actor.id);
  requireRole(user, ['approver']);
  requireFields(body, ['lotId', 'changes']);
  const lot = getLot(store.state, body.lotId);
  if (lot.status === 'identity_hold') fail(409, 'identity_hold', '该批已在身份更正核实中');
  if (lot.status === 'closed') fail(409, 'lot_closed', '批次已关闭');
  const before = { varietyId: lot.varietyId, seal: lot.seal, regions: [...lot.regions], purpose: lot.purpose };
  const changes = body.changes;
  if (changes.varietyId !== undefined) getVariety(store.state, changes.varietyId);
  if (changes.regions !== undefined && (!Array.isArray(changes.regions) || !changes.regions.length)) {
    fail(400, 'bad_regions', '适用生态区至少一项');
  }
  if (changes.purpose !== undefined && !['research', 'commercial'].includes(changes.purpose)) {
    fail(400, 'bad_purpose', '用途只能是 research 或 commercial');
  }
  lot.status = 'identity_hold';
  lot.identityNote = {
    at: nowIso(),
    by: user.id,
    before,
    proposed: changes,
    reason: body.reason ?? '身份更正核实',
    affectedPlans: [],
    affectedSown: [],
  };
  // 已承诺（未发）的试验点暂停；已播种的保留真实记录并标记受影响。
  for (const commitment of Object.values(store.state.commitments)) {
    if (commitment.lotId !== lot.id) continue;
    if (['committed', 'partially_shipped'].includes(commitment.status)) {
      commitment.status = 'suspended_identity';
      commitment.history.push({ at: nowIso(), by: user.id, action: 'suspended_identity', detail: '批次身份更正，未发部分暂停核实' });
      lot.identityNote.affectedPlans.push(commitment.planId);
    }
  }
  for (const movement of store.state.movements) {
    if (movement.lotId === lot.id && movement.kind === 'sow') {
      movement.identityAffected = true;
      movement.identityNote = `批次 ${lot.id} 身份更正，已播种记录保持真实，标记受影响范围`;
      lot.identityNote.affectedSown.push(movement.id);
    }
  }
  lot.history.push({ at: nowIso(), by: user.id, action: 'identity_correction_opened', detail: body.reason ?? '身份更正核实' });
  store.save();
  return { lotId: lot.id, status: lot.status, identityNote: lot.identityNote };
}

// 核实结束：库管/核准人确认更正后的身份事实，批次恢复；各承诺仍需逐点重新核准。
export function resolveIdentity(store, actor, body) {
  const user = getUser(store.state, actor.id);
  requireRole(user, ['approver', 'quality']);
  requireFields(body, ['lotId', 'verifiedChanges']);
  const lot = getLot(store.state, body.lotId);
  if (lot.status !== 'identity_hold') fail(409, 'not_on_hold', '该批当前不在身份更正核实中');
  const changes = body.verifiedChanges;
  if (changes.varietyId !== undefined) getVariety(store.state, changes.varietyId);
  Object.assign(lot, {
    varietyId: changes.varietyId ?? lot.varietyId,
    seal: changes.seal ?? lot.seal,
    regions: changes.regions ?? lot.regions,
    purpose: changes.purpose ?? lot.purpose,
  });
  lot.status = 'active';
  lot.history.push({ at: nowIso(), by: user.id, action: 'identity_correction_resolved', detail: `更正后身份：品种 ${lot.varietyId}，封样 ${lot.seal}` });
  lot.identityNote.resolvedAt = nowIso();
  lot.identityNote.resolvedBy = user.id;
  store.save();
  return { lotId: lot.id, status: lot.status, varietyId: lot.varietyId, seal: lot.seal };
}

// 重新核准受身份更正影响的承诺：按新身份重新检查许可与适用范围，旧许可不自动沿用。
export function reconfirmCommitment(store, actor, body) {
  const user = getUser(store.state, actor.id);
  requireRole(user, ['approver']);
  requireFields(body, ['commitmentId']);
  const commitment = store.state.commitments[body.commitmentId];
  if (!commitment) fail(404, 'commitment_not_found', `承诺不存在：${body.commitmentId}`);
  if (commitment.status !== 'suspended_identity') fail(409, 'commitment_not_suspended', '只有暂停核实的承诺可以重新核准');
  const lot = getLot(store.state, commitment.lotId);
  const plan = getPlan(store.state, commitment.planId);
  if (lot.status === 'identity_hold') fail(409, 'identity_hold', '批次身份核实未结束，不能重新核准');
  const permit = checkPlanForLot(store.state, plan, lot);
  commitment.status = commitment.shippedBase > 0 ? 'partially_shipped' : 'committed';
  commitment.history.push({ at: nowIso(), by: user.id, action: 'reconfirmed', detail: `按更正后身份重新核准，许可 ${permit.id}` });
  store.save();
  return commitment;
}

// 销毁：库内可用/隔离或站点隔离材料，经核准人决定。
export function destroyMaterial(store, actor, body) {
  const user = getUser(store.state, actor.id);
  requireRole(user, ['approver']);
  requireFields(body, ['lotId', 'quantity', 'unit', 'source']);
  const lot = getLot(store.state, body.lotId);
  const qty = toBase(lot, body.quantity, body.unit, '销毁数量');
  let ledgerSource;
  if (body.source === 'available') {
    if (lot.availableBase < qty) fail(409, 'insufficient_stock', `可用 ${lot.availableBase}，不足销毁 ${qty}`);
    if (qty > lot.availableBase - lot.committed) {
      fail(409, 'stock_reserved', `其中 ${lot.committed} ${lot.baseUnit} 已承诺，不能销毁已承诺部分`);
    }
    lot.availableBase -= qty;
    ledgerSource = 'warehouse_available';
  } else if (body.source === 'warehouse_quarantine') {
    if ((lot.quarantineBase ?? 0) < qty) fail(409, 'insufficient_quarantine', `库内隔离不足`);
    lot.quarantineBase -= qty;
    ledgerSource = 'warehouse_quarantine';
  } else if (body.source === 'site_quarantine') {
    requireFields(body, ['siteId']);
    ensureSiteScope(user, body.siteId);
    const have = lot.siteQuarantine[body.siteId] ?? 0;
    if (have < qty) fail(409, 'insufficient_quarantine', `站点隔离不足`);
    lot.siteQuarantine[body.siteId] = have - qty;
    ledgerSource = 'site_quarantine';
  } else {
    fail(400, 'bad_source', '销毁来源只能是 available、warehouse_quarantine、site_quarantine');
  }
  lot.destroyed += qty;
  const record = { id: store.nextId('DES'), lotId: lot.id, quantityBase: qty, source: ledgerSource, siteId: body.siteId ?? null, reason: body.reason ?? '经核准销毁', at: nowIso(), by: user.id };
  store.state.destructions.push(record);
  store.appendLedger({ type: 'destruction', lotId: lot.id, quantityBase: qty, source: ledgerSource, siteId: record.siteId, by: user.id, reason: record.reason });
  lot.history.push({ at: nowIso(), by: user.id, action: 'destroy', detail: `${qty} ${lot.baseUnit}（${ledgerSource}）` });
  store.save();
  return record;
}
