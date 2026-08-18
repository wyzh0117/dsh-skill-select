import test from "node:test";
import assert from "node:assert/strict";
import {
  SkillSelectApiError,
  classifySource,
  extractFallbackDescription,
  hashContent,
  isTrustedRequest,
  resolveList,
  resolveSummary,
} from "../lib/index.js";

// ── helpers ────────────────────────────────────────────────────────────────

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

// ── resolveList ────────────────────────────────────────────────────────────

test("resolveList: 会话不存在抛 session-not-found", async () => {
  await assert.rejects(
    resolveList({ sessions: fakeSessions("s1"), skills: { list: async () => [] }, summaries: {}, sessionId: "nope" }),
    (e) => e instanceof SkillSelectApiError && e.code === "session-not-found",
  );
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

// ── resolveSummary ─────────────────────────────────────────────────────────

test("resolveSummary: 技能不存在抛 skill-not-found", async () => {
  await assert.rejects(
    resolveSummary({ skills: { get: async () => undefined }, settings: {}, llm: {}, summaries: {}, name: "x", cwd: "/" }),
    (e) => e instanceof SkillSelectApiError && e.code === "skill-not-found",
  );
});

test("resolveSummary: frontmatter 简介直用且不写缓存", async () => {
  const skills = { get: async () => ({ name: "a", description: " 自带 ", content: "body" }) };
  const result = await resolveSummary({ skills, settings: {}, llm: {}, summaries: {}, name: "a", cwd: "/" });
  assert.equal(result.description, "自带");
  assert.equal(result.mode, "frontmatter");
  assert.equal(result.fromCache, false);
  assert.equal(result.contentHash, undefined);
});

test("resolveSummary: 缓存命中", async () => {
  const content = "body-v1";
  const summaries = { a: { description: "缓存简介", contentHash: hashContent(content), mode: "llm" } };
  const skills = { get: async () => ({ name: "a", description: "", content }) };
  const result = await resolveSummary({ skills, settings: {}, llm: {}, summaries, name: "a", cwd: "/" });
  assert.equal(result.description, "缓存简介");
  assert.equal(result.fromCache, true);
});

test("resolveSummary: LLM 生成成功", async () => {
  const skills = { get: async () => ({ name: "a", description: "", content: "body" }) };
  const settings = { get: () => ({ provider: "deepseek-official", model: "deepseek-v4-pro" }) };
  const llm = {
    prepareCall: async (cfg) => ({
      config: cfg,
      stream: async function* () {
        yield { type: "text-delta", index: 0, text: "一句  " };
        yield { type: "text-delta", index: 0, text: "简介" };
      },
    }),
  };
  const result = await resolveSummary({ skills, settings, llm, summaries: {}, name: "a", cwd: "/" });
  assert.equal(result.description, "一句 简介");
  assert.equal(result.mode, "llm");
  assert.equal(result.fromCache, false);
  assert.equal(result.contentHash, hashContent("body"));
});

test("resolveSummary: LLM 失败回退提取", async () => {
  const content = "# 手工兜底\n\n具体内容";
  const skills = { get: async () => ({ name: "a", description: "", content }) };
  const settings = { get: () => ({ provider: "p", model: "m" }) };
  const llm = { prepareCall: async () => { throw new Error("llm down"); } };
  const result = await resolveSummary({ skills, settings, llm, summaries: {}, name: "a", cwd: "/" });
  assert.equal(result.description, "手工兜底");
  assert.equal(result.mode, "fallback");
});

test("resolveSummary: 无默认模型 + 无正文 → internal 错误", async () => {
  const skills = { get: async () => ({ name: "a", description: "", content: "---\nname: a\n---\n" }) };
  const settings = { get: () => undefined };
  const llm = { prepareCall: async () => { throw new Error("unreachable"); } };
  await assert.rejects(
    resolveSummary({ skills, settings, llm, summaries: {}, name: "a", cwd: "/" }),
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
