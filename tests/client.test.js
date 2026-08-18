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
