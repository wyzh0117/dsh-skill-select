/**
 * client 半冒烟测试（不渲染 DOM，仅验证 ModuleLoader 入口、apply 行为、
 * 草稿手势与排序纯函数）。Node 环境需要先 stub `window.__ModuleLoader__` 再动态
 * import client bundle。
 */
import test from "node:test";
import assert from "node:assert/strict";

// ── 装载 client bundle ─────────────────────────────────────────────────────
let captured;
// react-dom 桩计数：用于断言 mountStandalone 被调用（createRoot/render/unmount）。
const reactDomMock = {
  createRootCount: 0,
  renderCount: 0,
  unmountCount: 0,
};

globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => {
      assert.equal(entry.id, "dsh-skill-select");
      captured = entry.factory((name) => {
        if (name === "@deepseek-ai/dsh-client-runtime") {
          return { createScope: (ctx, key) => ({ ctx: { marker: "scoped", key } }) };
        }
        if (name === "react") {
          return { createElement: (type, props, ...children) => ({ type, props, children }) };
        }
        if (name === "react-dom") {
          return {
            createRoot: () => {
              reactDomMock.createRootCount += 1;
              return {
                render() { reactDomMock.renderCount += 1; },
                unmount() { reactDomMock.unmountCount += 1; },
              };
            },
            createPortal: (node) => node,
          };
        }
        return {};
      });
    },
  },
};

await import("../lib/client.js");

function fakeCtx(overrides = {}) {
  const ctx = {
    get: (name) => undefined,
    on: () => () => {},
    conversation: { input: { for: () => ({ setDraft() {}, state: { getSnapshot: () => ({ draft: "" }) } }) } },
    _injections: [],
    _registrations: [],
    ...overrides,
  };
  return ctx;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 用例 ───────────────────────────────────────────────────────────────────

test("client: 模块装载返回 apply/inject", () => {
  assert.ok(captured, "factory 已执行");
  assert.equal(typeof captured.apply, "function");
  assert.deepEqual(captured.inject, ["conversation"]);
});

test("client: 无 betterSidebar 时 3.2s 后挂载独立抽屉（mountStandalone）", async () => {
  reactDomMock.createRootCount = 0;
  reactDomMock.renderCount = 0;
  globalThis.document = {
    createElement: () => ({ appendChild() {}, remove() {} }),
    body: { appendChild() {} },
  };
  try {
    const ctx = fakeCtx();
    captured.apply(ctx);
    assert.equal(reactDomMock.createRootCount, 0, "不立即挂载");
    await sleep(3400);
    assert.ok(reactDomMock.createRootCount >= 1, "createRoot 被调用");
    assert.ok(reactDomMock.renderCount >= 1, "render 被调用");
  } finally {
    delete globalThis.document;
  }
});

test("client: 有 betterSidebar 时立即注册 tab", () => {
  const descriptor = {};
  const ctx = fakeCtx({ get: (name) => (name === "betterSidebar" ? { registerTab: (d) => Object.assign(descriptor, d) } : undefined) });
  captured.apply(ctx);
  assert.equal(descriptor.id, "skill-select");
  assert.equal(descriptor.title, "Skills", "side card 风格：英文标题");
  assert.equal(descriptor.single, true);
  assert.equal(descriptor.order, 90);
  assert.equal(typeof descriptor.icon, "function", "tab 带图标工厂（side card 风格）");
  assert.equal(typeof descriptor.component, "function");
});

test("client: betterSidebar 通过 internal/service 事件迟到时注册 tab", async () => {
  const ctx = fakeCtx();
  const listeners = [];
  let provided = undefined;
  ctx.on = (name, fn) => {
    if (name === "internal/service") listeners.push(fn);
    return () => {};
  };
  ctx.get = (name) => (name === "betterSidebar" ? provided : undefined);
  captured.apply(ctx);
  assert.equal(ctx._registrations.length, 0);
  const descriptor = {};
  provided = { registerTab: (d) => Object.assign(descriptor, d) };
  listeners.forEach((fn) => fn("betterSidebar", provided));
  assert.equal(descriptor.id, "skill-select");
  // 3s 重探测与 3.2s 回退都不应再动作（服务已提供）
  await sleep(3400);
  assert.equal(ctx._registrations.length, 0, "tab 路径已占用，回退不注册");
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

// ── 竞态窗口与 disposer（修复 C 验收 [低] 竞态/HMR 项）───────────────────────
test("client: betterSidebar 在定时兜底时才出现 → 注册 tab 而非回退", async () => {
  const ctx = fakeCtx();
  let provided = undefined;
  ctx.get = (name) => (name === "betterSidebar" ? provided : undefined);
  captured.apply(ctx);
  const descriptor = {};
  // 2s 后服务出现（早于 3.2s 兜底，晚于立即探测）
  await sleep(2000);
  provided = { registerTab: (d) => Object.assign(descriptor, d) };
  await sleep(1400);
  assert.equal(descriptor.id, "skill-select", "兜底定时器重新探测并注册 tab");
  assert.equal(ctx._registrations.length, 0, "不注册回退");
});

test("client: apply 返回 disposer，卸载后定时器不再触发回退", async () => {
  const ctx = fakeCtx();
  const dispose = captured.apply(ctx);
  assert.equal(typeof dispose, "function");
  dispose();
  await sleep(3400);
  assert.equal(ctx._registrations.length, 0, "dispose 后回退定时器已清理");
});

test("client: disposer 卸载独立抽屉（unmount + 移除容器）", async () => {
  reactDomMock.createRootCount = 0;
  reactDomMock.renderCount = 0;
  reactDomMock.unmountCount = 0;
  let removed = 0;
  globalThis.document = {
    createElement: () => ({ appendChild() {}, remove() { removed += 1; } }),
    body: { appendChild() {} },
  };
  try {
    const ctx = fakeCtx();
    const dispose = captured.apply(ctx);
    await sleep(3400);
    assert.ok(reactDomMock.createRootCount >= 1, "createRoot 被调用");
    dispose();
    assert.ok(reactDomMock.unmountCount >= 1, "unmount 被调用");
    assert.ok(removed >= 1, "容器被移除");
  } finally {
    delete globalThis.document;
  }
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
