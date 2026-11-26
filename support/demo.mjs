// 中文演练脚本：用一条时间线串起方案换址、部分受潮、终止回收三类决定，
// 并按试验与批次查清未结材料。仅使用本地内存状态，不连接真实系统。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';

const dir = await mkdtemp(join(tmpdir(), 'seed-demo-'));
const stateFile = join(dir, 'demo.json');
const server = createApp(stateFile);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const lines = [];
const say = (text) => { lines.push(text); console.log(text); };
const call = async (method, path, body, userId) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(userId ? { 'X-User-Id': userId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    say(`  ✗ ${method} ${path} → ${res.status} ${json.error?.code}：${json.error?.message}`);
    return { ok: false, status: res.status, json };
  }
  return { ok: true, status: res.status, json };
};
const step = (title) => say(`\n【${title}】`);

try {
  say('========== 试种种子材料管理 · 本地演练 ==========');
  step('一、建立角色、站点、品种与许可');
  await call('POST', '/bootstrap', {});
  await call('POST', '/sites', { id: 'SITE-A', region: 'plain', name: '平原点' }, 'u-approver');
  await call('POST', '/sites', { id: 'SITE-B', region: 'hill', name: '山地点' }, 'u-approver');
  await call('POST', '/varieties', { id: 'VAR-1', name: '合成稻种甲' }, 'u-approver');
  await call('POST', '/permits', { id: 'PER-A', siteId: 'SITE-A', varietyId: 'VAR-1', season: '2027-spring', purpose: 'research' }, 'u-approver');
  await call('POST', '/lots', {
    id: 'SEED-1', varietyId: 'VAR-1', seal: 'S-1', grams: 10000, baseUnit: 'grams',
    regions: ['plain'], purpose: 'research',
  }, 'u-keeper');
  say('  · SITE-A 持 VAR-1 科研许可；SEED-1 共 10000 克，封样 S-1，仅适用 plain、research。');

  step('二、方案换址：旧许可不能沿用');
  await call('POST', '/plans', { id: 'PLAN-1', siteId: 'SITE-A', season: '2027-spring', varietyId: 'VAR-1', purpose: 'research' }, 'u-site-a');
  await call('POST', '/plans/PLAN-1/approvals', {}, 'u-approver');
  say('  · PLAN-1 在 SITE-A 核准通过。');
  const moved = await call('POST', '/plans/PLAN-1/amendments', { siteId: 'SITE-B', reason: '试验地变更' }, 'u-approver');
  say(`  · 换址后方案状态回到 ${moved.json.status}，须重新核准。`);
  const reApprove = await call('POST', '/plans/PLAN-1/approvals', {}, 'u-approver');
  say(`  · 重新核准被拒（${reApprove.json.error.code}）：SITE-B 没有对应许可，旧 PER-A 不能沿用。`);
  await call('POST', '/permits', { id: 'PER-B', siteId: 'SITE-B', varietyId: 'VAR-1', season: '2027-spring', purpose: 'research' }, 'u-approver');
  await call('POST', '/plans/PLAN-1/approvals', {}, 'u-approver');
  const app = await call('POST', '/applications', { planId: 'PLAN-1', lotId: 'SEED-1', quantity: 4000, unit: 'grams' }, 'u-site-b');
  const decision = await call('POST', `/applications/${app.json.id}/decisions`, { decision: 'reject', reason: '生态区不符' }, 'u-approver');
  say(`  · 补许可后方案可核准，但用种申请被驳回（${decision.json.status}）：SEED-1 只适用 plain 生态区，SITE-B 是 hill。`);
  await call('POST', '/plans/PLAN-1/amendments', { siteId: 'SITE-A' }, 'u-approver');
  await call('POST', '/plans/PLAN-1/approvals', {}, 'u-approver');
  say('  · 方案改回 SITE-A 并重新核准，原许可经重新核验后继续有效。');

  step('三、部分受潮：隔离不等于整批报废');
  await call('POST', '/lots/quality-events', { lotId: 'SEED-1', quantity: 500, unit: 'grams', event: '受潮', source: 'available' }, 'u-quality');
  say('  · 500 克受潮隔离，其余 9500 克仍是合格库存。');
  await call('POST', '/lots/quarantine-decisions', { lotId: 'SEED-1', quantity: 300, unit: 'grams', decision: 'release_usable', scope: 'warehouse' }, 'u-approver');
  await call('POST', '/lots/quarantine-decisions', { lotId: 'SEED-1', quantity: 200, unit: 'grams', decision: 'destroy', scope: 'warehouse', reason: '受潮报废' }, 'u-approver');
  say('  · 核准人明确放行 300 克、销毁 200 克；站点无权自行处置隔离材料。');

  step('四、申请、分批发种、运输与验收');
  const app2 = await call('POST', '/applications', { planId: 'PLAN-1', lotId: 'SEED-1', quantity: 4000, unit: 'grams' }, 'u-site-a');
  const decided = await call('POST', `/applications/${app2.json.id}/decisions`, { decision: 'approve' }, 'u-approver');
  const commitmentId = decided.json.commitment.id;
  say('  · 4000 克申请由非申请人核准，形成承诺。');
  const shp1 = await call('POST', '/shipments', { commitmentId, quantity: 1500, unit: 'grams', seal: 'S-1', carrierRef: 'C-1' }, 'u-keeper');
  await call('POST', `/shipments/${shp1.json.id}/dispatch`, {}, 'u-keeper');
  const interrupted = await call('POST', `/shipments/${shp1.json.id}/delivery`, { receiptInterrupted: true }, 'u-keeper');
  say(`  · 第一批 1500 克出库后回执中断，状态 ${interrupted.json.status}；同一包不会重新标成可发。`);
  await call('POST', `/shipments/${shp1.json.id}/receipt-resumptions`, {}, 'u-keeper');
  await call('POST', `/shipments/${shp1.json.id}/acceptances`, { sealIntact: true, quantity: 1500, unit: 'grams' }, 'u-site-a');
  say('  · 回执恢复补登记，SITE-A 凭原封样验收 1500 克。');
  const shp2 = await call('POST', '/shipments', { commitmentId, quantity: 2500, unit: 'grams', seal: 'S-1', carrierRef: 'C-2' }, 'u-keeper');
  await call('POST', `/shipments/${shp2.json.id}/dispatch`, {}, 'u-keeper');
  await call('POST', `/shipments/${shp2.json.id}/delivery`, {}, 'u-keeper');
  const acc2 = await call('POST', `/shipments/${shp2.json.id}/acceptances`, { sealIntact: false, quantity: 2200, unit: 'grams', note: '外袋破损短交300克' }, 'u-site-a');
  say(`  · 第二批验收 2200 克、隔离 ${acc2.json.quarantineBase} 克；隔离量不能填成播种。`);
  await call('POST', '/site-movements', { planId: 'PLAN-1', lotId: 'SEED-1', kind: 'sow', quantity: 1000, unit: 'grams', occurredAt: '2027-03-01T08:00:00Z' }, 'u-site-a');
  say('  · SITE-A 登记播种 1000 克。');

  step('五、终止一季试种与剩余材料回收');
  await call('POST', '/plans/PLAN-1/terminations', { reason: '站点终止本季试验' }, 'u-site-a');
  say('  · 方案终止：已播种 1000 克事实保留，未发承诺解除回库。');
  const ret = await call('POST', '/site-movements', { planId: 'PLAN-1', lotId: 'SEED-1', kind: 'return', quantity: 2500, unit: 'grams', seal: 'RETURN-SEAL-1' }, 'u-site-a');
  const recoveryId = ret.json.recovery.id;
  const arrived = await call('POST', `/recoveries/${recoveryId}/arrivals`, { seal: 'RETURN-SEAL-1' }, 'u-keeper');
  say(`  · 退回 2500 克到库，状态 ${arrived.json.status}：身份未核实前隔离，不并入可用库存。`);
  const beforeClose = await call('POST', '/plans/PLAN-1/closures', {}, 'u-approver');
  say(`  · 此时结清被拒（${beforeClose.json.error.code}）：仍有未结材料。`);
  await call('POST', `/recoveries/${recoveryId}/identity-verifications`, { identityConfirmed: true, note: '封样与来源相符' }, 'u-keeper');
  // 站点持有：可用 2700 克（3700 播种 1000）+ 验收隔离 300 克；退回 2500 后可用余 200 克。
  await call('POST', '/lots/quality-events', { lotId: 'SEED-1', quantity: 200, unit: 'grams', event: '终止余料', source: 'siteUsable', siteId: 'SITE-A' }, 'u-keeper');
  await call('POST', '/lots/destructions', { lotId: 'SEED-1', quantity: 500, unit: 'grams', source: 'site_quarantine', siteId: 'SITE-A', reason: '终止余料销毁（含验收隔离300克）' }, 'u-approver');
  say('  · 回收核实通过后 2500 克才回到可用；站点剩余 200 克可用连同 300 克验收隔离共 500 克经核准销毁。');
  const closed = await call('POST', '/plans/PLAN-1/closures', {}, 'u-approver');
  say(`  · 未结材料全部落实，方案结清，状态 ${closed.json.status}。`);

  step('六、按试验和批次查清材料责任（不是一份统计汇总）');
  const materials = await call('GET', '/plans/PLAN-1/materials', undefined, 'u-approver');
  say(`  · PLAN-1 未结条目：${materials.json.openItems.length}；播种记录仍保留：`);
  for (const lot of materials.json.lots) {
    for (const record of lot.siteRecords) {
      say(`    - ${record.movementId} ${record.kind} ${record.quantityBase} 克，身份更正受影响=${record.identityAffected}`);
    }
    for (const recovery of lot.recoveries) {
      say(`    - ${recovery.recoveryId} 回收 ${recovery.quantityBase} 克，终态 ${recovery.status}`);
    }
  }
  const trace = await call('GET', '/lots/SEED-1/trace', undefined, 'u-keeper');
  say('  · SEED-1 批次台账（按时间顺序的实际流向）：');
  for (const entry of trace.json.ledger) {
    say(`    - ${entry.ts} ${entry.type} ${entry.quantityBase ?? entry.quantity ?? ''} ${entry.unit ?? trace.json.lot.baseUnit}（${entry.by}）`);
  }
  const open = await call('GET', '/materials/open', undefined, 'u-approver');
  say(`  · 全库未结材料 ${open.json.count} 条，逐条带责任方，可继续办理。`);

  say('\n========== 演练结束 ==========');
} finally {
  await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
  await rm(dir, { recursive: true, force: true });
}
