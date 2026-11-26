import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Store } from './store.mjs';
import { AppError, fail, nowIso } from './util.mjs';
import { getUser } from './helpers.mjs';
import * as registry from './registry.mjs';
import * as lots from './lots.mjs';
import * as plans from './plans.mjs';
import * as applications from './applications.mjs';
import * as shipments from './shipments.mjs';
import * as site from './site.mjs';
import * as recovery from './recovery.mjs';
import * as harvest from './harvest.mjs';
import * as views from './views.mjs';

// 路由表：method、路径正则、处理函数；路径参数在 match.groups。
const routes = [
  ['POST', /^\/bootstrap$/, 'bootstrap'],
  ['POST', /^\/admin\/users$/, 'createUser'],
  ['POST', /^\/sites$/, 'createSite'],
  ['GET', /^\/sites$/, 'listSites'],
  ['POST', /^\/varieties$/, 'createVariety'],
  ['GET', /^\/varieties$/, 'listVarieties'],
  ['POST', /^\/permits$/, 'createPermit'],
  ['POST', /^\/permits\/(?<id>[^/]+)\/revoke$/, 'revokePermit'],
  ['GET', /^\/permits$/, 'listPermits'],
  ['POST', /^\/lots$/, 'createLot'],
  ['GET', /^\/lots$/, 'listLots'],
  ['GET', /^\/lots\/(?<id>[^/]+)$/, 'getLot'],
  ['POST', /^\/lots\/quality-events$/, 'reportQualityEvent'],
  ['POST', /^\/lots\/quarantine-decisions$/, 'releaseQuarantine'],
  ['POST', /^\/lots\/identity-corrections$/, 'correctIdentity'],
  ['POST', /^\/lots\/identity-resolutions$/, 'resolveIdentity'],
  ['POST', /^\/commitments\/reconfirm$/, 'reconfirmCommitment'],
  ['POST', /^\/lots\/destructions$/, 'destroyMaterial'],
  ['POST', /^\/plans$/, 'createPlan'],
  ['GET', /^\/plans$/, 'listPlans'],
  ['POST', /^\/plans\/(?<id>[^/]+)\/approvals$/, 'approvePlan'],
  ['POST', /^\/plans\/(?<id>[^/]+)\/amendments$/, 'amendPlan'],
  ['POST', /^\/plans\/(?<id>[^/]+)\/terminations$/, 'terminatePlan'],
  ['POST', /^\/plans\/(?<id>[^/]+)\/closures$/, 'closePlan'],
  ['GET', /^\/plans\/(?<id>[^/]+)\/materials$/, 'planMaterials'],
  ['POST', /^\/applications$/, 'createApplication'],
  ['POST', /^\/applications\/(?<id>[^/]+)\/decisions$/, 'decideApplication'],
  ['GET', /^\/applications$/, 'listApplications'],
  ['POST', /^\/shipments$/, 'createShipment'],
  ['POST', /^\/shipments\/(?<id>[^/]+)\/cancellations$/, 'cancelShipment'],
  ['POST', /^\/shipments\/(?<id>[^/]+)\/dispatch$/, 'recordDispatch'],
  ['POST', /^\/shipments\/(?<id>[^/]+)\/delivery$/, 'recordDelivery'],
  ['POST', /^\/shipments\/(?<id>[^/]+)\/receipt-resumptions$/, 'resumeReceipt'],
  ['POST', /^\/shipments\/(?<id>[^/]+)\/acceptances$/, 'confirmReceipt'],
  ['POST', /^\/shipments\/(?<id>[^/]+)\/forwards$/, 'forwardShipment'],
  ['GET', /^\/shipments$/, 'listShipments'],
  ['POST', /^\/site-movements$/, 'registerMovement'],
  ['GET', /^\/sites\/(?<id>[^/]+)\/balance$/, 'siteBalance'],
  ['POST', /^\/recoveries\/(?<id>[^/]+)\/arrivals$/, 'receiveRecovery'],
  ['POST', /^\/recoveries\/(?<id>[^/]+)\/identity-verifications$/, 'verifyRecoveryIdentity'],
  ['POST', /^\/recoveries\/(?<id>[^/]+)\/destructions$/, 'destroyRecovery'],
  ['GET', /^\/recoveries$/, 'listRecoveries'],
  ['POST', /^\/harvests$/, 'registerHarvest'],
  ['POST', /^\/harvests\/(?<id>[^/]+)\/repacks$/, 'repackHarvest'],
  ['POST', /^\/harvests\/(?<id>[^/]+)\/handovers$/, 'handoverHarvest'],
  ['GET', /^\/harvests$/, 'listHarvests'],
  ['GET', /^\/lots\/(?<id>[^/]+)\/trace$/, 'lotTrace'],
  ['GET', /^\/materials\/open$/, 'openMaterials'],
  ['GET', /^\/ledger$/, 'ledger'],
];

function bootstrap(store, body) {
  if (Object.keys(store.state.users).length) fail(409, 'already_bootstrapped', '系统已完成初始引导，请使用具体用户令牌');
  const seed = body?.users ?? [
    { id: 'u-approver', role: 'approver' },
    { id: 'u-keeper', role: 'keeper' },
    { id: 'u-quality', role: 'quality' },
    { id: 'u-site-a', role: 'site', siteId: 'SITE-A' },
    { id: 'u-site-b', role: 'site', siteId: 'SITE-B' },
  ];
  const users = [];
  for (const item of seed) {
    const user = { id: item.id, role: item.role, siteId: item.siteId ?? null, createdAt: nowIso() };
    store.state.users[user.id] = user;
    users.push(user);
  }
  store.save();
  return { users, note: '初始用户已建立；后续业务请求请用 X-User-Id 携带用户编号' };
}

export function createApp(stateFile) {
  const store = new Store(stateFile);

  const send = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { status: 'ok', service: 'seed-trial-materials', time: nowIso() });
      }
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 4 * 1024 * 1024) return send(res, 413, { error: { code: 'too_large', message: '请求体过大' } });
      }
      let body = {};
      if (raw) {
        try { body = JSON.parse(raw); }
        catch { return send(res, 400, { error: { code: 'bad_json', message: 'JSON 格式不符' } });
        }
      }
      const match = routes.find(([method, pattern]) => method === req.method && pattern.test(url.pathname));
      if (!match) return send(res, 404, { error: { code: 'not_found', message: '没有对应的接口' } });
      const [, pattern, action] = match;
      const params = url.pathname.match(pattern).groups ?? {};

      if (action === 'bootstrap') {
        return send(res, 200, bootstrap(store, body));
      }
      const actor = getUser(store.state, String(req.headers['x-user-id'] ?? ''));
      const result = await dispatch(action, store, actor, body, params);
      return send(res, result?.statusCode ?? 200, result?.body ?? result);
    } catch (error) {
      if (error instanceof AppError) {
        return send(res, error.status, { error: { code: error.code, message: error.message, details: error.details } });
      }
      console.error(error);
      return send(res, 500, { error: { code: 'internal', message: '服务内部错误' } });
    }
  });
  return server;
}

async function dispatch(action, store, actor, body, params) {
  switch (action) {
    case 'createUser': return registry.createUser(store, actor, body);
    case 'createSite': return registry.createSite(store, actor, body);
    case 'listSites': return { sites: registry.listRegistry(store, actor, 'sites') };
    case 'createVariety': return registry.createVariety(store, actor, body);
    case 'listVarieties': return { varieties: registry.listRegistry(store, actor, 'varieties') };
    case 'createPermit': return registry.createPermit(store, actor, body);
    case 'revokePermit': return registry.revokePermit(store, actor, params.id, body);
    case 'listPermits': return { permits: registry.listRegistry(store, actor, 'permits') };
    case 'createLot': return lots.createLot(store, actor, body);
    case 'listLots': return { lots: registry.listRegistry(store, actor, 'lots') };
    case 'getLot': return store.state.lots[params.id] ?? fail(404, 'lot_not_found', `批次不存在：${params.id}`);
    case 'reportQualityEvent': return lots.reportQualityEvent(store, actor, body);
    case 'releaseQuarantine': return lots.releaseQuarantine(store, actor, body);
    case 'correctIdentity': return lots.correctIdentity(store, actor, body);
    case 'resolveIdentity': return lots.resolveIdentity(store, actor, body);
    case 'reconfirmCommitment': return lots.reconfirmCommitment(store, actor, body);
    case 'destroyMaterial': return lots.destroyMaterial(store, actor, body);
    case 'createPlan': return plans.createPlan(store, actor, body);
    case 'listPlans': return { plans: registry.listRegistry(store, actor, 'plans') };
    case 'approvePlan': return plans.approvePlan(store, actor, params.id);
    case 'amendPlan': return plans.amendPlan(store, actor, params.id, body);
    case 'terminatePlan': return plans.terminatePlan(store, actor, params.id, body);
    case 'closePlan': return plans.closePlan(store, actor, params.id);
    case 'planMaterials': return views.planMaterials(store.state, actor, params.id);
    case 'createApplication': return applications.createApplication(store, actor, body);
    case 'decideApplication': return applications.decideApplication(store, actor, params.id, body);
    case 'listApplications': return { applications: registry.listRegistry(store, actor, 'applications') };
    case 'createShipment': return shipments.createShipment(store, actor, body);
    case 'cancelShipment': return shipments.cancelShipment(store, actor, params.id, body);
    case 'recordDispatch': return shipments.recordDispatch(store, actor, params.id, body);
    case 'recordDelivery': return shipments.recordDelivery(store, actor, params.id, body);
    case 'resumeReceipt': return shipments.resumeReceipt(store, actor, params.id, body);
    case 'confirmReceipt': return shipments.confirmReceipt(store, actor, params.id, body);
    case 'forwardShipment': return shipments.forwardShipment(store, actor, params.id, body);
    case 'listShipments': return { shipments: registry.listRegistry(store, actor, 'shipments') };
    case 'registerMovement': return site.registerMovement(store, actor, body);
    case 'siteBalance': return site.siteBalance(store, actor, params.id);
    case 'receiveRecovery': return recovery.receiveRecovery(store, actor, params.id, body);
    case 'verifyRecoveryIdentity': return recovery.verifyRecoveryIdentity(store, actor, params.id, body);
    case 'destroyRecovery': return recovery.destroyRecovery(store, actor, params.id, body);
    case 'listRecoveries': return { recoveries: registry.listRegistry(store, actor, 'recoveries') };
    case 'registerHarvest': return harvest.registerHarvest(store, actor, body);
    case 'repackHarvest': return harvest.repackHarvest(store, actor, params.id, body);
    case 'handoverHarvest': return harvest.handoverHarvest(store, actor, params.id, body);
    case 'listHarvests': return { harvests: registry.listRegistry(store, actor, 'harvests') };
    case 'lotTrace': return views.lotTrace(store.state, actor, params.id);
    case 'openMaterials': return views.openMaterials(store.state, actor);
    case 'ledger': {
      getUser(store.state, actor.id);
      return { ledger: store.state.ledger };
    }
    default: fail(404, 'not_found', '没有对应的接口');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stateFile = process.env.SEED_STATE ?? '.local/seed-trial.json';
  const port = Number(process.env.PORT ?? 4318);
  const server = createApp(stateFile);
  server.listen(port, '0.0.0.0', () => {
    console.log(JSON.stringify({ message: '试种材料管理服务已启动', port, stateFile }));
  });
}
