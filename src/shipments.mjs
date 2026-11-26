import { fail, requireFields, nowIso } from './util.mjs';
import {
  getUser, requireRole, getLot, getPlan, getSite, ensureSiteScope,
  requireLotHealthy, requirePlanOpen, toBase, findPermit,
} from './helpers.mjs';

function getCommitment(state, id) {
  const commitment = state.commitments[id];
  if (!commitment) fail(404, 'commitment_not_found', `承诺不存在：${id}`);
  return commitment;
}

function getShipment(state, id) {
  const shipment = state.shipments[id];
  if (!shipment) fail(404, 'shipment_not_found', `运输包不存在：${id}`);
  return shipment;
}

// 分批发种：库管从已核准承诺中拆包，承诺量内分批发。
export function createShipment(store, actor, body) {
  const user = getUser(store.state, actor.id);
  requireRole(user, ['keeper']);
  requireFields(body, ['commitmentId', 'quantity', 'unit', 'seal', 'carrierRef']);
  const commitment = getCommitment(store.state, body.commitmentId);
  if (!['committed', 'partially_shipped'].includes(commitment.status)) {
    fail(409, 'commitment_not_shippable', `承诺状态 ${commitment.status}，不能发种`);
  }
  const plan = getPlan(store.state, commitment.planId);
  requirePlanOpen(plan);
  const lot = getLot(store.state, commitment.lotId);
  requireLotHealthy(lot);
  const qty = toBase(lot, body.quantity, body.unit, '本批发种数量');
  const reserved = commitment.shippedBase + (commitment.preparedBase ?? 0);
  const remaining = commitment.quantityBase - reserved;
  if (qty > remaining) fail(409, 'over_shipment', `本承诺剩余未备 ${remaining} ${lot.baseUnit}（已发 ${commitment.shippedBase}，待出库 ${commitment.preparedBase ?? 0}），不能再备 ${qty}`);
  if (qty > lot.availableBase) fail(409, 'insufficient_stock', `库内可用仅 ${lot.availableBase} ${lot.baseUnit}`);
  // 备货即物理预留：从可用桶进入备货桶，防止超卖；承诺 overlay 不变。
  lot.availableBase -= qty;
  lot.preparedStock += qty;
  const shipment = {
    id: store.nextId('SHP'),
    commitmentId: commitment.id,
    planId: plan.id,
    lotId: lot.id,
    originSeal: body.seal,
    carrierRef: body.carrierRef,
    quantityBase: qty,
    unit: body.unit,
    sourceSiteId: null,
    destinationSiteId: commitment.siteId,
    status: 'prepared',
    legs: [{ leg: 1, from: '仓库', to: commitment.siteId, seal: body.seal, at: nowIso(), note: '库管备货封签' }],
    dispatch: null,
    delivery: null,
    acceptance: null,
    createdAt: nowIso(),
    createdBy: user.id,
  };
  store.state.shipments[shipment.id] = shipment;
  commitment.preparedBase = (commitment.preparedBase ?? 0) + qty;
  commitment.history.push({ at: nowIso(), by: user.id, action: 'prepare', detail: `备货 ${shipment.id} ${qty} ${lot.baseUnit}，待出库` });
  store.save();
  return shipment;
}

// 备货后出库前取消：实物退回可用桶，承诺预留同步解除。
export function cancelShipment(store, actor, id, body = {}) {
  const user = getUser(store.state, actor.id);
  requireRole(user, ['keeper']);
  const shipment = getShipment(store.state, id);
  if (shipment.status !== 'prepared') fail(409, 'shipment_not_prepared', `运输包状态 ${shipment.status}，只有备货未出库可以取消`);
  const lot = getLot(store.state, shipment.lotId);
  lot.preparedStock -= shipment.quantityBase;
  lot.availableBase += shipment.quantityBase;
  const commitment = getCommitment(store.state, shipment.commitmentId);
  commitment.preparedBase = Math.max(0, (commitment.preparedBase ?? 0) - shipment.quantityBase);
  commitment.status = commitment.shippedBase > 0 ? 'partially_shipped' : 'committed';
  commitment.history.push({ at: nowIso(), by: user.id, action: 'cancel_prepare', detail: `取消备货 ${shipment.id}，${shipment.quantityBase} ${lot.baseUnit} 退回可用` });
  shipment.status = 'cancelled';
  shipment.cancelledAt = nowIso();
  shipment.cancelReason = body.reason ?? '库管取消备货';
  store.appendLedger({ type: 'prepare_cancelled', lotId: lot.id, shipmentId: shipment.id, quantityBase: shipment.quantityBase, by: user.id });
  store.save();
  return shipment;
}

// 运输封签与出库由库管确认；已承诺种子转为在途。
export function recordDispatch(store, actor, id, body = {}) {
  const user = getUser(store.state, actor.id);
  requireRole(user, ['keeper']);
  const shipment = getShipment(store.state, id);
  if (shipment.status !== 'prepared') fail(409, 'shipment_not_prepared', `运输包状态 ${shipment.status}，不能出库`);
  const lot = getLot(store.state, shipment.lotId);
  if (lot.preparedStock < shipment.quantityBase) fail(409, 'insufficient_stock', '出库时备货桶不足');
  lot.preparedStock -= shipment.quantityBase;
  lot.inTransit += shipment.quantityBase;
  shipment.status = 'in_transit';
  shipment.dispatch = { seal: body.seal ?? shipment.originSeal, carrierRef: shipment.carrierRef, at: nowIso(), by: user.id };
  shipment.legs.push({ leg: shipment.legs.length + 1, from: '仓库', to: shipment.destinationSiteId, seal: shipment.dispatch.seal, at: shipment.dispatch.at, note: '承运方收件出库' });
  const commitment = getCommitment(store.state, shipment.commitmentId);
  commitment.preparedBase = Math.max(0, (commitment.preparedBase ?? 0) - shipment.quantityBase);
  commitment.shippedBase += shipment.quantityBase;
  // 承诺 overlay 只覆盖尚未出库的部分，已出库材料改由在途/站点桶承载。
  lot.committed -= shipment.quantityBase;
  commitment.status = commitment.shippedBase >= commitment.quantityBase ? 'shipped' : 'partially_shipped';
  commitment.history.push({ at: nowIso(), by: user.id, action: 'dispatch', detail: `发运 ${shipment.id} ${shipment.quantityBase} ${lot.baseUnit}` });
  store.appendLedger({ type: 'dispatch', lotId: lot.id, shipmentId: shipment.id, planId: shipment.planId, quantityBase: shipment.quantityBase, from: '仓库', to: shipment.destinationSiteId, seal: shipment.dispatch.seal, by: user.id });
  lot.history.push({ at: nowIso(), by: user.id, action: 'dispatch', detail: `${shipment.quantityBase} ${lot.baseUnit} 出库在途（${shipment.id}）` });
  store.save();
  return shipment;
}

// 交付到点：库管/承运回执登记；回执中断时保持在途，同一包不能重新标成可发。
export function recordDelivery(store, actor, id, body = {}) {
  const user = getUser(store.state, actor.id);
  requireRole(user, ['keeper']);
  const shipment = getShipment(store.state, id);
  if (shipment.status !== 'in_transit') fail(409, 'not_in_transit', `运输包状态 ${shipment.status}，不能登记交付`);
  if (body.receiptInterrupted) {
    shipment.status = 'receipt_interrupted';
    shipment.delivery = { interrupted: true, at: nowIso(), by: user.id, note: body.note ?? '承运方已收件但回执中断' };
    shipment.legs.push({ leg: shipment.legs.length + 1, from: shipment.legs.at(-1)?.from ?? '仓库', to: shipment.destinationSiteId, seal: shipment.dispatch?.seal ?? shipment.originSeal, at: nowIso(), note: '回执中断，保持在途责任' });
    store.save();
    return shipment;
  }
  shipment.status = 'delivered';
  shipment.delivery = {
    seal: body.seal ?? shipment.dispatch?.seal ?? shipment.originSeal,
    quantityBase: body.quantityBase ?? shipment.quantityBase,
    at: nowIso(),
    by: user.id,
  };
  store.save();
  return shipment;
}

// 回执恢复后补登记交付；中断期间没有产生第二包可发库存。
export function resumeReceipt(store, actor, id, body = {}) {
  const user = getUser(store.state, actor.id);
  requireRole(user, ['keeper']);
  const shipment = getShipment(store.state, id);
  if (shipment.status !== 'receipt_interrupted') fail(409, 'not_interrupted', '只有回执中断的运输包可以补登记');
  shipment.status = 'delivered';
  shipment.delivery = {
    seal: body.seal ?? shipment.dispatch?.seal ?? shipment.originSeal,
    quantityBase: body.quantityBase ?? shipment.quantityBase,
    at: nowIso(),
    by: user.id,
    resumedFromInterruption: true,
  };
  store.save();
  return shipment;
}

// 站点实际验收：封签、交付数量分别确认；未验收或验收隔离的数量不能填成已播种。
export function confirmReceipt(store, actor, id, body) {
  const user = getUser(store.state, actor.id);
  requireRole(user, ['site']);
  const shipment = getShipment(store.state, id);
  ensureSiteScope(user, shipment.destinationSiteId);
  if (shipment.status !== 'delivered') fail(409, 'not_delivered', `运输包状态 ${shipment.status}，不能验收`);
  if (shipment.acceptance) fail(409, 'already_accepted', '该运输包已验收，更正须另立事实记录');
  requireFields(body, ['sealIntact', 'quantity', 'unit']);
  const lot = getLot(store.state, shipment.lotId);
  const acceptedBase = toBase(lot, body.quantity, body.unit, '验收数量');
  if (acceptedBase > shipment.quantityBase) fail(409, 'over_acceptance', `验收数量不能超过发运量 ${shipment.quantityBase} ${lot.baseUnit}`);
  const plan = getPlan(store.state, shipment.planId);
  if (plan.status === 'closed') fail(409, 'plan_closed', '方案已结清，不能验收');
  const sealMatch = body.sealIntact === true && (body.seal ?? shipment.originSeal) === shipment.originSeal;
  const quarantineBase = shipment.quantityBase - acceptedBase;
  const acceptance = {
    id: store.nextId('ACC'),
    shipmentId: shipment.id,
    siteId: shipment.destinationSiteId,
    sealIntact: body.sealIntact === true,
    sealMatch,
    acceptedBase,
    quarantineBase,
    note: body.note ?? '',
    at: nowIso(),
    by: user.id,
  };
  lot.inTransit -= shipment.quantityBase;
  if (acceptedBase > 0) lot.siteUsable[shipment.destinationSiteId] = (lot.siteUsable[shipment.destinationSiteId] ?? 0) + acceptedBase;
  if (quarantineBase > 0) lot.siteQuarantine[shipment.destinationSiteId] = (lot.siteQuarantine[shipment.destinationSiteId] ?? 0) + quarantineBase;
  shipment.acceptance = acceptance;
  shipment.status = quarantineBase > 0 ? 'accepted_partial_quarantine' : 'accepted';
  store.state.acceptances[acceptance.id] = acceptance;
  store.appendLedger({
    type: 'acceptance', lotId: lot.id, shipmentId: shipment.id, planId: shipment.planId, siteId: shipment.destinationSiteId,
    quantityBase: acceptedBase, quarantineBase, sealIntact: acceptance.sealIntact, sealMatch, by: user.id,
  });
  lot.history.push({ at: nowIso(), by: user.id, action: 'acceptance', detail: `站点 ${shipment.destinationSiteId} 验收 ${acceptedBase}，隔离 ${quarantineBase}（${shipment.id}）` });
  store.save();
  return acceptance;
}

// 发错点后的转送：确认目的点许可与原封样关系；不允许单改地址掩盖流向。
export function forwardShipment(store, actor, id, body) {
  const user = getUser(store.state, actor.id);
  requireRole(user, ['approver', 'keeper']);
  const shipment = getShipment(store.state, id);
  requireFields(body, ['toSiteId', 'seal']);
  if (['accepted', 'accepted_partial_quarantine'].includes(shipment.status)) {
    fail(409, 'already_accepted', '已验收的包不能转送，应走回收/重新发种流程');
  }
  const toSite = getSite(store.state, body.toSiteId);
  if (toSite.id === shipment.destinationSiteId) fail(400, 'same_destination', '转送目的点与原目的点相同');
  if (body.seal !== shipment.originSeal && body.seal !== shipment.dispatch?.seal) {
    fail(409, 'seal_mismatch', '转送封签必须与原封样或出库封签一致，不能以新封签掩盖原包身份');
  }
  const plan = getPlan(store.state, shipment.planId);
  const lot = getLot(store.state, shipment.lotId);
  // 目的点许可、品种、生态区、用途重新核准；方案若未换址也要验证目的点资格。
  const effectiveSiteId = toSite.id;
  const probe = { ...plan, siteId: effectiveSiteId };
  const permit = findPermit(store.state, effectiveSiteId, plan.varietyId, plan.season, plan.purpose);
  if (!permit) fail(409, 'permit_mismatch', `目的点 ${effectiveSiteId} 缺少对应许可，转送不能成立`);
  if (!lot.regions.includes(toSite.region)) fail(409, 'region_mismatch', `批次适用生态区不覆盖目的点 ${effectiveSiteId}`);
  const legNo = shipment.legs.length + 1;
  shipment.legs.push({ leg: legNo, from: shipment.destinationSiteId, to: toSite.id, seal: body.seal, at: nowIso(), by: user.id, note: body.reason ?? '发错点转送，保留原封样关系' });
  shipment.sourceSiteId = shipment.destinationSiteId;
  shipment.destinationSiteId = toSite.id;
  shipment.forwardedFrom = shipment.sourceSiteId;
  if (shipment.status === 'delivered') {
    // 已交付但未验收即发现错点：回到在途。该数量本就仍在在途桶（验收时才落地），不重复计数。
    shipment.status = 'in_transit';
    shipment.delivery = null;
  }
  shipment.historyNote = `经核准转送：${shipment.sourceSiteId} → ${toSite.id}`;
  store.appendLedger({ type: 'forward', lotId: lot.id, shipmentId: shipment.id, planId: plan.id, quantityBase: shipment.quantityBase, from: shipment.sourceSiteId, to: toSite.id, seal: body.seal, by: user.id });
  store.save();
  return shipment;
}
