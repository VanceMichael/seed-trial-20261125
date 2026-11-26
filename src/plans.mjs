import { isValidId, fail, requireFields, nowIso } from './util.mjs';
import {
  getUser, requireRole, getPlan, getSite, getVariety, getLot,
  checkEligibility, requirePlanOpen, ensureSiteScope, findPermit,
} from './helpers.mjs';

// 方案核准：许可、品种使用范围、生态区、用途同时检查。
export function checkPlanForLot(state, plan, lot) {
  if (plan.status !== 'approved') fail(409, 'plan_not_approved', `方案 ${plan.id} 当前状态 ${plan.status}，未核准不能使用`);
  return checkEligibility(state, plan, lot);
}

export function createPlan(store, actor, body) {
  const user = getUser(store.state, actor.id);
  requireFields(body, ['siteId', 'season', 'varietyId', 'purpose']);
  if (!['research', 'commercial'].includes(body.purpose)) fail(400, 'bad_purpose', '用途只能是 research 或 commercial');
  const site = getSite(store.state, body.siteId);
  const variety = getVariety(store.state, body.varietyId);
  if (user.role === 'site') ensureSiteScope(user, site.id);
  const id = body.id ?? store.nextId('PLAN');
  if (!isValidId(id)) fail(400, 'bad_id', '方案编号格式不符');
  if (store.state.plans[id]) fail(409, 'plan_exists', '方案编号已存在');
  const plan = {
    id,
    siteId: site.id,
    season: body.season,
    varietyId: variety.id,
    purpose: body.purpose,
    status: 'draft',
    createdAt: nowIso(),
    createdBy: user.id,
    history: [{ at: nowIso(), by: user.id, action: 'created', detail: `站点 ${site.id} / ${body.season} / ${variety.id} / ${body.purpose}` }],
  };
  store.state.plans[id] = plan;
  store.save();
  return plan;
}

export function approvePlan(store, actor, id) {
  const user = getUser(store.state, actor.id);
  requireRole(user, ['approver']);
  const plan = getPlan(store.state, id);
  if (plan.status === 'approved') fail(409, 'plan_already_approved', '方案已核准');
  if (plan.status === 'terminated' || plan.status === 'closed') fail(409, 'plan_final', '方案已终止或结清，不能核准');
  // 先确认许可存在；品种使用范围在具体批次使用时再逐项核对。
  const permit = findPermit(store.state, plan.siteId, plan.varietyId, plan.season, plan.purpose);
  if (!permit) {
    fail(409, 'permit_mismatch', `核准被拒：站点 ${plan.siteId} 在 ${plan.season} 季以 ${plan.purpose} 用途使用 ${plan.varietyId} 缺少有效许可`);
  }
  plan.status = 'approved';
  plan.history.push({ at: nowIso(), by: user.id, action: 'approved', detail: `许可 ${permit.id}` });
  store.save();
  return plan;
}

// 站点搬迁或方案更换品种：旧许可不能直接沿用，方案回到待核准。
export function amendPlan(store, actor, id, body) {
  const user = getUser(store.state, actor.id);
  const plan = getPlan(store.state, id);
  if (plan.status === 'closed') fail(409, 'plan_closed', '方案已结清，不能修改');
  if (user.role === 'site') ensureSiteScope(user, plan.siteId);
  const before = { siteId: plan.siteId, varietyId: plan.varietyId, purpose: plan.purpose, season: plan.season };
  if (body.siteId !== undefined) getSite(store.state, body.siteId);
  if (body.varietyId !== undefined) getVariety(store.state, body.varietyId);
  if (body.purpose !== undefined && !['research', 'commercial'].includes(body.purpose)) fail(400, 'bad_purpose', '用途只能是 research 或 commercial');
  Object.assign(plan, {
    siteId: body.siteId ?? plan.siteId,
    varietyId: body.varietyId ?? plan.varietyId,
    purpose: body.purpose ?? plan.purpose,
    season: body.season ?? plan.season,
  });
  const changed = Object.keys(before).some((key) => before[key] !== plan[key]);
  if (changed) {
    plan.status = 'draft';
    plan.history.push({ at: nowIso(), by: user.id, action: 'amended', detail: `方案要素变更（${JSON.stringify(before)} → ${JSON.stringify({ siteId: plan.siteId, varietyId: plan.varietyId, purpose: plan.purpose, season: plan.season })}），需重新核准，旧许可不沿用` });
  } else {
    plan.history.push({ at: nowIso(), by: user.id, action: 'amended_noop', detail: body.reason ?? '要素未变' });
  }
  store.save();
  return plan;
}

export function terminatePlan(store, actor, id, body = {}) {
  const user = getUser(store.state, actor.id);
  const plan = getPlan(store.state, id);
  if (user.role === 'site') ensureSiteScope(user, plan.siteId);
  if (plan.status === 'terminated') fail(409, 'plan_terminated', '方案已终止');
  if (plan.status === 'closed') fail(409, 'plan_closed', '方案已结清');
  plan.status = 'terminated';
  plan.terminatedAt = nowIso();
  plan.terminateReason = body.reason ?? '终止一季试种';
  plan.history.push({ at: nowIso(), by: user.id, action: 'terminated', detail: plan.terminateReason });
  // 未发的承诺解除；承诺量本就是可用/备货实物上的预留 overlay，解除只减 committed，不重复增加实物。
  for (const commitment of Object.values(store.state.commitments)) {
    if (commitment.planId !== plan.id) continue;
    if (['committed', 'suspended_identity'].includes(commitment.status)) {
      const lot = getLot(store.state, commitment.lotId);
      const unshipped = commitment.quantityBase - commitment.shippedBase;
      if ((commitment.preparedBase ?? 0) > 0) {
        fail(409, 'prepared_shipment_open', `承诺 ${commitment.id} 仍有备货未出库，请先取消备货或完成出库，不能终止方案`);
      }
      lot.committed -= unshipped;
      commitment.status = 'cancelled_termination';
      commitment.history.push({ at: nowIso(), by: user.id, action: 'cancelled_termination', detail: `方案终止，未发 ${unshipped} ${lot.baseUnit} 解除承诺预留` });
    }
  }
  store.save();
  return plan;
}

// 项目结清材料责任：已播种事实保留；未用种子必须完成回收或经核准销毁；采收材料有交接去向。
export function closePlan(store, actor, id) {
  const user = getUser(store.state, actor.id);
  requireRole(user, ['approver']);
  const plan = getPlan(store.state, id);
  if (plan.status === 'closed') fail(409, 'plan_closed', '方案已结清');
  const blockers = planOpenItems(store.state, plan);
  if (blockers.length) {
    fail(409, 'plan_has_open_materials', '仍有未结材料，不能结清项目', { blockers });
  }
  plan.status = 'closed';
  plan.closedAt = nowIso();
  plan.history.push({ at: nowIso(), by: user.id, action: 'closed', detail: '未结材料全部落实后结清' });
  store.save();
  return plan;
}

// 未结材料清单（逐条责任，不做统计汇总替代）。
export function planOpenItems(state, plan) {
  const items = [];
  for (const shipment of Object.values(state.shipments)) {
    if (shipment.planId !== plan.id) continue;
    if (['accepted', 'accepted_partial_quarantine'].includes(shipment.status)) continue;
    if (!shipment.deliveredAt) {
      items.push({ kind: 'shipment_in_transit', shipmentId: shipment.id, lotId: shipment.lotId, quantityBase: shipment.quantityBase, status: shipment.status, responsible: '承运方/库管', detail: '承运方已收件但回执中断，仍在途，不能重新标成可发' });
    } else if (!shipment.acceptance) {
      items.push({ kind: 'shipment_awaiting_acceptance', shipmentId: shipment.id, lotId: shipment.lotId, quantityBase: shipment.quantityBase, responsible: `站点 ${shipment.destinationSiteId}`, detail: '已交付但站点尚未实际验收' });
    }
  }
  for (const movement of state.movements) {
    if (movement.planId !== plan.id) continue;
    if (movement.kind === 'return' && movement.recoveryId) {
      const recovery = state.recoveries[movement.recoveryId];
      if (recovery && !['verified', 'destroyed'].includes(recovery.status)) {
        items.push({ kind: 'recovery_open', recoveryId: recovery.id, lotId: recovery.lotId, quantityBase: recovery.quantityBase, status: recovery.status, responsible: recovery.status === 'in_transit' ? '站点/承运方' : '库管', detail: '回收包未完成身份核实或处置，不能并入可用库存' });
      }
    }
  }
  for (const lot of Object.values(state.lots)) {
    const usable = lot.siteUsable[plan.siteId] ?? 0;
    const quarantined = lot.siteQuarantine[plan.siteId] ?? 0;
    if (usable > 0 || quarantined > 0) {
      items.push({ kind: 'materials_at_site', lotId: lot.id, siteId: plan.siteId, usableBase: usable, quarantineBase: quarantined, responsible: `站点 ${plan.siteId}`, detail: '站点仍持有未用/隔离材料，需回收或经核准销毁' });
    }
  }
  for (const harvest of Object.values(state.harvests)) {
    if (harvest.planId !== plan.id) continue;
    if (harvest.status !== 'handover') {
      items.push({ kind: 'harvest_open', harvestId: harvest.id, lotId: harvest.sourceLotId, quantityBase: harvest.quantityBase, status: harvest.status, responsible: `站点 ${plan.siteId}`, detail: '采收材料仍受原用途限制，需登记交接去向，不能换包装对外发放' });
    }
  }
  return items;
}
