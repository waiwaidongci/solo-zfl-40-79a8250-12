// 配方试验与质量评估台页面：设计 / 录入 / 复核 / 比较 / 定版 五个视图
export function labPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>蓝晒工作室 · 配方试验与质量评估台</title>
<style>
:root { --bg:#eef1ea; --panel:#fff; --ink:#1f241d; --muted:#687066; --line:#d3dccf; --accent:#3f6b4f; --accent2:#32506b; --warn:#9b4937; --ok:#3f7a4f; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
header { padding:18px 26px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:14px; align-items:center; flex-wrap:wrap; }
h1 { margin:0; font-size:22px; } h2 { margin:0 0 12px; font-size:16px; } h3 { margin:0 0 8px; font-size:14px; }
.meta { color:var(--muted); font-size:13px; }
nav.tabs { display:flex; gap:6px; padding:12px 26px 0; flex-wrap:wrap; }
nav.tabs button { border:1px solid var(--line); border-bottom:0; background:#e4e9e0; color:var(--muted); padding:9px 16px; border-radius:8px 8px 0 0; cursor:pointer; font-weight:700; }
nav.tabs button.active { background:#fff; color:var(--accent); }
main { padding:18px 26px 40px; }
.view { display:none; } .view.active { display:block; }
.panel,.card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; margin-bottom:14px; }
.grid2 { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
.grid3 { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; }
label { display:block; margin:9px 0 4px; color:var(--muted); font-size:12px; }
input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; background:#fff; }
button.act { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 14px; font-weight:700; cursor:pointer; }
button.blue { background:var(--accent2); } button.gray { background:#69736a; } button.danger { background:var(--warn); }
button:disabled { opacity:.45; cursor:not-allowed; }
.row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:10px; }
.pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:12px; margin:2px 4px 2px 0; }
.pill.final { background:#e6f0e8; color:var(--ok); border-color:#b9d4bf; }
.pill.draft { background:#f2efe4; color:#7a6a2f; }
.pill.bad { background:#f7e7e3; color:var(--warn); border-color:#e2bdb3; }
table { width:100%; border-collapse:collapse; font-size:13px; }
th,td { border-bottom:1px solid var(--line); padding:7px 8px; text-align:left; vertical-align:top; }
th { color:var(--muted); font-weight:700; }
.gate-ok { color:var(--ok); font-weight:700; } .gate-bad { color:var(--warn); font-weight:700; }
.toast { position:fixed; right:18px; bottom:18px; max-width:420px; display:none; background:#26302a; color:#fff; padding:12px 16px; border-radius:8px; font-size:13px; z-index:99; white-space:pre-wrap; }
.toast.err { background:#6e342b; }
.small { font-size:12px; } .mono { font-family:Menlo,Consolas,monospace; }
details { margin-top:8px; } summary { cursor:pointer; color:var(--muted); font-size:13px; }
@media (max-width:900px){ .grid2{grid-template-columns:1fr} main,header,nav.tabs{padding-left:14px;padding-right:14px} }
</style>
</head>
<body>
<header>
  <div>
    <h1>配方试验与质量评估台</h1>
    <div class="meta">配方版本 · 随机区组试验 · 复核留痕 · 组均值/极差/置信区间 · 定版不可改</div>
  </div>
  <div class="row">
    <a class="pill" href="/">← 底片整理室</a>
    <label style="margin:0">当前角色
      <select id="role" style="width:auto">
        <option value="viewer">viewer 观察员（只读）</option>
        <option value="recorder">recorder 记录员（录入）</option>
        <option value="reviewer">reviewer 复核员（复核/封存）</option>
        <option value="technologist" selected>technologist 工艺师（设计/定版）</option>
        <option value="admin">admin 管理员（全部）</option>
      </select>
    </label>
    <label style="margin:0">署名 <input id="actor" style="width:130px" placeholder="操作人"></label>
    <button class="act gray" id="reload">刷新</button>
  </div>
</header>
<nav class="tabs">
  <button data-tab="design" class="active">① 设计</button>
  <button data-tab="entry">② 录入</button>
  <button data-tab="review">③ 复核</button>
  <button data-tab="compare">④ 比较</button>
  <button data-tab="finalize">⑤ 定版</button>
</nav>
<main>
  <!-- ① 设计 -->
  <section class="view active" id="view-design">
    <div class="grid2">
      <div class="panel">
        <h2>建立配方版本</h2>
        <form id="formulaForm">
          <div class="row"><input name="code" placeholder="配方编号，如 F-2026-01" required style="flex:1"><input name="name" placeholder="名称，如 经典双液 1:1" required style="flex:1"></div>
          <label>柠檬酸铁铵</label><input name="ferricAmmoniumCitrate" placeholder="如 20% 溶液" required>
          <label>铁氰化钾</label><input name="potassiumFerricyanide" placeholder="如 16% 溶液" required>
          <label>配比</label><input name="ratio" placeholder="如 A:B = 1:1" required>
          <label>备注</label><textarea name="note"></textarea>
          <div class="row"><button class="act">创建配方版本（草稿）</button></div>
        </form>
      </div>
      <div class="panel">
        <h2>生成随机区组批次</h2>
        <form id="batchForm">
          <label>批次名称</label><input name="name" placeholder="如 九月中旬气候对比" required>
          <div class="row">
            <div style="flex:1"><label>区组数（天/批次）</label><input name="blocks" type="number" value="3" min="1" max="20"></div>
            <div style="flex:1"><label>每区组重复</label><input name="repsPerBlock" type="number" value="1" min="1" max="5"></div>
            <div style="flex:1"><label>最小有效样本/配方</label><input name="minReplicates" type="number" value="2" min="1"></div>
          </div>
          <label>比较配方（至少 2 个，已定版不可再参试）</label>
          <div id="formulaPick"></div>
          <details><summary>因子水平（默认四因子两水平；非法水平会被拒绝）</summary><div id="factorPick"></div></details>
          <label>随机种子（留空自动生成，同种子可复现顺序）</label><input name="seed" placeholder="可选">
          <div class="row"><button class="act blue">生成不混杂试验顺序</button></div>
        </form>
      </div>
    </div>
    <div class="panel"><h2>配方版本</h2><div id="formulaList" class="grid3"></div></div>
    <div class="panel"><h2>批次</h2><div id="batchList"></div></div>
  </section>

  <!-- ② 录入 -->
  <section class="view" id="view-entry">
    <div class="panel">
      <h2>试样结果录入（支持并发、乱序提交、同试样重复测量）</h2>
      <div class="row">
        <select id="entryBatch" style="flex:1"></select>
      </div>
      <div class="grid2">
        <div>
          <label>按设计顺序选择试样（可乱序录入）</label>
          <select id="entryRun" size="10"></select>
          <div id="entryRunInfo" class="meta small" style="margin-top:6px"></div>
        </div>
        <div>
          <form id="readingForm">
            <div class="row">
              <div style="flex:1"><label>密度 D（0–3）</label><input name="density" type="number" step="0.01" min="0" max="3" required></div>
              <div style="flex:1"><label>色差 ΔE（0–100）</label><input name="colorDelta" type="number" step="0.1" min="0" max="100" required></div>
            </div>
            <label>缺陷</label><select name="defect" id="defectSelect"></select>
            <div class="row">
              <div style="flex:1"><label>温度 ℃（可选）</label><input name="temperature" type="number" step="0.1"></div>
              <div style="flex:1"><label>湿度 %（可选）</label><input name="humidity" type="number" step="1"></div>
            </div>
            <label>条件备注</label><input name="note" placeholder="光照、纸张、操作等">
            <div class="row"><button class="act">提交测量（自动算质量分）</button><span class="meta small">重复测量全部保留，由复核员裁决有效值</span></div>
          </form>
          <div id="entryProgress" class="meta small" style="margin-top:8px"></div>
        </div>
      </div>
    </div>
    <div class="panel"><h2>待录入 / 已录入试样</h2><div id="entryTable"></div></div>
  </section>

  <!-- ③ 复核 -->
  <section class="view" id="view-review">
    <div class="panel">
      <h2>复核：重复测量只留一个有效值，异常排除必须写明原因并留痕</h2>
      <div class="row"><select id="reviewBatch" style="flex:1"></select></div>
      <div id="reviewList"></div>
    </div>
  </section>

  <!-- ④ 比较 -->
  <section class="view" id="view-compare">
    <div class="panel">
      <h2>比较配方：组均值 / 极差 / 95% 置信区间 / 主效应与交互</h2>
      <div class="row"><select id="compareBatch" style="flex:1"></select><button class="act blue" id="compareBtn">重新计算</button></div>
      <div id="compareResult"></div>
    </div>
  </section>

  <!-- ⑤ 定版 -->
  <section class="view" id="view-finalize">
    <div class="panel">
      <h2>封存批次与配方定版（封存后不可再录入；定版后配方不可改、不可删）</h2>
      <div class="row"><select id="finalBatch" style="flex:1"></select>
        <button class="act" id="closeBatch">封存批次（结论性）</button>
        <button class="act gray" id="closeForce">无结论封存</button>
      </div>
      <div id="finalResult" class="meta small" style="margin-top:8px"></div>
    </div>
    <div class="panel"><h2>配方定版</h2><div id="finalizeList" class="grid3"></div></div>
    <div class="panel"><h2>留痕（最近 60 条）</h2><div id="auditList"></div></div>
  </section>
</main>
<div class="toast" id="toast"></div>
<script>
"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
let STATE = { factors: [], defectCodes: [], formulas: [], batches: [], currentBatchId: null };

function toast(msg, isErr) {
  const t = $("#toast"); t.textContent = msg; t.className = "toast" + (isErr ? " err" : ""); t.style.display = "block";
  clearTimeout(t._h); t._h = setTimeout(() => (t.style.display = "none"), 3800);
}
async function api(path, opts = {}) {
  const headers = Object.assign({ "Content-Type": "application/json",
    "x-lab-role": $("#role").value, "x-lab-user": encodeURIComponent($("#actor").value.trim() || "未署名") }, opts.headers || {});
  let res, data;
  try { res = await fetch(path, { ...opts, headers }); data = await res.json(); }
  catch (e) { throw new Error("网络或落盘失败：" + e.message); }
  if (!res.ok) {
    const err = new Error(data.error + (data.details ? " " + JSON.stringify(data.details) : ""));
    err.status = res.status; err.body = data; throw err;
  }
  if (data.replayed) toast("重复提交：已返回首次结果（幂等），未重复写入");
  return data.body !== undefined ? data.body : data;
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fPill = (f) => '<span class="pill ' + (f.status === "final" ? "final" : "draft") + '">' +
  (f.status === "final" ? "已定版" : "草稿") + "</span>";

$$("nav.tabs button").forEach((b) => b.onclick = () => {
  $$("nav.tabs button").forEach((x) => x.classList.toggle("active", x === b));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + b.dataset.tab));
});

async function refresh() {
  const st = await api("/api/lab/state");
  STATE.factors = st.factors; STATE.defectCodes = st.defectCodes;
  STATE.formulas = await api("/api/lab/formulas");
  STATE.batches = await api("/api/lab/batches");
  renderDesign(); renderEntry(); renderReviewSelectors(); renderCompareSelectors(); renderFinalize();
}

/* ---------- ① 设计 ---------- */
function renderDesign() {
  $("#factorPick").innerHTML = STATE.factors.map((f) =>
    '<label>' + f.name + '（' + f.key + '）</label><div class="row">' +
    f.levels.map((l) => '<label class="small" style="margin:0"><input type="checkbox" name="f_' + f.key + '" value="' + esc(l) + '" checked> ' + esc(l) + '</label>').join("") +
    '</div>').join("");
  $("#defectSelect").innerHTML = STATE.defectCodes.map((d) => "<option>" + esc(d) + "</option>").join("");
  $("#formulaPick").innerHTML = STATE.formulas.length ? STATE.formulas.map((f) =>
    '<label class="small" style="margin:0"><input type="checkbox" name="formula" value="' + esc(f.id) + '"' +
    (f.status === "final" ? " disabled" : "") + '> ' + esc(f.code) + " " + esc(f.name) + " " + fPill(f) + "</label>").join(" ")
    : '<span class="meta">先在左侧创建至少两个配方</span>';
  $("#formulaList").innerHTML = STATE.formulas.map((f) =>
    '<div class="card"><h3>' + esc(f.code) + " · " + esc(f.name) + " " + fPill(f) + '</h3>' +
    '<div class="meta small">v' + f.version + (f.parentId ? "（派生自 " + esc(f.parentId) + "）" : "") + "</div>" +
    '<div class="small">柠檬酸铁铵 ' + esc(f.ferricAmmoniumCitrate) + "<br>铁氰化钾 " + esc(f.potassiumFerricyanide) + "<br>配比 " + esc(f.ratio) + "</div>" +
    (f.finalizedBatchId ? '<div class="meta small">定版依据批次 ' + esc(f.finalizedBatchId) + "</div>" : "") +
    '<div class="row"><button class="act gray small" data-revise="' + esc(f.id) + '"' + (f.status === "final" ? " disabled" : "") + ">派生新版</button>" +
    '<button class="act danger small" data-del="' + esc(f.id) + '"' + (f.status === "final" ? " disabled" : "") + ">删除草稿</button></div></div>").join("") ||
    '<span class="meta">尚无配方</span>';
  $$("[data-revise]").forEach((b) => b.onclick = async () => {
    const note = prompt("新版调整说明（将作为备注，留空则沿用全部成分）") || "";
    const r = await api("/api/lab/formulas/" + b.dataset.revise + "/revise", { method: "POST", body: JSON.stringify({ note: note || "派生新版" }) });
    toast("已创建 " + r.code); refresh();
  });
  $$("[data-del]").forEach((b) => b.onclick = async () => {
    if (!confirm("确认删除该草稿？")) return;
    await api("/api/lab/formulas/" + b.dataset.del, { method: "DELETE" });
    toast("已删除"); refresh();
  });
  $("#batchList").innerHTML = STATE.batches.length ? "<table><tr><th>批次</th><th>配方</th><th>设计</th><th>进度</th><th>状态</th><th>种子</th></tr>" +
    STATE.batches.map((b) => "<tr><td>" + esc(b.id) + "<br><span class='meta small'>" + esc(b.name) + "</span></td>" +
      "<td>" + b.formulaIds.map((id) => { const f = STATE.formulas.find((x) => x.id === id); return esc(f ? f.code : id); }).join("<br>") + "</td>" +
      "<td>" + b.blocks + " 区组 × " + b.repsPerBlock + " 重复<br><span class='meta small'>每配方 " + b.combosPerFormula + " 个处理组合，共 " + b.runCount + " 试样</span></td>" +
      "<td>有效 " + b.validCount + " / 已录 " + b.enteredCount + " / 排除 " + b.excludedCount + "</td>" +
      "<td><span class='pill " + (b.closed ? "final" : "") + "'>" + (b.closed ? "已封存" : b.status) + "</span></td>" +
      "<td class='mono small'>" + esc(String(b.seed)) + "</td></tr>").join("") + "</table>"
    : '<span class="meta">尚无批次</span>';
}

$("#formulaForm").onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api("/api/lab/formulas", { method: "POST", body: JSON.stringify(Object.fromEntries(fd.entries())) });
    e.target.reset(); toast("配方版本已创建"); refresh();
  } catch (err) { toast(err.message, true); }
};
$("#batchForm").onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const formulaIds = $$("input[name=formula]:checked").map((x) => x.value);
  const levels = {};
  for (const f of STATE.factors) levels[f.key] = $$('input[name=f_' + f.key + ']:checked').map((x) => x.value);
  try {
    const b = await api("/api/lab/batches", { method: "POST", body: JSON.stringify({
      name: fd.get("name"), blocks: Number(fd.get("blocks")), repsPerBlock: Number(fd.get("repsPerBlock")),
      minReplicates: Number(fd.get("minReplicates")), seed: fd.get("seed"), formulaIds, levels
    }) });
    toast("已生成 " + b.runs.length + " 个试样，顺序已在区组内随机化（不混杂）");
    STATE.currentBatchId = b.id; e.target.reset(); refresh();
  } catch (err) { toast(err.message, true); }
};

/* ---------- ② 录入 ---------- */
function entryBatches() { return STATE.batches.filter((b) => !b.closed); }
function renderEntrySelectors() {
  const list = entryBatches();
  const cur = list.find((b) => b.id === STATE.currentBatchId) || list[0];
  STATE.currentBatchId = cur ? cur.id : null;
  ["entryBatch"].forEach((id) => {
    const sel = $("#" + id);
    sel.innerHTML = list.map((b) => "<option value='" + b.id + "'" + (b.id === STATE.currentBatchId ? " selected" : "") + ">" +
      b.id + " · " + esc(b.name) + "（有效 " + b.validCount + "/" + b.runCount + "）</option>").join("");
  });
}
async function entryBatchFull() {
  if (!STATE.currentBatchId) return null;
  return api("/api/lab/batches/" + STATE.currentBatchId);
}
async function renderEntry() {
  renderEntrySelectors();
  const b = await entryBatchFull();
  const runSel = $("#entryRun");
  if (!b) { runSel.innerHTML = ""; $("#entryTable").innerHTML = '<span class="meta">没有可录入的开放批次（请先设计或批次已封存）</span>'; $("#entryProgress").textContent = ""; $("#entryRunInfo").textContent = ""; return; }
  const factorName = (k) => (STATE.factors.find((f) => f.key === k) || {}).name || k;
  runSel.innerHTML = b.runs.filter((r) => r.status !== "excluded").map((r) => {
    const f = STATE.formulas.find((x) => x.id === r.formulaId);
    const tag = { pending: "待录入", entered: "已录入·待复核", reviewed: "已复核有效" }[r.status];
    return "<option value='" + r.id + "'>#" + r.order + " 区组" + r.block + " · " + esc(f ? f.code : r.formulaId) +
      " · " + Object.entries(r.factors).map(([k, v]) => factorName(k) + ":" + esc(v)).join("/") + " [" + tag + "]</option>";
  }).join("");
  const drawInfo = () => {
    const r = b.runs.find((x) => x.id === runSel.value);
    if (!r) return;
    $("#entryRunInfo").innerHTML = "试样 " + r.id + "，状态：" + r.status +
      (r.replacementOf ? "（替补 " + esc(r.replacementOf) + "）" : "") +
      "<br>已有测量 " + r.readings.length + " 次：" + r.readings.map((rd) =>
        esc(rd.id) + " D=" + rd.density + " ΔE=" + rd.colorDelta + " " + esc(rd.defect) +
        " [" + ({ candidate: "待裁决", valid: "有效值", redundant: "重复", rejected: "已驳回", void: "作废" }[rd.state]) + "]").join("；");
  };
  runSel.onchange = drawInfo; drawInfo();
  const active = b.runs.filter((r) => r.status !== "excluded");
  $("#entryProgress").textContent = "进度：有效 " + active.filter((r) => r.status === "reviewed").length +
    " / 已录 " + active.filter((r) => r.status !== "pending").length + " / 在册 " + active.length +
    "；排除 " + b.runs.filter((r) => r.status === "excluded").length;
  $("#entryTable").innerHTML = entryTable(b);
}
function entryTable(b) {
  const factorName = (k) => (STATE.factors.find((f) => f.key === k) || {}).name || k;
  const active = b.runs.filter((r) => r.status !== "excluded");
  return "<table><tr><th>顺序</th><th>区组</th><th>配方</th><th>因子组合</th><th>状态</th><th>测量</th></tr>" +
    active.map((r) => {
      const f = STATE.formulas.find((x) => x.id === r.formulaId);
      return "<tr><td>" + r.order + "</td><td>" + r.block + (r.rep > 1 ? "·" + r.rep : "") + "</td><td>" + esc(f ? f.code : r.formulaId) + "</td>" +
        "<td class='small'>" + Object.entries(r.factors).map(([k, v]) => esc(v)).join("/") + "<span class='meta'>（" + Object.keys(r.factors).map(factorName).join("/") + "）</span></td>" +
        "<td><span class='pill " + (r.status === "reviewed" ? "final" : r.status === "entered" ? "draft" : "") + "'>" +
        ({ pending: "待录入", entered: "待复核", reviewed: "有效" }[r.status]) + "</span>" +
        (r.replacementOf ? "<br><span class='meta small'>替补 " + esc(r.replacementOf) + "</span>" : "") + "</td>" +
        "<td class='small'>" + (r.readings.length ? r.readings.map((rd) => esc(rd.id) + " D=" + rd.density + " ΔE=" + rd.colorDelta + " " + esc(rd.defect)).join("<br>") : "—") + "</td></tr>";
    }).join("") + "</table>";
}
$("#entryBatch").onchange = (e) => { STATE.currentBatchId = e.target.value; renderEntry(); };
$("#readingForm").onsubmit = async (e) => {
  e.preventDefault();
  const runId = $("#entryRun").value;
  if (!runId) return toast("请选择试样", true);
  const fd = new FormData(e.target);
  const payload = Object.fromEntries(fd.entries());
  // 并发/重试安全：同一次提交带稳定幂等键；重新点提交视为新测量（允许重复测量）
  const idem = "read-" + runId + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
  try {
    await fetch("/api/lab/batches/" + STATE.currentBatchId + "/runs/" + runId + "/readings", {
      method: "POST", headers: { "Content-Type": "application/json", "x-lab-role": $("#role").value,
        "x-lab-user": encodeURIComponent($("#actor").value.trim() || "未署名"), "Idempotency-Key": idem },
      body: JSON.stringify(payload)
    }).then(async (res) => { const d = await res.json(); if (!res.ok) throw new Error(d.error + " " + JSON.stringify(d.details || {})); return d; });
    toast("测量已记录（原始数据保留，待复核）"); e.target.reset(); refresh();
  } catch (err) { toast(err.message, true); }
};

/* ---------- ③ 复核 ---------- */
function renderReviewSelectors() {
  const list = STATE.batches.filter((b) => !b.closed);
  const cur = list.find((b) => b.id === $("#reviewBatch").value) || list[0];
  $("#reviewBatch").innerHTML = list.map((b) => "<option value='" + b.id + "'>" + b.id + " · " + esc(b.name) + "</option>").join("");
  if (cur) $("#reviewBatch").value = cur.id;
}
$("#reviewBatch").onchange = renderReview;
async function renderReview() {
  const id = $("#reviewBatch").value;
  if (!id) { $("#reviewList").innerHTML = '<span class="meta">没有开放批次</span>'; return; }
  const b = await api("/api/lab/batches/" + id);
  const factorName = (k) => (STATE.factors.find((f) => f.key === k) || {}).name || k;
  const fCode = (fid) => (STATE.formulas.find((x) => x.id === fid) || {}).code || fid;
  const reviewed = b.runs.filter((r) => r.status === "reviewed");
  $("#reviewList").innerHTML = (groups.length ? groups.map((r) =>
    '<div class="card"><h3>' + r.id + " · 区组 " + r.block + " · 顺序#" + r.order + " · " + esc(fCode(r.formulaId)) +
    ' <span class="pill draft">待复核</span></h3><div class="meta small">' +
    Object.entries(r.factors).map(([k, v]) => factorName(k) + ":" + esc(v)).join(" / ") +
    (r.replacementOf ? "　替补自 " + esc(r.replacementOf) : "") + "</div>" +
    "<table><tr><th>读数</th><th>密度</th><th>ΔE</th><th>缺陷</th><th>质量分</th><th>条件</th><th>判定</th></tr>" +
    r.readings.filter((rd) => rd.state === "candidate").map((rd) => "<tr><td class='mono small'>" + esc(rd.id) + "</td><td>" + rd.density + "</td><td>" + rd.colorDelta +
      "</td><td>" + esc(rd.defect) + "</td><td><b>" + rd.score + "</b></td><td class='small'>" +
      (rd.temperature ?? "—") + "℃ / " + (rd.humidity ?? "—") + "% " + esc(rd.note || "") + "</td>" +
      "<td class='row' style='margin:0'><button class='act small' data-valid='" + r.id + "|" + rd.id + "'>选为有效值</button>" +
      "<button class='act gray small' data-reject='" + r.id + "|" + rd.id + "'>驳回该读数</button></td></tr>").join("") +
    "</table><div class='row'><input class='ex-reason' placeholder='排除原因（必填，留痕），如 涂布划伤'>" +
    "<button class='act danger small' data-exclude='" + r.id + "'>整样异常排除（自动补同区组替补）</button></div></div>").join("")
    : '<span class="meta">没有待复核试样。</span>') +
    (reviewed.length ? "<h3 style='margin-top:18px'>已复核（改选读数需先退回重裁，强制填写原因并留痕）</h3>" +
      reviewed.map((r) => {
        const valid = r.readings.find((rd) => rd.id === r.validReadingId);
        return '<div class="card"><h3>' + r.id + " · " + esc(fCode(r.formulaId)) + ' <span class="pill final">有效</span></h3>' +
          "<div class='small'>当前有效读数 <b class='mono'>" + esc(valid ? valid.id : "—") + "</b>　D=" + (valid ? valid.density : "—") +
          " ΔE=" + (valid ? valid.colorDelta : "—") + " " + esc(valid ? valid.defect : "") + "</div>" +
          "<div class='row'><button class='act gray small' data-reopen='" + r.id + "'>退回重裁（改选读数）</button></div></div>";
      }).join("") : "");

  const postReview = async (decisions) => api("/api/lab/batches/" + id + "/review", { method: "POST", body: JSON.stringify({ decisions }) });
  $$("[data-reopen]").forEach((btn) => btn.onclick = async () => {
    const runId = btn.dataset.reopen;
    const reason = prompt("退回重裁原因（至少 2 字，留痕后可重新选择有效读数）");
    if (!reason || reason.trim().length < 2) return toast("退回必须写明原因", true);
    try {
      await api("/api/lab/batches/" + id + "/runs/" + runId + "/reopen", { method: "POST", body: JSON.stringify({ reason }) });
      toast("已退回重裁，原有效值与重复读数均回到待裁决"); refresh();
    } catch (e) { toast(e.message, true); }
  });
  $$("[data-valid]").forEach((btn) => btn.onclick = async () => {
    const [runId, readingId] = btn.dataset.valid.split("|");
    const reason = prompt("复核说明（可空）：", "重复测量中密度与色差一致性最好") || "";
    try { await postReview([{ runId, readingId, action: "valid", reason }]); toast("有效值已确认，其余重复读数标记为重复"); refresh(); }
    catch (e) { toast(e.message, true); }
  });
  $$("[data-reject]").forEach((btn) => btn.onclick = async () => {
    const [runId, readingId] = btn.dataset.reject.split("|");
    const reason = prompt("驳回原因（至少 2 字，留痕）");
    if (!reason || reason.trim().length < 2) return toast("驳回必须写明原因", true);
    try { await postReview([{ runId, readingId, action: "reject-reading", reason }]); toast("该读数已驳回并留痕"); refresh(); }
    catch (e) { toast(e.message, true); }
  });
  $$("[data-exclude]").forEach((btn) => btn.onclick = async () => {
    const runId = btn.dataset.exclude;
    const reason = btn.closest(".card").querySelector(".ex-reason").value.trim();
    if (reason.length < 2) return toast("异常排除必须写明原因（留痕）", true);
    if (!confirm("排除 " + runId + " 并自动生成同区组替补试样？")) return;
    try { await postReview([{ runId, action: "exclude", reason }]); toast("已排除并补样，审计留痕"); refresh(); }
    catch (e) { toast(e.message, true); }
  });
}

/* ---------- ④ 比较 ---------- */
function renderCompareSelectors() {
  const list = STATE.batches;
  const cur = list.find((b) => b.id === $("#compareBatch").value) || list[0];
  $("#compareBatch").innerHTML = list.map((b) => "<option value='" + b.id + "'>" + b.id + " · " + esc(b.name) + (b.closed ? "（已封存）" : "") + "</option>").join("");
  if (cur) $("#compareBatch").value = cur.id;
}
$("#compareBatch").onchange = runCompare;
$("#compareBtn").onclick = runCompare;
const fName = (fid) => { const f = STATE.formulas.find((x) => x.id === fid); return f ? f.code + " " + f.name : fid; };
async function runCompare() {
  const id = $("#compareBatch").value;
  const box = $("#compareResult");
  if (!id) { box.innerHTML = '<span class="meta">尚无批次</span>'; return; }
  const a = await api("/api/lab/batches/" + id + "/analysis");
  const gateRow = (ok, label) => '<span class="' + (ok ? 'gate-ok">✔ ' : 'gate-bad">✘ ') + label + '</span>　';
  let html = '<div class="row">' +
    gateRow(a.gates.enoughSamples, "样本量达标（每配方 ≥ 最小重复）") +
    gateRow(a.gates.blockBalanced, "区组平衡") +
    gateRow(a.gates.noMissingCells, "无空缺区组格子") +
    gateRow(a.gates.everyFormulaPresent, "每配方有有效数据") +
    gateRow(a.gates.mainEffectsCovered, "区组内因子水平覆盖完整（主效应可成立）") +
    gateRow(a.gates.interactionsCovered, "区组内交互单元覆盖完整（二阶交互可成立）") +
    gateRow(a.gates.equalReplication, "处理重复数一致（同配方同区组各组合等重复）") + "</div>";
  if (a.status !== "conclusive") {
    html += '<p class="gate-bad">结论：样本不足、区组不平衡、覆盖不完整或处理重复数不一致，不得定论。原因：' + esc(a.reasons.join("；")) + "</p>";
  } else {
    html += '<p class="gate-ok">结论：可以定论。优胜：' + esc(fName(a.winner.formulaId)) + "（均分 " + a.winner.mean + "，n=" + a.winner.n + "，95%CI ±" + a.winner.ci + "）</p>";
    if (Array.isArray(a.ciOverlap) && a.ciOverlap.some((x) => x.overlap)) html += '<p><span class="pill bad">置信区间与次优重叠：' +
      a.ciOverlap.filter((x) => x.overlap).map((x) => esc(fName(x.formulaId)) + "（差 " + x.gap + "）").join("、") + "，建议增加重复</span></p>";
  }
  html += "<h3>配方组统计（质量分 / 密度 / 色差）</h3><table><tr><th>配方</th><th>n</th><th>均值</th><th>极差</th><th>95%CI</th><th>密度均值</th><th>ΔE均值</th><th>缺陷率</th></tr>" +
    a.ranking.map((r) => { const g = a.groups[r.formulaId]; return "<tr><td>" + esc(fName(r.formulaId)) + "</td><td>" + g.score.n + "</td>" +
      "<td><b>" + g.score.mean + "</b></td><td>" + g.score.range + "（" + g.score.min + "–" + g.score.max + "）</td>" +
      "<td>[" + g.score.lo + ", " + g.score.hi + "]</td><td>" + g.density.mean + "</td><td>" + g.colorDelta.mean + "</td><td>" +
      (g.defectRate === null ? "—" : Math.round(g.defectRate * 100) + "%") + "</td></tr>"; }).join("") + "</table>";
  const fn = (k) => (STATE.factors.find((f) => f.key === k) || { name: k }).name;
  if (a.effects) {
    html += "<h3>主效应（按质量分，正值为该因子最佳/最差水平差）</h3><table><tr><th>因子</th>" +
      Object.keys(a.effects).map((k) => "<th>" + fn(k) + "</th>").join("") + "</tr><tr><td>各水平均值</td>" +
      Object.values(a.effects).map((e) => "<td class='small'>" + Object.entries(e.means).map(([l, v]) => esc(l) + "=" + v).join("，") + "</td>").join("") +
      "</tr><tr><td>效应幅度</td>" + Object.values(a.effects).map((e) => "<td>" + e.effect + "</td>").join("") +
      "</tr><tr><td>建议水平</td>" + Object.values(a.effects).map((e) => "<td><b>" + esc(e.bestLevel || "—") + "</b></td>").join("") + "</tr></table>";
  } else {
    html += '<h3>主效应</h3><p class="gate-bad">因子水平覆盖不完整，主效应无法成立，不输出效应值与建议水平。</p>';
  }
  if (a.gates.interactionsCovered && a.interactions.length) {
    html += "<h3>二阶交互（DID 差之差）</h3><table><tr><th>因子对</th><th>DID</th><th>提示</th></tr>" +
      a.interactions.map((ix) => "<tr><td>" + ix.factors.map(fn).join(" × ") + "</td><td>" + ix.did +
        "</td><td>" + (a.strongInteractions.includes(ix.factors.join("×")) ? "<span class='pill bad'>交互较强：需按组合选择，不能只看主效应</span>" : "弱") + "</td></tr>").join("") + "</table>";
  } else {
    html += "<h3>二阶交互（DID 差之差）</h3><p class='gate-bad'>交互单元覆盖不完整，交互无法成立，不输出 DID。</p>";
  }
  if (a.status === "conclusive" && a.recommendedSetting) html += '<p class="meta small">建议工艺组合：' +
    Object.entries(a.recommendedSetting).map(([k, v]) => fn(k) + "=" + esc(v)).join("，") + "</p>";
  html += '<p class="meta small">有效试样 ' + a.validCount + " / 在册 " + a.runCount + "，已排除 " + a.exclusions + "，未完成 " + a.pendingCount + "</p>";
  box.innerHTML = html;
}

/* ---------- ⑤ 定版 ---------- */
function renderFinalize() {
  const list = STATE.batches;
  const cur = list.find((b) => b.id === $("#finalBatch").value) || list[0];
  $("#finalBatch").innerHTML = list.map((b) => "<option value='" + b.id + "'>" + b.id + " · " + esc(b.name) + (b.closed ? "（已封存）" : "") + "</option>").join("");
  if (cur) $("#finalBatch").value = cur.id;
  $("#closeBatch").disabled = !cur || cur.closed;
  $("#closeForce").disabled = !cur || cur.closed;
  $("#finalizeList").innerHTML = STATE.formulas.map((f) =>
    '<div class="card"><h3>' + esc(f.code) + " · " + esc(f.name) + " " + fPill(f) + "</h3>" +
    (f.finalizedBatchId ? '<div class="meta small">定版批次 ' + esc(f.finalizedBatchId) + " · " + esc(f.finalizedAt || "") + "</div>"
      : '<div class="row"><button class="act" data-finalize="' + esc(f.id) + '"' + (f.status === "final" ? " disabled" : "") + ">按优胜证据定版</button></div>") +
    "</div>").join("") || '<span class="meta">尚无配方</span>';
  $$("[data-finalize]").forEach((btn) => btn.onclick = async () => {
    const fid = btn.dataset.finalize;
    const batchId = $("#finalBatch").value || null;
    if (!confirm("定版后配方不可修改或删除。确认依据当前/已有优胜批次定版？")) return;
    try { await api("/api/lab/formulas/" + fid + "/finalize", { method: "POST", body: JSON.stringify({ batchId }) }); toast("配方已定版（不可改）"); refresh(); }
    catch (e) { toast(e.message, true); }
  });
  renderAudit();
}
async function renderAudit() {
  const rows = await api("/api/lab/audit?limit=60");
  $("#auditList").innerHTML = "<table><tr><th>时间</th><th>人</th><th>角色</th><th>动作</th><th>对象</th><th>详情</th></tr>" +
    rows.map((r) => "<tr><td class='small'>" + esc(r.at) + "</td><td>" + esc(r.actor) + "</td><td>" + esc(r.role) + "</td>" +
      "<td>" + esc(r.action) + "</td><td class='mono small'>" + esc(r.target) + "</td><td class='small'>" + esc(JSON.stringify(r.detail)) + "</td></tr>").join("") +
    "</table>";
}
$("#closeBatch").onclick = async () => {
  const id = $("#finalBatch").value;
  try {
    await api("/api/lab/batches/" + id + "/close", { method: "POST", body: JSON.stringify({ force: false }) });
    toast("批次已封存，分析快照固化"); refresh();
  } catch (e) {
    toast(e.message + "（如确认放弃定论，可用“无结论封存”）", true);
  }
};
$("#closeForce").onclick = async () => {
  const id = $("#finalBatch").value;
  if (!confirm("无结论封存后同样不可再录入，且该批不能作为定版依据。继续？")) return;
  try { await api("/api/lab/batches/" + id + "/close", { method: "POST", body: JSON.stringify({ force: true }) }); toast("已无结论封存"); refresh(); }
  catch (e) { toast(e.message, true); }
};

$("#reload").onclick = refresh;
refresh().then(() => { const t = $$("nav.tabs button").find((b) => b.dataset.tab === "compare"); });
</script>
</body>
</html>`;
}
