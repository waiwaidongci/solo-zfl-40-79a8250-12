// 试验设计：涂布 / 曝光 / 显影 / 水洗 四因子，全因子组合 × 随机区组（RCBD）。
// 每个区组内部用可复现的种子伪随机洗牌——区组间系统漂移只进区组效应，
// 处理（配方×因子组合）绝不与区组或先后次序混杂。
import { HttpError } from "./store.js";

export const FACTORS = [
  { key: "coating", name: "涂布", levels: ["薄涂", "厚涂"] },
  { key: "exposure", name: "曝光", levels: ["短曝", "长曝"] },
  { key: "development", name: "显影", levels: ["弱酸", "清水"] },
  { key: "wash", name: "水洗", levels: ["短洗", "长洗"] }
];
export const FACTOR_MAP = Object.fromEntries(FACTORS.map((f) => [f.key, f]));
export const DEFECT_CODES = ["无", "条纹", "白点", "过曝", "显影不均", "脱色"];

// mulberry32：确定性 PRNG，同种子必得同一试验顺序，便于复核与测试
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function cartesian(levelLists) {
  return levelLists.reduce(
    (acc, levels) => acc.flatMap((combo) => levels.map((lvl) => [...combo, lvl])),
    [[]]
  );
}

// 校验调用方提交的因子覆盖集：键必须是四因子之一，每个水平必须来自该因子的合法水平，
// 且每个因子至少保留 2 个水平，否则主效应无法估计。
export function validateFactors(factors) {
  if (!factors || typeof factors !== "object" || Array.isArray(factors)) {
    throw new HttpError(400, "invalid_factors", { reason: "因子必须是对象" });
  }
  const out = {};
  for (const f of FACTORS) {
    const raw = factors[f.key];
    if (raw === undefined) {
      out[f.key] = f.levels.slice();
      continue;
    }
    if (!Array.isArray(raw) || raw.length < 2) {
      throw new HttpError(400, "invalid_factor_levels", {
        factor: f.key,
        reason: `${f.name}至少需要 2 个合法水平`
      });
    }
    const bad = raw.find((l) => !f.levels.includes(l));
    if (bad) {
      throw new HttpError(400, "invalid_factor_level", { factor: f.key, level: String(bad), allowed: f.levels });
    }
    if (new Set(raw).size !== raw.length) {
      throw new HttpError(400, "duplicate_factor_level", { factor: f.key });
    }
    out[f.key] = raw.slice();
  }
  const extra = Object.keys(factors).filter((k) => !FACTOR_MAP[k]);
  if (extra.length) throw new HttpError(400, "unknown_factor", { keys: extra });
  return out;
}

// 生成全部处理组合（配方 × 因子组合）
export function buildTreatments(formulaIds, levels) {
  const combos = cartesian(FACTORS.map((f) => levels[f.key]));
  const out = [];
  for (const fid of formulaIds) {
    for (const combo of combos) {
      const setting = {};
      FACTORS.forEach((f, i) => (setting[f.key] = combo[i]));
      out.push({ formulaId: fid, factors: setting });
    }
  }
  return out;
}

// 生成随机区组运行表。返回 { runs, levels, combosPerFormula }
export function designRuns({ formulaIds, levels, blocks, repsPerBlock, seed, makeId }) {
  const treatments = buildTreatments(formulaIds, levels);
  if (treatments.length > 81) {
    throw new HttpError(400, "design_too_large", { combos: treatments.length, max: 81 });
  }
  const rng = makeRng(seed);
  const runs = [];
  let order = 1;
  for (let b = 0; b < blocks; b++) {
    for (let r = 0; r < repsPerBlock; r++) {
      // 关键：在每个区组内部独立洗牌 -> 处理与顺序/区组正交，不混杂
      for (const t of shuffle(treatments, rng)) {
        runs.push({
          id: makeId("RUN"),
          formulaId: t.formulaId,
          block: b + 1,
          rep: r + 1,
          order: order++, // 设计顺序（全局唯一）
          factors: { ...t.factors },
          status: "pending", // pending -> entered -> reviewed -> valid | excluded
          readings: [],
          validReadingId: null,
          excludedAt: null,
          excludedBy: null,
          excludeReason: null,
          replacedBy: null,
          replacementOf: null
        });
      }
    }
  }
  return { runs, combosPerFormula: treatments.length / formulaIds.length };
}

// 为被排除的试样在同区组同配方同因子组合下补一个新试样（保持平衡）
export function replacementRun({ run, blocks, makeId, order }) {
  return {
    id: makeId("RUN"),
    formulaId: run.formulaId,
    block: run.block,
    rep: run.rep,
    order,
    factors: { ...run.factors },
    status: "pending",
    readings: [],
    validReadingId: null,
    excludedAt: null,
    excludedBy: null,
    excludeReason: null,
    replacedBy: null,
    replacementOf: run.id
  };
}
