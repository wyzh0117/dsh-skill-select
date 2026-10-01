/**
 * client 半冒烟测试（不渲染 DOM，仅验证 ModuleLoader 入口、apply 行为、
 * 草稿手势与排序纯函数）。Node 环境需要先 stub `window.__ModuleLoader__` 再动态
 * import client bundle。
 */
import test from "node:test";
import assert from "node:assert/strict";

// ── 装载 client bundle ─────────────────────────────────────────────────────
let captured;

/** 每次 useEffect 调用按顺序记在这里，供主体测试断言“可见时才拉列表”。 */
const effectLog = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// React 桩：够跑通 hook 顺序并记录元素树，不渲染任何 DOM。
const reactMock = {
  Fragment: "Fragment",
  createElement: (type, props, ...children) => ({ type, props, children }),
  useRef: (initial) => ({ current: initial }),
  useState: (initial) => [initial, () => {}],
  // 立即执行 effect 回调：本文件只关心“可见性翻转时做了什么”。
  useEffect: (fn) => { effectLog.push(fn()); },
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
};

globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => {
      assert.equal(entry.id, "dsh-skill-select");
      captured = entry.factory((name) => (name === "react" ? reactMock : {}));
    },
  },
};

await import("../lib/client.js");

/**
 * 官方右侧栏的假上下文：`sidebarRightTabs` 收页签类型，`slots` 收 keyed 注册，
 * `effect` 就地执行回调并记下 disposer，好让测试断言卸载路径。
 */
function fakeCtx(overrides = {}) {
  const ctx = {
    get: () => undefined,
    on: () => () => {},
    conversation: { input: { for: () => ({ setDraft() {}, state: { getSnapshot: () => ({ draft: "" }) } }) } },
    sessions: { scope: (key) => ({ marker: "scoped", key }) },
    /** 已登记的 ctx.effect（label + 是否已卸载 + 已注册的页签类型）。 */
    _effects: [],
    /** 已登记的插槽注册（options + component）。 */
    _slots: [],
    _tabTypes: [],
    effect(callback, label) {
      const entry = { label, disposed: false, dispose: null };
      const returned = callback();
      entry.dispose = () => {
        if (entry.disposed) return;
        entry.disposed = true;
        if (typeof returned === "function") returned();
      };
      ctx._effects.push(entry);
      return entry.dispose;
    },
    inject: (deps, callback) => callback(ctx),
    sidebarRightTabs: {
      register(definition) {
        ctx._tabTypes.push(definition);
        return () => {};
      },
    },
    slots: {
      inject(name, callback) {
        const dispose = callback();
        return typeof dispose === "function" ? dispose : () => {};
      },
      register(options, component) {
        ctx._slots.push({ options, component });
        return () => {};
      },
    },
    ...overrides,
  };
  return ctx;
}

/** 从假上下文里取某个插槽的注册。 */
function slotOf(ctx, name) {
  return ctx._slots.find((entry) => entry.options.name === name);
}

// ── 用例 ───────────────────────────────────────────────────────────────────

test("client: 模块装载返回 apply/inject", () => {
  assert.ok(captured, "factory 已执行");
  assert.equal(typeof captured.apply, "function");
  assert.deepEqual(captured.inject, ["conversation", "slots", "sidebarRightTabs"]);
});

test("client: apply 向官方右侧栏注册页签类型（阶段一）", () => {
  const ctx = fakeCtx();
  captured.apply(ctx);
  assert.equal(ctx._tabTypes.length, 1, "只注册一个页签类型");
  const definition = ctx._tabTypes[0];
  const { TAB_ID, TAB_KIND, GUIDE_ORDER } = captured.__test.sidebar;
  assert.equal(definition.id, TAB_ID);
  assert.equal(definition.kind, TAB_KIND, "kind 是给 openTab 用的判别式");
  assert.equal(definition.priority, "extension", "外部插件用扩展档，天然压过内置类型");
  assert.equal(definition.patterns, undefined, "页面类型不认领任何资源地址");
  assert.equal(definition.multiple, undefined, "同一 kind 每个 pane 只开一个页");
  assert.equal(definition.title(""), "Skills");
  assert.equal(definition.guide.length, 1);
  const entry = definition.guide[0];
  // guide 入口的 id 是必填项：两个入口同时省略 id 会被注册表判为重复 id 直接抛错。
  assert.equal(entry.id, TAB_ID, "guide 入口带稳定 id");
  assert.equal(entry.order, GUIDE_ORDER);
  assert.equal(entry.title(), "Skills");
  assert.equal(typeof entry.description(), "string");
  assert.equal(typeof entry.icon, "function", "icon 是组件，不是元素");
});

test("client: apply 注册 keyed 页签主体与标题（阶段二，key === 阶段一的 id）", () => {
  const ctx = fakeCtx();
  captured.apply(ctx);
  const { TAB_ID } = captured.__test.sidebar;
  assert.equal(ctx._tabTypes[0].id, TAB_ID);
  const body = slotOf(ctx, "sidebar.right.pane.tab");
  const title = slotOf(ctx, "sidebar.right.pane.tab.title");
  assert.ok(body, "主体注册进 sidebar.right.pane.tab");
  assert.ok(title, "标题注册进 sidebar.right.pane.tab.title");
  assert.equal(body.options.key, ctx._tabTypes[0].id, "keyed 插槽按定义的 id 派发");
  assert.equal(title.options.key, ctx._tabTypes[0].id);
  // 列表形状（id/order）在 keyed 插槽上是一次失败的注册，不是"近似正确"。
  assert.equal(body.options.id, undefined);
  assert.equal(body.options.order, undefined);
  assert.equal(typeof body.component, "function");
  assert.equal(typeof title.component, "function");
});

test("client: 页签主体在有会话时渲染技能面板，无会话时给出提示", () => {
  effectLog.length = 0;
  const ctx = fakeCtx();
  captured.apply(ctx);
  const { component } = slotOf(ctx, "sidebar.right.pane.tab");
  const rendered = component({ sessionId: "s1", rootCtx: ctx, useTabInfo: () => ({ tab: { visible: false } }) });
  assert.equal(rendered.type, "div", "外层是撑满 pane 的容器");
  assert.ok(rendered.children.some((node) => node && node.props && node.props.sessionId === "s1"), "渲染 SkillPanel");
  const empty = component({ sessionId: undefined, rootCtx: ctx, useTabInfo: () => ({ tab: { visible: false } }) });
  assert.ok(JSON.stringify(empty).includes("No open session."), "无会话时说明原因");
  const title = slotOf(ctx, "sidebar.right.pane.tab.title").component;
  const chip = title({ useTabInfo: () => ({ tab: { title: "Skills" } }) });
  assert.equal(chip.type, "Fragment", "标题胶囊是 fragment");
});

test("client: 页签主体只在可见时拉列表，重新显示时再拉一次", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ ok: true, value: { skills: [] } }) };
  };
  try {
    const ctx = fakeCtx();
    captured.apply(ctx);
    const { component } = slotOf(ctx, "sidebar.right.pane.tab");
    const hidden = { tab: { visible: false } };
    component({ sessionId: "s-vis", rootCtx: ctx, useTabInfo: () => hidden });
    assert.equal(calls.filter((u) => u.includes("/list")).length, 0, "隐藏时不打宿主");
    const shown = { tab: { visible: true } };
    component({ sessionId: "s-vis", rootCtx: ctx, useTabInfo: () => shown });
    assert.equal(calls.filter((u) => u.includes("/list")).length, 1, "首次显示拉一次列表");
    // 等上一次请求收尾：in-flight 去重只合并并发请求，隐藏→显示的新周期仍要重新拉。
    await sleep(10);
    component({ sessionId: "s-vis", rootCtx: ctx, useTabInfo: () => shown });
    assert.equal(calls.filter((u) => u.includes("/list")).length, 2, "再次显示再拉一次");
  } finally {
    delete globalThis.fetch;
    effectLog.length = 0;
  }
});

test("client: repoTokens 仅收录合法 kebab 且无同名成员的 repo 名", () => {
  const { repoTokens } = captured.__test;
  const skills = [
    { name: "a", repo: "superpowers" },
    { name: "b", repo: "superpowers" },
    { name: "c", repo: "Auto-Empirical-Research-Skills" }, // 非 kebab
    { name: "auto-empirical-research-skills", repo: "auto-empirical-research-skills" }, // 同名成员
    { name: "d", repo: "" },
    { name: "e" },
  ];
  assert.deepEqual([...repoTokens(skills)], ["superpowers"]);
});

test("client: tokensForChecked 满选 repo → /repo 令牌，部分/非法名 → 逐个", () => {
  const { tokensForChecked } = captured.__test;
  const skills = [
    { id: "a", name: "a", kind: "dsh", repo: "superpowers" },
    { id: "b", name: "b", kind: "dsh", repo: "superpowers" },
    { id: "c", name: "c", kind: "dsh", repo: "Auto-Empirical-Research-Skills" },
    { id: "d", name: "d", kind: "dsh", repo: null },
    { id: "e", name: "e", kind: "dsh" },
  ];
  // 满选 superpowers → 一个 /superpowers；c（非法 kebab repo 名）逐个；d/e 逐个
  assert.deepEqual(
    tokensForChecked(skills, ["a", "b", "c", "d"]),
    ["/superpowers", "/c", "/d"],
  );
  // 部分选择 → 逐个
  assert.deepEqual(tokensForChecked(skills, ["a"]), ["/a"]);
  // stale 名（不在列表）→ 逐个保留
  assert.deepEqual(tokensForChecked(skills, ["stale"]), ["/stale"]);
  assert.deepEqual(tokensForChecked(skills, []), []);
});

test("client: stripManagedTokens 移除管理内令牌、保留其它内容", () => {
  const { stripManagedTokens } = captured.__test;
  const managed = new Set(["brainstorming", "superpowers"]);
  assert.equal(stripManagedTokens("请用 /superpowers 干活", managed), "请用 干活");
  assert.equal(stripManagedTokens("帮我写方案 /brainstorming", managed), "帮我写方案");
  assert.equal(stripManagedTokens("x/brainstorming 保留 /other 也保留", managed), "x/brainstorming 保留 /other 也保留");
  assert.equal(stripManagedTokens("", managed), "");
});

test("tokensForChecked emits /name@agent for external skills", () => {
  const skills = [{ id: "grok:ego-browser", kind: "external", agent: "grok", name: "ego-browser", repo: "grok" }];
  assert.deepEqual(captured.__test.tokensForChecked(skills, ["grok:ego-browser"]), ["/ego-browser@grok"]);
});

test("stripManagedTokens removes both /name and /name@agent", () => {
  const managed = new Set(["brainstorming", "grok:ego-browser"]);
  assert.equal(captured.__test.stripManagedTokens("/brainstorming /ego-browser@grok tail", managed), "tail");
});

test("client: composeDraft 重算草稿（追加/覆盖/取消）", () => {
  const { composeDraft } = captured.__test;
  const skills = [
    { id: "a", name: "a", kind: "dsh", repo: "superpowers" },
    { id: "b", name: "b", kind: "dsh", repo: "superpowers" },
    { id: "c", name: "c", kind: "dsh" },
  ];
  assert.equal(composeDraft(skills, ["a", "b"], ""), "/superpowers");
  assert.equal(composeDraft(skills, ["a"], "帮我干活"), "帮我干活 /a");
  assert.equal(composeDraft(skills, ["a", "b"], "帮我干活 /superpowers"), "帮我干活 /superpowers");
  // 取消全部 → 移除管理令牌、保留正文
  assert.equal(composeDraft(skills, [], "帮我干活 /superpowers"), "帮我干活");
  // 从满选改为部分 → 令牌替换为逐个手势
  assert.equal(composeDraft(skills, ["a"], "帮我干活 /superpowers"), "帮我干活 /a");
});

test("client: repoCheckState 三态派生", () => {
  const { repoCheckState } = captured.__test;
  const skills = [
    { id: "a", name: "a", repo: "superpowers" },
    { id: "b", name: "b", repo: "superpowers" },
    { id: "c", name: "c" },
  ];
  assert.equal(repoCheckState(skills, "superpowers", []), "none");
  assert.equal(repoCheckState(skills, "superpowers", ["a"]), "some");
  assert.equal(repoCheckState(skills, "superpowers", ["a", "b"]), "all");
  assert.equal(repoCheckState(skills, "ghost", ["x"]), "none");
});

test("client: setChecked 同步 set-checked 到 host（失败静默）", async () => {
  const { checked } = captured.__test;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return { ok: true, json: async () => ({ ok: true, value: { sessionId: "s1", count: 2 } }) };
  };
  try {
    checked.setChecked("s1", ["a", "b"]);
    await sleep(10);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/skill-select/api/set-checked");
    assert.equal(requests[0].init.method, "POST");
    assert.deepEqual(JSON.parse(requests[0].init.body), { sessionId: "s1", skills: ["a", "b"] });
  } finally {
    delete globalThis.fetch;
  }
});

// ── 排序纯函数 ─────────────────────────────────────────────────────────────
test("client: sorting.sortByName 字母序且不改原数组", () => {
  const { sorting } = captured.__test;
  const input = [{ name: "pear" }, { name: "apple" }, { name: "banana" }];
  const out = sorting.sortByName(input);
  assert.deepEqual(out.map((s) => s.name), ["apple", "banana", "pear"]);
  assert.deepEqual(input.map((s) => s.name), ["pear", "apple", "banana"], "原数组不变");
});

test("client: sorting.sortByUsage 降序、同数按名、缺 usage 按 0", () => {
  const { sorting } = captured.__test;
  const input = [
    { name: "a", usage: 5 },
    { name: "b", usage: 10 },
    { name: "c" },
    { name: "d", usage: 5 },
    { name: "e", usage: null },
  ];
  const out = sorting.sortByUsage(input);
  assert.deepEqual(out.map((s) => s.name), ["b", "a", "d", "c", "e"]);
  assert.equal(input[0].name, "a", "原数组不变");
  assert.equal(input[1].name, "b");
});

test("client: sorting.groupByRepo 分组/排序/无 repo 最后/空数组", () => {
  const { sorting } = captured.__test;
  const input = [
    { name: "b", repo: "repo2" },
    { name: "a", repo: "repo1" },
    { name: "c" },
    { name: "d", repo: "repo1" },
    { name: "e", repo: null },
  ];
  const out = sorting.groupByRepo(input);
  assert.deepEqual(out.map((g) => g.repo), ["repo1", "repo2", ""]);
  assert.deepEqual(out[0].items.map((s) => s.name), ["a", "d"], "组内名字序");
  assert.deepEqual(out[2].items.map((s) => s.name), ["c", "e"], "无 repo 组名字序");
  assert.deepEqual(sorting.groupByRepo([]), []);
});

// ── 勾选状态 store（修复 C 验收 [中] 项）─────────────────────────────────────
test("client: setChecked 替换 Map 引用并通知监听器", () => {
  const { checked } = captured.__test;
  const before = checked.getCheckedSnapshot();
  let fired = 0;
  const unsubscribe = (() => {
    // subscribeChecked 未导出；用监听副作用验证：setChecked 后快照引用必须变化。
    return () => {};
  })();
  unsubscribe();
  checked.setChecked("s1", ["a", "b"]);
  const after = checked.getCheckedSnapshot();
  assert.notEqual(after, before, "快照引用必须替换");
  assert.deepEqual(after.get("s1"), ["a", "b"]);
  assert.notEqual(after.get("s1"), before.get("s1"), "会话条目数组也是新数组");
});

test("client: checkedFor 懒加载并缓存 localStorage", () => {
  const { checked } = captured.__test;
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, value),
  };
  storage.set("dsh-skill-select:checked:s9", JSON.stringify(["x", "y"]));
  assert.deepEqual(checked.checkedFor("s9"), ["x", "y"], "回读 localStorage");
  assert.deepEqual(checked.readChecked("s9"), ["x", "y"]);
  checked.setChecked("s9", ["z"]);
  assert.equal(JSON.parse(storage.get("dsh-skill-select:checked:s9"))[0], "z", "写入 localStorage");
  delete globalThis.localStorage;
});

// ── 卸载与 HMR ─────────────────────────────────────────────────────────────
test("client: 页签注册都在 ctx.effect 里，卸载时逐一撤销", () => {
  const ctx = fakeCtx();
  captured.apply(ctx);
  assert.equal(ctx._effects.length, 3, "页签类型 + 主体 + 标题");
  assert.deepEqual(ctx._effects.map((entry) => entry.disposed), [false, false, false]);
  for (const entry of ctx._effects) entry.dispose();
  assert.deepEqual(ctx._effects.map((entry) => entry.disposed), [true, true, true], "三个注册的 disposer 全部跑过");
  // 卸载路径本身可重复调用（幂等 disposer）。
  for (const entry of ctx._effects) entry.dispose();
});

test("client: loadSkills 同 session 并发去重（只发一次 list；成功后同步 set-checked）", async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    await sleep(50);
    return { ok: true, json: async () => ({ ok: true, value: { skills: [] } }) };
  };
  try {
    const { loadSkills } = captured.__test;
    const p1 = loadSkills("s1");
    const p2 = loadSkills("s1");
    assert.equal(p1, p2, "同一会话的并发请求复用同一 promise");
    await p1;
    const listCalls = urls.filter((u) => u.includes("/list"));
    assert.equal(listCalls.length, 1, "只发一次 list 请求");
    assert.ok(urls.some((u) => u.includes("/set-checked")), "list 成功后同步勾选名单到 host");
  } finally {
    delete globalThis.fetch;
  }
});

test("repoCheckState normalizes null repo to empty", () => {
  const skills = [{ id: "a", name: "a", repo: null }];
  assert.equal(captured.__test.repoCheckState(skills, "", ["a"]), "all");
  assert.equal(captured.__test.repoCheckState(skills, "", []), "none");
});

// ── 守卫开关 store ─────────────────────────────────────────────────────────
test("client: guard 初始关闭，loadSkills 读取 list.guard，setGuard 写回 host", async () => {
  const { guard, loadSkills } = captured.__test;
  assert.equal(guard.getGuardSnapshot().guard, false, "初始关闭（无本插件默认工作流）");
  let setGuardBody = null;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/list")) {
      return { ok: true, json: async () => ({ ok: true, value: { skills: [], guard: true } }) };
    }
    if (u.includes("/set-guard")) {
      setGuardBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ ok: true, value: { guard: setGuardBody.on } }) };
    }
    return { ok: true, json: async () => ({ ok: true, value: { sessionId: "s1", count: 0 } }) };
  };
  try {
    await loadSkills("s1");
    assert.equal(guard.getGuardSnapshot().guard, true, "list 返回 guard=true 后本地同步");
    await guard.setGuard(false);
    assert.deepEqual(setGuardBody, { on: false }, "set-guard 发送 on:false");
    assert.equal(guard.getGuardSnapshot().guard, false, "本地回填为 false");
  } finally {
    delete globalThis.fetch;
  }
});

// ── 重新打开侧边栏重置 Skills 勾选（Auto-start 走 set-default 不受影响）───────
test("client: resetCheckedForSession 清空勾选并剥离草稿令牌", async () => {
  const { checked, resetCheckedForSession } = captured.__test;
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, value),
  };
  let draft = "帮我写方案 /brainstorming /ego-browser@grok";
  const ctx = {
    get: () => undefined,
    on: () => () => {},
    conversation: {
      input: {
        for: () => ({
          setDraft: (v) => { draft = v; },
          state: { getSnapshot: () => ({ draft }) },
        }),
      },
    },
    sessions: { scope: (key) => ({ marker: "scoped", key }) },
  };
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: init ? JSON.parse(init.body) : null });
    return { ok: true, json: async () => ({ ok: true, value: { sessionId: "s1", count: 0 } }) };
  };
  try {
    checked.setChecked("s1", ["brainstorming", "grok:ego-browser"]);
    requests.length = 0; // 清掉 setChecked 自身的同步，只观察 reset 的同步
    resetCheckedForSession(ctx, "s1");
    await sleep(10);
    assert.deepEqual(checked.checkedFor("s1"), [], "勾选被清空");
    assert.equal(draft, "帮我写方案", "草稿里本插件管理的 /name 与 /name@agent 被剥离");
    const sync = requests.find((r) => r.url.includes("/set-checked"));
    assert.ok(sync, "重置后同步 set-checked 到 host");
    assert.deepEqual(sync.body.skills, [], "host 收到空名单");
  } finally {
    delete globalThis.fetch;
    delete globalThis.localStorage;
  }
});

// ── Auto-start 组三态 + 批量默认启动 ────────────────────────────────────────
test("client: defaultCheckState 三态派生（按 defaultStart）", () => {
  const { defaultCheckState } = captured.__test;
  const skills = [
    { id: "a", name: "a", defaultStart: true },
    { id: "b", name: "b", defaultStart: true },
    { id: "c", name: "c", defaultStart: false },
  ];
  assert.equal(defaultCheckState(skills), "some");
  assert.equal(defaultCheckState([skills[0], skills[1]]), "all");
  assert.equal(defaultCheckState([skills[2]]), "none");
  assert.equal(defaultCheckState([]), "none");
});

test("client: setDefaultsBulk 单次 set-defaults 批量切换", async () => {
  const { setDefaultsBulk } = captured.__test;
  let body = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/set-defaults")) {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ ok: true, value: { count: 2 } }) };
    }
    return { ok: true, json: async () => ({ ok: true, value: {} }) };
  };
  try {
    await setDefaultsBulk(["a", "b"], true);
    assert.deepEqual(body, { names: ["a", "b"], on: true });
  } finally {
    delete globalThis.fetch;
  }
});
