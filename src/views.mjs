import { getUser, getLot, getPlan } from './helpers.mjs';
import { planOpenItems } from './plans.mjs';

// 按试验逐条查清材料责任：不用统计汇总代替材料责任。
export function planMaterials(state, actor, planId) {
  getUser(state, actor.id);
  const plan = getPlan(state, planId);
  const lotIds = new Set();
  const shipments = Object.values(state.shipments).filter((s) => s.planId === plan.id);
  const commitments = Object.values(state.commitments).filter((c) => c.planId === plan.id);
  const applications = Object.values(state.applications).filter((a) => a.planId === plan.id);
  shipments.forEach((s) => lotIds.add(s.lotId));
  commitments.forEach((c) => lotIds.add(c.lotId));
  state.movements.filter((m) => m.planId === plan.id).forEach((m) => lotIds.add(m.lotId));
  Object.values(state.recoveries).filter((r) => r.planId === plan.id).forEach((r) => lotIds.add(r.lotId));
  const lots = [...lotIds].map((lotId) => {
    const lot = getLot(state, lotId);
    const lotShipments = shipments.filter((s) => s.lotId === lotId);
    return {
      lotId,
      varietyId: lot.varietyId,
      seal: lot.seal,
      baseUnit: lot.baseUnit,
      lotStatus: lot.status,
      commitments: commitments.filter((c) => c.lotId === lotId).map((c) => ({
        commitmentId: c.id,
        quantityBase: c.quantityBase,
        shippedBase: c.shippedBase,
        unshippedBase: c.quantityBase - c.shippedBase,
        status: c.status,
        permitId: c.permitId,
      })),
      shipments: lotShipments.map((s) => ({
        shipmentId: s.id,
        quantityBase: s.quantityBase,
        status: s.status,
        destinationSiteId: s.destinationSiteId,
        seal: s.originSeal,
        legs: s.legs,
        delivery: s.delivery,
        acceptance: s.acceptance,
      })),
      siteRecords: state.movements.filter((m) => m.planId === plan.id && m.lotId === lotId).map((m) => ({
        movementId: m.id,
        kind: m.kind,
        quantityBase: m.quantityBase,
        identityAffected: m.identityAffected ?? false,
        recoveryId: m.recoveryId,
        occurredAt: m.occurredAt,
      })),
      recoveries: Object.values(state.recoveries)
        .filter((r) => r.planId === plan.id && r.lotId === lotId)
        .map((r) => ({ recoveryId: r.id, quantityBase: r.quantityBase, status: r.status, seal: r.seal, arrival: r.arrival, identity: r.identity, disposition: r.disposition })),
      harvests: Object.values(state.harvests)
        .filter((h) => h.planId === plan.id && h.sourceLotId === lotId)
        .map((h) => ({ harvestId: h.id, seal: h.seal, quantity: h.quantity, unit: h.unit, status: h.status, restrictedPurpose: h.restrictedPurpose, handover: h.handover })),
    };
  });
  return {
    plan: { id: plan.id, siteId: plan.siteId, season: plan.season, varietyId: plan.varietyId, purpose: plan.purpose, status: plan.status },
    applications: applications.map((a) => ({ applicationId: a.id, lotId: a.lotId, quantityBase: a.quantityBase, status: a.status, applicant: a.applicant, commitmentId: a.commitmentId })),
    lots,
    openItems: planOpenItems(state, plan),
  };
}

// 按批次追踪全部决定与流向（方案换址、受潮、终止回收均可追溯）。
export function lotTrace(state, actor, lotId) {
  getUser(state, actor.id);
  const lot = getLot(state, lotId);
  return {
    lot: {
      id: lot.id,
      varietyId: lot.varietyId,
      seal: lot.seal,
      baseUnit: lot.baseUnit,
      totalBase: lot.totalBase,
      purpose: lot.purpose,
      regions: lot.regions,
      status: lot.status,
      conversionBasis: lot.conversionBasis,
      identityNote: lot.identityNote,
      qualityEvents: lot.qualityEvents ?? [],
      history: lot.history,
    },
    stockBuckets: {
      availableBase: lot.availableBase,
      quarantineBase: lot.quarantineBase ?? 0,
      committed: lot.committed,
      preparedStock: lot.preparedStock ?? 0,
      inTransit: lot.inTransit,
      returning: lot.returning,
      pendingReturn: lot.pendingReturn,
      siteUsable: lot.siteUsable,
      siteQuarantine: lot.siteQuarantine,
      siteRetained: lot.siteRetained ?? {},
      sown: lot.sown,
      loss: lot.loss,
      destroyed: lot.destroyed,
    },
    ledger: state.ledger.filter((entry) => entry.lotId === lotId),
    commitments: Object.values(state.commitments).filter((c) => c.lotId === lotId),
    shipments: Object.values(state.shipments).filter((s) => s.lotId === lotId),
    movements: state.movements.filter((m) => m.lotId === lotId),
    recoveries: Object.values(state.recoveries).filter((r) => r.lotId === lotId),
    harvests: Object.values(state.harvests).filter((h) => h.sourceLotId === lotId),
  };
}

// 全库未结材料：跨试验、跨批次逐条列出责任方。
export function openMaterials(state, actor) {
  getUser(state, actor.id);
  const items = [];
  for (const lot of Object.values(state.lots)) {
    if (lot.status === 'identity_hold') {
      items.push({ kind: 'lot_identity_hold', lotId: lot.id, responsible: '核准人/质量', detail: '身份更正核实中，未发部分暂停' });
    }
    if ((lot.quarantineBase ?? 0) > 0) {
      items.push({ kind: 'warehouse_quarantine', lotId: lot.id, quantityBase: lot.quarantineBase, unit: lot.baseUnit, responsible: '核准人', detail: '库内隔离（受潮/身份待决），需明确放行或销毁' });
    }
    if (lot.pendingReturn > 0) {
      items.push({ kind: 'recovery_pending_identity', lotId: lot.id, quantityBase: lot.pendingReturn, unit: lot.baseUnit, responsible: '库管/质量', detail: '回收包已到库身份未核实，不能并入可用库存' });
    }
    if (lot.returning > 0) {
      items.push({ kind: 'recovery_in_transit', lotId: lot.id, quantityBase: lot.returning, unit: lot.baseUnit, responsible: '站点/承运方', detail: '回收在途' });
    }
    for (const [siteId, qty] of Object.entries(lot.siteUsable)) {
      if (qty > 0) items.push({ kind: 'site_usable', lotId: lot.id, siteId, quantityBase: qty, unit: lot.baseUnit, responsible: `站点 ${siteId}`, detail: '站点持有的未用可用材料' });
    }
    for (const [siteId, qty] of Object.entries(lot.siteQuarantine ?? {})) {
      if (qty > 0) items.push({ kind: 'site_quarantine', lotId: lot.id, siteId, quantityBase: qty, unit: lot.baseUnit, responsible: `站点 ${siteId}/核准人`, detail: '站点隔离材料，等待放行或销毁决定' });
    }
  }
  for (const shipment of Object.values(state.shipments)) {
    if (['in_transit', 'receipt_interrupted', 'delivered', 'prepared'].includes(shipment.status)) {
      items.push({
        kind: 'shipment_open',
        shipmentId: shipment.id,
        lotId: shipment.lotId,
        planId: shipment.planId,
        quantityBase: shipment.quantityBase,
        status: shipment.status,
        responsible: shipment.status === 'prepared'
          ? '库管'
          : (['in_transit', 'receipt_interrupted'].includes(shipment.status) ? '承运方/库管' : `站点 ${shipment.destinationSiteId}`),
        detail: shipment.status === 'prepared'
          ? '已备货封签待出库'
          : (shipment.status === 'receipt_interrupted' ? '回执中断，不能把同一包重新标成可发' : '运输/待验收环节未结'),
      });
    }
  }
  for (const plan of Object.values(state.plans)) {
    if (plan.status !== 'closed') {
      for (const item of planOpenItems(state, plan)) items.push({ ...item, planId: plan.id });
    }
  }
  for (const harvest of Object.values(state.harvests)) {
    if (harvest.status !== 'handover') {
      items.push({ kind: 'harvest_open', harvestId: harvest.id, lotId: harvest.sourceLotId, planId: harvest.planId, responsible: `站点 ${harvest.siteId}/核准人`, detail: '采收材料受原用途限制，未完成交接' });
    }
  }
  return { count: items.length, items };
}
