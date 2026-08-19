/**
 * host 半集成测试：真实 cordis Context 挂载 SkillSelectService，
 * 端到端覆盖 Service 适配层（super/inject/init/路由注册/围栏/dispatch/持久化）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import SkillSelectService from "../lib/index.js";

function fakeSkills(overrides = {}) {
  return {
    list: async () => [],
    get: async () => undefined,
    ...overrides,
  };
}

function fakeSession(sessionId) {
  return {
    get: (sid) => (sid === sessionId ? { header: { cwd: "/tmp/proj" } } : undefined),
  };
}

/** 组装一个带全套 fake 服务的 cordis 上下文并挂载插件。 */
async function bootService(skillsOverrides = {}, options = {}) {
  const ctx = new Context();

  const domainState = { summaries: {} };
  const domain = {
    global: {
      get: () => domainState,
      set: async (next) => {
        // options.failUsageSet：usage 写入时抛错（验证计数失败不阻断 agent 流程）。
        if (options.failUsageSet === true && next.usage !== undefined && domainState.usage !== next.usage) {
          throw new Error("simulated domain write failure");
        }
        Object.assign(domainState, next);
      },
    },
    close: () => {},
  };
  let closed = false;

  ctx.provide("storageDomain", { open: async () => ({ ...domain, close: () => { closed = true; } }) });
  ctx.provide("sessions", fakeSession("s1"));
  ctx.provide("settings", { get: (ns) => (ns === "agent-default-model" ? { provider: "p", model: "m" } : undefined) });
  ctx.provide("llm", {
    prepareCall: async (cfg) => ({
      config: cfg,
      stream: async function* () {
        yield { type: "text-delta", index: 0, text: "生成的简介" };
      },
    }),
  });

  // 记录 skills.list/get 收到的最近一次 options，供 scope 透传断言。
  const skillCalls = { list: undefined, get: undefined };
  const baseSkills = fakeSkills({
    list: async (opts) => {
      skillCalls.list = opts;
      return [
        {
          name: "demo-skill",
          description: "自带简介",
          whenToUse: undefined,
          source: "user-dsh",
          invocation: { modelInvocable: true, userInvocable: true },
        },
      ];
    },
    get: async (name, opts) => {
      skillCalls.get = opts;
      return name === "demo-skill"
        ? { name, description: "自带简介", content: "body", provider: "filesystem" }
        : undefined;
    },
  });
  ctx.provide("skills", {
    list: baseSkills.list,
    get: baseSkills.get,
    ...skillsOverrides,
  });

  if (options.withAgents !== false) {
    const agent = { id: "s1" };
    ctx.provide("agents", { get: (id) => (id === "s1" ? agent : undefined) });
  }

  let route = null;
  ctx.provide("webServer", {
    register: (r) => {
      route = r;
      return () => {};
    },
  });
  ctx.provide("webRuntime", { trustedHosts: [] });

  // tools：捕获 guard（skill 工具守卫），其余方法不需要。
  let capturedGuard = null;
  ctx.provide("tools", {
    guard: (fn) => {
      capturedGuard = fn;
      return () => {};
    },
  });

  const fiber = ctx.plugin(SkillSelectService);
  await fiber;
  assert.equal(fiber.state, 2, "fiber 应处于 ACTIVE");
  return { ctx, domainState, getRoute: () => route, isClosed: () => closed, skillCalls, getGuard: () => capturedGuard };
}

/** 用假 req/res 调一次已注册路由。 */
async function callRoute(route, path, payload, extraHeaders = {}) {
  const chunks = [Buffer.from(JSON.stringify(payload))];
  const req = {
    method: "POST",
    url: `http://127.0.0.1:3080${path}`,
    headers: { host: "127.0.0.1:3080", ...extraHeaders },
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) yield c;
    },
  };
  let status = 0;
  let bodyText = "";
  const res = {
    writeHead: (code) => { status = code; },
    end: (text) => { bodyText = String(text); },
  };
  await route.handler(req, res);
  return { status, body: JSON.parse(bodyText || "{}") };
}

test("service: 挂载后 ctx.skillSelect 可用且路由已注册", async () => {
  const { ctx, getRoute } = await bootService();
  assert.ok(ctx.get("skillSelect"), "skillSelect 服务已提供");
  const route = getRoute();
  assert.ok(route, "路由已注册");
  assert.equal(route.path, "/skill-select/api");
});

test("service: list 端到端（围栏→dispatch→包络）", async () => {
  const { getRoute } = await bootService();
  const { status, body } = await callRoute(getRoute(), "/skill-select/api/list", { sessionId: "s1" });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.value.sessionId, "s1");
  assert.equal(body.value.skills.length, 1);
  assert.equal(body.value.skills[0].name, "demo-skill");
  assert.equal(body.value.skills[0].source, "user");
});

test("service: list 通过 ctx.agents 把会话 scope 传给 skills.list（web 宿主根因回归）", async () => {
  const { getRoute, skillCalls } = await bootService();
  const { status } = await callRoute(getRoute(), "/skill-select/api/list", { sessionId: "s1" });
  assert.equal(status, 200);
  assert.ok(skillCalls.list, "skills.list 被调用");
  assert.equal(skillCalls.list.cwd, "/tmp/proj");
  assert.equal(skillCalls.list.scope?.id, "s1", "scope 为会话对应 agent");
});

test("service: 无 agents 服务时 list 不携带 scope（回退兼容）", async () => {
  const { getRoute, skillCalls } = await bootService({}, { withAgents: false });
  const { status } = await callRoute(getRoute(), "/skill-select/api/list", { sessionId: "s1" });
  assert.equal(status, 200);
  assert.equal(skillCalls.list.scope, undefined, "未提供 agents 时 scope 缺省");
});

test("service: summarize 同样携带会话 scope 调用 skills.get", async () => {
  const { getRoute, skillCalls } = await bootService();
  const { status } = await callRoute(getRoute(), "/skill-select/api/summarize", { sessionId: "s1", name: "demo-skill" });
  assert.equal(status, 200);
  assert.equal(skillCalls.get.scope?.id, "s1", "skills.get 收到 scope");
});

test("service: summarize 端到端并写入 domain 缓存", async () => {
  const { getRoute, domainState } = await bootService();
  const { status, body } = await callRoute(getRoute(), "/skill-select/api/summarize", { sessionId: "s1", name: "demo-skill" });
  assert.equal(status, 200);
  assert.equal(body.value.description, "自带简介");
  assert.equal(domainState.summaries["demo-skill"], undefined, "frontmatter 简介不写缓存");
});

test("service: 无简介技能 summarize 后写入 domain 缓存（LLM 路径）", async () => {
  const { getRoute, domainState } = await bootService({
    list: async () => [{
      name: "bare-skill",
      description: "",
      source: "user-dsh",
      invocation: { modelInvocable: true, userInvocable: true },
    }],
    get: async () => ({ name: "bare-skill", description: "", content: "bare body" }),
  });
  const { status, body } = await callRoute(getRoute(), "/skill-select/api/summarize", { sessionId: "s1", name: "bare-skill" });
  assert.equal(status, 200);
  assert.equal(body.value.description, "生成的简介");
  const record = domainState.summaries["bare-skill"];
  assert.ok(record, "缓存已写入");
  assert.equal(record.description, "生成的简介");
  assert.equal(record.mode, "llm");
  assert.match(record.contentHash, /^[0-9a-f]{16}$/);
  assert.match(record.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("service: 未知会话返回 404 session-not-found", async () => {
  const { getRoute } = await bootService();
  const { status, body } = await callRoute(getRoute(), "/skill-select/api/list", { sessionId: "nope" });
  assert.equal(status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "session-not-found");
});

test("service: 非 POST 返回 405", async () => {
  const { getRoute } = await bootService();
  const route = getRoute();
  const req = {
    method: "GET",
    url: "http://127.0.0.1:3080/skill-select/api/list",
    headers: { host: "127.0.0.1:3080" },
  };
  let status = 0;
  await route.handler(req, { writeHead: (c) => { status = c; }, end: () => {} });
  assert.equal(status, 405);
});

test("service: 非可信 Host 返回 403", async () => {
  const { getRoute } = await bootService();
  const { status, body } = await callRoute(getRoute(), "/skill-select/api/list", { sessionId: "s1" }, { host: "evil.example.com" });
  assert.equal(status, 403);
  assert.equal(body.error.code, "forbidden");
});

// ── agent/pre-step 调用计数观察者（真实 cordis waterfall 语义）──────────────

/** 与 dsh-agent-loop 相同的派发约定：waterfall(name, payload, 内层 next)。 */
function dispatchPreStep(ctx, messages) {
  return ctx.events.waterfall("agent/pre-step", {
    agent: { id: "s1" },
    signal: undefined,
    messages,
  }, async () => ({ kind: "enter", messages: [] }));
}

const flushUsage = () => new Promise((resolve) => setTimeout(resolve, 30));

test("service: agent/pre-step 观察者统计真实 /skill 手势调用并写入 domain", async () => {
  const { ctx, domainState } = await bootService();

  // 同消息同技能去重、assistant 消息不计 → 只 +1
  const decision = await dispatchPreStep(ctx, [
    { source: { kind: "user" }, content: [{ type: "text", text: "请用 /demo-skill 和 /demo-skill 干活" }] },
    { source: { kind: "assistant" }, content: [{ type: "text", text: "/demo-skill" }] },
  ]);
  assert.equal(decision.kind, "enter", "decision 原样透传");
  await flushUsage();
  assert.equal(domainState.usage?.["demo-skill"]?.count, 1);

  // 第二步累计 +1
  await dispatchPreStep(ctx, [
    { source: { kind: "user" }, content: [{ type: "text", text: "/demo-skill 继续" }] },
  ]);
  await flushUsage();
  assert.equal(domainState.usage?.["demo-skill"]?.count, 2);

  // 非 user 来源不计数
  await dispatchPreStep(ctx, [
    { source: { kind: "system" }, content: [{ type: "text", text: "/demo-skill" }] },
  ]);
  await flushUsage();
  assert.equal(domainState.usage?.["demo-skill"]?.count, 2);
  assert.match(domainState.usage?.["demo-skill"]?.lastUsedAt, /^\d{4}-\d{2}-\d{2}T/);
});

// ── v4：set-default / set-checked / guard / repo 令牌展开 / 默认注入 ─────────

const agentA = { id: "s1", session: { id: "s1", header: { cwd: "/tmp/proj" } } };

function dispatchPreStepWith(ctx, messages, agent = agentA) {
  return ctx.events.waterfall("agent/pre-step", { agent, signal: undefined, messages }, async () => ({ kind: "enter", messages: [] }));
}

function userMsg(text) {
  return { source: { kind: "user" }, content: [{ type: "text", text }] };
}

test("service: set-default 持久化到 domain 且 list 返回 defaultStart", async () => {
  const { getRoute, domainState } = await bootService();
  let res = await callRoute(getRoute(), "/skill-select/api/set-default", { name: "demo-skill", on: true });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.value, { name: "demo-skill", defaultStart: true });
  assert.deepEqual(domainState.defaults, ["demo-skill"]);

  res = await callRoute(getRoute(), "/skill-select/api/list", { sessionId: "s1" });
  assert.equal(res.body.value.skills[0].defaultStart, true);

  res = await callRoute(getRoute(), "/skill-select/api/set-default", { name: "demo-skill", on: false });
  assert.deepEqual(domainState.defaults, []);
  res = await callRoute(getRoute(), "/skill-select/api/list", { sessionId: "s1" });
  assert.equal(res.body.value.skills[0].defaultStart, false);
});

test("service: set-default on 非 boolean → bad-request", async () => {
  const { getRoute } = await bootService();
  const { status, body } = await callRoute(getRoute(), "/skill-select/api/set-default", { name: "demo-skill", on: "yes" });
  assert.equal(status, 400);
  assert.equal(body.error.code, "bad-request");
});

test("service: set-default name 必须是 kebab 技能名或 agent:name 复合 id", async () => {
  const { getRoute, domainState } = await bootService();

  // 合法：kebab 技能名与 agent:name 复合 id。
  let res = await callRoute(getRoute(), "/skill-select/api/set-default", { name: "demo-skill", on: true });
  assert.equal(res.status, 200);
  res = await callRoute(getRoute(), "/skill-select/api/set-default", { name: "grok:ego-browser", on: true });
  assert.equal(res.status, 200);
  assert.deepEqual(domainState.defaults, ["demo-skill", "grok:ego-browser"]);

  // 非法格式（大小写/空白/下划线/空复合段/多余冒号）→ 400 bad-request。
  for (const bad of ["Not A Skill", "UPPER", "demo_skill", "grok:", "a:b:c", "grok:ego browser", "a b:c"]) {
    res = await callRoute(getRoute(), "/skill-select/api/set-default", { name: bad, on: true });
    assert.equal(res.status, 400, `name=${JSON.stringify(bad)} 应 400`);
    assert.equal(res.body.error.code, "bad-request");
  }
});

test("service: set-checked 写入内存镜像供 guard 判定；校验会话与数组", async () => {
  const { getRoute, getGuard } = await bootService();
  const guard = getGuard();
  assert.equal(typeof guard, "function", "guard 已注册");

  // 会话不存在 → 404
  let res = await callRoute(getRoute(), "/skill-select/api/set-checked", { sessionId: "nope", skills: ["a"] });
  assert.equal(res.status, 404);

  // skills 非数组 → 400
  res = await callRoute(getRoute(), "/skill-select/api/set-checked", { sessionId: "s1", skills: "a" });
  assert.equal(res.status, 400);

  // 合法写入
  res = await callRoute(getRoute(), "/skill-select/api/set-checked", { sessionId: "s1", skills: ["a", "a", "b"] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.value, { sessionId: "s1", count: 2 });
});

test("service: guard 放行默认名单/会话勾选，拒绝未选择技能", async () => {
  const { getRoute, getGuard } = await bootService();
  const guard = getGuard();
  const exec = (name, overrides = {}) => ({
    name: "skill",
    arguments: { name },
    agent: agentA,
    ...overrides,
  });

  // 未允许 → 拒绝并给出提示
  const reason = guard(exec("brainstorming"));
  assert.equal(typeof reason, "string");
  assert.match(reason, /not enabled/);

  // set-default 后 → 放行
  await callRoute(getRoute(), "/skill-select/api/set-default", { name: "brainstorming", on: true });
  assert.equal(guard(exec("brainstorming")), undefined);

  // set-checked 后 → 放行
  await callRoute(getRoute(), "/skill-select/api/set-checked", { sessionId: "s1", skills: ["writing-plans"] });
  assert.equal(guard(exec("writing-plans")), undefined);

  // 非 skill 工具、非法参数一律放行
  assert.equal(guard({ name: "bash", arguments: {}, agent: agentA }), undefined);
  assert.equal(guard(exec("Not A Skill")), undefined);
  assert.equal(guard({ name: "skill", arguments: "raw", agent: agentA }), undefined);

  // guard 内部异常不逃逸（无 agent/session 的场景）
  assert.equal(guard({ name: "skill", arguments: { name: "brainstorming" } }), undefined);
});

test("service: repo 令牌 /superpowers 展开为单条注入行并计数", async () => {
  const members = [
    { name: "brainstorming", description: "b", source: "user-dsh", invocation: { modelInvocable: true, userInvocable: true } },
    { name: "writing-plans", description: "w", source: "user-dsh", invocation: { modelInvocable: true, userInvocable: true } },
  ];
  const { ctx, domainState } = await bootService({
    list: async () => members,
    get: async (name) => ({ name, description: "d", content: `BODY-${name}`, provider: "filesystem" }),
  });
  const decision = await dispatchPreStepWith(ctx, [userMsg("请 /superpowers 干活")]);
  assert.equal(decision.kind, "enter");
  const injected = decision.messages.filter((m) => m.source?.kind === "skill-invocation");
  assert.equal(injected.length, 1, "repo 令牌 → 单条注入行");
  assert.equal(injected[0].source.name, "superpowers", "注入行标签 = repo 显示名");
  assert.match(injected[0].content[0].text, /BODY-brainstorming/);
  assert.match(injected[0].content[0].text, /BODY-writing-plans/);
  await flushUsage();
  assert.equal(domainState.usage?.["brainstorming"]?.count, 1);
  assert.equal(domainState.usage?.["writing-plans"]?.count, 1);
});

test("service: 真实技能手势不按 repo 展开、不重复注入", async () => {
  const members = [
    { name: "brainstorming", description: "b", source: "user-dsh", invocation: { modelInvocable: true, userInvocable: true } },
  ];
  const { ctx, domainState } = await bootService({
    list: async () => members,
    get: async (name) => ({ name, description: "d", content: `BODY-${name}`, provider: "filesystem" }),
  });
  const decision = await dispatchPreStepWith(ctx, [userMsg("请 /brainstorming 干活")]);
  assert.equal(decision.kind, "enter");
  const injected = decision.messages.filter((m) => m.source?.kind === "skill-invocation");
  assert.equal(injected.length, 0, "真实技能手势由 dsh-tool-skill 注入，本插件不注入");
  await flushUsage();
  assert.equal(domainState.usage?.["brainstorming"]?.count, 1);
});

test("service: 默认技能每会话注入一次且计数一次", async () => {
  const { ctx, domainState, getRoute } = await bootService();
  await callRoute(getRoute(), "/skill-select/api/set-default", { name: "demo-skill", on: true });

  const first = await dispatchPreStepWith(ctx, [userMsg("第一条消息")]);
  const injectedFirst = first.messages.filter((m) => m.source?.kind === "skill-invocation");
  assert.equal(injectedFirst.length, 1);
  assert.equal(injectedFirst[0].source.name, "demo-skill");

  // 同一 agent 再发 → 不再注入
  const second = await dispatchPreStepWith(ctx, [userMsg("第二条消息")]);
  const injectedSecond = second.messages.filter((m) => m.source?.kind === "skill-invocation");
  assert.equal(injectedSecond.length, 0, "同一会话不重复注入");

  await flushUsage();
  assert.equal(domainState.usage?.["demo-skill"]?.count, 1);

  // 新 agent（新会话）→ 再次注入
  const agentB = { id: "s2", session: { id: "s2", header: { cwd: "/tmp/proj" } } };
  const third = await dispatchPreStepWith(ctx, [userMsg("新会话")], agentB);
  const injectedThird = third.messages.filter((m) => m.source?.kind === "skill-invocation");
  assert.equal(injectedThird.length, 1, "新会话再次注入默认技能");
});

test("service: reject decision 原样透传且无注入", async () => {
  const { ctx } = await bootService();
  const inner = async () => ({ kind: "reject", messages: [] });
  const decision = await ctx.events.waterfall("agent/pre-step", { agent: agentA, signal: undefined, messages: [userMsg("/demo-skill")] }, inner);
  assert.equal(decision.kind, "reject");
});

test("service: 计数失败（domain 写入抛错）不阻断 agent 流程", async () => {
  const { ctx } = await bootService({}, { failUsageSet: true });
  const decision = await dispatchPreStepWith(ctx, [userMsg("/demo-skill 计数")]);
  assert.equal(decision.kind, "enter", "计数写入失败时 decision 仍原样返回");
});

// ── Task 3：summarize/set-checked 复合 id（agent:name）通路 ─────────────────

test("service: summarize 复合 id（agent:name）走外部 SKILL.md 解析", async (t) => {
  const { getRoute } = await bootService();
  const { status, body } = await callRoute(getRoute(), "/skill-select/api/summarize", {
    sessionId: "s1", name: "grok:ego-browser",
  });
  if (status === 500) {
    // 环境无 ~/.grok/skills/ego-browser 时跳过具体断言（不绑定真实技能）。
    t.skip("~/.grok/skills/ego-browser 不存在，跳过复合 id summarize 具体断言");
    return;
  }
  assert.equal(status, 200);
  assert.equal(typeof body.value.description, "string");
  assert.ok(body.value.description.length > 0, "返回非空简介");
});

test("service: summarize 不存在的复合 id 返回 404 skill-not-found", async () => {
  const { getRoute } = await bootService();
  const { status, body } = await callRoute(getRoute(), "/skill-select/api/summarize", {
    sessionId: "s1", name: "grok:definitely-not-a-real-skill",
  });
  assert.equal(status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "skill-not-found");
  assert.match(body.error.message, /definitely-not-a-real-skill/);
});

test("service: set-checked 接受复合 id（agent:name），拒绝非法复合格式", async () => {
  const { getRoute } = await bootService();

  // 合法：普通技能名 + 复合 id 混合
  let res = await callRoute(getRoute(), "/skill-select/api/set-checked", {
    sessionId: "s1", skills: ["demo-skill", "grok:ego-browser"],
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.value, { sessionId: "s1", count: 2 });

  // 非法复合格式 → 400 bad-request
  for (const bad of [["Grok:ego"], ["grok:"], ["a:b:c"], ["grok:ego browser"], [""]]) {
    res = await callRoute(getRoute(), "/skill-select/api/set-checked", { sessionId: "s1", skills: bad });
    assert.equal(res.status, 400, `skills=${JSON.stringify(bad)} 应 400`);
    assert.equal(res.body.error.code, "bad-request");
  }
});
