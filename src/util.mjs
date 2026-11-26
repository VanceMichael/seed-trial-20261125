// 通用错误与校验工具。本服务只管理演练业务，不产出育种结论，也不判断真实检疫合格。
export class AppError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function fail(status, code, message, details = undefined) {
  throw new AppError(status, code, message, details);
}

export function isValidId(id) {
  return typeof id === 'string'
    && /^[A-Za-z0-9_.:-]{1,100}$/.test(id)
    && !['__proto__', 'constructor', 'prototype'].includes(id);
}

export function requireFields(body, fields) {
  if (!body || typeof body !== 'object') fail(400, 'bad_body', '请求体必须是 JSON 对象');
  for (const field of fields) {
    const value = body[field];
    if (value === undefined || value === null || value === '') {
      fail(400, 'missing_field', `缺少必填字段：${field}`, { field });
    }
  }
}

export function positiveInt(value, name = '数量') {
  if (!Number.isInteger(value) || value <= 0) {
    fail(400, 'bad_quantity', `${name}必须是正整数`);
  }
  return value;
}

export function optionalId(value, prefix) {
  if (value === undefined || value === null || value === '') return null;
  if (!isValidId(value)) fail(400, 'bad_id', `编号格式不符：${value}`);
  return value || `${prefix}-${Date.now()}`;
}

export function nowIso() {
  return new Date().toISOString();
}
