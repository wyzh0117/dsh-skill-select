import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import {
  SkillSelectApiError,
  buildRepoIndex,
  classifySource,
  externalRoots,
  extractFallbackDescription,
  hashContent,
  isAllowedSkill,
  isTrustedRequest,
  mergeUsage,
  parseExternalSkill,
  parseOriginMarker,
  openSkillView,
  readSessionCwd,
  resolveList,
  resolveRepo,
  resolveSummary,
  runUpdate,
  scanExternalGestures,
  scanSkillGestures,
  splitFrontmatter,
  toggleDefaults,
} from "../lib/index.js";

// ── helpers ────────────────────────────────────────────────────────────────

/** 没有默认模型时的 `ctx.agentDefaultModel` 替身（dsh 0.2 的读法）。 */
const noModel = { currentSelection: () => undefined };

function fakeSkill(overrides = {}) {
  return {
    name: "example-skill",
    description: "",
    whenToUse: undefined,
    source: "user-dsh",
    provider: "local",
    invocation: { modelInvocable: true, userInvocable: true },
    ...overrides,
  };
}

function fakeSessions(id) {
  return {
    get: (sid) => (sid === id ? { header: { cwd: "/tmp/proj" } } : undefined),
  };
}

// ── classifySource ─────────────────────────────────────────────────────────

test("classifySource: 全分支", () => {
  assert.equal(classifySource("project-dsh"), "project");
  assert.equal(classifySource("project-agents"), "project");
  assert.equal(classifySource("user-dsh"), "user");
  assert.equal(classifySource("user-agents"), "user");
  assert.equal(classifySource("bundled"), "bundled");
  assert.equal(classifySource("custom"), "other");
  assert.equal(classifySource("runtime"), "other");
  assert.equal(classifySource("weird-source"), "other");
});

// ── extractFallbackDescription ─────────────────────────────────────────────

test("extractFallbackDescription: 去掉 frontmatter 取首个非空行", () => {
  const content = [
    "---",
    "name: demo",
    "description: ignored-here",
    "---",
    "",
    "# 一个演示技能",
    "正文……",
  ].join("\n");
  assert.equal(extractFallbackDescription(content), "一个演示技能");
});

test("extractFallbackDescription: 无 frontmatter 的标题行", () => {
  assert.equal(extractFallbackDescription("# Title\n\nbody"), "Title");
});

test("extractFallbackDescription: 跳过代码围栏与注释", () => {
  assert.equal(extractFallbackDescription("```js\ncode\n```\n\n<!-- note -->\n实际用途"), "实际用途");
});

test("extractFallbackDescription: 空内容与超长截断", () => {
  assert.equal(extractFallbackDescription(""), null);
  assert.equal(extractFallbackDescription(undefined), null);
  const long = "x".repeat(120);
  assert.equal(extractFallbackDescription(long).length, 80);
});

// ── hashContent ────────────────────────────────────────────────────────────

test("hashContent: 确定性 16 位 hex", () => {
  const h = hashContent("abc");
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.equal(h, hashContent("abc"));
  assert.notEqual(h, hashContent("abd"));
});

// ── readSessionCwd ─────────────────────────────────────────────────────────
// dsh 0.2 的 `ctx.sessions` 只认已 enter 的活会话，网页端从历史打开的冷会话
// 一律 `get() === undefined`。冷读走 `ctx.sessionQuery.observeSession()`，
// 这三条锁住的就是"冷会话也能列出技能"这条主线，别再退回只读活存储。

/** 冷读替身：返回一个带 cwd 的 observation，并记录租约是否被释放。 */
function fakeSessionQuery(cwd, options = {}) {
  const state = { disposed: false, calls: [] };
  return {
    state,
    observeSession: async (sessionId, opts) => {
      state.calls.push({ sessionId, opts });
      if (options.error !== undefined) throw options.error;
      return {
        header: cwd === undefined ? {} : { cwd },
        [Symbol.dispose]: () => { state.disposed = true; },
      };
    },
  };
}

test("readSessionCwd: 冷会话（活存储查不到）经 sessionQuery 拿到 cwd，并释放租约", async () => {
  const query = fakeSessionQuery("/tmp/cold");
  const cwd = await readSessionCwd({
    sessions: { get: () => undefined },
    sessionQuery: query,
    sessionId: "s-cold",
  });
  assert.equal(cwd, "/tmp/cold");
  assert.equal(query.state.disposed, true, "observation 租约必须释放");
  assert.deepEqual(query.state.calls[0], { sessionId: "s-cold", opts: { projectionMode: "none" } });
});

test("readSessionCwd: sessionQuery 优先于活存储", async () => {
  const query = fakeSessionQuery("/tmp/cold");
  const cwd = await readSessionCwd({ sessions: fakeSessions("s1"), sessionQuery: query, sessionId: "s1" });
  assert.equal(cwd, "/tmp/cold");
});

test("readSessionCwd: 冷读的 SESSION_QUERY_SESSION_NOT_FOUND 映射为 404，其他失败为 500", async () => {
  const notFound = { code: "SESSION_QUERY_SESSION_NOT_FOUND", message: "no such session" };
  await assert.rejects(
    readSessionCwd({ sessionQuery: fakeSessionQuery(undefined, { error: notFound }), sessionId: "s1" }),
    (e) => e instanceof SkillSelectApiError && e.code === "session-not-found" && e.status === 404,
  );
  await assert.rejects(
    readSessionCwd({ sessionQuery: fakeSessionQuery(undefined, { error: new Error("backend down") }), sessionId: "s1" }),
    (e) => e instanceof SkillSelectApiError && e.status === 500 && /backend down/.test(e.message),
  );
});

test("readSessionCwd: 无 sessionQuery 的宿主退回活存储；两边都没有才 404", async () => {
  assert.equal(await readSessionCwd({ sessions: fakeSessions("s1"), sessionId: "s1" }), "/tmp/proj");
  await assert.rejects(
    readSessionCwd({ sessions: fakeSessions("s1"), sessionId: "nope" }),
    (e) => e instanceof SkillSelectApiError && e.code === "session-not-found",
  );
});

// ── openSkillView ──────────────────────────────────────────────────────────

/** 带投影（agentPreset）的冷读替身。 */
function fakeQueryWithPreset(cwd, preset) {
  const state = { released: false };
  return {
    state,
    observeSession: async () => ({
      header: { cwd },
      projections: { values: { agentPreset: preset } },
      [Symbol.dispose]: () => { state.released = true },
    }),
  };
}

test("openSkillView: 活会话用 agent 作 scope，并从 preset 隔离组取 skills 注册表", async () => {
  const agent = { id: "s1" };
  const scoped = { list: async () => [] };
  const host = { list: async () => [] };
  const view = await openSkillView({
    sessions: fakeSessions("s1"),
    sessionQuery: undefined,
    agents: { get: () => agent },
    agentPresets: {
      serviceFor: (a, name) => (a === agent && name === "skills" ? scoped : undefined),
      acquireScope: async () => { throw new Error("活会话不该租常驻 scope") },
    },
    skills: host,
    sessionId: "s1",
  });
  assert.equal(view.scope, agent);
  assert.equal(view.registry, scoped);
  await view.dispose();
});

test("openSkillView: 冷会话拿常驻预设租约作 scope，释放时两条租约一起还", async () => {
  const key = { preset: "standard" };
  let disposed = false;
  const query = fakeQueryWithPreset("/tmp/cold", "standard");
  const host = { list: async () => [] };
  const view = await openSkillView({
    sessions: { get: () => undefined },
    sessionQuery: query,
    agents: { get: () => undefined },
    agentPresets: {
      acquireScope: async (id) => {
        assert.equal(id, "standard", "按会话投影出的 preset 租 scope");
        return { key, [Symbol.asyncDispose]: async () => { disposed = true } };
      },
    },
    skills: host,
    sessionId: "s-cold",
  });
  assert.equal(view.cwd, "/tmp/cold");
  assert.equal(view.scope, key, "冷会话 scope 来自预设租约");
  assert.equal(view.registry, host, "无活 agent 时用宿主注册表");
  await view.dispose();
  assert.equal(disposed, true, "预设租约必须释放");
  assert.equal(query.state.released, true, "observation 必须释放");
});

test("openSkillView: 无 agentPresets 的宿主退回全局层（scope 缺省）", async () => {
  const host = { list: async () => [] };
  const view = await openSkillView({
    sessions: fakeSessions("s1"),
    agents: undefined,
    agentPresets: undefined,
    skills: host,
    sessionId: "s1",
  });
  assert.equal(view.scope, undefined);
  assert.equal(view.cwd, "/tmp/proj");
  assert.equal(view.registry, host);
  await view.dispose();
});

// ── resolveList ────────────────────────────────────────────────────────────

test("resolveList: 会话不存在抛 session-not-found", async () => {
  await assert.rejects(
    resolveList({ sessions: fakeSessions("s1"), skills: { list: async () => [] }, summaries: {}, sessionId: "nope" }),
    (e) => e instanceof SkillSelectApiError && e.code === "session-not-found",
  );
});

test("resolveList: 冷会话用 sessionQuery 的 cwd 列技能（活存储为空也能列出）", async () => {
  const seen = [];
  const skills = {
    list: async (view) => { seen.push(view); return [fakeSkill({ name: "cold-skill" })] },
    get: async () => undefined,
  };
  const result = await resolveList({
    sessions: { get: () => undefined },
    sessionQuery: fakeSessionQuery("/tmp/cold"),
    skills,
    summaries: {},
    sessionId: "s-cold",
  });
  assert.equal(seen[0].cwd, "/tmp/cold");
  assert.equal(result.skills[0].name, "cold-skill");
});

test("resolveList: 映射字段、frontmatter 简介直用、source 分类", async () => {
  const skills = {
    list: async ({ cwd }) => {
      assert.equal(cwd, "/tmp/proj");
      return [
        fakeSkill({ name: "local-skill", description: "  自带简介  ", source: "project-dsh" }),
        fakeSkill({ name: "user-skill", description: "", source: "user-dsh", whenToUse: "写计划时用" }),
        fakeSkill({ name: "bundled-skill", description: "", source: "bundled" }),
      ];
    },
    get: async () => undefined,
  };
  const { skills: views } = await resolveList({
    sessions: fakeSessions("s1"), skills, summaries: {}, sessionId: "s1",
  });
  const byName = Object.fromEntries(views.map((v) => [v.name, v]));
  assert.equal(byName["local-skill"].description, "自带简介");
  assert.equal(byName["local-skill"].source, "project");
  assert.equal(byName["user-skill"].description, null);
  assert.equal(byName["user-skill"].source, "user");
  assert.equal(byName["user-skill"].whenToUse, "写计划时用");
  assert.equal(byName["bundled-skill"].source, "bundled");
  assert.equal(byName["user-skill"].userInvocable, true);
  assert.equal(byName["user-skill"].modelInvocable, true);
});

test("resolveList: 缓存命中（hash 一致）与失效（hash 不一致）", async () => {
  const contentA = "body-a";
  let def = { content: contentA };
  const skills = {
    list: async () => [
      fakeSkill({ name: "hit", description: "" }),
      fakeSkill({ name: "stale", description: "" }),
    ],
    get: async (name) => (name === "hit" || name === "stale" ? { content: def.content } : undefined),
  };
  const summaries = {
    hit: { description: "命中简介", contentHash: hashContent(contentA) },
    stale: { description: "过期简介", contentHash: hashContent("old-body") },
  };
  const { skills: views } = await resolveList({ sessions: fakeSessions("s1"), skills, summaries, sessionId: "s1" });
  const byName = Object.fromEntries(views.map((v) => [v.name, v]));
  assert.equal(byName.hit.description, "命中简介");
  assert.equal(byName.stale.description, null);
});

test("resolveList: invocation 缺失默认双向可用", async () => {
  const skills = {
    list: async () => [fakeSkill({ name: "no-inv", description: "x", invocation: undefined })],
    get: async () => undefined,
  };
  const { skills: views } = await resolveList({ sessions: fakeSessions("s1"), skills, summaries: {}, sessionId: "s1" });
  assert.equal(views[0].userInvocable, true);
  assert.equal(views[0].modelInvocable, true);
});

test("resolveList: 通过 agents 解析会话 scope 并传给 skills.list 与缓存回查 get", async () => {
  // 根因回归：web 宿主把 skill-filesystem 挂进 agent preset 的 scoped 层，
  // 不带 scope 只能读到全局层 → 列表为空。agent 对象即 scope key。
  const agent = { id: "s1" };
  let listOptions;
  let getOptions;
  const skills = {
    list: async (opts) => {
      listOptions = opts;
      return [fakeSkill({ name: "cached-skill", description: "" })];
    },
    get: async (name, opts) => {
      getOptions = opts;
      return { content: "body-a" };
    },
  };
  const summaries = { "cached-skill": { description: "缓存简介", contentHash: hashContent("body-a") } };
  const agents = { get: (id) => (id === "s1" ? agent : undefined) };
  const { skills: views } = await resolveList({
    sessions: fakeSessions("s1"), skills, summaries, sessionId: "s1", agents,
  });
  assert.equal(listOptions.cwd, "/tmp/proj");
  assert.equal(listOptions.scope, agent, "skills.list 收到会话 scope");
  assert.equal(getOptions.scope, agent, "缓存回查 skills.get 同样收到 scope");
  assert.equal(views[0].description, "缓存简介");
});

test("resolveList: 无 agents 服务时不传 scope（无 scope 宿主回退兼容）", async () => {
  let listOptions;
  const skills = {
    list: async (opts) => {
      listOptions = opts;
      return [];
    },
    get: async () => undefined,
  };
  await resolveList({ sessions: fakeSessions("s1"), skills, summaries: {}, sessionId: "s1" });
  assert.equal(listOptions.cwd, "/tmp/proj");
  assert.equal(listOptions.scope, undefined, "scope 缺省（不携带）");
});

test("resolveList: agents 中查不到该会话时也不传 scope", async () => {
  let listOptions;
  const skills = {
    list: async (opts) => {
      listOptions = opts;
      return [];
    },
    get: async () => undefined,
  };
  const agents = { get: () => undefined };
  await resolveList({ sessions: fakeSessions("s1"), skills, summaries: {}, sessionId: "s1", agents });
  assert.equal(listOptions.scope, undefined);
});

// ── resolveSummary ─────────────────────────────────────────────────────────

test("resolveSummary: 技能不存在抛 skill-not-found", async () => {
  await assert.rejects(
    resolveSummary({ skills: { get: async () => undefined }, defaultModel: noModel, llm: {}, summaries: {}, name: "x", cwd: "/" }),
    (e) => e instanceof SkillSelectApiError && e.code === "skill-not-found",
  );
});

test("resolveSummary: frontmatter 简介直用且不写缓存", async () => {
  const skills = { get: async () => ({ name: "a", description: " 自带 ", content: "body" }) };
  const result = await resolveSummary({ skills, defaultModel: noModel, llm: {}, summaries: {}, name: "a", cwd: "/" });
  assert.equal(result.description, "自带");
  assert.equal(result.mode, "frontmatter");
  assert.equal(result.fromCache, false);
  assert.equal(result.contentHash, undefined);
});

test("resolveSummary: scope 透传给 skills.get", async () => {
  const agent = { id: "s1" };
  let getOptions;
  const skills = {
    get: async (name, opts) => {
      getOptions = opts;
      return { name, description: "自带", content: "body" };
    },
  };
  const result = await resolveSummary({
    skills, defaultModel: noModel, llm: {}, summaries: {}, name: "a", cwd: "/tmp/proj", scope: agent,
  });
  assert.equal(getOptions.cwd, "/tmp/proj");
  assert.equal(getOptions.scope, agent, "skills.get 收到会话 scope");
  assert.equal(result.description, "自带");
});

test("resolveSummary: 缓存命中", async () => {
  const content = "body-v1";
  const summaries = { a: { description: "缓存简介", contentHash: hashContent(content), mode: "llm" } };
  const skills = { get: async () => ({ name: "a", description: "", content }) };
  const result = await resolveSummary({ skills, defaultModel: noModel, llm: {}, summaries, name: "a", cwd: "/" });
  assert.equal(result.description, "缓存简介");
  assert.equal(result.fromCache, true);
});

test("resolveSummary: LLM 生成成功", async () => {
  const skills = { get: async () => ({ name: "a", description: "", content: "body" }) };
  const defaultModel = { currentSelection: () => ({ provider: "deepseek-official", model: "deepseek-v4-pro" }) };
  let seen = null;
  const llm = {
    prepareCall: async (cfg) => ({
      config: cfg,
      stream: async function* (options) {
        seen = options;
        yield { type: "text-delta", index: 0, text: "一句  " };
        yield { type: "text-delta", index: 0, text: "简介" };
      },
    }),
  };
  const result = await resolveSummary({ skills, defaultModel, llm, summaries: {}, name: "a", cwd: "/" });
  // dsh-llm 的 RequestUserInput.content 是 ContentBlock[]，不是裸字符串。
  assert.deepEqual(seen.messages[0].content, [{ type: "text", text: "Skill name: a\n\nSkill content:\nbody" }]);
  assert.equal(result.description, "一句 简介");
  assert.equal(result.mode, "llm");
  assert.equal(result.fromCache, false);
  assert.equal(result.contentHash, hashContent("body"));
});

test("resolveSummary: LLM 失败回退提取", async () => {
  const content = "# 手工兜底\n\n具体内容";
  const skills = { get: async () => ({ name: "a", description: "", content }) };
  const defaultModel = { currentSelection: () => ({ provider: "p", model: "m" }) };
  const llm = { prepareCall: async () => { throw new Error("llm down"); } };
  const result = await resolveSummary({ skills, defaultModel, llm, summaries: {}, name: "a", cwd: "/" });
  assert.equal(result.description, "手工兜底");
  assert.equal(result.mode, "fallback");
});

test("resolveSummary: 无默认模型 + 无正文 → internal 错误", async () => {
  const skills = { get: async () => ({ name: "a", description: "", content: "---\nname: a\n---\n" }) };
  const defaultModel = { currentSelection: () => undefined };
  const llm = { prepareCall: async () => { throw new Error("unreachable"); } };
  await assert.rejects(
    resolveSummary({ skills, defaultModel, llm, summaries: {}, name: "a", cwd: "/" }),
    (e) => e instanceof SkillSelectApiError && e.code === "internal",
  );
});

// ── isTrustedRequest ───────────────────────────────────────────────────────

test("isTrustedRequest: loopback 放行，非 loopback 拒绝", () => {
  assert.equal(isTrustedRequest({ headers: { host: "127.0.0.1:3080" } }, []), true);
  assert.equal(isTrustedRequest({ headers: { host: "localhost:3080" } }, []), true);
  assert.equal(isTrustedRequest({ headers: { host: "evil.example.com" } }, []), false);
});

test("isTrustedRequest: cross-site 拒绝", () => {
  assert.equal(
    isTrustedRequest({ headers: { host: "127.0.0.1:3080", "sec-fetch-site": "cross-site" } }, []),
    false,
  );
});

// ── resolveRepo ────────────────────────────────────────────────────────────

test("resolveRepo: 映射命中", () => {
  assert.equal(resolveRepo("brainstorming"), "superpowers");
  assert.equal(resolveRepo("writing-skills"), "superpowers");
  assert.equal(resolveRepo("auto-empirical-research-skills"), "Auto-Empirical-Research-Skills");
});

test("resolveRepo: 嵌套布局路径推断出 repo（未映射技能）", () => {
  assert.equal(
    resolveRepo("custom-skill", "/home/u/.dsh/skills/my-repo/custom-skill"),
    "my-repo",
  );
});

test("resolveRepo: 父目录为 skills 根目录返回 null（未映射技能）", () => {
  assert.equal(resolveRepo("custom-skill", "/home/u/.dsh/skills/custom-skill"), null);
});

test("resolveRepo: basename(dir) 不等于技能名（平铺 .md）返回 null", () => {
  assert.equal(resolveRepo("flat-skill", "/home/u/.dsh/skills"), null);
});

test("resolveRepo: 无 dirPath 返回 null", () => {
  assert.equal(resolveRepo("flat-skill"), null);
});

// ── scanSkillGestures ──────────────────────────────────────────────────────

test("scanSkillGestures: 提取用户消息中的手势", () => {
  const messages = [
    { source: { kind: "user" }, content: [{ type: "text", text: "用 /a 和 /b 干活" }] },
  ];
  assert.deepEqual(scanSkillGestures(messages), ["a", "b"]);
});

test("scanSkillGestures: 同技能去重", () => {
  const messages = [
    { source: { kind: "user" }, content: [{ type: "text", text: "/a /a /b /a" }] },
  ];
  assert.deepEqual(scanSkillGestures(messages), ["a", "b"]);
});

test("scanSkillGestures: 词边界（斜杠前非空白不匹配、行首匹配）", () => {
  assert.deepEqual(
    scanSkillGestures([{ source: { kind: "user" }, content: [{ type: "text", text: "x/a 不是手势" }] }]),
    [],
  );
  assert.deepEqual(
    scanSkillGestures([{ source: { kind: "user" }, content: [{ type: "text", text: "/a" }] }]),
    ["a"],
  );
});

test("scanSkillGestures: 忽略非 user 消息与非 text 块", () => {
  const messages = [
    { source: { kind: "assistant" }, content: [{ type: "text", text: "/a" }] },
    { source: { kind: "user" }, content: [{ type: "tool", text: "/b" }] },
    { source: { kind: "user" }, content: [{ type: "text", text: "/c" }] },
  ];
  assert.deepEqual(scanSkillGestures(messages), ["c"]);
});

test("scanSkillGestures: 消息块字段为 content；仅有 blocks 字段时不误扫", () => {
  // 生产事实：LLM 消息的块数组在 `content` 字段（dsh-tool-skill 同款）。
  const legacy = [{ source: { kind: "user" }, blocks: [{ type: "text", text: "/a" }] }];
  assert.deepEqual(scanSkillGestures(legacy), []);
});

test("scanSkillGestures: 空 / undefined messages 返回空数组", () => {
  assert.deepEqual(scanSkillGestures(undefined), []);
  assert.deepEqual(scanSkillGestures([]), []);
});

// ── mergeUsage ─────────────────────────────────────────────────────────────

test("mergeUsage: 空表新增", () => {
  const next = mergeUsage({}, ["a", "b"], "t1");
  assert.deepEqual(next, {
    a: { count: 1, lastUsedAt: "t1" },
    b: { count: 1, lastUsedAt: "t1" },
  });
});

test("mergeUsage: 已有计数 +1 且不改变其它键", () => {
  const usage = {
    a: { count: 1, lastUsedAt: "t0" },
    b: { count: 5, lastUsedAt: "t0" },
  };
  const next = mergeUsage(usage, ["a"], "t1");
  assert.equal(next.a.count, 2);
  assert.equal(next.a.lastUsedAt, "t1");
  assert.equal(next.b.count, 5);
  assert.equal(next.b.lastUsedAt, "t0");
});

test("mergeUsage: 返回新对象引用、输入对象不被 mutate", () => {
  const usage = { a: { count: 1, lastUsedAt: "t0" } };
  const next = mergeUsage(usage, ["a"], "t1");
  assert.notEqual(next, usage);
  assert.equal(usage.a.count, 1);
  assert.equal(usage.a.lastUsedAt, "t0");
});

// ── resolveList 新增语义 ────────────────────────────────────────────────────

test("resolveList: 嵌套技能按 resourceBase.path 拿到 repo", async () => {
  const skills = {
    list: async () => [fakeSkill({ name: "custom-skill", description: "有简介" })],
    get: async () => ({
      content: "body",
      resourceBase: { kind: "directory", path: "/home/u/.dsh/skills/my-repo/custom-skill" },
    }),
  };
  const { skills: views } = await resolveList({
    sessions: fakeSessions("s1"), skills, summaries: {}, sessionId: "s1",
  });
  assert.equal(views[0].repo, "my-repo");
});

test("resolveList: 映射命中的技能不触发 skills.get，仅未映射技能触发", async () => {
  const getCalls = [];
  const skills = {
    list: async () => [
      fakeSkill({ name: "brainstorming", description: "" }),
      fakeSkill({ name: "other-skill", description: "" }),
    ],
    get: async (name) => {
      getCalls.push(name);
      return undefined;
    },
  };
  const { skills: views } = await resolveList({
    sessions: fakeSessions("s1"), skills, summaries: {}, sessionId: "s1",
  });
  assert.deepEqual(getCalls, ["other-skill"]);
  const byName = Object.fromEntries(views.map((v) => [v.name, v]));
  assert.equal(byName.brainstorming.repo, "superpowers");
});

test("resolveList: usage 映射到 view.usage（无记录为 0）", async () => {
  const skills = {
    list: async () => [
      fakeSkill({ name: "usage-skill", description: "有简介" }),
      fakeSkill({ name: "usage-zero", description: "有简介" }),
    ],
    get: async () => undefined,
  };
  const { skills: views } = await resolveList({
    sessions: fakeSessions("s1"),
    skills,
    summaries: {},
    usage: { "usage-skill": { count: 7, lastUsedAt: "t1" } },
    sessionId: "s1",
  });
  const byName = Object.fromEntries(views.map((v) => [v.name, v]));
  assert.equal(byName["usage-skill"].usage, 7);
  assert.equal(byName["usage-zero"].usage, 0);
});

test("resolveList: 无 usage 参数时默认 0", async () => {
  const skills = {
    list: async () => [fakeSkill({ name: "no-usage-skill", description: "有简介" })],
    get: async () => undefined,
  };
  const { skills: views } = await resolveList({
    sessions: fakeSessions("s1"), skills, summaries: {}, sessionId: "s1",
  });
  assert.equal(views[0].usage, 0);
});

test("resolveList: repo 推断 get 失败时 repo 为 null 且不抛错", async () => {
  const skills = {
    list: async () => [fakeSkill({ name: "x-skill", description: "有简介" })],
    get: async () => { throw new Error("get down"); },
  };
  const { skills: views } = await resolveList({
    sessions: fakeSessions("s1"), skills, summaries: {}, sessionId: "s1",
  });
  assert.equal(views[0].repo, null);
});

// ── v4：默认启动名单 / 守卫判定 / repo 索引 ───────────────────────────────

test("toggleDefaults: 加入去重、移除、不改输入", () => {
  const base = ["a", "b"];
  assert.deepEqual(toggleDefaults(base, "b", true), ["a", "b"]);
  assert.deepEqual(toggleDefaults(base, "c", true), ["a", "b", "c"]);
  assert.deepEqual(toggleDefaults(base, "a", false), ["b"]);
  assert.deepEqual(base, ["a", "b"], "输入不被 mutate");
  assert.deepEqual(toggleDefaults(undefined, "x", true), ["x"]);
});

test("isAllowedSkill: 默认名单 ∪ 会话勾选", () => {
  assert.equal(isAllowedSkill(["a"], [], "a"), true);
  assert.equal(isAllowedSkill([], ["b"], "b"), true);
  assert.equal(isAllowedSkill(["a"], ["b"], "c"), false);
  assert.equal(isAllowedSkill([], undefined, "c"), false);
});

test("buildRepoIndex: 分组、小写键、忽略 null、保留显示名", () => {
  const repoByName = new Map([
    ["a-skill", "SuperPowers"],
    ["b-skill", "SuperPowers"],
    ["c-skill", null],
    ["d-skill", ""],
  ]);
  const index = buildRepoIndex(repoByName, [
    { name: "a-skill" }, { name: "b-skill" }, { name: "c-skill" }, { name: "d-skill" },
  ]);
  assert.equal(index.size, 1);
  assert.deepEqual(index.get("superpowers"), { repo: "SuperPowers", members: ["a-skill", "b-skill"] });
});

test("resolveList: defaults 参数映射 defaultStart", async () => {
  const skills = {
    list: async () => [
      fakeSkill({ name: "on-skill", description: "x" }),
      fakeSkill({ name: "off-skill", description: "x" }),
    ],
    get: async () => undefined,
  };
  const { skills: views } = await resolveList({
    sessions: fakeSessions("s1"), skills, summaries: {}, defaults: ["on-skill"], sessionId: "s1",
  });
  const byName = Object.fromEntries(views.map((v) => [v.name, v]));
  assert.equal(byName["on-skill"].defaultStart, true);
  assert.equal(byName["off-skill"].defaultStart, false);
});

test("resolveList: 未传 defaults 时全部 defaultStart=false", async () => {
  const skills = {
    list: async () => [fakeSkill({ name: "a-skill", description: "x" })],
    get: async () => undefined,
  };
  const { skills: views } = await resolveList({
    sessions: fakeSessions("s1"), skills, summaries: {}, sessionId: "s1",
  });
  assert.equal(views[0].defaultStart, false);
});

// ── 外部技能解析 ─────────────────────────────────────────────────────────

test("externalRoots resolves ~ against home", () => {
  const roots = externalRoots("/Users/me");
  assert.deepEqual(roots, [
    { agent: "codex", path: "/Users/me/.codex/skills" },
    { agent: "grok", path: "/Users/me/.grok/skills" },
    { agent: "hermes", path: "/Users/me/.hermes/skills" },
  ]);
});

test("splitFrontmatter separates yaml frontmatter and body", () => {
  const raw = "---\nname: x\ndescription: hello\n---\n\n# Body\nline\n";
  assert.equal(splitFrontmatter(raw).frontmatter, "name: x\ndescription: hello");
  assert.equal(splitFrontmatter(raw).body, "\n# Body\nline\n");
  assert.deepEqual(splitFrontmatter("no frontmatter"), { frontmatter: null, body: "no frontmatter" });
});

test("parseExternalSkill reads description/whenToUse and keeps body", () => {
  const raw = [
    "---",
    "description: >",
    "  Folded description line.",
    "whenToUse: when needed",
    "---",
    "",
    "# Real body",
  ].join("\n");
  const skill = parseExternalSkill({ agent: "grok", name: "ego-browser", raw, dirPath: "/tmp/grok/ego-browser" });
  assert.equal(skill.name, "ego-browser");
  assert.equal(skill.description, "Folded description line.");
  assert.equal(skill.whenToUse, "when needed");
  assert.equal(skill.content, "\n# Real body");
  assert.deepEqual(skill.resourceBase, { kind: "directory", path: "/tmp/grok/ego-browser" });
});

// ── 外部手势扫描 ─────────────────────────────────────────────────────────

test("scanExternalGestures extracts agent:name tokens", () => {
  const msgs = [
    { source: { kind: "user" }, content: [{ type: "text", text: "use /ego-browser@grok now and /foo@codex" }] },
    { source: { kind: "assistant" }, content: [{ type: "text", text: "/ignored@hermes" }] },
  ];
  assert.deepEqual(scanExternalGestures(msgs), ["grok:ego-browser", "codex:foo"]);
});

test("scanExternalGestures ignores plain /name and dedupes", () => {
  const msgs = [{ source: { kind: "user" }, content: [{ type: "text", text: "/brainstorming /ego-browser@grok /ego-browser@grok" }] }];
  assert.deepEqual(scanExternalGestures(msgs), ["grok:ego-browser"]);
});

test("resolveList includes external skills with agent grouping and defaultStart", async () => {
  const list = await resolveList({
    sessions: fakeSessions("s1"),
    skills: { list: async () => [], get: async () => undefined },
    summaries: {},
    usage: { "grok:ego-browser": { count: 2, lastUsedAt: "x" } },
    defaults: ["grok:ego-browser"],
    sessionId: "s1",
  });
  // external 必须为数组，且每项带完整字段（不绑定具体机器上存在的技能）。
  assert.ok(Array.isArray(list.external), "external 为数组");
  for (const e of list.external) {
    assert.equal(typeof e.id, "string", "id 为字符串");
    assert.equal(typeof e.agent, "string", "agent 为字符串");
    assert.equal(typeof e.name, "string", "name 为字符串");
    assert.equal(typeof e.repo, "string", "repo 为字符串");
    assert.equal(typeof e.usage, "number", "usage 为数字");
    assert.equal(typeof e.defaultStart, "boolean", "defaultStart 为布尔");
  }
  // 机器上存在 ~/.grok/skills/ego-browser 时，校验其具体聚合值。
  const ext = list.external.find((e) => e.id === "grok:ego-browser");
  if (ext !== undefined) {
    assert.equal(ext.agent, "grok");
    assert.equal(ext.repo, "grok");
    assert.equal(ext.usage, 2);
    assert.equal(ext.defaultStart, true);
  }
});

// ── parseOriginMarker ─────────────────────────────────────────────────────

test("parseOriginMarker reads source/commit/version", () => {
  const txt = "source=https://github.com/obra/superpowers.git\ncommit=b36e082\nversion=v6.3.0\ninstalled=2026-08-14\n";
  assert.deepEqual(parseOriginMarker(txt), { source: "https://github.com/obra/superpowers.git", commit: "b36e082", version: "v6.3.0" });
  assert.equal(parseOriginMarker("no source here"), null);
});

// ── runUpdate ─────────────────────────────────────────────────────────────

test("runUpdate: 坏 .git → failed；无 .git 无标记 → skipped；非法 source → failed", async () => {
  // 全部在 node:os tmpdir 下创建，测完清理；不发起任何真实网络克隆。
  const base = await mkdtemp(join(tmpdir(), "skill-select-test-"));
  try {
    const root = join(base, "root");
    // 无 .git、无来源标记的普通目录 → skipped。
    await mkdir(join(root, "plain"), { recursive: true });
    // 坏 .git：.git 目录存在但非有效仓库，git rev-parse/pull 必失败 → failed。
    await mkdir(join(root, "broken", ".git"), { recursive: true });
    // source 非合法协议前缀（以 `-` 开头会被 git 当作选项）→ 克隆前校验拒绝。
    await mkdir(join(root, "evil"), { recursive: true });
    await writeFile(
      join(root, "evil", ".superpowers-origin.txt"),
      "source=-upload-pack=git@example.com:repo.git\n",
      "utf8",
    );
    const items = await runUpdate([{ id: "test", path: root }]);
    const byName = Object.fromEntries(items.map((i) => [i.name, i]));
    assert.equal(byName.plain.status, "skipped");
    assert.equal(byName.plain.reason, "no update source");
    assert.equal(byName.broken.status, "failed");
    assert.ok(typeof byName.broken.reason === "string" && byName.broken.reason !== "", "坏 .git 必须带 reason");
    assert.equal(byName.evil.status, "failed");
    assert.equal(byName.evil.reason, 'invalid origin source "-upload-pack=git@example.com:repo.git"');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("runUpdate: git 已最新 → skipped(already up to date)；有新提交 → updated；agents 根 id 带前缀", async () => {
  // 真实本地 git 仓库（无网络）：克隆 origin 后 pull 无变更 → skipped；
  // origin 前进一个提交再 pull → updated 且 changes 含新提交行。
  const exec = promisify(execFileCb);
  const git = (args) => exec("git", args, { timeout: 30000 });
  const ident = ["-c", "user.name=T", "-c", "user.email=t@e.c"];
  const base = await mkdtemp(join(tmpdir(), "skill-select-test-"));
  try {
    const origin = join(base, "origin");
    await mkdir(origin, { recursive: true });
    await git(["init", "-b", "main", origin]);
    await writeFile(join(origin, "a.txt"), "v1\n", "utf8");
    await git([...ident, "-C", origin, "add", "."]);
    await git([...ident, "-C", origin, "commit", "-m", "init"]);

    // dsh-global 根：克隆 repo（与 origin 同步）→ pull 无变更 → skipped，裸名 id。
    const globalRoot = join(base, "global");
    await mkdir(globalRoot, { recursive: true });
    const repo = join(globalRoot, "repo");
    await git(["clone", origin, repo]);

    // agents 根：普通无来源目录 → skipped，但 id 必须带 agents: 前缀（不与 dsh-global 冲突）。
    const agentsRoot = join(base, "agents");
    await mkdir(join(agentsRoot, "plain"), { recursive: true });

    const first = await runUpdate([
      { id: "dsh-global", path: globalRoot },
      { id: "agents", path: agentsRoot },
    ]);
    const globalRepo = first.find((i) => i.source === "dsh-global" && i.name === "repo");
    assert.equal(globalRepo.id, "repo", "dsh-global 保持裸名 id");
    assert.equal(globalRepo.status, "skipped");
    assert.equal(globalRepo.reason, "already up to date");
    assert.deepEqual(globalRepo.changes, [], "skipped 时 changes 为空");
    const agentsPlain = first.find((i) => i.source === "agents" && i.name === "plain");
    assert.equal(agentsPlain.id, "agents:plain", "agents 根 id 带 agents: 前缀");
    assert.equal(agentsPlain.status, "skipped");

    // origin 前进一个提交 → 再次 pull → updated，changes 含新提交摘要行。
    await writeFile(join(origin, "a.txt"), "v2\n", "utf8");
    await git([...ident, "-C", origin, "add", "."]);
    await git([...ident, "-C", origin, "commit", "-m", "second"]);
    const second = await runUpdate([{ id: "dsh-global", path: globalRoot }]);
    const updated = second.find((i) => i.name === "repo");
    assert.equal(updated.status, "updated");
    assert.ok(updated.before !== updated.after, "before/after HEAD 应不同");
    assert.equal(updated.changes.length, 1);
    assert.match(updated.changes[0], /second/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
