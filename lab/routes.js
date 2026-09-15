// 配方试验台 HTTP 路由。权限、非法因子、并发、回滚在此收口。
import { HttpError, addAudit } from "./store.js";
import {
  FACTORS, DEFECT_CODES, validateFactors, designRuns,
  replacementRun, hashSeed
} from "./design.js";
import { analyzeBatch, qualityScore } from "./stats.js";

export const ROLES = ["viewer", "recorder", "reviewer", "technologist", "admin"];
const PERMISSIONS = {
  "POST /formulas": ["technologist", "admin"],
  "POST /formulas/:id/revise": ["technologist", "admin"],
  "DELETE /formulas/:id": ["admin"],
  "POST /formulas/:id/finalize": ["technologist", "admin"],
  "POST /batches": ["technologist", "admin"],
  "POST /batches/:id/readings": ["recorder", "reviewer", "admin"],
  "POST /batches/:id/review": ["reviewer", "admin"],
  "POST /batches/:id/close": ["technologist", "reviewer", "admin"]
};

function publicFormula(f) {
  const { revisions, ...rest } = f;
  return { ...rest, revisionCount: (f.revisions || []).length };
}

function batchStatus(batch) {
  if (batch.closed) return "closed";
  const active = batch.runs.filter((r) => r.status !== "excluded");
  if (active.some((r) => r.status === "reviewed")) return "review_ready";
  if (active.some((r) => r.status === "entered")) return "entering";
  return "designed";
}

function publicBatch(b) {
  return {
    id: b.id, name: b.name, seed: b.seed, blocks: b.blocks, repsPerBlock: b.repsPerBlock,
    minReplicates: b.minReplicates, levels: b.levels, formulaIds: b.formulaIds,
    combosPerFormula: b.combosPerFormula, status: batchStatus(b),
    closed: !!b.closed, closedAt: b.closedAt || null,
    createdAt: b.createdAt, runCount: b.runs.length,
    enteredCount: b.runs.filter((r) => r.status === "entered" || r.status === "reviewed").length,
    validCount: b.runs.filter((r) => r.status === "reviewed").length,
    excludedCount: b.runs.filter((r) => r.status === "excluded").length
  };
}

function guardClosed(batch) {
  if (batch.closed) throw new HttpError(409, "batch_closed", { batchId: batch.id });
}

function findBatch(db, id) {
  const b = db.batches.find((x) => x.id === id);
  if (!b) throw new HttpError(404, "batch_not_found");
  return b;
}
function findFormula(db, id) {
  const f = db.formulas.find((x) => x.id === id);
  if (!f) throw new HttpError(404, "formula_not_found");
  return f;
}

function assertPerm(role, key) {
  const allow = PERMISSIONS[key];
  if (!allow) return; // 默认任意登录角色可读
  if (!allow.includes(role)) {
    throw new HttpError(403, "forbidden", { action: key, yourRole: role, required: allow });
  }
}

const str = (v, field, { min = 1, max = 120, optional = false } = {}) => {
  if (v === undefined || v === null || v === "") {
    if (optional) return undefined;
    throw new HttpError(400, "invalid_field", { field, reason: "必填" });
  }
  if (typeof v !== "string") throw new HttpError(400, "invalid_field", { field, reason: "必须是字符串" });
  const t = v.trim();
  if (t.length < min || t.length > max) throw new HttpError(400, "invalid_field", { field, reason: `长度需在 ${min}-${max}` });
  return t;
};
const num = (v, field, { min, max }) => {
  if (typeof v === "string" && v.trim() !== "") v = Number(v);
  if (typeof v !== "number" || !Number.isFinite(v)) throw new HttpError(400, "invalid_number", { field });
  if (v < min || v > max) throw new HttpError(400, "number_out_of_range", { field, min, max, value: v });
  return v;
};
const intBetween = (v, field, min, max) => {
  if (!Number.isInteger(v) || v < min || v > max) throw new HttpError(400, "number_out_of_range", { field, min, max });
  return v;
};

export function registerLabRoutes(on) {
  // ---------- 配方版本 ----------
  on("GET", /^\/api\/lab\/formulas$/, async ({ store }) => {
    const db = await store.read();
    return { status: 200, body: db.formulas.map(publicFormula) };
  });

  on("POST", /^\/api\/lab\/formulas$/, async ({ store, body, ctx, key }) => {
    assertPerm(ctx.role, "POST /formulas");
    const name = str(body.name, "name", { max: 60 });
    const ferric = str(body.ferricAmmoniumCitrate, "ferricAmmoniumCitrate", { max: 40 });
    const potassium = str(body.potassiumFerricyanide, "potassiumFerricyanide", { max: 40 });
    const ratio = str(body.ratio, "ratio", { max: 20 });
    const note = body.note === undefined ? "" : str(body.note, "note", { max: 300, optional: true }) || "";
    return store.mutate((db, { nextId, now }) => {
      if (db.formulas.some((f) => f.name === name && f.status !== "superseded")) {
        throw new HttpError(409, "formula_name_exists", { name });
      }
      const f = {
        id: nextId("FV"), code: str(body.code, "code", { max: 20 }), name,
        ferricAmmoniumCitrate: ferric, potassiumFerricyanide: potassium, ratio, note,
        status: "draft", parentId: null, version: 1,
        finalizedAt: null, finalizedBy: null, finalizedBatchId: null,
        revisions: [], createdAt: now(), createdBy: ctx.actor
      };
      db.formulas.push(f);
      addAudit(db, { at: now(), actor: ctx.actor, role: ctx.role, action: "formula_create", target: f.id, detail: { code: f.code, name } });
      return { status: 201, body: publicFormula(f) };
    }, { idemKey: key });
  });

  on("GET", /^\/api\/lab\/formulas\/([^/]+)$/, async ({ store, params }) => {
    const db = await store.read();
    const f = db.formulas.find((x) => x.id === params[0] || x.code === params[0]);
    if (!f) throw new HttpError(404, "formula_not_found");
    return { status: 200, body: f };
  });

  on("POST", /^\/api\/lab\/formulas\/([^/]+)\/revise$/, async ({ store, params, body, ctx, key }) => {
    assertPerm(ctx.role, "POST /formulas/:id/revise");
    const parent = (await store.read()).formulas.find((f) => f.id === params[0] || f.code === params[0]);
    if (!parent) throw new HttpError(404, "formula_not_found");
    const fields = ["name", "ferricAmmoniumCitrate", "potassiumFerricyanide", "ratio", "note"];
    const patch = {};
    for (const k of fields) {
      if (body[k] !== undefined) patch[k] = str(body[k], k, { max: k === "note" ? 300 : 60, optional: true });
    }
    if (!Object.keys(patch).length) throw new HttpError(400, "no_changes");
    return store.mutate((db, { nextId, now }) => {
      const p = findFormula(db, parent.id);
      if (p.status === "final") throw new HttpError(409, "formula_finalized_immutable", { formulaId: p.id });
      const version = (p.revisions.length || 0) + 2;
      const f = {
        ...structuredClone(p),
        id: nextId("FV"), code: `${p.code}-r${version - 1}`,
        status: "draft", parentId: p.id, version,
        finalizedAt: null, finalizedBy: null, finalizedBatchId: null,
        revisions: [], createdAt: now(), createdBy: ctx.actor,
        ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
      };
      db.formulas.push(f);
      p.revisions.push({ id: f.id, code: f.code, at: now(), changes: patch });
      addAudit(db, { at: now(), actor: ctx.actor, role: ctx.role, action: "formula_revise", target: f.id, detail: { parent: p.id, changes: patch } });
      return { status: 201, body: publicFormula(f) };
    }, { idemKey: key });
  });

  on("DELETE", /^\/api\/lab\/formulas\/([^/]+)$/, async ({ store, params, ctx, key }) => {
    assertPerm(ctx.role, "DELETE /formulas/:id");
    return store.mutate((db, { now }) => {
      const f = findFormula(db, params[0]);
      if (f.status === "final") throw new HttpError(409, "formula_finalized_immutable", { formulaId: f.id });
      const used = db.batches.some((b) => b.formulaIds.includes(f.id));
      if (used) throw new HttpError(409, "formula_used_by_batch", { formulaId: f.id });
      db.formulas = db.formulas.filter((x) => x.id !== f.id);
      addAudit(db, { at: now(), actor: ctx.actor, role: ctx.role, action: "formula_delete", target: f.id });
      return { status: 200, body: { ok: true } };
    }, { idemKey: key });
  });

  // 定版：不可改、不可删。必须有一个结论性批次支持，且优胜配方正是本配方。
  on("POST", /^\/api\/lab\/formulas\/([^/]+)\/finalize$/, async ({ store, params, body, ctx, key }) => {
    assertPerm(ctx.role, "POST /formulas/:id/finalize");
    const db0 = await store.read();
    const f0 = db0.formulas.find((x) => x.id === params[0] || x.code === params[0]);
    if (!f0) throw new HttpError(404, "formula_not_found");
    const batchId = body.batchId ? str(body.batchId, "batchId", { max: 40 }) : null;
    return store.mutate((db, { now }) => {
      const f = findFormula(db, f0.id);
      if (f.status === "final") throw new HttpError(409, "formula_already_finalized", { formulaId: f.id });
      let support = null;
      if (batchId) {
        const b = findBatch(db, batchId);
        if (!b.closed) throw new HttpError(409, "batch_not_closed", { batchId: b.id });
        const snap = b.snapshot;
        if (snap.analysis.status !== "conclusive" || snap.analysis.winner?.formulaId !== f.id) {
          throw new HttpError(409, "finalize_not_winner", { analysis: snap.analysis.status, winner: snap.analysis.winner?.formulaId });
        }
        support = b.id;
      } else {
        // 无显式批次时，也必须存在支撑本配方胜出的已定版批次，禁止无证据定版
        const found = db.batches.find(
          (b) => b.closed && b.snapshot?.analysis?.status === "conclusive" && b.snapshot.analysis.winner?.formulaId === f.id
        );
        if (!found) throw new HttpError(409, "finalize_no_evidence", { reason: "没有优胜结论为该配方的已定版批次" });
        support = found.id;
      }
      f.status = "final";
      f.finalizedAt = now();
      f.finalizedBy = ctx.actor;
      f.finalizedBatchId = support;
      addAudit(db, { at: now(), actor: ctx.actor, role: ctx.role, action: "formula_finalize", target: f.id, detail: { batchId: support } });
      return { status: 200, body: publicFormula(f) };
    }, { idemKey: key });
  });

  // ---------- 批次 / 试验设计 ----------
  on("GET", /^\/api\/lab\/batches$/, async ({ store }) => {
    const db = await store.read();
    return { status: 200, body: db.batches.map(publicBatch).reverse() };
  });

  on("POST", /^\/api\/lab\/batches$/, async ({ store, body, ctx, key }) => {
    assertPerm(ctx.role, "POST /batches");
    const name = str(body.name, "name", { max: 60 });
    const blocks = intBetween(body.blocks ?? 3, "blocks", 1, 20);
    const repsPerBlock = intBetween(body.repsPerBlock ?? 1, "repsPerBlock", 1, 5);
    const minReplicates = intBetween(body.minReplicates ?? 2, "minReplicates", 1, blocks * repsPerBlock * 16);
    const levels = validateFactors(body.levels || {});
    const rawIds = body.formulaIds;
    if (!Array.isArray(rawIds) || rawIds.length < 2) throw new HttpError(400, "formulas_required", { reason: "比较试验至少需要 2 个配方" });
    if (rawIds.some((id) => typeof id !== "string" || !id.trim())) {
      throw new HttpError(400, "invalid_field", { field: "formulaIds", reason: "必须全部为配方 ID 字符串" });
    }
    return store.mutate((db, { nextId, now }) => {
      const formulas = rawIds.map((id) => findFormula(db, id));
      const dup = rawIds.filter((id, i) => rawIds.indexOf(id) !== i);
      if (dup.length) throw new HttpError(400, "duplicate_formula", { ids: dup });
      const finals = formulas.filter((f) => f.status === "final").map((f) => f.id);
      if (finals.length) throw new HttpError(409, "formula_finalized_immutable", { finalFormulaIds: finals, reason: "已定版配方不参与新试验" });
      const id = nextId("B");
      const seedText = body.seed !== undefined && body.seed !== "" ? str(body.seed, "seed", { max: 80 }) : `${id}:${name}:${db.seq}`;
      const seed = hashSeed(seedText);
      const { runs, combosPerFormula } = designRuns({
        formulaIds: formulas.map((f) => f.id), levels, blocks, repsPerBlock, seed,
        makeId: (p) => nextId(p)
      });
      const batch = {
        id, name, levels, blocks, repsPerBlock, minReplicates, seed,
        formulaIds: formulas.map((f) => f.id), combosPerFormula,
        runs, readingSeq: 0, closed: false, closedAt: null, snapshot: null,
        createdAt: now(), createdBy: ctx.actor
      };
      db.batches.push(batch);
      addAudit(db, { at: now(), actor: ctx.actor, role: ctx.role, action: "batch_design", target: id,
        detail: { name, blocks, repsPerBlock, runs: runs.length, seed, levels } });
      return { status: 201, body: { ...publicBatch(batch), runs: batch.runs } };
    }, { idemKey: key });
  });

  on("GET", /^\/api\/lab\/batches\/([^/]+)$/, async ({ store, params }) => {
    const db = await store.read();
    const b = db.batches.find((x) => x.id === params[0]);
    if (!b) throw new HttpError(404, "batch_not_found");
    return { status: 200, body: { ...publicBatch(b), runs: b.runs, snapshot: b.snapshot } };
  });

  // ---------- 试样录入（允许并发、允许乱序、允许重复测量） ----------
  on("POST", /^\/api\/lab\/batches\/([^/]+)\/runs\/([^/]+)\/readings$/,
    async ({ store, params, body, ctx, key }) => {
      assertPerm(ctx.role, "POST /batches/:id/readings");
      const density = num(body.density, "density", { min: 0, max: 3 });
      const colorDelta = num(body.colorDelta, "colorDelta", { min: 0, max: 100 });
      const defect = str(body.defect, "defect", { max: 20 });
      if (!DEFECT_CODES.includes(defect)) throw new HttpError(400, "invalid_defect_code", { allowed: DEFECT_CODES });
      const temperature = body.temperature === undefined || body.temperature === "" ? null : num(body.temperature, "temperature", { min: -10, max: 60 });
      const humidity = body.humidity === undefined || body.humidity === "" ? null : num(body.humidity, "humidity", { min: 0, max: 100 });
      const note = body.note === undefined ? "" : str(body.note, "note", { max: 300, optional: true }) || "";
      return store.mutate((db, { now }) => {
        const b = findBatch(db, params[0]);
        guardClosed(b);
        const run = b.runs.find((r) => r.id === params[1]);
        if (!run) throw new HttpError(404, "run_not_found", { runId: params[1] });
        if (run.status === "excluded") throw new HttpError(409, "run_excluded", { runId: run.id, replacement: run.replacedBy });
        if (run.status === "reviewed") throw new HttpError(409, "run_reviewed", { runId: run.id, reason: "已定有效值，补测请先退回复核" });
        // 重复测量：保留全部原始读数，状态保持 entered，有效值由复核裁决
        b.readingSeq += 1;
        const reading = {
          id: `${b.id}-R${String(b.readingSeq).padStart(3, "0")}`,
          seq: b.readingSeq, density, colorDelta, defect, temperature, humidity, note,
          score: qualityScore({ density, colorDelta, defect }),
          at: now(), by: ctx.actor, state: "candidate", decisionNote: null
        };
        run.readings.push(reading);
        run.status = "entered";
        addAudit(db, { at: now(), actor: ctx.actor, role: ctx.role, action: "reading_create", target: run.id,
          detail: { batchId: b.id, readingId: reading.id, seq: reading.seq } });
        return { status: 201, body: { runId: run.id, status: run.status, reading } };
      }, { idemKey: key });
    });

  // ---------- 复核：重复测量只留复核后的有效值；异常排除必须留痕 ----------
  on("POST", /^\/api\/lab\/batches\/([^/]+)\/review$/, async ({ store, params, body, ctx, key }) => {
    assertPerm(ctx.role, "POST /batches/:id/review");
    const decisionsInput = body.decisions;
    if (!Array.isArray(decisionsInput) || !decisionsInput.length) throw new HttpError(400, "decisions_required");
    const decisions = decisionsInput.map((d) => {
      if (!d || typeof d !== "object") throw new HttpError(400, "invalid_decision");
      const runId = str(d.runId, "runId", { max: 40 });
      const action = d.action;
      if (!["valid", "exclude", "reject-reading"].includes(action)) {
        throw new HttpError(400, "invalid_review_action", { action });
      }
      const reason = d.reason === undefined ? "" : str(d.reason, "reason", { min: 2, max: 200, optional: true }) || "";
      if (action === "exclude" && reason.length < 2) throw new HttpError(400, "exclude_reason_required", { runId });
      let readingId = null;
      if (action === "valid") {
        readingId = str(d.readingId, "readingId", { max: 40 });
      }
      if (action === "reject-reading") {
        readingId = str(d.readingId, "readingId", { max: 40 });
        if (reason.length < 2) throw new HttpError(400, "reject_reason_required", { runId });
      }
      return { runId, action, readingId, reason };
    });
    const autoReplace = body.autoReplace !== false;
    return store.mutate((db, { nextId, now }) => {
      const b = findBatch(db, params[0]);
      guardClosed(b);
      const touched = [];
      for (const d of decisions) {
        const run = b.runs.find((r) => r.id === d.runId);
        if (!run) throw new HttpError(404, "run_not_found", { runId: d.runId });
        if (run.status === "excluded") throw new HttpError(409, "run_excluded", { runId: run.id });
        if (d.action === "reject-reading") {
          const rd = run.readings.find((x) => x.id === d.readingId);
          if (!rd) throw new HttpError(404, "reading_not_found", { readingId: d.readingId });
          if (rd.state !== "candidate") throw new HttpError(409, "reading_decided", { readingId: rd.id, state: rd.state });
          rd.state = "rejected";
          rd.decisionNote = d.reason;
          rd.decidedAt = now();
          rd.decidedBy = ctx.actor;
          addAudit(db, { at: now(), actor: ctx.actor, role: ctx.role, action: "reading_reject", target: rd.id,
            detail: { batchId: b.id, runId: run.id, reason: d.reason } });
          touched.push(run.id);
          continue;
        }
        if (d.action === "valid") {
          const rd = run.readings.find((x) => x.id === d.readingId);
          if (!rd) throw new HttpError(404, "reading_not_found", { readingId: d.readingId });
          if (rd.state === "rejected") throw new HttpError(409, "reading_rejected", { readingId: rd.id });
          // 其余重复读数标记为 redundant（留痕但不进统计）
          for (const x of run.readings) {
            if (x.id !== rd.id && x.state === "candidate") {
              x.state = "redundant";
              x.decisionNote = "重复测量：未选为有效值";
              x.decidedAt = now();
              x.decidedBy = ctx.actor;
            }
          }
          rd.state = "valid";
          rd.decisionNote = d.reason || null;
          rd.decidedAt = now();
          rd.decidedBy = ctx.actor;
          run.validReadingId = rd.id;
          run.status = "reviewed";
          addAudit(db, { at: now(), actor: ctx.actor, role: ctx.role, action: "run_validate", target: run.id,
            detail: { batchId: b.id, readingId: rd.id, readings: run.readings.length, reason: d.reason } });
        } else {
          // 整样异常排除：必须填写原因；自动补样维持区组平衡
          run.status = "excluded";
          run.excludedAt = now();
          run.excludedBy = ctx.actor;
          run.excludeReason = d.reason;
          for (const x of run.readings) {
            if (x.state === "candidate") { x.state = "void"; x.decisionNote = `整样排除：${d.reason}`; }
          }
          if (autoReplace) {
            const order = b.runs.length ? Math.max(...b.runs.map((r) => r.order)) + 1 : 1;
            const rep = replacementRun({ run, blocks: b.blocks, makeId: (p) => nextId(p), order });
            b.runs.push(rep);
            run.replacedBy = rep.id;
            addAudit(db, { at: now(), actor: ctx.actor, role: ctx.role, action: "run_replace", target: rep.id,
              detail: { batchId: b.id, replaces: run.id, block: run.block } });
          }
          addAudit(db, { at: now(), actor: ctx.actor, role: ctx.role, action: "run_exclude", target: run.id,
            detail: { batchId: b.id, reason: d.reason, autoReplace } });
        }
        touched.push(run.id);
      }
      return { status: 200, body: { batchId: b.id, status: batchStatus(b), touched } };
    }, { idemKey: key });
  });

  // 退回已复核试样（复核纠错；批次关闭后禁止）
  on("POST", /^\/api\/lab\/batches\/([^/]+)\/runs\/([^/]+)\/reopen$/, async ({ store, params, body, ctx, key }) => {
    assertPerm(ctx.role, "POST /batches/:id/review");
    const reason = str(body.reason || "", "reason", { min: 2, max: 200 });
    return store.mutate((db, { now }) => {
      const b = findBatch(db, params[0]);
      guardClosed(b);
      const run = b.runs.find((r) => r.id === params[1]);
      if (!run) throw new HttpError(404, "run_not_found");
      if (run.status !== "reviewed") throw new HttpError(409, "run_not_reviewed", { status: run.status });
      const rd = run.readings.find((x) => x.id === run.validReadingId);
      if (rd) { rd.state = "candidate"; rd.decisionNote = `退回：${reason}`; rd.decidedAt = now(); rd.decidedBy = ctx.actor; }
      run.validReadingId = null;
      run.status = "entered";
      addAudit(db, { at: now(), actor: ctx.actor, role: ctx.role, action: "run_reopen", target: run.id, detail: { reason } });
      return { status: 200, body: { runId: run.id, status: run.status } };
    }, { idemKey: key });
  });

  // ---------- 比较分析（只读） ----------
  on("GET", /^\/api\/lab\/batches\/([^/]+)\/analysis$/, async ({ store, params }) => {
    const db = await store.read();
    const b = db.batches.find((x) => x.id === params[0]);
    if (!b) throw new HttpError(404, "batch_not_found");
    if (b.closed) return { status: 200, body: b.snapshot.analysis };
    return { status: 200, body: analyzeBatch(b) };
  });

  // ---------- 关闭批次：结论不成立则拒绝定案 ----------
  on("POST", /^\/api\/lab\/batches\/([^/]+)\/close$/, async ({ store, params, body, ctx, key }) => {
    assertPerm(ctx.role, "POST /batches/:id/close");
    const force = body.force === true; // force 仅允许“无结论封存”，不产生优胜快照结论
    return store.mutate((db, { now }) => {
      const b = findBatch(db, params[0]);
      if (b.closed) throw new HttpError(409, "batch_already_closed", { batchId: b.id, at: b.closedAt });
      const analysis = analyzeBatch(b);
      if (!force && analysis.status !== "conclusive") {
        throw new HttpError(409, "batch_inconclusive", { gates: analysis.gates, reasons: analysis.reasons });
      }
      const formulaSnapshots = b.formulaIds.map((fid) => {
        const f = db.formulas.find((x) => x.id === fid);
        return { id: f.id, code: f.code, name: f.name,
          ferricAmmoniumCitrate: f.ferricAmmoniumCitrate, potassiumFerricyanide: f.potassiumFerricyanide,
          ratio: f.ratio, statusAtClose: f.status };
      });
      b.closed = true;
      b.closedAt = now();
      b.closedBy = ctx.actor;
      b.snapshot = { at: b.closedAt, analysis, formulas: formulaSnapshots };
      addAudit(db, { at: now(), actor: ctx.actor, role: ctx.role, action: "batch_close", target: b.id,
        detail: { status: analysis.status, winner: analysis.winner?.formulaId || null, force } });
      return { status: 200, body: publicBatch(b) };
    }, { idemKey: key });
  });

  // ---------- 留痕 / 总览 ----------
  on("GET", /^\/api\/lab\/audit$/, async ({ store, query }) => {
    const db = await store.read();
    let rows = db.audit;
    if (query.get("action")) rows = rows.filter((a) => a.action === query.get("action"));
    if (query.get("target")) rows = rows.filter((a) => a.target === query.get("target"));
    const limit = Math.min(Number(query.get("limit") || 200) || 200, 1000);
    return { status: 200, body: rows.slice(0, limit) };
  });

  on("GET", /^\/api\/lab\/state$/, async ({ store }) => {
    const db = await store.read();
    return {
      status: 200,
      body: {
        roles: ROLES,
        factors: FACTORS,
        defectCodes: DEFECT_CODES,
        formulas: db.formulas.length,
        batches: db.batches.length,
        finalFormulas: db.formulas.filter((f) => f.status === "final").map(publicFormula),
        recentAudit: db.audit.slice(0, 10)
      }
    };
  });
}

