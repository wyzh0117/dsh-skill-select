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
async function bootService(skillsOverrides = {}) {
  const ctx = new Context();

  const domainState = { summaries: {} };
  const domain = {
    global: {
      get: () => domainState,
      set: async (next) => Object.assign(domainState, next),
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
  ctx.provide("skills", fakeSkills({
    list: async () => [
      {
        name: "demo-skill",
        description: "自带简介",
        whenToUse: undefined,
        source: "user-dsh",
        invocation: { modelInvocable: true, userInvocable: true },
      },
    ],
    get: async (name) => (name === "demo-skill"
      ? { name, description: "自带简介", content: "body" }
      : undefined),
    ...skillsOverrides,
  }));

  let route = null;
  ctx.provide("webServer", {
    register: (r) => {
      route = r;
      return () => {};
    },
  });
  ctx.provide("webRuntime", { trustedHosts: [] });

  const fiber = ctx.plugin(SkillSelectService);
  await fiber;
  assert.equal(fiber.state, 2, "fiber 应处于 ACTIVE");
  return { ctx, domainState, getRoute: () => route, isClosed: () => closed };
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
