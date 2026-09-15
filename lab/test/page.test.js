// 页面回归：解析真实 /lab 返回的 HTML，在 Node VM 中执行真实客户端脚本，
// 用极简 DOM 桩驱动真实 HTTP 服务——验证脚本能执行、五个视图可切换、表单可提交。
// 不引入任何第三方依赖。
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { createServer } from "../../server.js";
import { LabStore } from "../store.js";

// ---------------- 极简 DOM ----------------
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TAGS = new Set(["script", "style"]);

class ClassList {
  constructor(el) { this.el = el; }
  has(c) { return this.el._classes.has(c); }
  add(c) { this.el._classes.add(c); }
  remove(c) { this.el._classes.delete(c); }
  toggle(c, force) {
    const want = force === undefined ? !this.has(c) : force;
    want ? this.add(c) : this.remove(c);
    return want;
  }
  contains(c) { return this.has(c); }
}

class El {
  constructor(tagName, doc) {
    this.tagName = tagName.toLowerCase();
    this.doc = doc;
    this.attrs = {};
    this._classes = new Set();
    this.children = [];
    this.parentNode = null;
    this._value = "";
    this.checked = false;
    this.disabled = false;
    this.dataset = {};
    this.classList = new ClassList(this);
    this.style = {};
    this.textContent = "";
  }
  get id() { return this.attrs.id || ""; }
  get name() { return this.attrs.name || ""; }
  get type() { return this.attrs.type || ""; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "class") this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  getAttribute(k) { return this.attrs[k]; }
  appendChild(c) { c.parentNode = this; this.children.push(c); if (c.id) this.doc._byId[c.id] = c; return c; }
  _setText(t) { this.textContent = (this.textContent || "") + t; }

  set innerHTML(html) {
    this.children = [];
    this.textContent = "";
    parseInto(html, this, this.doc);
  }

  querySelector(sel) { return this.doc._find(sel, this)[0] || null; }
  querySelectorAll(sel) { return this.doc._find(sel, this); }
  closest(sel) {
    let n = this;
    while (n) { if (n !== this.doc.root && matchSelector(sel, n, this.doc)) return n; n = n.parentNode; }
    return null;
  }
  reset() {
    for (const d of this.doc._find("input,select,textarea", this)) {
      d._value = d.attrs.value ?? "";
      if (d.tagName === "input") d.checked = "checked" in d.attrs;
      if (d.tagName === "select") d._syncSelect(true);
    }
  }
  _syncSelect(initial) {
    const opts = this.doc._find("option", this);
    if (!opts.length) return;
    let sel = opts.find((o) => "selected" in o.attrs);
    if (!sel && initial) sel = opts[0];
    for (const o of opts) { if (o === sel) { o.attrs.selected = ""; o.selected = true; } else { delete o.attrs.selected; o.selected = false; } }
    this._value = sel ? (sel.attrs.value ?? sel.textContent) : "";
  }
}

function makeSelectAccessors(el) {
  if (el.tagName !== "select") return;
  Object.defineProperty(el, "value", {
    get() {
      const opts = el.doc._find("option", el);
      const sel = opts.find((o) => o.selected || "selected" in o.attrs);
      return sel ? (sel.attrs.value ?? sel.textContent) : "";
    },
    set(v) {
      const opts = el.doc._find("option", el);
      let hit = null;
      for (const o of opts) {
        const ov = o.attrs.value ?? o.textContent;
        const on = ov === String(v);
        if (on) hit = o;
        o.selected = on;
        if (on) o.attrs.selected = ""; else delete o.attrs.selected;
      }
      el._value = hit ? String(v) : "";
    }
  });
}
function applyValueAccessors(el) {
  if (el.tagName === "select") { makeSelectAccessors(el); return; }
  Object.defineProperty(el, "value", {
    get() { return this._value; },
    set(v) { this._value = v == null ? "" : String(v); }
  });
}

function parseAttrs(s) {
  const out = {};
  const re = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g;
  let m;
  while ((m = re.exec(s))) {
    if (!m[1]) continue;
    out[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}

function makeDocument(html) {
  const doc = {
    _byId: {}, root: null,
    _find(sel, scope) { return findAll(sel, scope || this.root, this); },
    querySelector(sel) { return this._find(sel, this.root)[0] || null; },
    querySelectorAll(sel) { return this._find(sel, this.root); }
  };
  const root = new El("html", doc);
  doc.root = root;
  parseInto(html, root, doc);
  return doc;
}

function parseInto(html, container, doc) {
  const stack = [container];
  const tagRe = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w-]*)((?:\s+[^<>]*?)?)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = tagRe.exec(html))) {
    if (m[0].startsWith("<!--")) continue;
    if (m[4] !== undefined) {
      if (stack.length) stack[stack.length - 1]._setText(m[4]);
      continue;
    }
    const isClose = m[0][1] === "/";
    const tag = m[1].toLowerCase();
    if (isClose) {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tagName === tag) { stack.length = i; break; }
      continue;
    }
    if (RAW_TAGS.has(tag)) {
      const closeAt = html.indexOf("</" + tag + ">", tagRe.lastIndex);
      const raw = closeAt === -1 ? html.slice(tagRe.lastIndex) : html.slice(tagRe.lastIndex, closeAt);
      const el = new El(tag, doc);
      el.textContent = raw;
      stack[stack.length - 1].appendChild(el);
      tagRe.lastIndex = closeAt === -1 ? html.length : closeAt + tag.length + 3;
      continue;
    }
    const el = new El(tag, doc);
    const attrs = parseAttrs(m[2] || "");
    for (const [k, v] of Object.entries(attrs)) {
      el.attrs[k] = v;
      if (k === "class") el._classes = new Set(v.split(/\s+/).filter(Boolean));
      else if (k.startsWith("data-")) el.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    }
    applyValueAccessors(el);
    if ("checked" in el.attrs) el.checked = true;
    if ("disabled" in el.attrs) el.disabled = true;
    if (el.attrs.value !== undefined && el.tagName !== "select") el._value = el.attrs.value;
    stack[stack.length - 1].appendChild(el);
    const selfClose = m[3] === "/" || VOID_TAGS.has(tag);
    if (!selfClose) stack.push(el);
  }
  for (const s of doc._find("select", container)) s._syncSelect(true);
}

// 选择器：标签 / #id / .class / [attr] / [attr=v] / :checked / :selected，支持后代组合
function parseSimple(token) {
  const conds = [];
  const re = /([.#]?[\w-]+|\[[^\]]+\]|:[\w-]+)/g;
  let m;
  while ((m = re.exec(token))) {
    const t = m[1];
    if (t[0] === "#") conds.push((el) => el.id === t.slice(1));
    else if (t[0] === ".") conds.push((el) => el._classes.has(t.slice(1)));
    else if (t[0] === "[") {
      const mm = t.slice(1, -1).match(/^([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+)))?$/);
      const attr = mm[1], val = mm[2] ?? mm[3] ?? mm[4];
      conds.push((el) => (attr in el.attrs) && (val === undefined || String(el.attrs[attr]) === String(val)));
    } else if (t[0] === ":") {
      if (t === ":checked") conds.push((el) => el.checked === true || "checked" in el.attrs);
      if (t === ":selected") conds.push((el) => el.selected === true || "selected" in el.attrs);
    } else conds.push((el) => el.tagName === t.toLowerCase());
  }
  return (el) => conds.every((c) => c(el));
}
function matchSelector(selector, el) {
  const parts = selector.trim().split(/\s+/).map(parseSimple);
  let node = el, i = parts.length - 1;
  if (!parts[i](node)) return false;
  while (i > 0) {
    i--;
    let p = node.parentNode, hit = false;
    while (p) { if (parts[i](p)) { node = p; hit = true; break; } p = p.parentNode; }
    if (!hit) return false;
  }
  return true;
}
function walk(el, fn) {
  for (const c of el.children) { fn(c); walk(c, fn); }
}
function findAll(selector, scope, doc) {
  const groups = selector.split(",").map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const g of groups) {
    if (g[0] === "#") {
      const direct = doc._byId[g.slice(1)];
      if (direct && !out.includes(direct)) out.push(direct);
      continue;
    }
    walk(scope, (el) => { if (el.parentNode && matchSelector(g, el) && !out.includes(el)) out.push(el); });
  }
  return out;
}

class FormData {
  constructor(form) { this.form = form; }
  *entries() {
    for (const el of this.form.doc._find("input[name],select[name],textarea[name]", this.form)) {
      if (el.tagName === "input" && (el.type === "checkbox" || el.type === "radio")) {
        if (!el.checked) continue;
      }
      if (el.disabled) continue;
      yield [el.attrs.name, el.value];
    }
  }
}

function runClientScript(script, { doc, base }) {
  const hostFetch = fetch;
  const sandboxFetch = (path, init) => hostFetch(new URL(path, base), init);
  const params = ["document", "fetch", "FormData", "prompt", "confirm", "alert",
    "setTimeout", "clearTimeout", "setInterval", "clearInterval", "encodeURIComponent", "console"];
  const args = [doc, sandboxFetch, FormData, () => null, () => true, () => {},
    setTimeout, clearTimeout, setInterval, clearInterval, encodeURIComponent, console];
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction(...params, script);
  return fn(...args);
}
const flush = (ms = 120) => new Promise((r) => setTimeout(r, ms));
function textOf(el, doc) {
  let t = el.textContent || "";
  for (const c of el.children) t += textOf(c, doc);
  return t;
}

// ---------------- 测试 ----------------
async function boot() {
  const file = join(tmpdir(), `lab-page-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const { server } = createServer(new LabStore(file));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, file,
    stop: () => new Promise((r) => server.close(r)),
    api: async (path, opts = {}) => {
      const res = await hostFetchJson(base, path, opts);
      return res;
    }
  };
}
async function hostFetchJson(base, path, opts = {}) {
  const res = await fetch(base + path, {
    method: opts.method || "GET",
    headers: Object.assign({ "Content-Type": "application/json", "x-lab-role": opts.role || "technologist", "x-lab-user": encodeURIComponent(opts.user || "page") }, opts.headers || {}),
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  return { status: res.status, json: await res.json() };
}

const FULL_LEVELS = {
  coating: ["薄涂", "厚涂"], exposure: ["短曝", "长曝"],
  development: ["弱酸", "清水"], wash: ["短洗", "长洗"]
};

test("页面：脚本无语法错误、五视图可切换、设计/录入提交真实落库", async () => {
  const ctx = await boot();
  const rejections = [];
  const onRej = (e) => rejections.push(e);
  process.on("unhandledRejection", onRej);
  try {
    const html = await (await fetch(ctx.base + "/lab")).text();
    const doc = makeDocument(html);
    assert.ok(doc._byId["formulaForm"], "静态 DOM 解析出关键节点");
    assert.ok(doc._find("nav.tabs button").length === 5, "五个页签");

    // 执行真实客户端脚本（若存在语法错误，这里直接抛错）
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(m, "页面包含脚本");
    await runClientScript(m[1], { doc, base: ctx.base + "/" });
    await flush();
    assert.equal(rejections.length, 0, "初始化无未捕获错误：" + rejections.map((e) => e && e.message).join("; "));

    // 视图切换：初始 design 激活，其余隐藏
    const tabs = doc._find("nav.tabs button");
    const byTab = Object.fromEntries(tabs.map((b) => [b.attrs["data-tab"], b]));
    const activeView = () => doc._find(".view").filter((v) => v._classes.has("active")).map((v) => v.id);
    assert.deepEqual(activeView(), ["view-design"]);
    for (const name of ["entry", "review", "compare", "finalize", "design"]) {
      byTab[name].onclick();
      assert.deepEqual(activeView(), ["view-" + name], "切换到 " + name);
      assert.equal(tabs.filter((b) => b._classes.has("active")).length, 1);
    }

    // 设计页提交：新建配方
    doc._byId["role"].value = "admin";
    doc._byId["actor"].value = "页面测试人";
    const form = doc._byId["formulaForm"];
    const vals = { code: "PF-1", name: "页面配方", ferricAmmoniumCitrate: "20%", potassiumFerricyanide: "16%", ratio: "1:1", note: "" };
    for (const [k, v] of Object.entries(vals)) form.querySelector(`input[name=${k}],textarea[name=${k}]`).value = v;
    await form.onsubmit({ preventDefault() {}, target: form });
    await flush();
    let list = await ctx.api("/api/lab/formulas");
    assert.equal(list.json.body.length, 1, "设计表单提交真实落库");
    assert.equal(list.json.body[0].code, "PF-1");

    // 再造一个配方 + 批次（API 造数据，用页面“刷新”载入）
    const f2 = await ctx.api("/api/lab/formulas", { method: "POST", body: { code: "PF-2", name: "对照配方", ferricAmmoniumCitrate: "18%", potassiumFerricyanide: "14%", ratio: "1:1.2" } });
    const batch = await ctx.api("/api/lab/batches", {
      method: "POST",
      body: { name: "页面批", blocks: 2, repsPerBlock: 1, minReplicates: 2, formulaIds: [list.json.body[0].id, f2.json.body.id], levels: FULL_LEVELS }
    });
    assert.equal(batch.status, 201);
    const bid = batch.json.body.id;
    await doc._byId["reload"].onclick();
    await flush();

    // 切到录入页，选中第一个试样，用页面表单提交一条测量
    byTab.entry.onclick();
    const runSel = doc._byId["entryRun"];
    const firstRun = batch.json.body.runs[0];
    runSel.value = firstRun.id;
    assert.equal(runSel.value, firstRun.id, "生成的试样下拉可选");
    const rf = doc._byId["readingForm"];
    rf.querySelector("input[name=density]").value = "1.32";
    rf.querySelector("input[name=colorDelta]").value = "8.5";
    rf.querySelector("select[name=defect]").value = "无";
    await rf.onsubmit({ preventDefault() {}, target: rf });
    await flush();
    const full = await ctx.api(`/api/lab/batches/${bid}`);
    const run = full.json.body.runs.find((r) => r.id === firstRun.id);
    assert.equal(run.readings.length, 1, "录入表单提交真实落库");
    assert.equal(run.status, "entered");
    assert.equal(run.readings[0].density, 1.32);

    // 比较页：未复核 → 不得定论，页面渲染出闸门行
    byTab.compare.onclick();
    await doc._byId["compareBtn"].onclick();
    await flush();
    const compareText = textOf(doc._byId["compareResult"], doc);
    assert.ok(compareText.includes("不得定论") || compareText.includes("样本"), "比较页渲染结论");

    await flush();
    assert.equal(rejections.length, 0, "全部交互无未捕获错误：" + rejections.map((e) => e && e.message).join("; "));
  } finally {
    process.removeListener("unhandledRejection", onRej);
    await ctx.stop();
    await rm(ctx.file, { force: true });
  }
});
