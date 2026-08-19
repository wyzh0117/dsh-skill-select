# dsh-skill-select 四项改动 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在既有 dsh-skill-select 插件上落地四项改动：①repo 页字体/层级与 Other 计数修复；②codex/grok/hermes 外部技能（`/name@agent` 令牌，B2）；③一键更新 + 面板内摘要；④活动栏 + VSCode 式右滑面板。

**Architecture:** 单 npm 包、host/client 双半、纯 ESM、无构建。host 半（`lib/index.js`，Cordis Service）新增外部技能枚举/解析/注入与 `update` 路由；client 半（`lib/client.js`，ModuleLoader bundle）合并外部技能展示、改造草稿令牌、重写回退 UI 为活动栏。

**Tech Stack:** Node ≥20、Cordis Service、React 18（内联 style + CSS 变量）、`node:test`、`node --check`、新依赖 `yaml`。

**Spec:** `docs/design.md`（唯一事实来源，含 B2 方案）

## Global Constraints

- 纯 ESM，无构建步骤；运行 `node --check lib/index.js && node --check lib/client.js` 必须通过。
- 绝不读写/修改任何 skill 文件；外部技能只读 `SKILL.md`。
- 外部技能**不注册**进 `ctx.skills`（不进 `available_skills`），注入由本插件 `renderSkillContent` 完成。
- 复合 id 格式 `agent:name`（`agent ∈ {codex,grok,hermes}`），作为 storage domain 的 string key，schema 不变、version 仍 1。
- 外部技能令牌 `/name@agent`；`@` 不在 DSH 手势语法内，`dsh-tool-skill` 不会误注。
- 依赖：`yaml`（新增，加入 `dependencies`）。
- 测试命令：`node --test`；host 测试 `import test from "node:test"; import assert from "node:assert/strict";`。
- UI 文案英文；样式内联 + `var(--dsw-alias-*)` / `var(--ds-font-family-code)`。

## File Structure

| 文件 | 责任 | 变更 |
|------|------|------|
| `lib/index.js` | host 半：Service + 路由 + 外部技能 + update | 修改 |
| `lib/client.js` | client 半：面板/草稿/活动栏/更新按钮 | 修改 |
| `tests/index.test.js` | host 纯函数单测 | 修改 |
| `tests/client.test.js` | client 纯函数冒烟 | 修改 |
| `package.json` | 声明 `yaml` 依赖 | 修改 |
| `README.md` | 使用说明同步 | 修改 |
| `docs/design.md` | 设计（已完成） | 不变 |

---

### Task 1: host 外部技能枚举与解析

**Files:**
- Modify: `lib/index.js`（顶部 import、纯函数区新增；Service 内新增读文件包装）
- Test: `tests/index.test.js`（顶部 import 列表追加，末尾追加测试）

**Interfaces:**
- Produces:
  - `externalRoots(home?) → Array<{agent, path}>`
  - `splitFrontmatter(content) → {frontmatter: string|null, body: string}`
  - `parseExternalSkill({agent, name, raw, dirPath}) → {name, description, whenToUse?, content, resourceBase:{kind:"directory", path}}`
  - `readExternalSkill(agent, name) → Promise<同上>`（Service 私有方法，读 `join(root.path, name, "SKILL.md")`）

- [ ] **Step 1: 写失败测试**

在 `tests/index.test.js` 末尾追加：

```js
// ── 外部技能解析 ─────────────────────────────────────────────────────────
import { externalRoots, splitFrontmatter, parseExternalSkill } from "../lib/index.js";

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
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/index.test.js`
Expected: FAIL（`externalRoots`/`splitFrontmatter`/`parseExternalSkill` not exported）

- [ ] **Step 3: 最小实现**

在 `lib/index.js` 顶部 import 追加：

```js
import { parse } from "yaml";
import { homedir } from "node:os";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
```

在纯函数区（`buildRepoIndex` 之后、`// ── 错误与 wire 助手` 之前）新增：

```js
// ── 外部 agent 技能 ─────────────────────────────────────────────────────────

/** 外部 agent 技能扫描根（目录名即技能名）。 */
export const EXTERNAL_AGENTS = [
  { agent: "codex", dir: "~/.codex/skills" },
  { agent: "grok", dir: "~/.grok/skills" },
  { agent: "hermes", dir: "~/.hermes/skills" },
];

/** 把 `~/...` 解析为绝对路径（测试传 home 覆盖）。 */
export function externalRoots(home = homedir()) {
  return EXTERNAL_AGENTS.map(({ agent, dir }) => ({
    agent,
    path: dir.startsWith("~/") ? join(home, dir.slice(2)) : dir,
  }));
}

/** 切分 YAML frontmatter 与正文；无 frontmatter 时 frontmatter 为 null。 */
export function splitFrontmatter(content) {
  if (typeof content !== "string") return { frontmatter: null, body: content ?? "" };
  const m = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (m === null) return { frontmatter: null, body: content };
  return { frontmatter: m[1], body: content.slice(m[0].length) };
}

/** 解析单个外部 SKILL.md：frontmatter 取 description/whenToUse，正文作 content。 */
export function parseExternalSkill({ agent, name, raw, dirPath }) {
  const { frontmatter, body } = splitFrontmatter(raw);
  let meta = {};
  if (frontmatter !== null && frontmatter.trim() !== "") {
    try {
      meta = parse(frontmatter);
    } catch {
      meta = {};
    }
  }
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) meta = {};
  const description = typeof meta.description === "string" && meta.description.trim() !== ""
    ? meta.description.trim()
    : null;
  const whenToUse = typeof meta.whenToUse === "string" && meta.whenToUse.trim() !== ""
    ? meta.whenToUse.trim()
    : undefined;
  return {
    name,
    description,
    ...(whenToUse !== undefined ? { whenToUse } : {}),
    content: body,
    resourceBase: { kind: "directory", path: dirPath },
  };
}

/** 读取某 agent 的某个技能定义；失败抛错由调用方跳过。 */
export async function readExternalSkill(agent, name) {
  const root = EXTERNAL_AGENTS.find((e) => e.agent === agent);
  if (root === undefined) throw new Error(`unknown external agent "${agent}"`);
  const dirPath = externalRoots().find((e) => e.agent === agent).path;
  const raw = await readFile(join(dirPath, name, "SKILL.md"), "utf8");
  return parseExternalSkill({ agent, name, raw, dirPath: join(dirPath, name) });
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/index.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add lib/index.js tests/index.test.js
git commit -m "feat: 外部 agent 技能解析（externalRoots/splitFrontmatter/parseExternalSkill/readExternalSkill）"
```

---

### Task 2: host 外部手势扫描 + pre-step 注入

**Files:**
- Modify: `lib/index.js`（`#onPreStep` 内新增外部手势注入；`resolveList` 无需改动）
- Test: `tests/index.test.js`

**Interfaces:**
- Produces: `scanExternalGestures(messages) → string[]`（复合 id，`agent:name`）
- Consumes: Task 1 的 `readExternalSkill`、既有 `renderSkillContent`/`createUserMessage`

- [ ] **Step 1: 写失败测试**

```js
import { scanExternalGestures } from "../lib/index.js";

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
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/index.test.js`
Expected: FAIL（`scanExternalGestures` not exported）

- [ ] **Step 3: 实现**

在 `scanSkillGestures` 之后新增：

```js
/** 识别 `/name@agent` 外部手势（agent:name 复合 id；`@` 不在 DSH 手势语法内）。 */
const EXTERNAL_GESTURE_RE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)@([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;
export function scanExternalGestures(messages) {
  const ids = [];
  if (messages === undefined || messages === null) return ids;
  if (typeof messages[Symbol.iterator] !== "function") return ids;
  const seen = new Set();
  for (const message of messages) {
    if (message?.source?.kind !== "user") continue;
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type !== "text" || typeof block.text !== "string") continue;
      EXTERNAL_GESTURE_RE.lastIndex = 0;
      let m;
      while ((m = EXTERNAL_GESTURE_RE.exec(block.text)) !== null) {
        const id = `${m[3]}:${m[2]}`;
        if (!seen.has(id)) { seen.add(id); ids.push(id); }
      }
    }
  }
  return ids;
}
```

在 `#onPreStep` 中，repo 令牌展开 `if (tokens.length > 0) { ... }` 块之后、默认注入之前插入：

```js
    // 外部技能手势：/name@agent → 直接读文件注入（不进 ctx.skills）。
    for (const id of scanExternalGestures(messages)) {
      const [agent, name] = id.split(":");
      if (agent === undefined || name === undefined) continue;
      try {
        const skill = await readExternalSkill(agent, name);
        counted.add(id);
        injections.push(createUserMessage({
          content: [{ type: "text", text: renderSkillContent(skill) }],
          source: { kind: "skill-invocation", name, form: "instructions" },
        }));
      } catch {
        // 无法解析/读取则跳过，与 DSH 未知 /name 一致。
      }
    }
```

默认注入循环内，对 `defaults` 中复合 id 分支：

```js
      for (const name of this.#defaults) {
        if (counted.has(name)) continue;
        try {
          const skill = name.includes(":")
            ? await readExternalSkill(name.split(":")[0], name.split(":")[1])
            : await this.ctx.skills.get(name, view).catch(() => undefined);
          if (skill === undefined) continue;
          counted.add(name);
          injections.push(createUserMessage({
            content: [{ type: "text", text: renderSkillContent(skill) }],
            source: { kind: "skill-invocation", name: name.split(":")[1] ?? name, form: "instructions" },
          }));
        } catch {
          // 单个技能加载/渲染失败不影响其余技能。
        }
      }
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/index.test.js`
Expected: PASS（`node --check lib/index.js` 也须通过）

- [ ] **Step 5: 提交**

```bash
git add lib/index.js tests/index.test.js
git commit -m "feat: /name@agent 外部手势注入 + defaults 复合 id 注入"
```

---

### Task 3: host list 返回 external + summarize/set-checked/set-default 复合 id 通路

**Files:**
- Modify: `lib/index.js`（`resolveList`、`#dispatch` 的 list/summarize/set-checked）
- Test: `tests/index.test.js`

**Interfaces:**
- Produces: `resolveList(...)` 返回值增加 `external`；`summarize` 接受复合 id；`set-checked` 校验复合 id 格式
- Consumes: Task 1 `readExternalSkill`、`EXTERNAL_AGENTS`

- [ ] **Step 1: 写失败测试**

```js
test("resolveList includes external skills with agent grouping and defaultStart", async () => {
  const list = await resolveList({
    sessions: fakeSessions("s1"),
    skills: { list: async () => [], get: async () => undefined },
    summaries: {},
    usage: { "grok:ego-browser": { count: 2, lastUsedAt: "x" } },
    defaults: ["grok:ego-browser"],
    sessionId: "s1",
  });
  const ext = list.external.find((e) => e.id === "grok:ego-browser");
  assert.equal(ext.agent, "grok");
  assert.equal(ext.repo, "grok");
  assert.equal(ext.usage, 2);
  assert.equal(ext.defaultStart, true);
});
```

> 注意：`resolveList` 会真实读取 `~/.grok/skills`，测试环境存在 `ego-browser`。若断言依赖真实文件过脆，改为仅断言 `external` 为数组、每项含 `id/agent/name/repo/usage/defaultStart` 字段，不绑定具体技能。

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/index.test.js`
Expected: FAIL（`list.external` undefined）

- [ ] **Step 3: 实现**

`resolveList` 末尾（`return { sessionId, skills: views }` 前）新增外部枚举；返回改为：

```js
  const external = [];
  for (const { agent, path } of externalRoots()) {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;      // 跳过点目录/内置
      if (!isSkillName(entry.name)) continue;
      const id = `${agent}:${entry.name}`;
      let skill;
      try { skill = await readExternalSkill(agent, entry.name); }
      catch { continue; }
      const cached = cache[id];
      let description = skill.description;
      if (description === null && cached !== undefined && cached.contentHash === hashContent(skill.content)) {
        description = cached.description;
      }
      external.push({
        id, agent, name: entry.name, description, repo: agent,
        ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
        usage: usage?.[id]?.count ?? 0,
        defaultStart: defaults.includes(id),
      });
    }
  }
  return { sessionId, skills: views, external };
```

`#dispatch` 的 `summarize` 分支改为先判复合 id：

```js
      case "summarize": {
        const sessionId = requireString(payload, "sessionId");
        const name = requireString(payload, "name");
        const idx = name.indexOf(":");
        if (idx > 0 && EXTERNAL_AGENTS.some((e) => e.agent === name.slice(0, idx))) {
          const agent = name.slice(0, idx);
          const skill = await readExternalSkill(agent, name.slice(idx + 1));
          if (typeof skill.description === "string" && skill.description.trim() !== "") {
            return { name, description: skill.description.trim() };
          }
          const contentHash = hashContent(skill.content);
          const cached = this.summaries?.[name];
          if (cached !== undefined && cached.contentHash === contentHash) {
            return { name, description: cached.description };
          }
          let description; let mode;
          try {
            description = await generateLlmSummary({ settings: this.ctx.settings, llm: this.ctx.llm, name, content: skill.content ?? "" });
            mode = "llm";
          } catch {
            description = extractFallbackDescription(skill.content);
            mode = "fallback";
          }
          if (description === null || description === "") {
            throw new SkillSelectApiError("internal", `failed to generate a description for skill "${name}"`, 500);
          }
          await this.#persistSummary(name, { name, description, mode, contentHash });
          return { name, description };
        }
        const cwd = this.#cwdOf(sessionId);
        // ... 原逻辑不变
      }
```

`set-checked` 校验改为：

```js
        const valid = skills.every((s) => typeof s === "string" && s !== ""
          && (isSkillName(s) || /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)));
        if (!valid) throw new SkillSelectApiError("bad-request", "missing or invalid \"skills\"");
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/index.test.js`
Expected: PASS；`node --check lib/index.js` 通过

- [ ] **Step 5: 提交**

```bash
git add lib/index.js tests/index.test.js
git commit -m "feat: list 返回 external + summarize/set-checked 复合 id 通路"
```

---

### Task 4: host update API（git pull + 来源标记重拉）

**Files:**
- Modify: `lib/index.js`（`import { execFile } from "node:child_process"; import { promisify } from "node:util";`、`#dispatch` 增加 `update`）
- Test: `tests/index.test.js`

**Interfaces:**
- Produces: `parseOriginMarker(content) → {source, commit?, version?}|null`；`runUpdate(roots) → Promise<UpdateItem[]>`
- Consumes: Task 1 `externalRoots`、`EXTERNAL_AGENTS`

- [ ] **Step 1: 写失败测试**

```js
import { parseOriginMarker } from "../lib/index.js";

test("parseOriginMarker reads source/commit/version", () => {
  const txt = "source=https://github.com/obra/superpowers.git\ncommit=b36e082\nversion=v6.3.0\ninstalled=2026-08-14\n";
  assert.deepEqual(parseOriginMarker(txt), { source: "https://github.com/obra/superpowers.git", commit: "b36e082", version: "v6.3.0" });
  assert.equal(parseOriginMarker("no source here"), null);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/index.test.js`
Expected: FAIL（`parseOriginMarker` not exported）

- [ ] **Step 3: 实现**

```js
/** 解析 `.superpowers-origin.txt` 类来源标记。 */
export function parseOriginMarker(content) {
  if (typeof content !== "string") return null;
  const out = {};
  for (const line of content.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "source" || key === "commit" || key === "version") out[key] = value;
  }
  return typeof out.source === "string" && out.source !== "" ? out : null;
}
```

Service 内 `#dispatch` 增加 `update` 分支，并加私有 `#runUpdate`：

```js
      case "update": {
        return { items: await this.#runUpdate() };
      }
```

```js
  async #runUpdate() {
    const exec = promisify(execFile);
    const roots = [
      { id: "dsh-global", path: join(homedir(), ".dsh/skills") },
      { id: "agents", path: join(homedir(), ".agents/skills") },
      ...externalRoots().map((r) => ({ id: r.agent, path: r.path })),
    ];
    const items = [];
    for (const root of roots) {
      let entries;
      try { entries = await readdir(root.path, { withFileTypes: true }); }
      catch { continue; }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (!entry.isDirectory()) continue;
        const dir = join(root.path, entry.name);
        const id = root.id === "dsh-global" || root.id === "agents" ? entry.name : `${root.id}:${entry.name}`;
        const item = { id, name: entry.name, source: root.id, status: "skipped", changes: [] };
        try {
          const hasGit = await stat(join(dir, ".git")).then(() => true, () => false);
          if (hasGit) {
            const before = (await exec("git", ["-C", dir, "rev-parse", "HEAD"], { timeout: 30000, maxBuffer: 1 << 20 })).stdout.trim();
            await exec("git", ["-C", dir, "pull", "--ff-only"], { timeout: 30000, maxBuffer: 1 << 20 });
            const after = (await exec("git", ["-C", dir, "rev-parse", "HEAD"], { timeout: 30000, maxBuffer: 1 << 20 })).stdout.trim();
            const log = (await exec("git", ["-C", dir, "log", "--oneline", `${before}..${after}`], { timeout: 30000, maxBuffer: 1 << 20 })).stdout.trim();
            item.status = "updated"; item.before = before; item.after = after;
            item.changes = log === "" ? [] : log.split("\n");
          } else {
            const marker = await readFile(join(root.path, ".superpowers-origin.txt"), "utf8").then(parseOriginMarker, () => null);
            if (marker === null) { item.reason = "no update source"; }
            else {
              const tmp = join(tmpdir(), `skill-select-update-${Date.now()}`);
              await exec("git", ["clone", "--depth", "1", marker.source, tmp], { timeout: 60000, maxBuffer: 1 << 20 });
              const after = (await exec("git", ["-C", tmp, "rev-parse", "HEAD"], { timeout: 30000, maxBuffer: 1 << 20 })).stdout.trim();
              await exec("cp", ["-R", `${tmp}/.`, dir], { timeout: 30000, maxBuffer: 1 << 20 });
              item.status = "updated"; item.before = marker.commit ?? marker.version; item.after = after;
              item.changes = [`origin ${marker.version ?? ""} → ${after.slice(0, 7)}`];
            }
          }
        } catch (error) {
          item.status = "failed";
          item.reason = error instanceof Error ? error.message : String(error);
        }
        items.push(item);
      }
    }
    return items;
  }
```

> `tmpdir` 来自 `node:os`（在 Task 1 的 `node:os` import 中一并引入）。`cp -R` 用 `execFile("cp", ...)` 在 macOS/Linux 可用；如需 Windows 兼容可改 `fs.cp`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/index.test.js`
Expected: PASS；`node --check lib/index.js` 通过

- [ ] **Step 5: 提交**

```bash
git add lib/index.js tests/index.test.js
git commit -m "feat: update API（git pull + 来源标记重拉）"
```

---

### Task 5: client 行模型合并 + 来源徽标 + 字体/缩进/Other 计数

**Files:**
- Modify: `lib/client.js`（`SOURCE_LABEL`/`SOURCE_COLOR`、`loadSkills`、`groupByRepo`、`repoCheckState`、`renderRow`、`SkillPanel` 组头）
- Test: `tests/client.test.js`

**Interfaces:**
- Produces: 合并行 `{id, kind, agent?, name, description, whenToUse, repo, source, usage, defaultStart, ...}`；`repoCheckState(skills, repo, checked)` 归一化 null repo
- Consumes: host `list` 的 `external` 字段

- [ ] **Step 1: 写失败测试**

在 `tests/client.test.js` 追加（通过 `captured.__test` 访问）：

```js
test("repoCheckState normalizes null repo to empty", () => {
  const skills = [{ id: "a", name: "a", repo: null }];
  assert.equal(captured.__test.repoCheckState(skills, "", ["a"]), "all");
  assert.equal(captured.__test.repoCheckState(skills, "", []), "none");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/client.test.js`
Expected: FAIL（`repoCheckState` 用 `===` 不归一化 → 返回 "none"）

- [ ] **Step 3: 实现**

`SOURCE_LABEL`/`SOURCE_COLOR` 增加：

```js
      codex: "Codex", grok: "Grok", hermes: "Hermes",
```
```js
      codex: "#f0a24c", grok: "#c792ea", hermes: "#56b6c2",
```

`loadSkills` 成功分支改为合并：

```js
          const value = await apiCall("list", { sessionId });
          const dsh = (value.skills ?? []).filter((s) => s.userInvocable !== false)
            .map((s) => ({ ...s, id: s.name, kind: "dsh" }));
          const external = (value.external ?? []).map((e) => ({
            ...e, kind: "external",
          }));
          const skills = [...dsh, ...external].sort((a, b) => a.name.localeCompare(b.name));
```

`repoCheckState` 与组头 `members` 归一化（`SkillPanel` 内）：

```js
    function repoCheckState(skills, repo, checked) {
      const members = skills.filter((s) => (s.repo ?? "") === (repo ?? ""));
      if (members.length === 0) return "none";
      const checkedCount = members.filter((m) => checked.includes(m.id)).length;
      if (checkedCount === 0) return "none";
      if (checkedCount === members.length) return "all";
      return "some";
    }
```

组头 `members` 改为 `state.skills.filter((s) => (s.repo ?? "") === (group.repo ?? ""))`；计数仍用 `group.items.length`。

`renderRow` 内 skill 名行加 repo 模式缩进（在行容器 style 中）：

```js
          style: {
            display: "flex", alignItems: "flex-start", gap: 8,
            padding: sortMode === "repo" ? "7px 12px 7px 28px" : "7px 12px",
            borderBottom: "1px solid var(--dsw-alias-divider-primary, rgba(128,128,128,0.15))",
          },
```

组头名 style（`groupHeaderStyle` 内的 repo 名 span）改为：

```js
        style: { fontSize: 13, fontWeight: 600, fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)", color: "var(--dsw-alias-label-primary, #e8eaf0)" },
```

外部行勾选用 `skill.id`（`applyChecked`/`applyCheckedBulk` 已接受 id 字符串，无需改）；`renderRow` 的 checkbox `onChange` 改为 `applyChecked(rootCtx, sessionId, skill.id, on)`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/client.test.js`
Expected: PASS；`node --check lib/client.js` 通过

- [ ] **Step 5: 提交**

```bash
git add lib/client.js tests/client.test.js
git commit -m "feat: client 合并外部技能 + 来源徽标 + repo 字体/缩进 + Other 计数归一化"
```

---

### Task 6: client B2 草稿令牌（tokensForChecked / stripManagedTokens / composeDraft）

**Files:**
- Modify: `lib/client.js`（`tokensForChecked`、`stripManagedTokens`、`composeDraft`、`repTokens`、`applyCheckedBulk`）
- Test: `tests/client.test.js`

**Interfaces:**
- Produces: 外部技能输出 `/name@agent`；`stripManagedTokens` 同时剥 `/name` 与 `/name@agent`
- Consumes: Task 5 的合并行模型

- [ ] **Step 1: 写失败测试**

```js
test("tokensForChecked emits /name@agent for external skills", () => {
  const skills = [{ id: "grok:ego-browser", kind: "external", agent: "grok", name: "ego-browser", repo: "grok" }];
  assert.deepEqual(captured.__test.tokensForChecked(skills, ["grok:ego-browser"]), ["/ego-browser@grok"]);
});

test("stripManagedTokens removes both /name and /name@agent", () => {
  const managed = new Set(["brainstorming", "grok:ego-browser"]);
  assert.equal(captured.__test.stripManagedTokens("/brainstorming /ego-browser@grok tail", managed), "tail");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/client.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

替换 `tokensForChecked`：

```js
    const EXTERNAL_TOKEN_RE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)@([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;

    function tokensForChecked(skills, checked) {
      const checkedSet = new Set(checked);
      const tokens = [];
      for (const s of skills) {
        if (s.kind === "external" && checkedSet.has(s.id)) tokens.push(`/${s.name}@${s.agent}`);
      }
      const dsh = skills.filter((s) => s.kind !== "external");
      const remaining = new Set(checked.filter((c) => !c.includes(":")));
      const byRepo = new Map();
      for (const s of dsh) {
        if (typeof s.repo !== "string" || s.repo === "") continue;
        if (!byRepo.has(s.repo)) byRepo.set(s.repo, []);
        byRepo.get(s.repo).push(s);
      }
      const usable = repoTokens(dsh);
      for (const [repo, members] of byRepo) {
        if (!usable.has(repo) || members.length === 0) continue;
        if (members.every((m) => checkedSet.has(m.id))) {
          tokens.push(`/${repo}`);
          for (const m of members) remaining.delete(m.id);
        }
      }
      for (const id of remaining) tokens.push(`/${id}`);
      return tokens;
    }
```

替换 `stripManagedTokens`：

```js
    function stripManagedTokens(draft, managed) {
      if (typeof draft !== "string") return "";
      return draft
        .replace(EXTERNAL_TOKEN_RE, (m, lead, name, agent) => (managed.has(`${agent}:${name}`) ? "" : m))
        .replace(GESTURE_TOKEN_RE, (m, lead, token) => (managed.has(token) ? "" : m))
        .replace(/\s{2,}/g, " ").trim();
    }
```

替换 `composeDraft`：

```js
    function composeDraft(skills, checked, currentDraft) {
      const managed = new Set(skills.map((s) => s.id));
      for (const token of repoTokens(skills.filter((s) => s.kind !== "external"))) managed.add(token);
      const base = stripManagedTokens(currentDraft, managed);
      const tokens = tokensForChecked(skills, checked);
      if (tokens.length === 0) return base;
      return base ? `${base} ${tokens.join(" ")}` : tokens.join(" ");
    }
```

`repTokens` 保持只作用于 DSH 技能（其内部按 `s.repo` 判定，外部行的 `repo` 是 agent 名会被误当 repo 令牌，故所有调用点已传 `skills.filter(s => s.kind !== "external")`）。

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/client.test.js`
Expected: PASS；`node --check lib/client.js` 通过

- [ ] **Step 5: 提交**

```bash
git add lib/client.js tests/client.test.js
git commit -m "feat: client /name@agent 草稿令牌（B2）"
```

---

### Task 7: client 活动栏 + VSCode 式右滑面板

**Files:**
- Modify: `lib/client.js`（`SkillsDrawer` 重写）

**Interfaces:**
- Produces: 无导出函数变更；仅 `SkillsDrawer` 内部结构
- Consumes: `SkillPanel`（既有）

- [ ] **Step 1: 无纯函数单测（UI 冒烟由 `mountStandalone` 既有测试覆盖 render 调用次数）**

- [ ] **Step 2: 实现**

替换 `SkillsDrawer` 返回结构：把原「右上角圆钮 + 抽屉」改为「右侧缘活动栏 + 贴边面板」。

```js
    function SkillsDrawer({ rootCtx }) {
      const sessions = rootCtx.get("sessions");
      const sessionId = React.useSyncExternalStore(
        (fn) => (sessions?.list ? sessions.list.subscribe(fn) : () => {}),
        () => (sessions?.list ? sessions.list.getSnapshot().current : undefined),
      );
      const [open, setOpen] = React.useState(false);
      const [top, setTop] = React.useState(56);
      React.useEffect(() => {
        const measure = () => {
          const el = document.querySelector('[data-conversation-scroll]');
          const rect = el ? el.getBoundingClientRect() : null;
          setTop(rect && typeof rect.top === "number" ? Math.round(rect.top) : 56);
        };
        measure();
        window.addEventListener("resize", measure);
        return () => window.removeEventListener("resize", measure);
      }, []);
      React.useEffect(() => {
        if (open && sessionId) loadSkills(sessionId);
      }, [open, sessionId]);

      return ReactDOM.createPortal(
        React.createElement(React.Fragment, null,
          // 右侧缘竖向活动栏
          React.createElement("div", {
            style: {
              position: "fixed", top, right: 0, bottom: 0, width: 40, zIndex: 9200,
              display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 8,
              background: "var(--dsw-specific-panel, #17191d)",
              borderLeft: "1px solid var(--dsw-alias-divider-primary, rgba(128,128,128,0.25))",
            },
          },
            React.createElement("button", {
              type: "button", onClick: () => setOpen(!open),
              title: open ? "Close skills" : "Skills",
              "aria-label": open ? "Close skills" : "Skills",
              style: {
                width: 28, height: 28, borderRadius: 6, padding: 0, cursor: "pointer",
                border: "none", background: "transparent",
                color: "var(--dsw-alias-label-primary, #e8eaf0)",
                display: "inline-flex", alignItems: "center", justifyContent: "center",
              },
            }, open
              ? React.createElement("span", { style: { fontSize: 16, lineHeight: 1 } }, "×")
              : React.createElement(SkillIcon, { size: 16 })),
          ),
          // VSCode 式贴边面板
          React.createElement("div", {
            style: {
              position: "fixed", top, right: 40, bottom: 0, width: 380, maxWidth: "calc(92vw - 40px)",
              zIndex: 9100, display: "flex", flexDirection: "column",
              background: "var(--dsw-specific-panel, #17191d)",
              borderLeft: "1px solid var(--dsw-alias-divider-primary, rgba(128,128,128,0.25))",
              transform: open ? "translateX(0)" : "translateX(calc(100% + 40px))",
              visibility: open ? "visible" : "hidden",
              transition: "transform .25s ease, visibility 0s linear " + (open ? "0s" : ".25s"),
            },
          },
            React.createElement("div", {
              style: {
                height: 36, padding: "0 12px", display: "flex", alignItems: "center", gap: 6, flexShrink: 0,
                borderBottom: "1px solid var(--dsw-alias-divider-primary, rgba(128,128,128,0.25))",
              },
            },
              React.createElement(SkillIcon, { size: 15 }),
              React.createElement("span", { style: { fontSize: 13, fontWeight: 600 } }, "Skills")),
            open ? React.createElement("div", {
              style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" },
            }, sessionId
              ? React.createElement(SkillPanel, { rootCtx, sessionId, embedded: false })
              : React.createElement("div", { style: { padding: 16, fontSize: 12, color: "var(--dsw-alias-label-tertiary, #8a8f98)" } }, "No open session.")) : null,
          ),
        ),
        document.body,
      );
    }
```

- [ ] **Step 3: 运行冒烟确认**

Run: `node --test tests/client.test.js`
Expected: PASS（`mountStandalone` render 计数不变）

- [ ] **Step 4: 提交**

```bash
git add lib/client.js
git commit -m "feat: client 活动栏 + VSCode 式右滑面板"
```

---

### Task 8: client 更新按钮 + 面板内摘要

**Files:**
- Modify: `lib/client.js`（`SkillPanel` 工具栏新增按钮与摘要区）

**Interfaces:**
- Consumes: host `update` 路由（Task 4）；`apiCall`

- [ ] **Step 1: 实现**

`SkillPanel` 内新增 state 与处理：

```js
      const [updating, setUpdating] = React.useState(false);
      const [updateResult, setUpdateResult] = React.useState(null);
      const [updateError, setUpdateError] = React.useState(null);
      const runUpdate = async () => {
        if (updating) return;
        setUpdating(true); setUpdateError(null); setUpdateResult(null);
        try {
          const value = await apiCall("update", {});
          setUpdateResult(value.items ?? []);
        } catch (error) {
          setUpdateError(error instanceof Error ? error.message : String(error));
        } finally {
          setUpdating(false);
        }
      };
```

工具栏搜索框之后、刷新按钮之前插入更新按钮：

```js
          React.createElement("button", {
            type: "button", onClick: runUpdate, disabled: updating,
            title: "Update skills",
            style: {
              fontSize: 11.5, padding: "4px 8px", borderRadius: 6, cursor: updating ? "default" : "pointer",
              border: "1px solid var(--dsw-alias-divider-primary, rgba(128,128,128,0.25))",
              background: "var(--dsw-specific-input-major, #20242b)",
              color: "var(--dsw-alias-label-primary, #e8eaf0)", flexShrink: 0, opacity: updating ? 0.6 : 1,
            },
          }, updating ? "Updating…" : "Update"),
```

错误行与列表之间插入摘要区：

```js
        updateError !== null && React.createElement("div", { style: { padding: "4px 12px", fontSize: 11.5, color: "var(--dsw-alias-state-error-primary, #f56c6c)" } }, `Update failed: ${updateError}`),
        updateResult !== null && React.createElement("div", {
          style: { padding: "8px 12px", borderBottom: "1px solid var(--dsw-alias-divider-primary, rgba(128,128,128,0.15))" },
        },
          updateResult.map((item) => React.createElement("div", {
            key: item.id, style: { display: "flex", flexDirection: "column", gap: 2, padding: "3px 0" },
          },
            React.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
              React.createElement("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-primary, #e8eaf0)" } }, item.name),
              React.createElement("span", { style: { fontSize: 10, padding: "0 5px", borderRadius: 999, border: "1px solid var(--dsw-alias-label-tertiary, #8a8f98)", color: item.status === "updated" ? "var(--dsw-alias-state-success-primary, #2fbf71)" : item.status === "failed" ? "var(--dsw-alias-state-error-primary, #f56c6c)" : "var(--dsw-alias-label-tertiary, #8a8f98)" } }, item.status)),
            (item.changes ?? []).slice(0, 3).map((c, i) => React.createElement("div", { key: i, style: { fontSize: 11, color: "var(--dsw-alias-label-secondary, #9aa0a8)", paddingLeft: 4 } }, c)),
            item.reason !== undefined && React.createElement("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #8a8f98)", paddingLeft: 4 } }, item.reason))),
        ),
```

- [ ] **Step 2: 运行确认**

Run: `node --check lib/client.js`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add lib/client.js
git commit -m "feat: client 更新按钮 + 面板内变更摘要"
```

---

### Task 9: 依赖声明 + 文档 + 全量验证

**Files:**
- Modify: `package.json`（`dependencies` 增加 `"yaml"`）
- Modify: `README.md`（外部技能、`/name@agent`、更新按钮、活动栏说明同步）
- Test: 全量

- [ ] **Step 1: 声明依赖**

`package.json` 增加：

```json
  "dependencies": {
    "yaml": "^2.8.1"
  },
```

运行：`cd ~/.dsh/profiles/web && pnpm install`（让 `yaml` 就位）。

- [ ] **Step 2: 更新 README**

在「使用」与「开发」节补充：外部 agent 技能来源与 `/name@agent` 令牌、更新按钮行为、活动栏回退 UI。

- [ ] **Step 3: 全量验证**

Run: `node --test` 与 `node --check lib/index.js && node --check lib/client.js`
Expected: 全绿

- [ ] **Step 4: 提交**

```bash
git add package.json README.md
git commit -m "chore: yaml 依赖 + README 同步"
```

---

## Self-Review（已执行）

- **Spec coverage**：§1.1/1.2 字体缩进 Other 计数 → Task 5；§2.5 外部技能枚举/解析 → Task 1；注入 → Task 2；list/summarize/set-checked → Task 3；§2.6 更新 → Task 4/8；§2.7 活动栏 → Task 7；B2 令牌 → Task 6；依赖 → Task 9。R1–R12 均有对应任务。
- **Placeholder scan**：无 TBD/TODO；每处代码步骤给出具体代码。
- **Type consistency**：`id`（`agent:name`）贯穿 host 与 client；`ExternalSkillView` 字段（`id/agent/name/repo/usage/defaultStart/description/whenToUse`）在 Task 1/3/5/6 一致；`UpdateItem` 字段（`id/name/source/status/before/after/changes/reason`）在 Task 4/8 一致。
