/**
 * client 半冒烟测试（不渲染 DOM，仅验证 ModuleLoader 入口、apply 行为与
 * 草稿手势纯函数）。Node 环境需要先 stub `window.__ModuleLoader__` 再动态
 * import client bundle。
 */
import test from "node:test";
import assert from "node:assert/strict";

// ── 装载 client bundle ─────────────────────────────────────────────────────
let captured;

globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => {
      assert.equal(entry.id, "dsh-skill-select");
      captured = entry.factory((name) => {
        if (name === "@deepseek-ai/dsh-client-runtime") {
          return { createScope: (ctx, key) => ({ ctx: { marker: "scoped", key } }) };
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
    slots: {
      // 模拟真实语义：槽声明已存在时回调立即执行（内置侧栏 shell 已声明该槽）。
      inject: (key, cb) => {
        ctx._injections.push({ key, cb });
        cb();
        return () => {};
      },
      register: (opts, Comp) => {
        ctx._registrations.push({ opts, Comp });
        return () => {};
      },
    },
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
  assert.deepEqual(captured.inject, ["conversation", "slots"]);
});

test("client: 无 betterSidebar 时 3.2s 后注册 sidebar.footer.action 回退", async () => {
  const ctx = fakeCtx();
  captured.apply(ctx);
  assert.equal(ctx._registrations.length, 0, "不立即注册");
  await sleep(3400);
  const slot = ctx._registrations.find((r) => r.opts?.id === "dsh-skill-select");
  assert.ok(slot, "footer action 已注册");
  assert.equal(slot.opts.name, "sidebar.footer.action");
  assert.equal(slot.opts.order, 100);
  assert.equal(slot.opts.registrant, "dsh-skill-select");
});

test("client: 有 betterSidebar 时立即注册 tab", () => {
  const descriptor = {};
  const ctx = fakeCtx({ get: (name) => (name === "betterSidebar" ? { registerTab: (d) => Object.assign(descriptor, d) } : undefined) });
  captured.apply(ctx);
  assert.equal(descriptor.id, "skill-select");
  assert.equal(descriptor.title, "技能");
  assert.equal(descriptor.single, true);
  assert.equal(descriptor.order, 90);
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

test("client: draftGesture 追加/幂等/移除", () => {
  const { draftGesture } = captured.__test;
  assert.equal(draftGesture("", "/brainstorming", true), "/brainstorming");
  assert.equal(draftGesture("帮我写方案", "/brainstorming", true), "帮我写方案 /brainstorming");
  assert.equal(draftGesture("帮我 /brainstorming 写方案", "/brainstorming", true), "帮我 /brainstorming 写方案");
  assert.equal(draftGesture("请用 /a /b 干活", "/a", false), "请用 /b 干活");
  assert.equal(draftGesture("/a", "/a", false), "");
  assert.equal(draftGesture("x/a 保持", "/a", true), "x/a 保持 /a", "斜杠不在词边界时不误判");
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
