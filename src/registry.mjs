import { isValidId, fail, requireFields, nowIso, optionalId } from './util.mjs';
import { ROLES, PURPOSES, getUser, requireRole, getSite, getVariety } from './helpers.mjs';

export function createUser(store, actor, body) {
  requireRole(getUser(store.state, actor.id), ['approver']);
  requireFields(body, ['id', 'role']);
  if (!isValidId(body.id)) fail(400, 'bad_id', '用户编号格式不符');
  if (!ROLES.includes(body.role)) fail(400, 'bad_role', `角色只能是 ${ROLES.join('/')}`);
  if (store.state.users[body.id]) fail(409, 'user_exists', '用户编号已存在');
  const user = {
    id: body.id,
    role: body.role,
    siteId: null,
    createdAt: nowIso(),
  };
  if (body.role === 'site') {
    requireFields(body, ['siteId']);
    getSite(store.state, body.siteId);
    user.siteId = body.siteId;
  }
  store.state.users[user.id] = user;
  store.save();
  return user;
}

export function createSite(store, actor, body) {
  requireRole(getUser(store.state, actor.id), ['approver']);
  requireFields(body, ['id', 'region']);
  if (!isValidId(body.id)) fail(400, 'bad_id', '站点编号格式不符');
  if (store.state.sites[body.id]) fail(409, 'site_exists', '站点编号已存在');
  const site = { id: body.id, name: body.name ?? body.id, region: body.region, createdAt: nowIso() };
  store.state.sites[site.id] = site;
  store.save();
  return site;
}

export function createVariety(store, actor, body) {
  requireRole(getUser(store.state, actor.id), ['approver']);
  requireFields(body, ['id', 'name']);
  if (!isValidId(body.id)) fail(400, 'bad_id', '品种编号格式不符');
  if (store.state.varieties[body.id]) fail(409, 'variety_exists', '品种编号已存在');
  const variety = { id: body.id, name: body.name, createdAt: nowIso() };
  store.state.varieties[variety.id] = variety;
  store.save();
  return variety;
}

// 站点许可：品种、试验季、地点范围；核准人登记后生效。
export function createPermit(store, actor, body) {
  const user = getUser(store.state, actor.id);
  requireRole(user, ['approver']);
  requireFields(body, ['siteId', 'varietyId', 'season', 'purpose']);
  if (!PURPOSES.includes(body.purpose)) fail(400, 'bad_purpose', `用途只能是 ${PURPOSES.join('/')}`);
  const site = getSite(store.state, body.siteId);
  const variety = getVariety(store.state, body.varietyId);
  const id = body.id ?? store.nextId('PER');
  if (!isValidId(id)) fail(400, 'bad_id', '许可编号格式不符');
  if (store.state.permits[id]) fail(409, 'permit_exists', '许可编号已存在');
  const permit = {
    id,
    siteId: site.id,
    varietyId: variety.id,
    season: body.season,
    purpose: body.purpose,
    status: 'active',
    createdAt: nowIso(),
    createdBy: user.id,
    history: [{ at: nowIso(), by: user.id, action: 'created', detail: body.note ?? '核准人登记许可' }],
  };
  store.state.permits[id] = permit;
  store.save();
  return permit;
}

export function revokePermit(store, actor, id, body = {}) {
  const user = getUser(store.state, actor.id);
  requireRole(user, ['approver']);
  const permit = store.state.permits[id];
  if (!permit) fail(404, 'permit_not_found', `许可不存在：${id}`);
  if (permit.status !== 'active') fail(409, 'permit_not_active', '许可已不是有效状态');
  permit.status = 'revoked';
  permit.history.push({ at: nowIso(), by: user.id, action: 'revoked', detail: body.reason ?? '核准人撤销许可' });
  store.save();
  return permit;
}

export function listRegistry(store, actor, collection) {
  getUser(store.state, actor.id);
  return Object.values(store.state[collection]);
}
