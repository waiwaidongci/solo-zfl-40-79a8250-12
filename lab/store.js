// 配方试验与质量评估台 —— JSON 文件存储层
// 所有写操作经单写队列串行化：事务内修改状态，提交时原子落盘；
// 落盘失败则把内存状态整体回滚到事务前快照，统计与后续读取永不接触半成品。
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

export class HttpError extends Error {
  constructor(status, code, details) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function emptyDb() {
  return {
    seq: 0,
    formulas: [], // 配方版本
    batches: [], // 试验批次
    audit: [], // 留痕事件（建版、设计、录入、复核、排除、定版、回滚…）
    idem: {} // idempotencyKey -> 已完成响应
  };
}

async function defaultPersist(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${(Math.random() * 1e9) | 0}`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, path); // 同目录 rename 原子替换，杜绝半文件
}

export class LabStore {
  constructor(path, { persist } = {}) {
    this.path = path;
    this._persist = persist || (path ? ((p, data) => defaultPersist(p, data)) : async () => {});
    this._db = null;
    this._chain = Promise.resolve();
  }

  async init() {
    if (this._db) return;
    if (!this.path || !existsSync(this.path)) {
      this._db = emptyDb();
      if (this.path) {
        await mkdir(dirname(this.path), { recursive: true });
        await this._persist(this.path, this._db);
      }
    } else {
      this._db = JSON.parse(await readFile(this.path, "utf8"));
      const base = emptyDb();
      for (const k of Object.keys(base)) if (!(k in this._db)) this._db[k] = base[k];
    }
  }

  async getState() {
    await this.init();
    return this._db;
  }

  // 只读快照（深拷贝），供分析/列表使用
  async read() {
    await this.init();
    return structuredClone(this._db);
  }

  nextId(prefix) {
    this._db.seq += 1;
    return `${prefix}-${String(this._db.seq).padStart(4, "0")}`;
  }

  // 串行事务：mutator(db, helpers) 直接改 db；返回值作为 HTTP 响应体。
  // mutator 内抛 HttpError -> 不落盘、回滚并按 status 抛出；
  // 落盘抛错 -> 内存状态回滚到 before，调用方收到 500，可原样重试。
  mutate(mutator, { idemKey } = {}) {
    const run = this._chain.then(async () => {
      await this.init();
      if (idemKey) {
        const hit = this._db.idem[idemKey];
        if (hit) return { ...hit, replayed: true };
      }
      const before = structuredClone(this._db);
      let result;
      try {
        result = await mutator(this._db, {
          nextId: (p) => this.nextId(p),
          now: () => new Date().toISOString()
        });
      } catch (e) {
        this._db = before; // 校验/业务失败：不留痕迹地回滚（仅事务后已 push 的 audit 也一并撤销）
        throw e;
      }
      try {
        const payload = { status: (result && result.status) || 200, body: result && result.body !== undefined ? result.body : result };
        if (idemKey) this._db.idem[idemKey] = payload; // 与业务数据同事务落盘，重启后仍可去重
        await this._persist(this.path, this._db);
        return { ...payload, replayed: false };
      } catch (e) {
        if (!(e instanceof HttpError) || e.code !== "persist_failed") {
          this._db = before; // 落盘失败：内存同步回滚，失败提交绝不污染后续统计
          throw new HttpError(500, "persist_failed", { reason: String((e && e.message) || e) });
        }
        throw e;
      }
    });
    // 队列自身不能因单次失败而断裂
    this._chain = run.then(() => {}, () => {});
    return run;
  }
}

export function addAudit(db, { at, actor, role, action, target, detail = {} }) {
  db.audit.unshift({ id: db.seq + 1, at, actor: actor || "匿名", role: role || "-", action, target, detail });
  if (db.audit.length > 2000) db.audit.length = 2000;
}
