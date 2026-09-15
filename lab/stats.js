// 质量评估与统计：组均值 / 极差 / 置信区间、主效应、二阶交互、
// 优胜方案筛选。样本不足、区组不平衡、因子/交互覆盖不完整、处理重复数不一致
// 一律 inconclusive，不得定论。
import { cartesian, FACTORS } from "./design.js";

// 学生 t 双侧 95% 临界值（df 1..30），df>30 用正态近似
const T95 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086,
  2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042
];
export function t95(df) {
  if (df <= 0) return null;
  return df <= 30 ? T95[df - 1] : 1.96;
}

export const DEFECT_PENALTY = {
  无: 0, 白点: 3, 条纹: 6, 脱色: 8, 过曝: 10, 显影不均: 12
};

export function qualityScore({ density, colorDelta, defect }) {
  const penalty = DEFECT_PENALTY[defect] ?? 6;
  // 高密度蓝、低色差、无缺陷为佳：0~100 量纲
  return Math.round((density * 100 - colorDelta - penalty) * 100) / 100;
}

export function summarize(values) {
  const n = values.length;
  if (!n) return { n: 0, mean: null, min: null, max: null, range: null, sd: null, se: null, ci: null, lo: null, hi: null };
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const variance = n > 1 ? values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  const se = n > 1 ? sd / Math.sqrt(n) : null;
  const tc = t95(n - 1);
  const ci = tc === null || se === null ? null : tc * se;
  return {
    n, mean: r4(mean), min: r4(min), max: r4(max), range: r4(max - min),
    sd: r4(sd), se: r4(se), ci: ci === null ? null : r4(ci),
    lo: ci === null ? r4(mean) : r4(mean - ci), hi: ci === null ? r4(mean) : r4(mean + ci)
  };
}
const r4 = (x) => Math.round(x * 10000) / 10000;

export function validRunsOf(batch) {
  return batch.runs.filter((r) => r.status === "reviewed" && r.validReadingId);
}

export function activeRunsOf(batch) {
  // 未排除、未定版关闭前仍占着设计格子的试样
  return batch.runs.filter((r) => r.status !== "excluded");
}

// 主效应：每个因子各水平的平均质量分（先在配方内平均，再等权跨配方，避免失衡加权）
export function mainEffects(validRuns, factorKeys) {
  const formulas = [...new Set(validRuns.map((r) => r.formulaId))];
  const out = {};
  for (const key of factorKeys) {
    const levels = [...new Set(validRuns.map((r) => r.factors[key]))];
    const perLevel = {};
    for (const lvl of levels) {
      const perFormula = formulas
        .map((fid) => {
          const vs = validRuns.filter((r) => r.formulaId === fid && r.factors[key] === lvl);
          return vs.length ? vs.reduce((s, r) => s + r._score, 0) / vs.length : null;
        })
        .filter((v) => v !== null);
      perLevel[lvl] = perFormula.length ? perFormula.reduce((s, v) => s + v, 0) / perFormula.length : null;
    }
    const present = Object.entries(perLevel).filter(([, v]) => v !== null);
    const means = Object.fromEntries(present.map(([k, v]) => [k, r4(v)]));
    const vals = present.map(([, v]) => v);
    out[key] = {
      means,
      effect: vals.length > 1 ? r4(Math.max(...vals) - Math.min(...vals)) : null,
      bestLevel: vals.length ? present.reduce((a, b) => (b[1] > a[1] ? b : a))[0] : null
    };
  }
  return out;
}

// 二阶交互（仅当该批因子恰为两水平）：差之差 DID = (ab-aB)-(Ab-AB)
export function interactions(validRuns, factorKeys) {
  const formulas = [...new Set(validRuns.map((r) => r.formulaId))];
  const out = [];
  for (let i = 0; i < factorKeys.length; i++) {
    for (let j = i + 1; j < factorKeys.length; j++) {
      const a = factorKeys[i], b = factorKeys[j];
      const perFormula = formulas.map((fid) => {
        const cell = {};
        for (const run of validRuns.filter((r) => r.formulaId === fid)) {
          const k = `${run.factors[a]}|${run.factors[b]}`;
          (cell[k] ||= []).push(run._score);
        }
        const keys = Object.keys(cell);
        if (keys.length !== 4) return null;
        const m = Object.fromEntries(keys.map((k) => [k, cell[k].reduce((s, v) => s + v, 0) / cell[k].length]));
        const [la, lb] = [keys.map((k) => k.split("|")[0]), keys.map((k) => k.split("|")[1])];
        const a1 = [...new Set(la)], b1 = [...new Set(lb)];
        if (a1.length !== 2 || b1.length !== 2) return null;
        return (m[`${a1[1]}|${b1[1]}`] - m[`${a1[1]}|${b1[0]}`]) -
               (m[`${a1[0]}|${b1[1]}`] - m[`${a1[0]}|${b1[0]}`]);
      }).filter((v) => v !== null);
      if (!perFormula.length) continue;
      const did = perFormula.reduce((s, v) => s + v, 0) / perFormula.length;
      out.push({ factors: [a, b], did: r4(did), estimatedFromFormulas: perFormula.length });
    }
  }
  return out;
}

// 区组平衡矩阵：每个配方在每个区组的有效试样数必须一致；
// 且每配方有效样本数达到最小重复要求。
export function balanceCheck(validRuns, blocks, minReplicates) {
  const formulas = [...new Set(validRuns.map((r) => r.formulaId))].sort();
  const matrix = {};
  for (const fid of formulas) {
    matrix[fid] = Array.from({ length: blocks }, (_, b) =>
      validRuns.filter((r) => r.formulaId === fid && r.block === b + 1).length);
  }
  const counts = formulas.map((fid) => matrix[fid].reduce((s, v) => s + v, 0));
  const enough = counts.every((n) => n >= minReplicates);
  const missing = [];
  // 严格区组平衡，两条都必须成立：
  //  1) 配方内：同一配方在每个区组的有效试样数相等（区组等重复）——
  //     只比配方之间的总数无法发现 [3,1] 与 [2,2] 这类区内失衡；
  //  2) 配方间：每个区组各配方的有效试样数一致（区组×配方格子对齐）。
  let withinFormulaUniform = counts.length > 0;
  for (const fid of formulas) {
    const first = matrix[fid][0];
    for (let b = 0; b < blocks; b++) {
      if (matrix[fid][b] === 0) missing.push({ formulaId: fid, block: b + 1 });
      if (b > 0 && matrix[fid][b] !== first) withinFormulaUniform = false;
    }
  }
  const ref = matrix[formulas[0]] || [];
  let crossFormulaUniform = counts.length > 0 && counts.every((c) => c === counts[0]);
  if (crossFormulaUniform) {
    for (const fid of formulas) {
      for (let b = 0; b < blocks; b++) {
        if (matrix[fid][b] !== ref[b]) { crossFormulaUniform = false; }
      }
    }
  }
  const balanced = withinFormulaUniform && crossFormulaUniform;
  return {
    matrix,
    counts: Object.fromEntries(formulas.map((f, i) => [f, counts[i]])),
    enough, balanced, withinFormulaUniform, crossFormulaUniform, missing
  };
}

// 覆盖度（RCBD：随机化与外推都在区组内成立，效应必须在“每个配方 × 每个区组”内可估）：
//   主效应——每个配方在每个区组中，每个因子的全部设计水平都至少有一条有效观测；
//   二阶交互——每个配方在每个区组中，每对因子的全部 l1×l2 单元都有有效观测。
// 只在跨区组汇总后才“凑齐”某水平/单元（如短洗全在区组1、长洗全在区组2）属于因子与区组
// 混杂，判为覆盖不完整，不得据此给结论、效应值或建议水平。
export function coverageCheck(validRuns, factorKeys, levels, formulas, blocks) {
  const blockNums = [];
  for (let b = 1; b <= blocks; b++) blockNums.push(b);
  // 若调用方未给区组数，按数据中实际出现的区组兜底（单元测试直调时使用）
  if (!blockNums.length) {
    for (const r of validRuns) if (!blockNums.includes(r.block)) blockNums.push(r.block);
  }

  const missingMain = [];
  for (const fid of formulas) {
    for (const block of blockNums) {
      const rows = validRuns.filter((r) => r.formulaId === fid && r.block === block);
      for (const key of factorKeys) {
        const present = new Set(rows.map((r) => r.factors[key]));
        const missingLevels = (levels[key] || []).filter((lvl) => !present.has(lvl));
        if (missingLevels.length) missingMain.push({ formulaId: fid, block, factor: key, missingLevels });
      }
    }
  }

  const pairs = [];
  const missingInteractions = [];
  for (let i = 0; i < factorKeys.length; i++) {
    for (let j = i + 1; j < factorKeys.length; j++) {
      const a = factorKeys[i], b = factorKeys[j];
      pairs.push([a, b]);
      for (const fid of formulas) {
        for (const block of blockNums) {
          const rows = validRuns.filter((r) => r.formulaId === fid && r.block === block);
          const cells = new Set(rows.map((r) => `${r.factors[a]}␟${r.factors[b]}`));
          const missingCells = [];
          for (const la of levels[a] || []) {
            for (const lb of levels[b] || []) {
              if (!cells.has(`${la}␟${lb}`)) missingCells.push([la, lb]);
            }
          }
          if (missingCells.length) {
            missingInteractions.push({ formulaId: fid, block, factors: [a, b], missingCells });
          }
        }
      }
    }
  }
  return {
    mainEffectsEstimable: missingMain.length === 0,
    interactionsEstimable: missingInteractions.length === 0,
    missingMain, missingInteractions, pairs
  };
}

// 处理重复数一致性（RCBD 均衡重复）：在“每个配方 × 每个区组”内，
// 设计表中的每一个处理组合都必须有相同条数的有效观测。
// 即使所有组合都出现（覆盖完整），若有的组合 1 次、有的组合 2 次，简单均值会把结果
// 隐式拉向重复较多的组合；此时效应值/优胜/建议都不能成立。
export function replicationCheck(validRuns, factorKeys, levels, formulas, blocks) {
  // 组合签名严格按因子定义顺序，避免 levels 键序不同造成误判
  const orderedKeys = FACTORS.map((f) => f.key).filter((k) => factorKeys.includes(k));
  const levelLists = orderedKeys.map((k) => levels[k] || []);
  const designed = cartesian(levelLists).map((combo) =>
    orderedKeys.map((k, i) => combo[i]).join("␟"));

  const blockNums = [];
  for (let b = 1; b <= blocks; b++) blockNums.push(b);
  if (!blockNums.length) {
    for (const r of validRuns) if (!blockNums.includes(r.block)) blockNums.push(r.block);
  }
  const sigOf = (r) => orderedKeys.map((k) => r.factors[k]).join("␟");

  const matrix = {}; // formulaId -> [ {block, counts:Map, uniform} ]
  const uneven = [];
  for (const fid of formulas) {
    matrix[fid] = [];
    for (const block of blockNums) {
      const counts = new Map(designed.map((s) => [s, 0]));
      for (const r of validRuns) {
        if (r.formulaId !== fid || r.block !== block) continue;
        const s = sigOf(r);
        if (counts.has(s)) counts.set(s, counts.get(s) + 1);
      }
      const n = [...counts.values()];
      const min = n.length ? Math.min(...n) : 0;
      const max = n.length ? Math.max(...n) : 0;
      const present = n.filter((x) => x > 0);
      const uniform = present.length === designed.length && present.every((x) => x === present[0]);
      matrix[fid].push({ block, counts: Object.fromEntries(counts), min, max, uniform });
      if (!uniform) {
        uneven.push({
          formulaId: fid, block, min, max,
          overRepresented: [...counts.entries()].filter(([, c]) => c === max && max > min).map(([s]) => s),
          underRepresented: [...counts.entries()].filter(([, c]) => c === min).map(([s]) => s)
        });
      }
    }
  }
  return { uniform: uneven.length === 0, matrix, uneven };
}

export function analyzeBatch(batch) {
  const factorKeys = Object.keys(batch.levels);
  const valid = validRunsOf(batch).map((r) => {
    const reading = r.readings.find((x) => x.id === r.validReadingId) || null;
    return { ...r, _score: reading ? reading.score : 0, _reading: reading };
  });

  const balance = balanceCheck(valid, batch.blocks, batch.minReplicates);
  // 因子水平 / 交互单元覆盖：在“每个配方 × 每个区组”内核对，防止水平与区组混杂
  const coverage = coverageCheck(valid, factorKeys, batch.levels, batch.formulaIds, batch.blocks);
  // 处理重复数一致：同一配方同一区组内各设计组合的有效条数必须相等
  const replication = replicationCheck(valid, factorKeys, batch.levels, batch.formulaIds, batch.blocks);
  const pendingCount = activeRunsOf(batch).filter((r) => r.status !== "reviewed").length;
  const exclusions = batch.runs.filter((r) => r.status === "excluded").length;

  const groups = {};
  for (const fid of batch.formulaIds) {
    const rows = valid.filter((r) => r.formulaId === fid);
    groups[fid] = {
      score: summarize(rows.map((r) => r._score)),
      density: summarize(rows.map((r) => r._reading.density)),
      colorDelta: summarize(rows.map((r) => r._reading.colorDelta)),
      defectRate: rows.length
        ? r4(rows.filter((r) => r._reading.defect !== "无").length / rows.length)
        : null
    };
  }

  // 覆盖不完整、或处理重复数不等时，效应会受到加权影响：不输出会误导的数值
  const effectsEstimable = coverage.mainEffectsEstimable && replication.uniform;
  const interEstimable = coverage.interactionsEstimable && replication.uniform;
  const effects = effectsEstimable ? mainEffects(valid, factorKeys) : null;
  const inter = interEstimable ? interactions(valid, factorKeys) : [];
  const pooledRange = (() => {
    const s = valid.map((r) => r._score);
    return s.length ? Math.max(...s) - Math.min(...s) : 0;
  })();
  const strongInteractions = interEstimable
    ? inter
        .filter((ix) => {
          const [a, b] = ix.factors;
          const ea = effects[a]?.effect || 0, eb = effects[b]?.effect || 0;
          const smaller = Math.min(ea, eb);
          return smaller > 0 && Math.abs(ix.did) >= 0.5 * smaller && Math.abs(ix.did) >= 0.05 * pooledRange;
        })
        .map((ix) => ix.factors.join("×"))
    : [];

  // 结论闸门：任何一条不过都不得定论
  const gates = {
    enoughSamples: balance.enough,
    blockBalanced: balance.balanced,
    noMissingCells: balance.missing.length === 0,
    everyFormulaPresent: batch.formulaIds.every((fid) => (balance.counts[fid] || 0) > 0),
    mainEffectsCovered: coverage.mainEffectsEstimable,
    interactionsCovered: coverage.interactionsEstimable,
    equalReplication: replication.uniform
  };
  const conclusive = Object.values(gates).every(Boolean);

  const ranking = batch.formulaIds
    .map((fid) => ({ formulaId: fid, n: groups[fid].score.n, mean: groups[fid].score.mean, ci: groups[fid].score.ci, colorDelta: groups[fid].colorDelta.mean }))
    .filter((x) => x.n > 0)
    .sort((a, b) => (b.mean - a.mean) || (a.colorDelta - b.colorDelta));

  let winner = null, ciOverlap = null;
  if (ranking.length) {
    winner = ranking[0];
    if (ranking.length > 1) {
      const wg = groups[winner.formulaId].score;
      ciOverlap = ranking.slice(1).map((x) => {
        const og = groups[x.formulaId].score;
        return {
          formulaId: x.formulaId,
          overlap: !(wg.lo > og.hi || og.lo > wg.hi),
          gap: r4(winner.mean - x.mean)
        };
      });
    } else {
      ciOverlap = [];
    }
  }

  // 建议水平只在可定论（含全部覆盖闸门）时给出；覆盖不完整一律 null
  const recommendedSetting = conclusive
    ? Object.fromEntries(factorKeys.map((k) => [k, effects[k]?.bestLevel ?? null]))
    : null;

  return {
    batchId: batch.id,
    status: conclusive ? "conclusive" : "inconclusive",
    gates,
    reasons: [
      !gates.enoughSamples && `有效样本不足：每配方至少 ${batch.minReplicates} 次`,
      !gates.blockBalanced && "区组不平衡：同一配方在各区组的有效试样数不等，或配方间区组分布不一致",
      !gates.noMissingCells && "存在空缺的配方×区组格子",
      !gates.everyFormulaPresent && "有配方尚无任何有效试样",
      !gates.mainEffectsCovered && "区组内因子水平覆盖不完整：某配方在某区组缺少某因子的设计水平，水平与区组混杂，主效应无法成立",
      !gates.interactionsCovered && "区组内交互单元覆盖不完整：某配方在某区组缺少因子对的交互单元，交互无法成立",
      !gates.equalReplication && "处理重复数不一致：同一配方同一区组中各设计组合的有效条数不等，简单均值被重复较多的组合加权，效应无法成立"
    ].filter(Boolean),
    balance,
    coverage,
    replication,
    groups,
    ranking,
    winner: conclusive ? winner : null,
    ciOverlap,
    effects,
    interactions: inter,
    strongInteractions,
    recommendedSetting: conclusive ? recommendedSetting : null,
    pendingCount,
    exclusions,
    validCount: valid.length,
    runCount: batch.runs.length
  };
}
