import test from "node:test";
import assert from "node:assert/strict";
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
  resolveList,
  resolveRepo,
  resolveSummary,
  scanExternalGestures,
  scanSkillGestures,
  splitFrontmatter,
  toggleDefaults,
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
    skills, settings: {}, llm: {}, summaries: {}, name: "a", cwd: "/tmp/proj", scope: agent,
  });
  assert.equal(getOptions.cwd, "/tmp/proj");
  assert.equal(getOptions.scope, agent, "skills.get 收到会话 scope");
  assert.equal(result.description, "自带");
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
