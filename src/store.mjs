import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { nowIso } from './util.mjs';

// 单文件 JSON 持久化，原子替换；与合作方服务各自使用独立状态文件。
function freshState() {
  return {
    seq: 1,
    users: {},
    sites: {},
    varieties: {},
    permits: {},
    lots: {},
    plans: {},
    applications: {},
    commitments: {},
    shipments: {},
    acceptances: {},
    movements: [],
    recoveries: {},
    harvests: {},
    destructions: [],
    ledger: [],
  };
}

export class Store {
  constructor(stateFile) {
    this.stateFile = stateFile;
    let state;
    try {
      state = JSON.parse(readFileSync(stateFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state = freshState();
    }
    this.state = state;
  }

  nextId(prefix) {
    return `${prefix}-${this.state.seq++}`;
  }

  save() {
    mkdirSync(dirname(this.stateFile), { recursive: true });
    writeFileSync(this.stateFile + '.tmp', JSON.stringify(this.state, null, 1));
    renameSync(this.stateFile + '.tmp', this.stateFile);
  }

  // 台账只记实际材料流向；身份更正、核准决定等非数量事件留在各自实体的历史中。
  appendLedger(entry) {
    const record = {
      id: this.nextId('LED'),
      ts: nowIso(),
      ...entry,
    };
    this.state.ledger.push(record);
    return record;
  }
}
