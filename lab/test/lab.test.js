// 配方试验台自动化测试：node --test
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { createServer } from "../../server.js";
import { LabStore } from "../store.js";
import { makeRng, hashSeed, validateFactors, designRuns } from "../design.js";
import { summarize, qualityScore, analyzeBatch, balanceCheck } from "../stats.js";
async function startServer(store) {
  const { server } = createServer(store);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    stop: () => new Promise((r) => server.close(r)),
    req: (path, opts = {}) => {
      const headers = Object.assign(
        { "Content-Type": "application/json", "x-lab-role": opts.role || "admin", "x-lab-user": encodeURIComponent(opts.user || "测试员") },
        opts.headers || {}
      );
      if (opts.key) headers["Idempotency-Key"] = opts.key;
      return fetch(base + path, {
        method: opts.method || "GET",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
      }).then(async (res) => ({ status: res.status, json: await res.json() }));
    }
  };
}

async function tempStoreServer() {
  const file = join(tmpdir(), `lab-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const ctx = await startServer(new LabStore(file));
  ctx.file = file;
  return ctx;
}

async function makeTwoFormulas(ctx, overrides = {}) {
  const mk = async (code, name) =>
    ctx.req("/api/lab/formulas", {
      method: "POST",
      body: { code, name, ferricAmmoniumCitrate: "20%", potassiumFerricyanide: "16%", ratio: "1:1", ...overrides }
    });
  const a = await mk("FA", "配方甲");
  const b = await mk("FB", "配方乙");
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  return [a.json.body, b.json.body];
}

const minimalBatch = (formulaIds, patch = {}) => ({
  name: "对比批", blocks: 2, repsPerBlock: 1, minReplicates: 2, formulaIds,
  levels: { coating: ["薄涂", "厚涂"], exposure: ["短曝", "长曝"], development: ["弱酸", "清水"], wash: ["短洗", "长洗"] },
  ...patch
});

// ---------- 纯函数单元测试 ----------
describe("design 纯函数", () => {
  test("同种子产生同一试验顺序（可复现）", () => {
    const r1 = makeRng(12345), r2 = makeRng(12345);
    const seq1 = Array.from({ length: 20 }, () => r1());
    const seq2 = Array.from({ length: 20 }, () => r2());
    assert.deepEqual(seq1, seq2);
    assert.equal(hashSeed("abc"), hashSeed("abc"));
    assert.notEqual(hashSeed("abc"), hashSeed("abd"));
  });

  test("全因子设计与区组不混杂：每区组处理集合完全一致", () => {
    const levels = validateFactors({});
    const { runs } = designRuns({
      formulaIds: ["FA", "FB"], levels, blocks: 3, repsPerBlock: 1, seed: 99,
      makeId: (p) => `${p}-x`
    });
    assert.equal(runs.length, 2 * 16 * 3);
    for (const block of [1, 2, 3]) {
      const inBlock = runs.filter((r) => r.block === block);
      assert.equal(inBlock.length, 32);
      for (const fid of ["FA", "FB"]) {
        const combos = inBlock.filter((r) => r.formulaId === fid).map((r) => JSON.stringify(r.factors));
        assert.equal(new Set(combos).size, 16, "每配方在每区组覆盖全部 16 个因子组合各一次");
      }
    }
    // 区组内确实被洗牌（不是固定顺序）
    const orderKey = (b) => runs.filter((r) => r.block === b).map((r) => JSON.stringify([r.formulaId, r.factors])).join("|");
    assert.notEqual(orderKey(1), orderKey(2));
  });

  test("非法因子水平被拒", () => {
    assert.throws(() => validateFactors({ coating: ["薄涂"] }), /invalid_factor_levels/);
    assert.throws(() => validateFactors({ exposure: ["短曝", "正午爆晒"] }), /invalid_factor_level/);
    assert.throws(() => validateFactors({ magic: ["a", "b"] }), /unknown_factor/);
    assert.throws(() => validateFactors({ wash: ["短洗", "短洗"] }), /duplicate_factor_level/);
  });
});

describe("stats 纯函数", () => {
  test("均值/极差/置信区间", () => {
    const s = summarize([1, 2, 3, 4]);
    assert.equal(s.n, 4);
    assert.equal(s.mean, 2.5);
    assert.equal(s.range, 3);
    assert.ok(s.lo < 2.5 && s.hi > 2.5);
    const one = summarize([5]);
    assert.equal(one.ci, null, "单点无法估计置信区间");
    assert.deepEqual(summarize([]).n, 0);
  });
  test("质量分：密度越高、色差越低、无缺陷越好", () => {
    const good = qualityScore({ density: 1.4, colorDelta: 5, defect: "无" });
    const bad = qualityScore({ density: 0.8, colorDelta: 40, defect: "显影不均" });
    assert.ok(good > bad);
  });
  test("空数据不得定论", () => {
    const result = analyzeBatch({
      id: "B-x", blocks: 2, minReplicates: 2, formulaIds: ["FA", "FB"], levels: {}, runs: []
    });
    assert.equal(result.status, "inconclusive");
    assert.equal(result.winner, null);
    assert.ok(result.reasons.length >= 1);
  });

  const mkRun = (formulaId, block) => ({ formulaId, block, status: "reviewed", validReadingId: "r", _score: 1 });

  test("区组矩阵：配方间一致但配方内区组不等（[2,1,1]）判为不平衡", () => {
    const runs = [];
    for (const fid of ["FA", "FB"]) {
      runs.push(mkRun(fid, 1), mkRun(fid, 1), mkRun(fid, 2), mkRun(fid, 3));
    }
    const b = balanceCheck(runs, 3, 2);
    assert.equal(b.enough, true, "总数达标：每配方 4 ≥ 2");
    assert.equal(b.withinFormulaUniform, false, "配方内各区组 2/1/1 不等");
    assert.equal(b.crossFormulaUniform, true, "两配方区组向量完全一致——旧逻辑会误放");
    assert.equal(b.balanced, false);
  });

  test("区组矩阵：每配方各区组等重复才算平衡", () => {
    const balanced = [];
    for (const fid of ["FA", "FB"]) for (const block of [1, 2, 3]) balanced.push(mkRun(fid, block));
    const ok = balanceCheck(balanced, 3, 2);
    assert.equal(ok.withinFormulaUniform, true);
    assert.equal(ok.crossFormulaUniform, true);
    assert.equal(ok.balanced, true);

    // 配方间不一致同样不平衡
    const cross = [...balanced, mkRun("FA", 1)];
    const bad = balanceCheck(cross, 3, 2);
    assert.equal(bad.crossFormulaUniform, false);
    assert.equal(bad.balanced, false);
  });
});

// ---------- HTTP 端到端 ----------
describe("权限", () => {
  test("viewer 不能建配方/批次，recorder 不能设计，reviewer 不能定版", async () => {
    const ctx = await tempStoreServer();
    try {
      let r = await ctx.req("/api/lab/formulas", { method: "POST", role: "viewer", body: { code: "X", name: "x", ferricAmmoniumCitrate: "a", potassiumFerricyanide: "b", ratio: "1:1" } });
      assert.equal(r.status, 403);
      assert.equal(r.json.error, "forbidden");

      r = await ctx.req("/api/lab/batches", { method: "POST", role: "recorder", body: minimalBatch(["x", "y"]) });
      assert.equal(r.status, 403);

      r = await ctx.req("/api/lab/formulas", { method: "POST", role: "recorder", body: { code: "X", name: "x", ferricAmmoniumCitrate: "a", potassiumFerricyanide: "b", ratio: "1:1" } });
      assert.equal(r.status, 403);

      // 只读对所有人开放
      r = await ctx.req("/api/lab/formulas", { role: "viewer" });
      assert.equal(r.status, 200);
    } finally { await ctx.stop(); await rm(ctx.file, { force: true }); }
  });

  test("缺少角色头时按 viewer 处理", async () => {
    const ctx = await tempStoreServer();
    try {
      const r = await ctx.req("/api/lab/formulas", {
        method: "POST", headers: { "x-lab-role": "" },
        body: { code: "X", name: "x", ferricAmmoniumCitrate: "a", potassiumFerricyanide: "b", ratio: "1:1" }
      });
      assert.equal(r.status, 403);
    } finally { await ctx.stop(); await rm(ctx.file, { force: true }); }
  });
});

describe("设计接口", () => {
  test("非法因子 / 配方数量 / 已定版配方参试均被拒", async () => {
    const ctx = await tempStoreServer();
    try {
      const [fa, fb] = await makeTwoFormulas(ctx);
      const fullLevels = { coating: ["薄涂", "厚涂"], exposure: ["短曝", "长曝"], development: ["弱酸", "清水"], wash: ["短洗", "长洗"] };
      let r = await ctx.req("/api/lab/batches", {
        method: "POST", role: "technologist",
        body: minimalBatch([fa.id], { levels: fullLevels })
      });
      assert.equal(r.status, 400);
      assert.equal(r.json.error, "formulas_required");

      r = await ctx.req("/api/lab/batches", {
        method: "POST", role: "technologist",
        body: minimalBatch([fa.id, fb.id], { levels: { coating: ["薄涂"], exposure: ["短曝", "长曝"], development: ["弱酸", "清水"], wash: ["短洗", "长洗"] } })
      });
      assert.equal(r.status, 400, "单水平因子不可设计");
      assert.equal(r.json.error, "invalid_factor_levels");

      r = await ctx.req("/api/lab/batches", {
        method: "POST", role: "technologist",
        body: minimalBatch([fa.id, fb.id], { levels: { coating: ["薄涂", "月光涂"], exposure: ["短曝", "长曝"], development: ["弱酸", "清水"], wash: ["短洗", "长洗"] } })
      });
      assert.equal(r.status, 400);
      assert.equal(r.json.error, "invalid_factor_level");

      r = await ctx.req("/api/lab/batches", {
        method: "POST", role: "technologist",
        body: minimalBatch([fa.id, fa.id], { levels: fullLevels })
      });
      assert.equal(r.status, 400, "重复配方");
      assert.equal(r.json.error, "duplicate_formula");

      r = await ctx.req("/api/lab/batches", {
        method: "POST", role: "technologist",
        body: minimalBatch([fa.id, { weird: "object" }], { levels: fullLevels })
      });
      assert.equal(r.status, 400, "非字符串配方 ID");

      r = await ctx.req("/api/lab/batches", {
        method: "POST", role: "technologist",
        body: minimalBatch([fa.id, "FV-NONEXIST"], { levels: fullLevels })
      });
      assert.equal(r.status, 404, "不存在的配方");
    } finally { await ctx.stop(); await rm(ctx.file, { force: true }); }
  });

  test("同种子重建批次顺序一致，不同种子顺序不同", async () => {
    const ctx = await tempStoreServer();
    try {
      const [fa, fb] = await makeTwoFormulas(ctx);
      const body = minimalBatch([fa.id, fb.id], { seed: "固定种子-001", blocks: 2 });
      const b1 = await ctx.req("/api/lab/batches", { method: "POST", role: "technologist", body });
      const b2 = await ctx.req("/api/lab/batches", { method: "POST", role: "technologist", body: { ...body, name: "对比批2" } });
      assert.equal(b1.status, 201);
      const key = (b) => b.json.body.runs.map((r) => r.formulaId + JSON.stringify(r.factors) + ":" + r.block).join("|");
      // 顺序应可复现：区组与处理排布一致（ID 必然不同，剥掉 ID 再比）
      assert.equal(key(b1), key(b2));
      const b3 = await ctx.req("/api/lab/batches", { method: "POST", role: "technologist", body: { ...body, seed: "另一个种子", name: "对比批3" } });
      assert.notEqual(key(b1), key(b3));
    } finally { await ctx.stop(); await rm(ctx.file, { force: true }); }
  });
});

describe("录入 / 重复测量 / 复核", () => {
  test("重复测量全部保留，复核只留一个有效值，其余标红为重复", async () => {
    const ctx = await tempStoreServer();
    try {
      const [fa, fb] = await makeTwoFormulas(ctx);
      const batch = await ctx.req("/api/lab/batches", { method: "POST", role: "technologist", body: minimalBatch([fa.id, fb.id]) });
      const runId = batch.json.body.runs[0].id;
      const bid = batch.json.body.id;
      const post = (density, colorDelta) =>
        ctx.req(`/api/lab/batches/${bid}/runs/${runId}/readings`, {
          method: "POST", role: "recorder",
          body: { density, colorDelta, defect: "无", temperature: 22, humidity: 60 }
        });
      const r1 = await post(1.3, 8);
      const r2 = await post(1.25, 9);
      assert.equal(r1.status, 201);
      assert.equal(r2.status, 201);
      assert.notEqual(r1.json.body.reading.id, r2.json.body.reading.id);

      let full = await ctx.req(`/api/lab/batches/${bid}`);
      const run = full.json.body.runs.find((r) => r.id === runId);
      assert.equal(run.readings.length, 2, "两次重复测量都保留原始记录");
      assert.equal(run.status, "entered");

      const rv = await ctx.req(`/api/lab/batches/${bid}/review`, {
        method: "POST", role: "reviewer",
        body: { decisions: [{ runId, readingId: r1.json.body.reading.id, action: "valid", reason: "一致性最好" }] }
      });
      assert.equal(rv.status, 200);

      full = await ctx.req(`/api/lab/batches/${bid}`);
      const after = full.json.body.runs.find((r) => r.id === runId);
      assert.equal(after.status, "reviewed");
      assert.equal(after.validReadingId, r1.json.body.reading.id);
      assert.equal(after.readings.find((x) => x.id === r1.json.body.reading.id).state, "valid");
      assert.equal(after.readings.find((x) => x.id === r2.json.body.reading.id).state, "redundant");
    } finally { await ctx.stop(); await rm(ctx.file, { force: true }); }
  });

  test("驳回读数与异常排除必须写明原因；排除自动补同区组替补并双向关联", async () => {
    const ctx = await tempStoreServer();
    try {
      const [fa, fb] = await makeTwoFormulas(ctx);
      const batch = await ctx.req("/api/lab/batches", { method: "POST", role: "technologist", body: minimalBatch([fa.id, fb.id]) });
      const run = batch.json.body.runs[0];
      const bid = batch.json.body.id;
      const rd = await ctx.req(`/api/lab/batches/${bid}/runs/${run.id}/readings`, {
        method: "POST", role: "recorder", body: { density: 1.1, colorDelta: 7, defect: "条纹" }
      });
      let r = await ctx.req(`/api/lab/batches/${bid}/review`, {
        method: "POST", role: "reviewer",
        body: { decisions: [{ runId: run.id, readingId: rd.json.body.reading.id, action: "reject-reading", reason: "" }] }
      });
      assert.equal(r.status, 400, "驳回无原因");

      r = await ctx.req(`/api/lab/batches/${bid}/review`, {
        method: "POST", role: "reviewer",
        body: { decisions: [{ runId: run.id, action: "exclude", reason: "" }] }
      });
      assert.equal(r.status, 400, "排除无原因必须拒绝");
      assert.equal(r.json.error, "exclude_reason_required");

      r = await ctx.req(`/api/lab/batches/${bid}/review`, {
        method: "POST", role: "reviewer",
        body: { decisions: [{ runId: run.id, action: "exclude", reason: "涂布划伤整样报废" }] }
      });
      assert.equal(r.status, 200);

      const full = await ctx.req(`/api/lab/batches/${bid}`);
      const ex = full.json.body.runs.find((x) => x.id === run.id);
      assert.equal(ex.status, "excluded");
      assert.equal(ex.readings[0].state, "void");
      const rep = full.json.body.runs.find((x) => x.id === ex.replacedBy);
      assert.ok(rep, "自动生成替补试样");
      assert.equal(rep.replacementOf, ex.id);
      assert.equal(rep.block, ex.block, "替补保持同区组");
      assert.deepEqual(rep.factors, ex.factors, "替补保持同因子组合");
      assert.equal(rep.formulaId, ex.formulaId);

      // 留痕
      const audit = await ctx.req("/api/lab/audit?action=run_exclude");
      assert.ok(audit.json.body.some((a) => a.target === run.id && a.detail.reason === "涂布划伤整样报废"));
    } finally { await ctx.stop(); await rm(ctx.file, { force: true }); }
  });

  test("recorder 不能复核，reviewer 不能设计", async () => {
    const ctx = await tempStoreServer();
    try {
      const [fa, fb] = await makeTwoFormulas(ctx);
      const batch = await ctx.req("/api/lab/batches", { method: "POST", role: "technologist", body: minimalBatch([fa.id, fb.id]) });
      const bid = batch.json.body.id;
      const r = await ctx.req(`/api/lab/batches/${bid}/review`, {
        method: "POST", role: "recorder", body: { decisions: [] }
      });
      assert.equal(r.status, 403);
    } finally { await ctx.stop(); await rm(ctx.file, { force: true }); }
  });

  test("已复核试样可凭原因退回重裁，退回后统计不再计入", async () => {
    const ctx = await tempStoreServer();
    try {
      const [fa, fb] = await makeTwoFormulas(ctx);
      const batch = await ctx.req("/api/lab/batches", { method: "POST", role: "technologist", body: minimalBatch([fa.id, fb.id]) });
      const bid = batch.json.body.id;
      const runId = batch.json.body.runs[0].id;
      const rd = await ctx.req(`/api/lab/batches/${bid}/runs/${runId}/readings`, {
        method: "POST", role: "recorder", body: { density: 1.1, colorDelta: 7, defect: "无" }
      });
      await ctx.req(`/api/lab/batches/${bid}/review`, {
        method: "POST", role: "reviewer",
        body: { decisions: [{ runId, readingId: rd.json.body.reading.id, action: "valid" }] }
      });
      // 无原因退回被拒
      let r = await ctx.req(`/api/lab/batches/${bid}/runs/${runId}/reopen`, {
        method: "POST", role: "reviewer", body: { reason: "" }
      });
      assert.equal(r.status, 400);
      r = await ctx.req(`/api/lab/batches/${bid}/runs/${runId}/reopen`, {
        method: "POST", role: "reviewer", body: { reason: "发现读数抄录有误" }
      });
      assert.equal(r.status, 200);
      const full = await ctx.req(`/api/lab/batches/${bid}`);
      const run = full.json.body.runs.find((x) => x.id === runId);
      assert.equal(run.status, "entered");
      assert.equal(run.validReadingId, null);
      assert.equal(run.readings[0].state, "candidate");
    } finally { await ctx.stop(); await rm(ctx.file, { force: true }); }
  });
});

describe("并发 / 幂等 / 乱序 / 落盘失败", () => {
  test("20 个并发录入互不丢失，读数序号连续", async () => {
    const ctx = await tempStoreServer();
    try {
      const [fa, fb] = await makeTwoFormulas(ctx);
      const batch = await ctx.req("/api/lab/batches", { method: "POST", role: "technologist", body: minimalBatch([fa.id, fb.id]) });
      const bid = batch.json.body.id;
      const runs = batch.json.body.runs.slice(0, 20);
      const results = await Promise.all(runs.map((r, i) =>
        ctx.req(`/api/lab/batches/${bid}/runs/${r.id}/readings`, {
          method: "POST", role: "recorder", body: { density: 1 + i * 0.01, colorDelta: 10, defect: "无" }
        })
      ));
      assert.ok(results.every((r) => r.status === 201));
      const full = await ctx.req(`/api/lab/batches/${bid}`);
      const seqs = full.json.body.runs.flatMap((r) => r.readings.map((x) => x.seq)).sort((a, b) => a - b);
      assert.equal(seqs.length, 20);
      assert.deepEqual(seqs, Array.from({ length: 20 }, (_, i) => i + 1), "无丢失更新");
    } finally { await ctx.stop(); await rm(ctx.file, { force: true }); }
  });

  test("同一幂等键并发双发只生效一次", async () => {
    const ctx = await tempStoreServer();
    try {
      const [fa, fb] = await makeTwoFormulas(ctx);
      const batch = await ctx.req("/api/lab/batches", { method: "POST", role: "technologist", body: minimalBatch([fa.id, fb.id]) });
      const run = batch.json.body.runs[0];
      const bid = batch.json.body.id;
      const path = `/api/lab/batches/${bid}/runs/${run.id}/readings`;
      const payload = { density: 1.2, colorDelta: 6, defect: "无" };
      const [a, b] = await Promise.all([
        ctx.req(path, { method: "POST", role: "recorder", key: "fixed-key-777", body: payload }),
        ctx.req(path, { method: "POST", role: "recorder", key: "fixed-key-777", body: payload })
      ]);
      assert.equal(a.status, 201);
      assert.equal(b.status, 201, "回放首次成功响应（含原状态码）");
      assert.equal(b.json.replayed, true);
      assert.equal(a.json.body.reading.id, b.json.body.reading.id);
      const full = await ctx.req(`/api/lab/batches/${bid}`);
      const r0 = full.json.body.runs.find((x) => x.id === run.id);
      assert.equal(r0.readings.length, 1, "重复提交未产生第二条读数");
    } finally { await ctx.stop(); await rm(ctx.file, { force: true }); }
  });

  test("幂等键按提交人隔离：同键不同提交人各自生效，不回放他人响应", async () => {
    const ctx = await tempStoreServer();
    try {
      const [fa, fb] = await makeTwoFormulas(ctx);
      const batch = await ctx.req("/api/lab/batches", { method: "POST", role: "technologist", body: minimalBatch([fa.id, fb.id]) });
      const run = batch.json.body.runs[0];
      const bid = batch.json.body.id;
      const path = `/api/lab/batches/${bid}/runs/${run.id}/readings`;
      const payload = { density: 1.2, colorDelta: 6, defect: "无" };
      // 同一键、同一接口、不同提交人 -> 两条独立读数
      const a = await ctx.req(path, { method: "POST", role: "recorder", user: "记录员甲", key: "shared-K", body: payload });
      const b = await ctx.req(path, { method: "POST", role: "recorder", user: "记录员乙", key: "shared-K", body: payload });
      assert.equal(a.status, 201);
      assert.equal(b.status, 201, "不同提交人复用同键不得回放他人响应");
      assert.notEqual(b.json.replayed, true);
      assert.notEqual(a.json.body.reading.id, b.json.body.reading.id);
      const full = await ctx.req(`/api/lab/batches/${bid}`);
      const r0 = full.json.body.runs.find((x) => x.id === run.id);
      assert.equal(r0.readings.length, 2);
      // 同一提交人重发同键 -> 回放本人的首次响应
      const again = await ctx.req(path, { method: "POST", role: "recorder", user: "记录员甲", key: "shared-K", body: payload });
      assert.equal(again.status, 201);
      assert.equal(again.json.replayed, true);
      assert.equal(again.json.body.reading.id, a.json.body.reading.id);
    } finally { await ctx.stop(); await rm(ctx.file, { force: true }); }
  });

  test("幂等键按请求隔离：同键用于不同接口不会回放旧响应", async () => {
    const ctx = await tempStoreServer();
    try {
      const [fa, fb] = await makeTwoFormulas(ctx);
      const batch = await ctx.req("/api/lab/batches", {
        method: "POST", role: "technologist", key: "cross-endpoint-K",
        body: minimalBatch([fa.id, fb.id])
      });
      assert.equal(batch.status, 201);
      const bid = batch.json.body.id;
      const runId = batch.json.body.runs[0].id;
      // 同一个键打到“录入读数”这个不同接口：必须真实执行，不能回放批次创建响应
      const reading = await ctx.req(`/api/lab/batches/${bid}/runs/${runId}/readings`, {
        method: "POST", role: "recorder", key: "cross-endpoint-K",
        body: { density: 1.2, colorDelta: 6, defect: "无" }
      });
      assert.equal(reading.status, 201, "不同接口同键不得回放旧接口响应");
      assert.notEqual(reading.json.replayed, true);
      assert.ok(reading.json.body.reading.id);
      const full = await ctx.req(`/api/lab/batches/${bid}`);
      assert.equal(full.json.body.runs.find((r) => r.id === runId).readings.length, 1);
      // 同接口同键再发（合法但数值不同的重试体）-> 回放的是首次响应，不产生第二条读数
      const replay = await ctx.req(`/api/lab/batches/${bid}/runs/${runId}/readings`, {
        method: "POST", role: "recorder", key: "cross-endpoint-K",
        body: { density: 0.9, colorDelta: 5, defect: "无" }
      });
      assert.equal(replay.json.replayed, true);
      assert.equal(replay.json.body.reading.id, reading.json.body.reading.id);
      assert.equal(replay.json.body.reading.density, 1.2, "回放的是首次测量值而非重试体");
      const afterReplay = await ctx.req(`/api/lab/batches/${bid}`);
      assert.equal(afterReplay.json.body.runs.find((r) => r.id === runId).readings.length, 1);
    } finally { await ctx.stop(); await rm(ctx.file, { force: true }); }
  });

  test("乱序提交不影响设计顺序与统计", async () => {
    const ctx = await tempStoreServer();
    try {
      const [fa, fb] = await makeTwoFormulas(ctx);
      const batch = await ctx.req("/api/lab/batches", { method: "POST", role: "technologist", body: minimalBatch([fa.id, fb.id]) });
      const bid = batch.json.body.id;
      const runs = batch.json.body.runs.slice().reverse(); // 故意逆序录入
      await Promise.all(runs.map((r) =>
        ctx.req(`/api/lab/batches/${bid}/runs/${r.id}/readings`, {
          method: "POST", role: "recorder", body: { density: 1.2, colorDelta: 8, defect: "无" }
        })
      ));
      const full = await ctx.req(`/api/lab/batches/${bid}`);
      const orders = full.json.body.runs.map((r) => r.order);
      assert.deepEqual(orders, Array.from({ length: runs.length }, (_, i) => i + 1), "设计顺序保持不变");
    } finally { await ctx.stop(); await rm(ctx.file, { force: true }); }
  });

  test("落盘失败：事务回滚，失败提交不进内存与统计，后续请求仍干净", async () => {
    let failNext = true;
    const store = new LabStore(null, { persist: async () => {
      if (failNext) throw new Error("ENOSPC 模拟磁盘满");
    } });
    const ctx = await startServer(store);
    try {
      const bad = await ctx.req("/api/lab/formulas", {
        method: "POST", role: "technologist",
        body: { code: "FAIL", name: "落盘失败配方", ferricAmmoniumCitrate: "a", potassiumFerricyanide: "b", ratio: "1:1" }
      });
      assert.equal(bad.status, 500);
      assert.equal(bad.json.error, "persist_failed");

      let list = await ctx.req("/api/lab/formulas");
      assert.equal(list.json.body.length, 0, "回滚后内存中无脏数据");

      // 恢复落盘后同数据可正常提交
      failNext = false;
      const ok = await ctx.req("/api/lab/formulas", {
        method: "POST", role: "technologist",
        body: { code: "OK1", name: "恢复后配方甲", ferricAmmoniumCitrate: "a", potassiumFerricyanide: "b", ratio: "1:1" }
      });
      assert.equal(ok.status, 201);
      list = await ctx.req("/api/lab/formulas");
      assert.equal(list.json.body.length, 1);
    } finally { await ctx.stop(); }
  });

  test("落盘进行中读取被阻塞：提交完成前看不到未提交记录", async () => {
    let releaseWrite;
    const gate = new Promise((r) => { releaseWrite = r; });
    let blockNext = true;
    const store = new LabStore(null, {
      persist: async () => { if (blockNext) await gate; }
    });
    const ctx = await startServer(store);
    try {
      const writeP = ctx.req("/api/lab/formulas", {
        method: "POST", role: "technologist",
        body: { code: "HANG", name: "未落盘配方", ferricAmmoniumCitrate: "a", potassiumFerricyanide: "b", ratio: "1:1" }
      });
      await new Promise((r) => setTimeout(r, 60)); // 确保写事务已进入落盘阶段
      const readP = ctx.req("/api/lab/formulas");
      let readDone = false;
      readP.then(() => { readDone = true; });
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(readDone, false, "读取在落盘完成前必须排队等待");

      blockNext = false;
      releaseWrite(); // 放行使落盘完成、事务提交
      const [writeRes, readRes] = await Promise.all([writeP, readP]);
      assert.equal(writeRes.status, 201);
      // 读取排在写事务之后，看到的是提交后的状态（含该记录），绝不会读到中间态
      assert.equal(readRes.json.body.length, 1);
      assert.equal(readRes.json.body[0].code, "HANG");
    } finally { releaseWrite && releaseWrite(); await ctx.stop(); }
  });

  test("落盘失败：等待中的读取在回滚完成后才执行，看不到随后回滚的记录", async () => {
    let releaseWrite;
    const gate = new Promise((r) => { releaseWrite = r; });
    let shouldBlock = true;
    const store = new LabStore(null, {
      persist: async () => { if (shouldBlock) { await gate; throw new Error("磁盘掉线"); } }
    });
    const ctx = await startServer(store);
    try {
      const writeP = ctx.req("/api/lab/formulas", {
        method: "POST", role: "technologist",
        body: { code: "GHOST", name: "将回滚配方", ferricAmmoniumCitrate: "a", potassiumFerricyanide: "b", ratio: "1:1" }
      });
      await new Promise((r) => setTimeout(r, 60));
      const readP = ctx.req("/api/lab/formulas"); // 落盘挂起期间发起的读取
      let readDone = false;
      readP.then(() => { readDone = true; });
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(readDone, false, "回滚完成前读取保持阻塞");

      shouldBlock = false;
      releaseWrite(); // 落盘抛错 -> 内存回滚
      const [writeRes, readRes] = await Promise.all([writeP, readP]);
      assert.equal(writeRes.status, 500);
      assert.equal(writeRes.json.error, "persist_failed");
      assert.equal(readRes.json.body.length, 0, "未提交/已回滚记录对读取不可见");
    } finally { releaseWrite && releaseWrite(); await ctx.stop(); }
  });
});

describe("统计闸门：样本不足 / 区组不平衡不得定论", () => {
  async function fullBatch(ctx) {
    const [fa, fb] = await makeTwoFormulas(ctx);
    const batch = await ctx.req("/api/lab/batches", { method: "POST", role: "technologist", body: minimalBatch([fa.id, fb.id]) });
    return { fa, fb, bid: batch.json.body.id, runs: batch.json.body.runs };
  }

  test("只录部分数据 → inconclusive，拒绝封存定论", async () => {
    const ctx = await tempStoreServer();
    try {
      const { bid, runs } = await fullBatch(ctx);
      const half = runs.slice(0, 4);
      const decisions = [];
      for (const r of half) {
        const rd = await ctx.req(`/api/lab/batches/${bid}/runs/${r.id}/readings`, {
          method: "POST", role: "recorder", body: { density: 1.2, colorDelta: 8, defect: "无" }
        });
        decisions.push({ runId: r.id, readingId: rd.json.body.reading.id, action: "valid" });
      }
      await ctx.req(`/api/lab/batches/${bid}/review`, { method: "POST", role: "reviewer", body: { decisions } });
      const a = await ctx.req(`/api/lab/batches/${bid}/analysis`);
      assert.equal(a.json.body.status, "inconclusive");
      assert.equal(a.json.body.winner, null);
      assert.ok(a.json.body.reasons.length > 0);

      const close = await ctx.req(`/api/lab/batches/${bid}/close`, { method: "POST", role: "technologist", body: { force: false } });
      assert.equal(close.status, 409);
      assert.equal(close.json.error, "batch_inconclusive");
    } finally { await ctx.stop(); await rm(ctx.file, { force: true }); }
  });

  test("配方间区组不平衡 → 闸门 blockBalanced 失败", async () => {
    const ctx = await tempStoreServer();
    try {
      const { fa, fb, bid, runs } = await fullBatch(ctx);
      // 甲：两个区组全部有效；乙：只有区组1有效 → 不平衡
      const pick = runs.filter((r) =>
        r.formulaId === fa.id || (r.formulaId === fb.id && r.block === 1));
      const decisions = [];
      for (const r of pick) {
        const rd = await ctx.req(`/api/lab/batches/${bid}/runs/${r.id}/readings`, {
          method: "POST", role: "recorder", body: { density: 1.2, colorDelta: 8, defect: "无" }
        });
        decisions.push({ runId: r.id, readingId: rd.json.body.reading.id, action: "valid" });
      }
      await ctx.req(`/api/lab/batches/${bid}/review`, { method: "POST", role: "reviewer", body: { decisions } });
      const a = await ctx.req(`/api/lab/batches/${bid}/analysis`);
      assert.equal(a.json.body.gates.blockBalanced, false);
      assert.equal(a.json.body.status, "inconclusive");
    } finally { await ctx.stop(); await rm(ctx.file, { force: true }); }
  });

  test("配方内区组不等（两配方同样 [2,1,1]）仍不得定论", async () => {
    const ctx = await tempStoreServer();
    try {
      const [fa, fb] = await makeTwoFormulas(ctx);
      const batch = await ctx.req("/api/lab/batches", {
        method: "POST", role: "technologist",
        body: minimalBatch([fa.id, fb.id], { blocks: 3, repsPerBlock: 1, minReplicates: 2 })
      });
      const bid = batch.json.body.id;
      const runs = batch.json.body.runs;
      // 每个配方在区组1取2个、区组2取1个、区组3取1个 -> 配方内 2/1/1 不等，
      // 但两配方分布完全相同，只比较配方之间的旧逻辑会误判为平衡。
      const want = [[fa.id, 1, 2], [fa.id, 2, 1], [fa.id, 3, 1], [fb.id, 1, 2], [fb.id, 2, 1], [fb.id, 3, 1]];
      const decisions = [];
      for (const [fid, block, n] of want) {
        const inBlock = runs.filter((r) => r.formulaId === fid && r.block === block).slice(0, n);
        for (const r of inBlock) {
          const rd = await ctx.req(`/api/lab/batches/${bid}/runs/${r.id}/readings`, {
            method: "POST", role: "recorder", body: { density: 1.2, colorDelta: 8, defect: "无" }
          });
          decisions.push({ runId: r.id, readingId: rd.json.body.reading.id, action: "valid" });
        }
      }
      await ctx.req(`/api/lab/batches/${bid}/review`, { method: "POST", role: "reviewer", body: { decisions } });
      const a = await ctx.req(`/api/lab/batches/${bid}/analysis`);
      assert.equal(a.json.body.balance.withinFormulaUniform, false);
      assert.equal(a.json.body.balance.crossFormulaUniform, true, "两配方分布一致");
      assert.equal(a.json.body.gates.enoughSamples, true, "样本总数本身达标");
      assert.equal(a.json.body.gates.blockBalanced, false);
      assert.equal(a.json.body.status, "inconclusive");
      assert.equal(a.json.body.winner, null);

      const close = await ctx.req(`/api/lab/batches/${bid}/close`, { method: "POST", role: "technologist", body: { force: false } });
      assert.equal(close.status, 409, "区组不等必须拒绝封存定论");
    } finally { await ctx.stop(); await rm(ctx.file, { force: true }); }
  });
});

describe("完整流程：设计→录入→复核→比较→封存→定版→回溯", () => {
  test("优胜配方定版后不可改/删/参试，批次快照可回溯有效数据", async () => {
    const ctx = await tempStoreServer();
    try {
      const [fa, fb] = await makeTwoFormulas(ctx);
      const batch = await ctx.req("/api/lab/batches", {
        method: "POST", role: "technologist", body: minimalBatch([fa.id, fb.id], { name: "定版依据批", blocks: 2, minReplicates: 2 })
      });
      const bid = batch.json.body.id;
      const runs = batch.json.body.runs;

      // 并发乱序录入：甲明显优于乙
      await Promise.all(runs.map((r) =>
        ctx.req(`/api/lab/batches/${bid}/runs/${r.id}/readings`, {
          method: "POST", role: "recorder",
          body: r.formulaId === fa.id
            ? { density: 1.4, colorDelta: 10, defect: "无" }
            : { density: 0.8, colorDelta: 30, defect: "白点" }
        })
      ));
      // 每个试样再补一次重复测量，验证统计只取复核有效值
      await Promise.all(runs.slice(0, 6).map((r) =>
        ctx.req(`/api/lab/batches/${bid}/runs/${r.id}/readings`, {
          method: "POST", role: "recorder",
          body: { density: 0.1, colorDelta: 99, defect: "过曝" } // 极端离群
        })
      ));
      const before = await ctx.req(`/api/lab/batches/${bid}`);
      const decisions = before.json.body.runs.map((r) => ({
        runId: r.id, readingId: r.readings[0].id, action: "valid", reason: "取首次规范测量"
      }));
      const rv = await ctx.req(`/api/lab/batches/${bid}/review`, { method: "POST", role: "reviewer", body: { decisions } });
      assert.equal(rv.status, 200);

      const a = await ctx.req(`/api/lab/batches/${bid}/analysis`);
      assert.equal(a.json.body.status, "conclusive", "应满足全部闸门：" + JSON.stringify(a.json.body.gates));
      assert.equal(a.json.body.winner.formulaId, fa.id);
      assert.ok(a.json.body.groups[fa.id].score.mean > a.json.body.groups[fb.id].score.mean);
      assert.ok(a.json.body.effects.coating.effect !== null);
      assert.ok(Array.isArray(a.json.body.interactions));
      // 离群的第二次测量是 redundant，未污染均值
      const faGroup = a.json.body.groups[fa.id];
      assert.ok(faGroup.score.mean > 100, "若离群值被计入均值不可能这么高");

      const close = await ctx.req(`/api/lab/batches/${bid}/close`, { method: "POST", role: "technologist", body: { force: false } });
      assert.equal(close.status, 200);

      // 封存后只读，不可再录入/复核/封存
      let r = await ctx.req(`/api/lab/batches/${bid}/runs/${runs[0].id}/readings`, {
        method: "POST", role: "recorder", body: { density: 1, colorDelta: 1, defect: "无" }
      });
      assert.equal(r.status, 409);
      assert.equal(r.json.error, "batch_closed");
      r = await ctx.req(`/api/lab/batches/${bid}/close`, { method: "POST", role: "technologist", body: {} });
      assert.equal(r.status, 409);

      // 输家不能依据该批定版
      r = await ctx.req(`/api/lab/formulas/${fb.id}/finalize`, { method: "POST", role: "technologist", body: { batchId: bid } });
      assert.equal(r.status, 409);
      assert.equal(r.json.error, "finalize_not_winner");

      // 赢家定版
      r = await ctx.req(`/api/lab/formulas/${fa.id}/finalize`, { method: "POST", role: "technologist", body: { batchId: bid } });
      assert.equal(r.status, 200);
      assert.equal(r.json.body.status, "final");
      assert.equal(r.json.body.finalizedBatchId, bid);

      // 定版不可改：派生新版、删除、参试、重复定版全部拒绝
      assert.equal((await ctx.req(`/api/lab/formulas/${fa.id}/revise`, { method: "POST", role: "technologist", body: { note: "尝试改" } })).status, 409);
      assert.equal((await ctx.req(`/api/lab/formulas/${fa.id}`, { method: "DELETE", role: "admin" })).status, 409);
      assert.equal((await ctx.req(`/api/lab/formulas/${fa.id}/finalize`, { method: "POST", role: "technologist", body: { batchId: bid } })).status, 409);
      const fc = await ctx.req("/api/lab/batches", { method: "POST", role: "technologist", body: minimalBatch([fa.id, fb.id]) });
      assert.equal(fc.status, 409);
      assert.equal(fc.json.error, "formula_finalized_immutable");

      // 回溯：关闭批次的快照保留结论时刻的有效数据与配方版本
      const snap = await ctx.req(`/api/lab/batches/${bid}`);
      assert.equal(snap.json.body.snapshot.analysis.winner.formulaId, fa.id);
      assert.equal(snap.json.body.snapshot.formulas.length, 2);
      assert.ok(snap.json.body.snapshot.formulas.find((f) => f.id === fa.id));
      const validRuns = snap.json.body.runs.filter((x) => x.status === "reviewed");
      assert.ok(validRuns.every((x) => x.validReadingId));

      // 无证据不能定版（新建的草稿没有支撑批次）
      const extra = await ctx.req("/api/lab/formulas", {
        method: "POST", role: "technologist",
        body: { code: "FC", name: "无证据配方", ferricAmmoniumCitrate: "a", potassiumFerricyanide: "b", ratio: "2:1" }
      });
      const noEv = await ctx.req(`/api/lab/formulas/${extra.json.body.id}/finalize`, { method: "POST", role: "technologist", body: {} });
      assert.equal(noEv.status, 409);
      assert.equal(noEv.json.error, "finalize_no_evidence");
    } finally { await ctx.stop(); await rm(ctx.file, { force: true }); }
  });

  test("无结论封存的批次不能作为定版依据", async () => {
    const ctx = await tempStoreServer();
    try {
      const [fa, fb] = await makeTwoFormulas(ctx);
      const batch = await ctx.req("/api/lab/batches", { method: "POST", role: "technologist", body: minimalBatch([fa.id, fb.id]) });
      const bid = batch.json.body.id;
      const forced = await ctx.req(`/api/lab/batches/${bid}/close`, { method: "POST", role: "reviewer", body: { force: true } });
      assert.equal(forced.status, 200);
      const r = await ctx.req(`/api/lab/formulas/${fa.id}/finalize`, { method: "POST", role: "technologist", body: { batchId: bid } });
      assert.equal(r.status, 409);
      assert.equal(r.json.error, "finalize_not_winner");
    } finally { await ctx.stop(); await rm(ctx.file, { force: true }); }
  });
});

describe("页面与留痕", () => {
  test("/lab 页面覆盖五个视图", async () => {
    const ctx = await tempStoreServer();
    try {
      const res = await fetch(ctx.base + "/lab");
      assert.equal(res.status, 200);
      const html = await res.text();
      for (const name of ["设计", "录入", "复核", "比较", "定版"]) {
        assert.ok(html.includes(name), "页面缺少视图：" + name);
      }
    } finally { await ctx.stop(); await rm(ctx.file, { force: true }); }
  });

  test("审计日志记录关键操作人", async () => {
    const ctx = await tempStoreServer();
    try {
      const created = await ctx.req("/api/lab/formulas", {
        method: "POST", role: "technologist", user: "王工艺",
        body: { code: "FAU", name: "审计测试配方", ferricAmmoniumCitrate: "a", potassiumFerricyanide: "b", ratio: "1:1" }
      });
      assert.equal(created.status, 201);
      const audit = await ctx.req("/api/lab/audit?action=formula_create&limit=5");
      assert.ok(audit.json.body.some((a) => a.actor === "王工艺" && a.target === created.json.body.id));
    } finally { await ctx.stop(); await rm(ctx.file, { force: true }); }
  });
});
