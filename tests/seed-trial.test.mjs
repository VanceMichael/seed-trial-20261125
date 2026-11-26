import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((resolve) => {
  server.closeAllConnections?.();
  server.close(resolve);
});

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'seed-trial-'));
  const server = createApp(join(dir, 'state.json'));
  const base = await listen(server);
  const request = async (method, path, body, userId) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Connection: 'close', ...(userId ? { 'X-User-Id': userId } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json();
    return { status: res.status, json };
  };
  const ok = async (method, path, body, userId) => {
    const r = await request(method, path, body, userId);
    assert.equal(r.status, 200, `${method} ${path} 应成功：${JSON.stringify(r.json)}`);
    return r.json;
  };
  const failStatus = async (status, method, path, body, userId) => {
    const r = await request(method, path, body, userId);
    assert.equal(r.status, status, `${method} ${path} 应返回 ${status}：${JSON.stringify(r.json)}`);
    return r.json;
  };
  return {
    dir, server, request, ok, failStatus,
    async stop() { await close(server); await rm(dir, { recursive: true, force: true }); },
  };
}

// 基础资料：两站点、两品种、许可、克/粒两个批次。
async function seedBaseline(h) {
  await h.ok('POST', '/bootstrap', {});
  await h.ok('POST', '/sites', { id: 'SITE-A', region: 'plain' }, 'u-approver');
  await h.ok('POST', '/sites', { id: 'SITE-B', region: 'hill' }, 'u-approver');
  await h.ok('POST', '/varieties', { id: 'VAR-1', name: '合成稻种甲' }, 'u-approver');
  await h.ok('POST', '/varieties', { id: 'VAR-2', name: '合成稻种乙' }, 'u-approver');
  await h.ok('POST', '/permits', { siteId: 'SITE-A', varietyId: 'VAR-1', season: '2027-spring', purpose: 'research' }, 'u-approver');
  await h.ok('POST', '/lots', {
    id: 'SEED-1', varietyId: 'VAR-1', seal: 'S-1', grams: 10000, baseUnit: 'grams',
    regions: ['plain'], purpose: 'research',
  }, 'u-approver');
  await h.ok('POST', '/lots', {
    id: 'SEED-2', varietyId: 'VAR-2', seal: 'S-2', seeds: 50000, baseUnit: 'seeds',
    regions: ['hill'], purpose: 'research',
  }, 'u-approver');
}

test('申请核准：许可范围、站点隔离、申请人不能自批、重复申请与库存竞争', async () => {
  const h = await harness();
  try {
    await seedBaseline(h);

    // 无许可的方案不能核准。
    await h.ok('POST', '/plans', { id: 'PLAN-B', siteId: 'SITE-B', season: '2027-spring', varietyId: 'VAR-2', purpose: 'research' }, 'u-site-b');
    await h.failStatus(409, 'POST', '/plans/PLAN-B/approvals', {}, 'u-approver');

    // 站点只能处理本站点材料。
    await h.failStatus(403, 'POST', '/plans', { siteId: 'SITE-A', season: '2027-spring', varietyId: 'VAR-1', purpose: 'research' }, 'u-site-b');

    // 正常方案与核准。
    await h.ok('POST', '/plans', { id: 'PLAN-A', siteId: 'SITE-A', season: '2027-spring', varietyId: 'VAR-1', purpose: 'research' }, 'u-site-a');
    await h.ok('POST', '/plans/PLAN-A/approvals', {}, 'u-approver');

    // 未认证请求被拒绝。
    await h.failStatus(401, 'GET', '/lots', undefined, undefined);

    // 申请 3000 克。
    const app1 = await h.ok('POST', '/applications', { planId: 'PLAN-A', lotId: 'SEED-1', quantity: 3000, unit: 'grams' }, 'u-site-a');
    // 重复申请被拒。
    await h.failStatus(409, 'POST', '/applications', { planId: 'PLAN-A', lotId: 'SEED-1', quantity: 1000, unit: 'grams' }, 'u-site-a');

    // 另建方案竞争库存：先由另一核准人批准竞争申请，验证已承诺不重复分配。
    await h.ok('POST', '/admin/users', { id: 'u-approver-2', role: 'approver' }, 'u-approver');
    await h.ok('POST', '/plans', { id: 'PLAN-A2', siteId: 'SITE-A', season: '2027-spring', varietyId: 'VAR-1', purpose: 'research' }, 'u-approver');
    await h.ok('POST', '/plans/PLAN-A2/approvals', {}, 'u-approver-2');
    const app2 = await h.ok('POST', '/applications', { planId: 'PLAN-A2', lotId: 'SEED-1', quantity: 7000, unit: 'grams' }, 'u-approver-2');
    await h.ok('POST', `/applications/${app2.id}/decisions`, { decision: 'approve' }, 'u-approver');

    // 此时已承诺 7000，3000 的申请仍可批准（10000 总量）。
    const app1Id = (await h.request('GET', '/applications', undefined, 'u-approver')).json.applications.find((a) => a.planId === 'PLAN-A').id;
    const decided = await h.ok('POST', `/applications/${app1Id}/decisions`, { decision: 'approve' }, 'u-approver-2');
    assert.equal(decided.commitment.quantityBase, 3000);

    // 再竞争 1 克也不行：已承诺合计 10000，无剩余可分配（用第三个方案避开同方案重复申请限制）。
    await h.ok('POST', '/plans', { id: 'PLAN-A3', siteId: 'SITE-A', season: '2027-spring', varietyId: 'VAR-1', purpose: 'research' }, 'u-approver');
    await h.ok('POST', '/plans/PLAN-A3/approvals', {}, 'u-approver-2');
    const app3 = await h.ok('POST', '/applications', { planId: 'PLAN-A3', lotId: 'SEED-1', quantity: 1, unit: 'grams' }, 'u-approver-2');
    await h.failStatus(409, 'POST', `/applications/${app3.id}/decisions`, { decision: 'approve' }, 'u-approver');

    // 申请人不能批准自己的申请。
    const selfApp = await h.ok('POST', '/applications', { planId: 'PLAN-A2', lotId: 'SEED-2', quantity: 100, unit: 'seeds' }, 'u-approver-2');
    await h.failStatus(403, 'POST', `/applications/${selfApp.id}/decisions`, { decision: 'approve' }, 'u-approver-2');

    // 科研批次不能用于商业方案。
    await h.ok('POST', '/permits', { id: 'PER-COMM', siteId: 'SITE-A', varietyId: 'VAR-1', season: '2027-spring', purpose: 'commercial' }, 'u-approver');
    await h.ok('POST', '/plans', { id: 'PLAN-COMM', siteId: 'SITE-A', season: '2027-spring', varietyId: 'VAR-1', purpose: 'commercial' }, 'u-approver');
    await h.ok('POST', '/plans/PLAN-COMM/approvals', {}, 'u-approver');
    const commApp = await h.ok('POST', '/applications', { planId: 'PLAN-COMM', lotId: 'SEED-1', quantity: 100, unit: 'grams' }, 'u-approver');
    await h.failStatus(409, 'POST', `/applications/${commApp.id}/decisions`, { decision: 'approve' }, 'u-approver-2');
  } finally { await h.stop(); }
});

test('分批发种、回执中断、验收隔离与未验收不能播种', async () => {
  const h = await harness();
  try {
    await seedBaseline(h);
    await h.ok('POST', '/plans', { id: 'PLAN-A', siteId: 'SITE-A', season: '2027-spring', varietyId: 'VAR-1', purpose: 'research' }, 'u-site-a');
    await h.ok('POST', '/plans/PLAN-A/approvals', {}, 'u-approver');
    const app = await h.ok('POST', '/applications', { planId: 'PLAN-A', lotId: 'SEED-1', quantity: 4000, unit: 'grams' }, 'u-site-a');
    const decided = await h.ok('POST', `/applications/${app.id}/decisions`, { decision: 'approve' }, 'u-approver');
    const commitmentId = decided.commitment.id;

    // 分两批发：1500 + 2500。
    const shp1 = await h.ok('POST', '/shipments', { commitmentId, quantity: 1500, unit: 'grams', seal: 'S-1', carrierRef: 'C-1' }, 'u-keeper');
    const shp2 = await h.ok('POST', '/shipments', { commitmentId, quantity: 2500, unit: 'grams', seal: 'S-1', carrierRef: 'C-2' }, 'u-keeper');
    // 超承诺发种被拒。
    await h.failStatus(409, 'POST', '/shipments', { commitmentId, quantity: 1, unit: 'grams', seal: 'S-1', carrierRef: 'C-3' }, 'u-keeper');
    // 备货已物理预留：库内可用只剩 6000，备货桶 4000。
    const preparedTrace = await h.ok('GET', '/lots/SEED-1/trace', undefined, 'u-keeper');
    assert.equal(preparedTrace.stockBuckets.availableBase, 6000);
    assert.equal(preparedTrace.stockBuckets.preparedStock, 4000);
    // 已承诺部分不能被质量事件直接隔离。
    await h.failStatus(409, 'POST', '/lots/quality-events', { lotId: 'SEED-1', quantity: 6001, unit: 'grams', event: '受潮', source: 'available' }, 'u-quality');
    // 取消第二批备货：实物退回可用桶与承诺预留。
    await h.ok('POST', `/shipments/${shp2.id}/cancellations`, { reason: '暂缓发运' }, 'u-keeper');
    const cancelledTrace = await h.ok('GET', '/lots/SEED-1/trace', undefined, 'u-keeper');
    assert.equal(cancelledTrace.stockBuckets.availableBase, 8500);
    assert.equal(cancelledTrace.stockBuckets.preparedStock, 1500);
    // 重新备货后继续流程。
    const shp2b = await h.ok('POST', '/shipments', { commitmentId, quantity: 2500, unit: 'grams', seal: 'S-1', carrierRef: 'C-2B' }, 'u-keeper');

    // 第一批：承运方收件但回执中断，不能重新标成可发（库存仍在在途桶）。
    await h.ok('POST', `/shipments/${shp1.id}/dispatch`, { seal: 'S-1' }, 'u-keeper');
    const interrupted = await h.ok('POST', `/shipments/${shp1.id}/delivery`, { receiptInterrupted: true }, 'u-keeper');
    assert.equal(interrupted.status, 'receipt_interrupted');
    const traceDuring = await h.ok('GET', '/lots/SEED-1/trace', undefined, 'u-keeper');
    assert.equal(traceDuring.stockBuckets.inTransit, 1500);
    // 第二批 2500 克已备货：物理进入备货桶，不再属于可用；承诺 overlay 仍为 4000。
    assert.equal(traceDuring.stockBuckets.preparedStock, 2500);
    assert.equal(traceDuring.stockBuckets.availableBase, 6000);
    assert.equal(traceDuring.stockBuckets.committed, 2500);
    // 中断期间站点不能验收。
    await h.failStatus(409, 'POST', `/shipments/${shp1.id}/acceptances`, { sealIntact: true, quantity: 1500, unit: 'grams' }, 'u-site-a');
    // 回执恢复补登记，再验收。
    await h.ok('POST', `/shipments/${shp1.id}/receipt-resumptions`, {}, 'u-keeper');
    const acc1 = await h.ok('POST', `/shipments/${shp1.id}/acceptances`, { sealIntact: true, quantity: 1500, unit: 'grams' }, 'u-site-a');
    assert.equal(acc1.acceptedBase, 1500);

    // 第二批：短交 300 克且封签破损，隔离部分不能播种。
    await h.ok('POST', `/shipments/${shp2b.id}/dispatch`, { seal: 'S-1' }, 'u-keeper');
    await h.ok('POST', `/shipments/${shp2b.id}/delivery`, { seal: 'S-1' }, 'u-keeper');
    const acc2 = await h.ok('POST', `/shipments/${shp2b.id}/acceptances`, { sealIntact: false, quantity: 2200, unit: 'grams', note: '外袋破损短交300克' }, 'u-site-a');
    assert.equal(acc2.quarantineBase, 300);
    const balance = await h.ok('GET', '/sites/SITE-A/balance', undefined, 'u-site-a');
    const row = balance.materials.find((m) => m.lotId === 'SEED-1');
    assert.equal(row.usableBase, 3700);
    assert.equal(row.quarantineBase, 300);
    // 隔离量不能填成播种：尝试播 3701 克被拒。
    await h.failStatus(409, 'POST', '/site-movements', { planId: 'PLAN-A', lotId: 'SEED-1', kind: 'sow', quantity: 3701, unit: 'grams' }, 'u-site-a');
    // 播种 1000 克成立。
    const sow = await h.ok('POST', '/site-movements', { planId: 'PLAN-A', lotId: 'SEED-1', kind: 'sow', quantity: 1000, unit: 'grams', occurredAt: '2027-03-01T08:00:00Z' }, 'u-site-a');
    assert.equal(sow.movement.identityAffected, false);

    // 克与粒不同口径，无换算依据不能换算。
    await h.failStatus(400, 'POST', '/site-movements', { planId: 'PLAN-A', lotId: 'SEED-1', kind: 'sow', quantity: 100, unit: 'seeds' }, 'u-site-a');

    // 站点 B 看不到站点 A 的库存。
    const balanceB = await h.ok('GET', '/sites/SITE-B/balance', undefined, 'u-site-b');
    assert.equal(balanceB.materials.length, 0);
  } finally { await h.stop(); }
});

test('部分受潮不株连其余合格部分，放行必须有权决定', async () => {
  const h = await harness();
  try {
    await seedBaseline(h);
    // 库内 500 克受潮隔离。
    const qe = await h.ok('POST', '/lots/quality-events', { lotId: 'SEED-1', quantity: 500, unit: 'grams', event: '受潮', source: 'available' }, 'u-quality');
    assert.equal(qe.status, 'quarantined');
    const trace = await h.ok('GET', '/lots/SEED-1/trace', undefined, 'u-approver');
    assert.equal(trace.stockBuckets.availableBase, 9500);
    assert.equal(trace.stockBuckets.quarantineBase, 500);

    // 站点无权放行隔离材料。
    await h.failStatus(403, 'POST', '/lots/quarantine-decisions', { lotId: 'SEED-1', quantity: 500, unit: 'grams', decision: 'release_usable', scope: 'warehouse' }, 'u-site-a');
    // 核准人明确放行 300 克，其余 200 克销毁。
    await h.ok('POST', '/lots/quarantine-decisions', { lotId: 'SEED-1', quantity: 300, unit: 'grams', decision: 'release_usable', scope: 'warehouse' }, 'u-approver');
    await h.ok('POST', '/lots/quarantine-decisions', { lotId: 'SEED-1', quantity: 200, unit: 'grams', decision: 'destroy', scope: 'warehouse', reason: '受潮报废' }, 'u-approver');
    const after = await h.ok('GET', '/lots/SEED-1/trace', undefined, 'u-approver');
    assert.equal(after.stockBuckets.availableBase, 9800);
    assert.equal(after.stockBuckets.quarantineBase, 0);
    assert.equal(after.stockBuckets.destroyed, 200);
  } finally { await h.stop(); }
});

test('方案换址必须重新核准，旧许可不能沿用', async () => {
  const h = await harness();
  try {
    await seedBaseline(h);
    await h.ok('POST', '/plans', { id: 'PLAN-A', siteId: 'SITE-A', season: '2027-spring', varietyId: 'VAR-1', purpose: 'research' }, 'u-site-a');
    await h.ok('POST', '/plans/PLAN-A/approvals', {}, 'u-approver');
    // 搬迁到 SITE-B：无许可，方案回到草稿，核准被拒。
    const amended = await h.ok('POST', '/plans/PLAN-A/amendments', { siteId: 'SITE-B', reason: '试验地变更' }, 'u-approver');
    assert.equal(amended.status, 'draft');
    await h.failStatus(409, 'POST', '/plans/PLAN-A/approvals', {}, 'u-approver');
    // 即便补了 SITE-B 许可，SEED-1 只适用 plain 生态区，仍不能用于 hill 站点。
    await h.ok('POST', '/permits', { id: 'PER-B', siteId: 'SITE-B', varietyId: 'VAR-1', season: '2027-spring', purpose: 'research' }, 'u-approver');
    await h.ok('POST', '/plans/PLAN-A/approvals', {}, 'u-approver');
    const app = await h.ok('POST', '/applications', { planId: 'PLAN-A', lotId: 'SEED-1', quantity: 200, unit: 'grams' }, 'u-site-b');
    await h.failStatus(409, 'POST', `/applications/${app.id}/decisions`, { decision: 'approve' }, 'u-approver');
    // 换回 SITE-A 后重新核准，原许可在新核准中重新核验后才有效。
    await h.ok('POST', '/plans/PLAN-A/amendments', { siteId: 'SITE-A' }, 'u-approver');
    await h.ok('POST', '/plans/PLAN-A/approvals', {}, 'u-approver');
    const plans = (await h.request('GET', '/plans', undefined, 'u-approver')).json.plans;
    assert.equal(plans.find((p) => p.id === 'PLAN-A').status, 'approved');
  } finally { await h.stop(); }
});

test('身份更正：未发暂停、已播种标记受影响、承诺逐点重新核准', async () => {
  const h = await harness();
  try {
    await seedBaseline(h);
    await h.ok('POST', '/plans', { id: 'PLAN-A', siteId: 'SITE-A', season: '2027-spring', varietyId: 'VAR-1', purpose: 'research' }, 'u-site-a');
    await h.ok('POST', '/plans/PLAN-A/approvals', {}, 'u-approver');
    const app = await h.ok('POST', '/applications', { planId: 'PLAN-A', lotId: 'SEED-1', quantity: 3000, unit: 'grams' }, 'u-site-a');
    const decided = await h.ok('POST', `/applications/${app.id}/decisions`, { decision: 'approve' }, 'u-approver');
    const commitmentId = decided.commitment.id;
    const shp = await h.ok('POST', '/shipments', { commitmentId, quantity: 1000, unit: 'grams', seal: 'S-1', carrierRef: 'C-9' }, 'u-keeper');
    await h.ok('POST', `/shipments/${shp.id}/dispatch`, {}, 'u-keeper');
    await h.ok('POST', `/shipments/${shp.id}/delivery`, {}, 'u-keeper');
    await h.ok('POST', `/shipments/${shp.id}/acceptances`, { sealIntact: true, quantity: 1000, unit: 'grams' }, 'u-site-a');
    await h.ok('POST', '/site-movements', { planId: 'PLAN-A', lotId: 'SEED-1', kind: 'sow', quantity: 600, unit: 'grams' }, 'u-site-a');

    // 开启身份更正。
    const correction = await h.ok('POST', '/lots/identity-corrections', { lotId: 'SEED-1', changes: { seal: 'S-1R' }, reason: '封样复核' }, 'u-approver');
    assert.equal(correction.status, 'identity_hold');
    assert.ok(correction.identityNote.affectedPlans.includes('PLAN-A'));
    assert.equal(correction.identityNote.affectedSown.length, 1);

    // 暂停期间新发种被拒；已播种事实保留并带受影响标记。
    await h.failStatus(409, 'POST', '/shipments', { commitmentId, quantity: 100, unit: 'grams', seal: 'S-1', carrierRef: 'C-10' }, 'u-keeper');
    const materials = await h.ok('GET', '/plans/PLAN-A/materials', undefined, 'u-approver');
    const sownRecord = materials.lots[0].siteRecords.find((m) => m.kind === 'sow');
    assert.equal(sownRecord.identityAffected, true);

    // 核实结束后批次恢复，但承诺仍处暂停，必须逐点重新核准。
    await h.ok('POST', '/lots/identity-resolutions', { lotId: 'SEED-1', verifiedChanges: { seal: 'S-1R' } }, 'u-quality');
    const commitment = (await h.request('GET', '/lots/SEED-1/trace', undefined, 'u-approver')).json.commitments[0];
    assert.equal(commitment.status, 'suspended_identity');
    const reconfirmed = await h.ok('POST', '/commitments/reconfirm', { commitmentId: commitment.id }, 'u-approver');
    assert.equal(reconfirmed.status, 'partially_shipped');
    // 重新核准后可以继续发剩余 2000 克。
    await h.ok('POST', '/shipments', { commitmentId: commitment.id, quantity: 2000, unit: 'grams', seal: 'S-1R', carrierRef: 'C-11' }, 'u-keeper');
  } finally { await h.stop(); }
});

test('发错点转送：核对目的点许可与原封样，禁止单改地址', async () => {
  const h = await harness();
  try {
    await seedBaseline(h);
    // SITE-B 的合法方案与许可（使用 SEED-2，hill 生态区）。
    await h.ok('POST', '/permits', { id: 'PER-B2', siteId: 'SITE-B', varietyId: 'VAR-2', season: '2027-spring', purpose: 'research' }, 'u-approver');
    await h.ok('POST', '/plans', { id: 'PLAN-B', siteId: 'SITE-B', season: '2027-spring', varietyId: 'VAR-2', purpose: 'research' }, 'u-site-b');
    await h.ok('POST', '/plans/PLAN-B/approvals', {}, 'u-approver');
    const appB = await h.ok('POST', '/applications', { planId: 'PLAN-B', lotId: 'SEED-2', quantity: 1000, unit: 'seeds' }, 'u-site-b');
    const decidedB = await h.ok('POST', `/applications/${appB.id}/decisions`, { decision: 'approve' }, 'u-approver');

    // 同时建 SITE-A 方案，制造发错点。
    await h.ok('POST', '/plans', { id: 'PLAN-A', siteId: 'SITE-A', season: '2027-spring', varietyId: 'VAR-1', purpose: 'research' }, 'u-site-a');
    await h.ok('POST', '/plans/PLAN-A/approvals', {}, 'u-approver');
    const appA = await h.ok('POST', '/applications', { planId: 'PLAN-A', lotId: 'SEED-1', quantity: 500, unit: 'grams' }, 'u-site-a');
    const decidedA = await h.ok('POST', `/applications/${appA.id}/decisions`, { decision: 'approve' }, 'u-approver');
    const shp = await h.ok('POST', '/shipments', { commitmentId: decidedA.commitment.id, quantity: 500, unit: 'grams', seal: 'S-1', carrierRef: 'C-20' }, 'u-keeper');
    await h.ok('POST', `/shipments/${shp.id}/dispatch`, {}, 'u-keeper');
    await h.ok('POST', `/shipments/${shp.id}/delivery`, {}, 'u-keeper');

    // 目的点无许可：转送被拒。
    await h.failStatus(409, 'POST', `/shipments/${shp.id}/forwards`, { toSiteId: 'SITE-B', seal: 'S-1' }, 'u-approver');
    // 补 SITE-B 对 VAR-1 的许可，但生态区不覆盖，仍被拒。
    await h.ok('POST', '/permits', { id: 'PER-B1', siteId: 'SITE-B', varietyId: 'VAR-1', season: '2027-spring', purpose: 'research' }, 'u-approver');
    await h.failStatus(409, 'POST', `/shipments/${shp.id}/forwards`, { toSiteId: 'SITE-B', seal: 'S-1' }, 'u-approver');
    // 封签不符也被拒：不能换封签掩盖流向。
    await h.failStatus(409, 'POST', `/shipments/${shp.id}/forwards`, { toSiteId: 'SITE-B', seal: 'FAKE' }, 'u-approver');

    // 合法转送：把 SITE-B 方案改用 SEED-1 不成立（生态区），改为让 SITE-B 位于 plain 的新站点 SITE-C。
    await h.ok('POST', '/sites', { id: 'SITE-C', region: 'plain' }, 'u-approver');
    await h.ok('POST', '/admin/users', { id: 'u-site-c', role: 'site', siteId: 'SITE-C' }, 'u-approver');
    await h.ok('POST', '/permits', { id: 'PER-C1', siteId: 'SITE-C', varietyId: 'VAR-1', season: '2027-spring', purpose: 'research' }, 'u-approver');
    const forwarded = await h.ok('POST', `/shipments/${shp.id}/forwards`, { toSiteId: 'SITE-C', seal: 'S-1', reason: '发错点转送' }, 'u-approver');
    assert.equal(forwarded.destinationSiteId, 'SITE-C');
    assert.equal(forwarded.legs.length, 3);
    assert.equal(forwarded.status, 'in_transit');
    // 原目的点不能验收，新目的点凭原封样验收（先交付到新点）。
    await h.failStatus(403, 'POST', `/shipments/${shp.id}/acceptances`, { sealIntact: true, quantity: 500, unit: 'grams' }, 'u-site-a');
    await h.ok('POST', `/shipments/${shp.id}/delivery`, { seal: 'S-1' }, 'u-keeper');
    const acc = await h.ok('POST', `/shipments/${shp.id}/acceptances`, { sealIntact: true, quantity: 500, unit: 'grams' }, 'u-site-c');
    assert.equal(acc.siteId, 'SITE-C');
  } finally { await h.stop(); }
});

test('终止回收：已播种不抹去、回收未核实不入库、未结不清项目', async () => {
  const h = await harness();
  try {
    await seedBaseline(h);
    await h.ok('POST', '/plans', { id: 'PLAN-A', siteId: 'SITE-A', season: '2027-spring', varietyId: 'VAR-1', purpose: 'research' }, 'u-site-a');
    await h.ok('POST', '/plans/PLAN-A/approvals', {}, 'u-approver');
    const app = await h.ok('POST', '/applications', { planId: 'PLAN-A', lotId: 'SEED-1', quantity: 4000, unit: 'grams' }, 'u-site-a');
    const decided = await h.ok('POST', `/applications/${app.id}/decisions`, { decision: 'approve' }, 'u-approver');
    const commitmentId = decided.commitment.id;
    const shp = await h.ok('POST', '/shipments', { commitmentId, quantity: 4000, unit: 'grams', seal: 'S-1', carrierRef: 'C-30' }, 'u-keeper');
    await h.ok('POST', `/shipments/${shp.id}/dispatch`, {}, 'u-keeper');
    await h.ok('POST', `/shipments/${shp.id}/delivery`, {}, 'u-keeper');
    await h.ok('POST', `/shipments/${shp.id}/acceptances`, { sealIntact: true, quantity: 4000, unit: 'grams' }, 'u-site-a');
    await h.ok('POST', '/site-movements', { planId: 'PLAN-A', lotId: 'SEED-1', kind: 'sow', quantity: 1000, unit: 'grams', occurredAt: '2027-03-01T08:00:00Z' }, 'u-site-a');

    // 终止方案：未发承诺解除回库；已播种保留；站点仍持 3000 克。
    const terminated = await h.ok('POST', '/plans/PLAN-A/terminations', { reason: '站点终止本季试验' }, 'u-site-a');
    assert.equal(terminated.status, 'terminated');
    const trace1 = await h.ok('GET', '/lots/SEED-1/trace', undefined, 'u-approver');
    assert.equal(trace1.stockBuckets.sown, 1000);
    assert.equal(trace1.stockBuckets.siteUsable['SITE-A'], 3000);
    // 终止后不能再播种。
    await h.failStatus(409, 'POST', '/site-movements', { planId: 'PLAN-A', lotId: 'SEED-1', kind: 'sow', quantity: 10, unit: 'grams' }, 'u-site-a');
    // 项目此时不能结清。
    await h.failStatus(409, 'POST', '/plans/PLAN-A/closures', {}, 'u-approver');

    // 退回 2500 克，封签 RETURN-SEAL-1；站点余 500 克经核准销毁。
    const ret = await h.ok('POST', '/site-movements', { planId: 'PLAN-A', lotId: 'SEED-1', kind: 'return', quantity: 2500, unit: 'grams', seal: 'RETURN-SEAL-1' }, 'u-site-a');
    const recoveryId = ret.recovery.id;
    await h.ok('POST', '/lots/destructions', { lotId: 'SEED-1', quantity: 500, unit: 'grams', source: 'site_quarantine' }, 'u-approver').catch(() => {});
    // 站点可用的 500 克先转隔离再销毁：可用桶不能直接按 site_quarantine 销毁。
    await h.ok('POST', '/lots/quality-events', { lotId: 'SEED-1', quantity: 500, unit: 'grams', event: '终止余料', source: 'siteUsable', siteId: 'SITE-A' }, 'u-keeper');
    await h.ok('POST', '/lots/destructions', { lotId: 'SEED-1', quantity: 500, unit: 'grams', source: 'site_quarantine', siteId: 'SITE-A', reason: '终止余料销毁' }, 'u-approver');

    // 回收包到库未核实：不并入可用。
    const arrived = await h.ok('POST', `/recoveries/${recoveryId}/arrivals`, { seal: 'RETURN-SEAL-1' }, 'u-keeper');
    assert.equal(arrived.status, 'arrived_pending_identity');
    const trace2 = await h.ok('GET', '/lots/SEED-1/trace', undefined, 'u-approver');
    assert.equal(trace2.stockBuckets.pendingReturn, 2500);
    assert.equal(trace2.stockBuckets.availableBase, 6000);
    // 仍不能结清。
    await h.failStatus(409, 'POST', '/plans/PLAN-A/closures', {}, 'u-approver');
    // 身份核实通过后才回到可用库存。
    await h.ok('POST', `/recoveries/${recoveryId}/identity-verifications`, { identityConfirmed: true }, 'u-keeper');
    const trace3 = await h.ok('GET', '/lots/SEED-1/trace', undefined, 'u-approver');
    assert.equal(trace3.stockBuckets.pendingReturn, 0);
    assert.equal(trace3.stockBuckets.availableBase, 8500);
    // 终止后承诺已解除，committed 归零。
    assert.equal(trace3.stockBuckets.committed, 0);

    // 未结材料清单已无该方案条目，项目可以结清；播种事实仍在。
    const closed = await h.ok('POST', '/plans/PLAN-A/closures', {}, 'u-approver');
    assert.equal(closed.status, 'closed');
    const materials = await h.ok('GET', '/plans/PLAN-A/materials', undefined, 'u-approver');
    assert.equal(materials.openItems.length, 0);
    assert.equal(materials.lots[0].siteRecords.find((m) => m.kind === 'sow').quantityBase, 1000);
  } finally { await h.stop(); }
});

test('采收材料延续原用途限制，换包装不能对外发放', async () => {
  const h = await harness();
  try {
    await seedBaseline(h);
    await h.ok('POST', '/plans', { id: 'PLAN-A', siteId: 'SITE-A', season: '2027-spring', varietyId: 'VAR-1', purpose: 'research' }, 'u-site-a');
    await h.ok('POST', '/plans/PLAN-A/approvals', {}, 'u-approver');
    const app = await h.ok('POST', '/applications', { planId: 'PLAN-A', lotId: 'SEED-1', quantity: 500, unit: 'grams' }, 'u-site-a');
    const decided = await h.ok('POST', `/applications/${app.id}/decisions`, { decision: 'approve' }, 'u-approver');
    const shp = await h.ok('POST', '/shipments', { commitmentId: decided.commitment.id, quantity: 500, unit: 'grams', seal: 'S-1', carrierRef: 'C-40' }, 'u-keeper');
    await h.ok('POST', `/shipments/${shp.id}/dispatch`, {}, 'u-keeper');
    await h.ok('POST', `/shipments/${shp.id}/delivery`, {}, 'u-keeper');
    await h.ok('POST', `/shipments/${shp.id}/acceptances`, { sealIntact: true, quantity: 500, unit: 'grams' }, 'u-site-a');
    await h.ok('POST', '/site-movements', { planId: 'PLAN-A', lotId: 'SEED-1', kind: 'sow', quantity: 500, unit: 'grams' }, 'u-site-a');

    const hrv = await h.ok('POST', '/harvests', { planId: 'PLAN-A', sourceLotId: 'SEED-1', quantity: 200, unit: 'grams', seal: 'H-1' }, 'u-site-a');
    assert.equal(hrv.restrictedPurpose, 'research');
    await h.ok('POST', `/harvests/${hrv.id}/repacks`, { newSeal: 'H-1R' }, 'u-site-a');
    // 商业交接被拒。
    await h.failStatus(409, 'POST', `/harvests/${hrv.id}/handovers`, { recipient: '某公司', purpose: 'commercial' }, 'u-approver');
    // 未结材料里有采收材料。
    const open = await h.ok('GET', '/materials/open', undefined, 'u-approver');
    assert.ok(open.items.some((i) => i.kind === 'harvest_open'));
    // 科研交接成立，保留原批次关联。
    const handed = await h.ok('POST', `/harvests/${hrv.id}/handovers`, { recipient: '下游科研组', purpose: 'research' }, 'u-approver');
    assert.equal(handed.status, 'handover');
    const trace = await h.ok('GET', '/lots/SEED-1/trace', undefined, 'u-approver');
    assert.equal(trace.harvests[0].handover.recipient, '下游科研组');
  } finally { await h.stop(); }
});

test('有核准换算依据时克/粒可换算，库存守恒恒成立', async () => {
  const h = await harness();
  try {
    await h.ok('POST', '/bootstrap', {});
    await h.ok('POST', '/sites', { id: 'SITE-A', region: 'plain' }, 'u-approver');
    await h.ok('POST', '/varieties', { id: 'VAR-1', name: '合成稻种甲' }, 'u-approver');
    await h.ok('POST', '/permits', { siteId: 'SITE-A', varietyId: 'VAR-1', season: '2027-spring', purpose: 'research' }, 'u-approver');
    // 100 粒 = 250 克（2.5 克/粒），以整数因子表达：seeds*5/2=grams。
    await h.ok('POST', '/lots', {
      id: 'SEED-X', varietyId: 'VAR-1', seal: 'SX', grams: 10000, baseUnit: 'grams',
      regions: ['plain'], purpose: 'research',
      conversionBasis: { fromUnit: 'seeds', toUnit: 'grams', factorNumerator: 5, factorDenominator: 2 },
    }, 'u-approver');
    await h.ok('POST', '/plans', { id: 'PLAN-X', siteId: 'SITE-A', season: '2027-spring', varietyId: 'VAR-1', purpose: 'research' }, 'u-site-a');
    await h.ok('POST', '/plans/PLAN-X/approvals', {}, 'u-approver');
    // 100 粒 → 250 克，整数成立。
    const app = await h.ok('POST', '/applications', { planId: 'PLAN-X', lotId: 'SEED-X', quantity: 100, unit: 'seeds' }, 'u-site-a');
    const decided = await h.ok('POST', `/applications/${app.id}/decisions`, { decision: 'approve' }, 'u-approver');
    assert.equal(decided.commitment.quantityBase, 250);
    // 101 粒 → 252.5 克，非整数被拒。
    await h.failStatus(400, 'POST', '/applications', { planId: 'PLAN-X', lotId: 'SEED-X', quantity: 101, unit: 'seeds' }, 'u-site-a');

    // 走完发种/验收/播种/退回全流程，验证库存桶守恒。
    const shp = await h.ok('POST', '/shipments', { commitmentId: decided.commitment.id, quantity: 250, unit: 'grams', seal: 'SX', carrierRef: 'CX' }, 'u-keeper');
    await h.ok('POST', `/shipments/${shp.id}/dispatch`, {}, 'u-keeper');
    await h.ok('POST', `/shipments/${shp.id}/delivery`, {}, 'u-keeper');
    await h.ok('POST', `/shipments/${shp.id}/acceptances`, { sealIntact: true, quantity: 250, unit: 'grams' }, 'u-site-a');
    await h.ok('POST', '/site-movements', { planId: 'PLAN-X', lotId: 'SEED-X', kind: 'sow', quantity: 100, unit: 'grams' }, 'u-site-a');
    await h.ok('POST', '/site-movements', { planId: 'PLAN-X', lotId: 'SEED-X', kind: 'return', quantity: 150, unit: 'grams', seal: 'RX' }, 'u-site-a');
    const recoveryId = (await h.request('GET', '/recoveries', undefined, 'u-keeper')).json.recoveries[0].id;
    await h.ok('POST', `/recoveries/${recoveryId}/arrivals`, {}, 'u-keeper');
    await h.ok('POST', `/recoveries/${recoveryId}/identity-verifications`, { identityConfirmed: true }, 'u-keeper');

    const trace = await h.ok('GET', '/lots/SEED-X/trace', undefined, 'u-approver');
    const b = trace.stockBuckets;
    const siteHeld = Object.values(b.siteUsable).reduce((a, v) => a + v, 0)
      + Object.values(b.siteQuarantine).reduce((a, v) => a + v, 0)
      + Object.values(b.siteRetained).reduce((a, v) => a + v, 0);
    // 恒等式一：批次总量 = 库内可用 + 备货桶 + 库内隔离 + 已离开仓库的各类材料（committed 是 overlay 不重复计入）。
    const accounted = b.availableBase + b.preparedStock + b.quarantineBase + b.inTransit + b.returning
      + b.pendingReturn + siteHeld + b.sown + b.destroyed + b.loss;
    assert.equal(accounted, trace.lot.totalBase, '全部实物库存桶之和必须等于批次总量');
    // 恒等式二：承诺 overlay 只落在尚未出库的实物（可用 + 备货）上。
    assert.ok(b.committed <= b.availableBase + b.preparedStock, '已承诺未出库量不能超过可用与备货之和');
  } finally { await h.stop(); }
});

test('状态持久化：重新加载状态文件后责任与流水保留', async () => {
  const h = await harness();
  try {
    await seedBaseline(h);
    await h.ok('POST', '/plans', { id: 'PLAN-A', siteId: 'SITE-A', season: '2027-spring', varietyId: 'VAR-1', purpose: 'research' }, 'u-site-a');
    await h.ok('POST', '/plans/PLAN-A/approvals', {}, 'u-approver');
    const app = await h.ok('POST', '/applications', { planId: 'PLAN-A', lotId: 'SEED-1', quantity: 100, unit: 'grams' }, 'u-site-a');
    await h.ok('POST', `/applications/${app.id}/decisions`, { decision: 'approve' }, 'u-approver');
    // 用同一状态文件新建服务实例，模拟进程重启后重新加载。
    const { Store } = await import('../src/store.mjs');
    const reloaded = new Store(join(h.dir, 'state.json'));
    assert.equal(reloaded.state.lots['SEED-1'].committed, 100);
    assert.equal(reloaded.state.applications[app.id].status, 'approved');
  } finally {
    await h.stop();
  }
});
