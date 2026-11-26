import { fail, positiveInt } from './util.mjs';

export const ROLES = ['site', 'approver', 'keeper', 'quality'];
export const PURPOSES = ['research', 'commercial'];

export function getUser(state, userId) {
  const user = state.users[userId];
  if (!user) fail(401, 'unauthenticated', '未识别的用户令牌或用户已停用');
  return user;
}

export function requireRole(user, roles) {
  if (!roles.includes(user.role)) {
    fail(403, 'forbidden', `当前角色 ${user.role} 无权执行该操作，需要 ${roles.join('/')}`);
  }
}

export function siteOf(user) {
  return user.role === 'site' ? user.siteId : null;
}

export function ensureSiteScope(user, siteId) {
  if (user.role === 'site' && user.siteId !== siteId) {
    fail(403, 'site_scope', '站点只能处理本站点的材料');
  }
}

export function getSite(state, siteId) {
  const site = state.sites[siteId];
  if (!site) fail(404, 'site_not_found', `站点不存在：${siteId}`);
  return site;
}

export function getVariety(state, varietyId) {
  const variety = state.varieties[varietyId];
  if (!variety) fail(404, 'variety_not_found', `品种不存在：${varietyId}`);
  return variety;
}

export function getLot(state, lotId) {
  const lot = state.lots[lotId];
  if (!lot) fail(404, 'lot_not_found', `种子批次不存在：${lotId}`);
  return lot;
}

export function getPlan(state, planId) {
  const plan = state.plans[planId];
  if (!plan) fail(404, 'plan_not_found', `试验方案不存在：${planId}`);
  return plan;
}

// 许可按 站点+品种+试验季+用途 精确匹配；换址、换季、换用途都不能沿用旧许可。
export function findPermit(state, siteId, varietyId, season, purpose) {
  return Object.values(state.permits).find((permit) =>
    permit.siteId === siteId
    && permit.varietyId === varietyId
    && permit.season === season
    && permit.purpose === purpose
    && permit.status === 'active');
}

// 将请求数量换算到批次基准计量（克 grams 或粒 seeds）。
// 克与粒是两套口径，只有该批有核准换算依据时才允许跨口径换算。
export function toBase(lot, quantity, unit, label = '数量') {
  positiveInt(quantity, label);
  if (!['grams', 'seeds'].includes(unit)) fail(400, 'bad_unit', '计量单位只能是 grams（克）或 seeds（粒）');
  if (unit === lot.baseUnit) return quantity;
  const basis = lot.conversionBasis;
  if (!basis || basis.fromUnit !== unit || basis.toUnit !== lot.baseUnit) {
    fail(400, 'no_conversion_basis', `批次 ${lot.id} 没有从 ${unit} 到 ${lot.baseUnit} 的核准换算依据，不能跨口径换算`);
  }
  const converted = unit === 'seeds'
    ? (quantity * basis.factorNumerator) / basis.factorDenominator
    : (quantity * basis.factorDenominator) / basis.factorNumerator;
  if (!Number.isInteger(converted) || converted <= 0) {
    fail(400, 'conversion_not_exact', `换算结果不是正整数，不能在批次基准计量中成立`);
  }
  return converted;
}

// 核准品种使用范围及所需许可：许可、批次生态区、用途三者同时成立。
export function checkEligibility(state, plan, lot, extraReason = '该用途') {
  const permit = findPermit(state, plan.siteId, plan.varietyId, plan.season, plan.purpose);
  if (!permit) {
    fail(409, 'permit_mismatch', `站点 ${plan.siteId} 在 ${plan.season} 季以 ${plan.purpose} 用途使用 ${plan.varietyId} 缺少有效许可，旧许可不能沿用`);
  }
  if (lot.varietyId !== plan.varietyId) {
    fail(409, 'variety_mismatch', `批次 ${lot.id} 品种 ${lot.varietyId} 与方案品种 ${plan.varietyId} 不一致`);
  }
  if (!lot.regions.includes(state.sites[plan.siteId]?.region)) {
    fail(409, 'region_mismatch', `批次 ${lot.id} 适用生态区 ${lot.regions.join('/')} 不覆盖站点 ${plan.siteId} 所在生态区`);
  }
  if (lot.purpose !== plan.purpose) {
    fail(409, 'purpose_mismatch', `批次 ${lot.id} 准许用途为 ${lot.purpose}，不能用于 ${plan.purpose}；科研用途放行不能用于商业推广`);
  }
  if (plan.purpose === 'commercial' && lot.purpose === 'research') {
    fail(409, 'research_only', '科研用途放行的种子不能用于商业推广');
  }
  return permit;
}

export function requireLotHealthy(lot) {
  if (lot.status === 'identity_hold') fail(409, 'identity_hold', `批次 ${lot.id} 正在身份更正核实中，未发部分已暂停`);
  if (lot.status === 'closed') fail(409, 'lot_closed', `批次 ${lot.id} 已结清关闭，不能再发生材料移动`);
}

export function requirePlanOpen(plan) {
  if (plan.status === 'terminated') fail(409, 'plan_terminated', `方案 ${plan.id} 已终止，不能再登记新的材料动作（已播种事实保留）`);
  if (plan.status === 'closed') fail(409, 'plan_closed', `方案 ${plan.id} 已结清`);
}

export function siteUsableBalance(lot, siteId) {
  return (lot.siteUsable[siteId] ?? 0) + (lot.siteQuarantine[siteId] ?? 0);
}

export function planMovements(state, planId) {
  return state.movements.filter((movement) => movement.planId === planId);
}
