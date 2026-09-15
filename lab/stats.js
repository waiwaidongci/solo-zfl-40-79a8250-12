// 质量评估与统计：组均值 / 极差 / 置信区间、主效应、二阶交互、
// 优胜方案筛选。样本不足或区组不平衡一律 inconclusive，不得定论。

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

export function analyzeBatch(batch) {
  const factorKeys = Object.keys(batch.levels);
  const valid = validRunsOf(batch).map((r) => {
    const reading = r.readings.find((x) => x.id === r.validReadingId) || null;
    return { ...r, _score: reading ? reading.score : 0, _reading: reading };
  });

  const balance = balanceCheck(valid, batch.blocks, batch.minReplicates);
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

  const effects = mainEffects(valid, factorKeys);
  const inter = interactions(valid, factorKeys);
  const pooledRange = (() => {
    const s = valid.map((r) => r._score);
    return s.length ? Math.max(...s) - Math.min(...s) : 0;
  })();
  const strongInteractions = inter
    .filter((ix) => {
      const [a, b] = ix.factors;
      const ea = effects[a]?.effect || 0, eb = effects[b]?.effect || 0;
      const smaller = Math.min(ea, eb);
      return smaller > 0 && Math.abs(ix.did) >= 0.5 * smaller && Math.abs(ix.did) >= 0.05 * pooledRange;
    })
    .map((ix) => ix.factors.join("×"));

  // 结论闸门：任何一条不过都不得定论
  const gates = {
    enoughSamples: balance.enough,
    blockBalanced: balance.balanced,
    noMissingCells: balance.missing.length === 0,
    everyFormulaPresent: batch.formulaIds.every((fid) => (balance.counts[fid] || 0) > 0)
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

  const recommendedSetting = Object.fromEntries(factorKeys.map((k) => [k, effects[k]?.bestLevel ?? null]));

  return {
    batchId: batch.id,
    status: conclusive ? "conclusive" : "inconclusive",
    gates,
    reasons: [
      !gates.enoughSamples && `有效样本不足：每配方至少 ${batch.minReplicates} 次`,
      !gates.blockBalanced && "区组不平衡：各配方在各区组的有效试样数不一致",
      !gates.noMissingCells && "存在空缺的配方×区组格子",
      !gates.everyFormulaPresent && "有配方尚无任何有效试样"
    ].filter(Boolean),
    balance,
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
