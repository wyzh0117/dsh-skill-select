/**
 * dsh-skill-select — host 半。
 *
 * 注册 `ctx.skillSelect`（SkillSelectService），提供 fenced `/skill-select/api`
 * JSON 路由：
 *   - list      { sessionId }            → 该会话 cwd 视角下的全部技能
 *                                          （含来源分类、repo 归属、简介解析与
 *                                          真实调用计数）
 *   - summarize { sessionId, name }      → 为无 frontmatter 简介的技能生成一句
 *                                          简介（LLM，失败回退提取），写入插件
 *                                          自己的 storage domain 缓存
 *
 * 此外在 `agent/pre-step` 上观察用户消息中的 `/skill` 手势，把真实调用次数
 * 记录进 storage domain（usage 表），供 list 输出 `usage.count`。
 *
 * 绝不读写任何 skill 文件；技能枚举与加载全部经由 `ctx.skills` 服务。
 * 信任围栏与 JSON 包络与 dsh-pin 完全一致。
 *
 * @module dsh-skill-select
 */
import { Service } from "@deepseek-ai/cordis";
import { defineDomain } from "@deepseek-ai/dsh-storage-domain";
import { isSkillName, renderSkillContent } from "@deepseek-ai/dsh-skill";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { z } from "zod";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { parse } from "yaml";

// ── durable domain ─────────────────────────────────────────────────────────

/** 简介缓存 + 真实调用计数 + 默认启动名单 schema（按技能名记录）。 */
const summaryStateSchema = z.object({
  summaries: z.record(z.object({
    description: z.string(),
    contentHash: z.string(),
    generatedAt: z.string(),
    mode: z.enum(["llm", "fallback"]),
  })),
  usage: z.record(z.object({
    count: z.number(),
    lastUsedAt: z.string(),
  })).default({}),
  defaults: z.array(z.string()).default([]),
});

/** 插件自有 domain（global-only，无表）。名称限小写+下划线（storage 规范）。 */
const skillSelectDomainSpec = defineDomain({
  name: "skill_select",
  version: 1,
  global: {
    schema: summaryStateSchema,
    initial: { summaries: {} },
  },
  tables: {},
});

// ── 纯函数（导出供单测）─────────────────────────────────────────────────────

/**
 * 把 SkillSummary.source 归入四类展示来源。
 * @param {string} source - `ctx.skills.list()` 返回的原始 source 字段。
 * @returns {"project"|"user"|"bundled"|"other"}
 */
export function classifySource(source) {
  if (source === "project-dsh" || source === "project-agents") return "project";
  if (source === "user-dsh" || source === "user-agents") return "user";
  if (source === "bundled") return "bundled";
  return "other";
}

/**
 * 去掉 YAML frontmatter 后取第一个非空行作为兜底简介。
 * @param {string|undefined} content - SKILL.md 原始内容。
 * @returns {string|null} 截断到 80 字符的简介；无内容返回 null。
 */
export function extractFallbackDescription(content) {
  if (typeof content !== "string") return null;
  let body = content;
  const front = body.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/);
  if (front) body = body.slice(front[0].length);
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    const raw = line.trim();
    if (raw.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    let t = raw;
    if (!t || t.startsWith("<!--")) continue;
    t = t.replace(/^#+\s*/, "").replace(/[*_`~]/g, "").trim();
    if (!t) continue;
    return t.length > 80 ? t.slice(0, 80) : t;
  }
  return null;
}

/** sha1 内容指纹（前 16 位 hex），用于缓存失效校验。 */
export function hashContent(content) {
  return createHash("sha1").update(String(content ?? "")).digest("hex").slice(0, 16);
}

/**
 * 技能名 → 所属 repo 显示名的固定映射。
 * 命中此表即直接返回，无需读取技能定义做路径推断。
 */
export const SKILL_REPOS = {
  brainstorming: "superpowers",
  "dispatching-parallel-agents": "superpowers",
  "executing-plans": "superpowers",
  "finishing-a-development-branch": "superpowers",
  "receiving-code-review": "superpowers",
  "requesting-code-review": "superpowers",
  "subagent-driven-development": "superpowers",
  "systematic-debugging": "superpowers",
  "test-driven-development": "superpowers",
  "using-git-worktrees": "superpowers",
  "using-superpowers": "superpowers",
  "verification-before-completion": "superpowers",
  "writing-plans": "superpowers",
  "writing-skills": "superpowers",
  "auto-empirical-research-skills": "Auto-Empirical-Research-Skills",
};

/** 已知技能根目录名：路径推断时父目录若为此类目录，不视为 repo。 */
const SKILL_ROOT_DIRS = new Set(["skills"]);

/**
 * 解析技能归属的 repo 显示名。
 *
 * 1. 命中 `SKILL_REPOS` 映射即返回；
 * 2. 否则若 `dirPath` 是技能目录路径（嵌套布局 `<repo>/<skill>`），
 *    取父目录 basename 作为 repo；平铺 .md 技能（dir 即根目录）或
 *    父目录为 `skills` 之类的根目录时返回 null。
 * @param {string} name - 技能名。
 * @param {string|undefined} dirPath - 技能目录路径（来自 resourceBase.path）。
 * @returns {string|null}
 */
export function resolveRepo(name, dirPath) {
  if (Object.prototype.hasOwnProperty.call(SKILL_REPOS, name)) {
    return SKILL_REPOS[name];
  }
  if (typeof dirPath !== "string" || dirPath === "") return null;
  const dir = resolve(dirPath);
  if (basename(dir) !== name) return null;
  const repo = basename(dirname(dir));
  if (repo === "" || SKILL_ROOT_DIRS.has(repo)) return null;
  return repo;
}

/** 识别 `/skill` 手势的正则（与 dsh-tool-skill 完全一致）。 */
const GESTURE_RE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;

/**
 * 扫描用户消息中的 `/skill` 手势，去重返回技能名数组。
 *
 * 只扫 `message.source.kind === "user"` 的文本块（块数组字段是
 * `message.content`，与 dsh-tool-skill 一致）；对 messages 缺失、
 * content 缺失等做防御。词边界要求斜杠前是行首或空白、名字后是空白或行尾。
 * @param {Array<object>|undefined} messages
 * @returns {string[]}
 */
export function scanSkillGestures(messages) {
  const names = [];
  if (messages === undefined || messages === null) return names;
  if (typeof messages[Symbol.iterator] !== "function") return names;
  const seen = new Set();
  for (const message of messages) {
    if (message?.source?.kind !== "user") continue;
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type !== "text" || typeof block.text !== "string") continue;
      GESTURE_RE.lastIndex = 0;
      let match;
      while ((match = GESTURE_RE.exec(block.text)) !== null) {
        const name = match[2];
        if (!seen.has(name)) {
          seen.add(name);
          names.push(name);
        }
      }
    }
  }
  return names;
}

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

/**
 * 合并一次调用计数，返回新对象（不原地改动输入）。
 * @param {Record<string,{count:number,lastUsedAt:string}>|undefined} usage
 * @param {string[]} names
 * @param {string} now - ISO 时间戳，默认当前时间。
 * @returns {Record<string,{count:number,lastUsedAt:string}>}
 */
export function mergeUsage(usage, names, now = new Date().toISOString()) {
  const next = { ...(usage ?? {}) };
  for (const name of names) {
    const prev = next[name];
    next[name] = {
      count: (prev?.count ?? 0) + 1,
      lastUsedAt: now,
    };
  }
  return next;
}

/**
 * 切换默认启动名单：on 加入（去重）、off 移除；返回新数组，不 mutate 输入。
 * @param {string[]} defaults
 * @param {string} name
 * @param {boolean} on
 * @returns {string[]}
 */
export function toggleDefaults(defaults, name, on) {
  const list = defaults ?? [];
  if (on) return list.includes(name) ? [...list] : [...list, name];
  return list.filter((n) => n !== name);
}

/**
 * 是否允许该技能被模型调用：默认启动名单 ∪ 会话勾选名单。
 * @param {string[]} defaults
 * @param {string[]|undefined} checked
 * @param {string} name
 * @returns {boolean}
 */
export function isAllowedSkill(defaults, checked, name) {
  return (defaults ?? []).includes(name) || (checked ?? []).includes(name);
}

/**
 * 按 repo 分组技能名：Map<小写repo名, { repo: 显示名, members: string[] }>。
 * repoByName 为技能名 → repo|null（null 忽略）；成员顺序按 listed 顺序。
 * @param {Map<string,string|null>} repoByName
 * @param {Array<{name:string}>} listed
 * @returns {Map<string, {repo:string, members:string[]}>}
 */
export function buildRepoIndex(repoByName, listed) {
  const index = new Map();
  for (const s of listed ?? []) {
    const repo = repoByName.get(s.name);
    if (typeof repo !== "string" || repo === "") continue;
    const key = repo.toLowerCase();
    let entry = index.get(key);
    if (entry === undefined) {
      entry = { repo, members: [] };
      index.set(key, entry);
    }
    entry.members.push(s.name);
  }
  return index;
}

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

/** origin source 允许的协议前缀；校验失败即拒绝（防 git 选项注入）。 */
const ORIGIN_SOURCE_RE = /^(https?|ssh|git):\/\//;

/**
 * 全量更新技能目录：git 仓库做 `pull --ff-only`；非 git 目录读取目录内
 * `.superpowers-origin.txt` 来源标记做 depth-1 重克隆（标记在单个技能目录
 * 内，避免把 ~/.grok/skills 根上的 superpowers 技能集标记误写成每个技能）。
 * 单个目录失败不中断整体：写入 item.status="failed" 与 reason。
 * @param {Array<{id:string,path:string}>} roots
 * @returns {Promise<Array<{id:string,name:string,source:string,status:string,changes:string[],before?:string,after?:string,reason?:string}>>}
 */
export async function runUpdate(roots) {
  const exec = promisify(execFile);
  const items = [];
  for (const root of roots) {
    let entries;
    try { entries = await readdir(root.path, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (!entry.isDirectory()) continue;
      const dir = join(root.path, entry.name);
      // dsh-global 保持裸名 id；其余根（agents/codex/grok/hermes）一律带根前缀，
      // 避免 agents 与 dsh-global 的裸名 id 冲突。
      const id = root.id === "dsh-global" ? entry.name : `${root.id}:${entry.name}`;
      const item = { id, name: entry.name, source: root.id, status: "skipped", changes: [] };
      try {
        const hasGit = await stat(join(dir, ".git")).then(() => true, () => false);
        if (hasGit) {
          const before = (await exec("git", ["-C", dir, "rev-parse", "HEAD"], { timeout: 30000, maxBuffer: 1 << 20 })).stdout.trim();
          await exec("git", ["-C", dir, "pull", "--ff-only"], { timeout: 30000, maxBuffer: 1 << 20 });
          const after = (await exec("git", ["-C", dir, "rev-parse", "HEAD"], { timeout: 30000, maxBuffer: 1 << 20 })).stdout.trim();
          item.before = before; item.after = after;
          if (before === after) {
            // HEAD 未变：仓库已是最新，不产生变更 → skipped（不是 updated）。
            item.status = "skipped";
            item.reason = "already up to date";
          } else {
            const log = (await exec("git", ["-C", dir, "log", "--oneline", `${before}..${after}`], { timeout: 30000, maxBuffer: 1 << 20 })).stdout.trim();
            item.status = "updated";
            item.changes = log === "" ? [] : log.split("\n");
          }
        } else {
          const marker = await readFile(join(dir, ".superpowers-origin.txt"), "utf8").then(parseOriginMarker, () => null);
          if (marker === null) { item.reason = "no update source"; }
          else if (!ORIGIN_SOURCE_RE.test(marker.source)) {
            // 来源字符串会原样进入 git 的选项解析器：以 `-` 开头可被当作
            // git 选项注入，故克隆前按协议前缀校验，拒绝即跳过克隆。
            item.status = "failed";
            item.reason = `invalid origin source "${marker.source}"`;
          }
          else {
            const tmp = join(tmpdir(), `skill-select-update-${Date.now()}`);
            try {
              await exec("git", ["clone", "--depth", "1", marker.source, tmp], { timeout: 60000, maxBuffer: 1 << 20 });
              const after = (await exec("git", ["-C", tmp, "rev-parse", "HEAD"], { timeout: 30000, maxBuffer: 1 << 20 })).stdout.trim();
              await exec("cp", ["-R", `${tmp}/.`, dir], { timeout: 30000, maxBuffer: 1 << 20 });
              item.status = "updated"; item.before = marker.commit ?? marker.version; item.after = after;
              item.changes = [`origin ${marker.version ?? ""} → ${after.slice(0, 7)}`];
            } finally {
              // 临时克隆目录：无论复制成功与否都清理（失败时可能残留半成品）。
              await rm(tmp, { recursive: true, force: true }).catch(() => {});
            }
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

// ── 错误与 wire 助手 ────────────────────────────────────────────────────────

export class SkillSelectApiError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** 浏览器信任围栏：与 /api 网关及 dsh-pin 相同的 loopback/trusted-host 检查。 */
export function isTrustedRequest(req, trustedHosts) {
  const host = req.headers.host;
  if (host === undefined) return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  const isLoopback = (hostname) => {
    if (hostname === "localhost" || hostname === "[::1]") return true;
    const parts = hostname.split(".");
    return parts.length === 4
      && parts[0] === "127"
      && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
  };
  const trusted = (trustedHosts ?? []).some((entry) => {
    try {
      const e = new URL(`http://${entry}`);
      const ePort = e.port || new URL(`https://${entry}`).port;
      const hPort = hostUrl.port || new URL(`https://${host}`).port;
      if (ePort === "" || hPort === "") return e.hostname === hostUrl.hostname;
      return e.host === hostUrl.host;
    } catch {
      return false;
    }
  });
  if (!isLoopback(hostUrl.hostname) && !trusted) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

const MAX_BODY_BYTES = 1 << 20;

export async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new SkillSelectApiError("bad-request", "request body too large");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new SkillSelectApiError("bad-request", "request body is not valid JSON");
  }
}

export function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value });
}

export function writeError(res, error) {
  if (error instanceof SkillSelectApiError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } });
    return;
  }
  writeJson(res, 500, { ok: false, error: { code: "internal", message: error instanceof Error ? error.message : String(error) } });
}

export function requireString(payload, key) {
  const value = payload?.[key];
  if (typeof value !== "string" || value === "") {
    throw new SkillSelectApiError("bad-request", `missing or invalid "${key}"`);
  }
  return value;
}

// ── 核心逻辑（独立函数，Service 薄适配；单测直接调用）────────────────────────

/**
 * 列出某会话视角下的技能视图。
 *
 * 会话 scope 是正确性的关键：web 宿主把 `skill-filesystem` 挂进 agent preset
 * 的 scoped 层（全局层被禁用），不带 scope 只能读到全局层 → 列表恒为空。
 * 与 `dsh-tool-skill` 一致，用 `ctx.agents.get(sessionId)` 返回的 agent 作
 * scope key；`agents` 服务缺失或查不到时退化为仅全局层（其他宿主兼容）。
 * @param {object} deps
 * @param {{get:(id:string)=>object|undefined}} deps.sessions - ctx.sessions
 * @param {{list:(opts:object)=>Promise<Array>,get:(name:string,opts:object)=>Promise<object|undefined>}} deps.skills - ctx.skills
 * @param {{get:(id:string)=>object|undefined}|undefined} deps.agents - ctx.agents（可选）
 * @param {Record<string,{description:string,contentHash:string}>|undefined} deps.summaries - 缓存
 * @param {Record<string,{count:number,lastUsedAt:string}>|undefined} deps.usage - 真实调用计数（可选）
 * @param {string[]|undefined} deps.defaults - 默认启动名单（可选）
 * @param {string} deps.sessionId
 * @returns {Promise<{sessionId:string, skills:Array<object>, external:Array<object>}>}
 */
export async function resolveList({ sessions, skills, summaries, usage = {}, defaults = [], sessionId, agents }) {
  const session = sessions.get(sessionId);
  if (session === undefined) {
    throw new SkillSelectApiError("session-not-found", `session "${sessionId}" not found`, 404);
  }
  const cwd = session.header?.cwd;
  const scope = agents?.get(sessionId);
  const view = { cwd, ...(scope !== undefined ? { scope } : {}) };
  const listed = await skills.list(view);
  const cache = summaries ?? {};
  const views = [];
  for (const s of listed) {
    let description = typeof s.description === "string" && s.description.trim() !== ""
      ? s.description.trim()
      : null;
    let repo = resolveRepo(s.name);
    const cached = cache[s.name];
    const needDef = repo === null
      || (description === null && cached !== undefined && typeof cached.contentHash === "string");
    let def;
    if (needDef) {
      try {
        def = await skills.get(s.name, view);
      } catch {
        def = undefined;
      }
    }
    if (repo === null && def?.resourceBase?.kind === "directory") {
      repo = resolveRepo(s.name, def.resourceBase.path);
    }
    if (description === null && cached !== undefined && typeof cached.contentHash === "string") {
      if (def !== undefined && hashContent(def.content) === cached.contentHash) {
        description = cached.description;
      }
    }
    views.push({
      name: s.name,
      description,
      repo,
      usage: usage?.[s.name]?.count ?? 0,
      defaultStart: defaults.includes(s.name),
      ...(typeof s.whenToUse === "string" && s.whenToUse !== "" ? { whenToUse: s.whenToUse } : {}),
      source: classifySource(s.source),
      modelInvocable: s.invocation?.modelInvocable !== false,
      userInvocable: s.invocation?.userInvocable !== false,
    });
  }
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
}

const SUMMARY_SYSTEM_PROMPT = [
  "You are a skill description generator.",
  "Output a single English sentence (at most 80 characters) describing what the skill does and when to use it.",
  "Output nothing else.",
].join("");

/** LLM 生成一句简介；任何异常向上抛（调用方回退）。 */
async function generateLlmSummary({ settings, llm, name, content }) {
  const sel = settings.get("agent-default-model");
  if (sel === undefined || typeof sel.provider !== "string" || typeof sel.model !== "string") {
    throw new Error("no default model configured");
  }
  const prepared = await llm.prepareCall({ provider: sel.provider, model: sel.model, maxTokens: 200 });
  const signal = AbortSignal.timeout(15000);
  let text = "";
  for await (const chunk of prepared.stream({
    ...prepared.config,
    system: SUMMARY_SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Skill name: ${name}\n\nSkill content:\n${content.slice(0, 4000)}` }],
    signal,
  })) {
    if (chunk.type === "text-delta") text += chunk.text;
  }
  const trimmed = text.trim().replace(/\s+/g, " ").slice(0, 80);
  if (trimmed === "") throw new Error("empty summary");
  return trimmed;
}

/**
 * 解析一个技能的简介：frontmatter → 缓存（hash 校验）→ LLM → 提取回退。
 * `scope` 为会话对应 agent（见 resolveList），透传给 skills.get。
 * @param {object} deps
 * @param {{get:(name:string,opts:object)=>Promise<object|undefined>}} deps.skills
 * @param {{get:(ns:string)=>unknown}} deps.settings
 * @param {{prepareCall:(cfg:object)=>Promise<object>}} deps.llm
 * @param {Record<string,object>|undefined} deps.summaries
 * @param {string} deps.name
 * @param {string|undefined} deps.cwd
 * @param {object|undefined} deps.scope - 会话 scope key（可选）
 * @returns {Promise<{name:string,description:string,mode:string,fromCache:boolean,contentHash?:string}>}
 */
export async function resolveSummary({ skills, settings, llm, summaries, name, cwd, scope }) {
  const skill = await skills.get(name, { cwd, ...(scope !== undefined ? { scope } : {}) });
  if (skill === undefined) {
    throw new SkillSelectApiError("skill-not-found", `skill "${name}" not found`, 404);
  }
  if (typeof skill.description === "string" && skill.description.trim() !== "") {
    return { name, description: skill.description.trim(), mode: "frontmatter", fromCache: false };
  }
  const contentHash = hashContent(skill.content);
  const cache = summaries ?? {};
  const cached = cache[name];
  if (cached !== undefined && cached.contentHash === contentHash) {
    return { name, description: cached.description, mode: cached.mode ?? "fallback", fromCache: true };
  }
  let description;
  let mode;
  try {
    description = await generateLlmSummary({ settings, llm, name, content: skill.content ?? "" });
    mode = "llm";
  } catch {
    description = extractFallbackDescription(skill.content);
    mode = "fallback";
  }
  if (description === null || description === "") {
    throw new SkillSelectApiError("internal", `failed to generate a description for skill "${name}"`, 500);
  }
  return { name, description, mode, fromCache: false, contentHash };
}

// ── service ────────────────────────────────────────────────────────────────

/**
 * 插件主体：打开 domain、注册围栏路由。发布为 `ctx.skillSelect`。
 */
export default class SkillSelectService extends Service {
  static inject = ["skills", "sessions", "webServer", "storageDomain", "settings", "llm", "tools"];

  #domain;
  #summaries;
  #usage;
  #defaults;
  #usageChain = Promise.resolve();
  /** sessionId → 已勾选技能名（客户端经 set-checked 同步的内存镜像，守卫判定用）。 */
  #checkedBySession = new Map();
  /** 已注入过默认技能的 agent 对象（每会话一次）。 */
  #defaultInjected = new WeakSet();

  constructor(ctx) {
    super(ctx, "skillSelect");
  }

  async [Service.init]() {
    const domain = await this.ctx.storageDomain.open(skillSelectDomainSpec);
    this.ctx.effect(() => () => domain.close(), "skill-select.domainClose");
    this.#domain = domain;
    this.#summaries = domain.global.get().summaries;
    this.#usage = domain.global.get().usage ?? {};
    this.#defaults = domain.global.get().defaults ?? [];
    this.#registerRoute();

    const offGuard = this.ctx.tools.guard((exec) => this.#guardSkill(exec));
    this.ctx.effect(() => offGuard, "skill-select.skill guard");

    const offPre = this.ctx.on("agent/pre-step", async ({ agent, messages }, next) => {
      const decision = await next();
      try {
        return await this.#onPreStep(decision, agent, messages);
      } catch (error) {
        this.ctx.logger.warn(`skill-select pre-step observer failed: ${error instanceof Error ? error.message : String(error)}`);
        return decision;
      }
    });
    this.ctx.effect(() => offPre, "skill-select.preStep observer");
  }

  /** 当前缓存快照（未初始化时为空对象）。 */
  get summaries() {
    return this.#summaries ?? {};
  }

  /** 当前真实调用计数快照（未初始化时为空对象）。 */
  get usage() {
    return this.#usage ?? {};
  }

  /** 当前默认启动名单（未初始化时为空数组）。 */
  get defaults() {
    return this.#defaults ?? [];
  }

  /** 在串行链上 read-modify-write，把一次调用计数落盘并刷新内存快照。 */
  #recordUsage(names) {
    this.#usageChain = this.#usageChain
      .catch(() => {})
      .then(async () => {
        const state = this.#domain.global.get();
        const usage = mergeUsage(state.usage ?? {}, names);
        await this.#domain.global.set({ ...state, usage });
        this.#usage = usage;
      });
    return this.#usageChain;
  }

  /**
   * skill 工具守卫：模型对「默认启动名单 ∪ 本会话勾选名单」之外的技能调用被拒绝。
   * 绝不抛异常；非 skill 工具与非法参数一律放行（由 dsh-tool-skill 自行校验）。
   */
  #guardSkill(exec) {
    try {
      if (exec?.name !== "skill") return undefined;
      const args = exec.arguments;
      const name = typeof args === "object" && args !== null ? args.name : undefined;
      if (typeof name !== "string" || name === "" || !isSkillName(name)) return undefined;
      const sessionId = typeof exec.agent?.session?.id === "string" ? exec.agent.session.id : undefined;
      const checked = sessionId !== undefined ? this.#checkedBySession.get(sessionId) : undefined;
      if (isAllowedSkill(this.#defaults, checked, name)) return undefined;
      return `skill "${name}" is not enabled — check it in the Skills panel or add it to Auto-start`;
    } catch {
      return undefined;
    }
  }

  /**
   * pre-step 观察者主流程：repo 令牌展开、默认技能每会话一次注入、真实调用计数。
   * decision 为 next() 的返回值；异常已在调用方捕获（logger.warn 后原样返回）。
   */
  async #onPreStep(decision, agent, messages) {
    if (decision.kind === "reject") return decision;
    const view = {
      cwd: agent?.session?.header?.cwd,
      ...(agent !== undefined && agent !== null ? { scope: agent } : {}),
    };
    const tokens = scanSkillGestures(messages);
    const injections = [];
    const counted = new Set();

    if (tokens.length > 0) {
      const listed = await this.ctx.skills.list(view).catch(() => []);
      const byName = new Set(listed.map((s) => s.name));
      const repoByName = new Map();
      for (const s of listed) {
        let repo = resolveRepo(s.name);
        if (repo === null) {
          const def = await this.ctx.skills.get(s.name, view).catch(() => undefined);
          if (def?.resourceBase?.kind === "directory") repo = resolveRepo(s.name, def.resourceBase.path);
        }
        repoByName.set(s.name, repo);
      }
      const repoIndex = buildRepoIndex(repoByName, listed);
      for (const token of tokens) {
        if (byName.has(token)) {
          // 真实技能手势：注入由 dsh-tool-skill 完成，这里只计数。
          counted.add(token);
          continue;
        }
        const entry = repoIndex.get(token.toLowerCase());
        if (entry === undefined) continue;
        const blocks = [];
        for (const member of entry.members) {
          counted.add(member);
          try {
            const skill = await this.ctx.skills.get(member, view).catch(() => undefined);
            if (skill !== undefined) blocks.push(renderSkillContent(skill));
          } catch {
            // 单个成员加载/渲染失败不影响其余成员。
          }
        }
        if (blocks.length > 0) {
          injections.push(createUserMessage({
            content: [{ type: "text", text: blocks.join("\n\n") }],
            source: { kind: "skill-invocation", name: entry.repo, form: "instructions" },
          }));
        }
      }
    }

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

    // 默认技能：每个 agent 会话的首条含用户消息的步骤注入一次。
    const hasUser = (messages ?? []).some((m) => m?.source?.kind === "user");
    if (hasUser && agent !== undefined && agent !== null && !this.#defaultInjected.has(agent)) {
      this.#defaultInjected.add(agent);
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
    }

    if (counted.size > 0) await this.#recordUsage([...counted]);
    if (injections.length === 0) return decision;
    return { kind: "enter", messages: [...(decision.messages ?? []), ...injections] };
  }

  async #persistSummary(name, result) {
    const state = this.#domain.global.get();
    const next = {
      ...state,
      summaries: {
        ...state.summaries,
        [name]: {
          description: result.description,
          contentHash: result.contentHash,
          generatedAt: new Date().toISOString(),
          mode: result.mode,
        },
      },
    };
    await this.#domain.global.set(next);
    this.#summaries = next.summaries;
  }

  #cwdOf(sessionId) {
    const session = this.ctx.sessions.get(sessionId);
    if (session === undefined) {
      throw new SkillSelectApiError("session-not-found", `session "${sessionId}" not found`, 404);
    }
    return session.header?.cwd;
  }

  /**
   * 全量更新入口：计算默认 roots 后委托给导出的 `runUpdate`（单测直接测它，
   * 避免触碰真实技能目录与网络）。
   * @returns {Promise<Array<{id:string,name:string,source:string,status:string,changes:string[],before?:string,after?:string,reason?:string}>>}
   */
  async #runUpdate() {
    const roots = [
      { id: "dsh-global", path: join(homedir(), ".dsh/skills") },
      { id: "agents", path: join(homedir(), ".agents/skills") },
      ...externalRoots().map((r) => ({ id: r.agent, path: r.path })),
    ];
    return runUpdate(roots);
  }

  async #dispatch(method, payload) {
    // agents 是可选服务：web 宿主里会话 scope 由 agent preset 层提供
    // （见 resolveList）；缺失时退化为全局层视图，保持其他宿主兼容。
    const agents = this.ctx.get("agents");
    switch (method) {
      case "list": {
        const sessionId = requireString(payload, "sessionId");
        return await resolveList({
          sessions: this.ctx.sessions,
          skills: this.ctx.skills,
          agents,
          summaries: this.summaries,
          usage: this.usage,
          defaults: this.defaults,
          sessionId,
        });
      }
      case "summarize": {
        const sessionId = requireString(payload, "sessionId");
        const name = requireString(payload, "name");
        const idx = name.indexOf(":");
        if (idx > 0 && EXTERNAL_AGENTS.some((e) => e.agent === name.slice(0, idx))) {
          const agent = name.slice(0, idx);
          let skill;
          try {
            skill = await readExternalSkill(agent, name.slice(idx + 1));
          } catch {
            throw new SkillSelectApiError("skill-not-found", `skill "${name}" not found`, 404);
          }
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
        const scope = agents?.get(sessionId);
        const result = await resolveSummary({
          skills: this.ctx.skills,
          settings: this.ctx.settings,
          llm: this.ctx.llm,
          summaries: this.summaries,
          name,
          cwd,
          scope,
        });
        if (!result.fromCache && result.contentHash !== undefined) {
          await this.#persistSummary(result.name, result);
        }
        return { name: result.name, description: result.description };
      }
      case "set-default": {
        const name = requireString(payload, "name");
        // name 必须是 kebab 技能名或 agent:name 复合 id（与 set-checked 同一套校验）。
        if (!(isSkillName(name) || /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))) {
          throw new SkillSelectApiError("bad-request", "missing or invalid \"name\"");
        }
        if (typeof payload.on !== "boolean") {
          throw new SkillSelectApiError("bad-request", "missing or invalid \"on\"");
        }
        const next = toggleDefaults(this.#defaults, name, payload.on);
        const state = this.#domain.global.get();
        await this.#domain.global.set({ ...state, defaults: next });
        this.#defaults = next;
        return { name, defaultStart: payload.on };
      }
      case "set-checked": {
        const sessionId = requireString(payload, "sessionId");
        if (this.ctx.sessions.get(sessionId) === undefined) {
          throw new SkillSelectApiError("session-not-found", `session "${sessionId}" not found`, 404);
        }
        const skills = payload.skills;
        // 每个元素必须是普通技能名（isSkillName）或 agent:name 复合 id。
        const valid = Array.isArray(skills) && skills.every((s) => typeof s === "string" && s !== ""
          && (isSkillName(s) || /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)));
        if (!valid) throw new SkillSelectApiError("bad-request", "missing or invalid \"skills\"");
        this.#checkedBySession.set(sessionId, [...new Set(skills)]);
        return { sessionId, count: this.#checkedBySession.get(sessionId).length };
      }
      case "update": {
        return { items: await this.#runUpdate() };
      }
      default:
        throw new SkillSelectApiError("not-found", `unknown skill-select API method "${method}"`, 404);
    }
  }

  #registerRoute() {
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: "prefix",
      path: "/skill-select/api",
      handler: async (req, res) => {
        const trustedHosts = this.ctx.get("webRuntime")?.trustedHosts ?? [];
        if (!isTrustedRequest(req, trustedHosts)) {
          writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
          return;
        }
        if (req.method !== "POST") {
          writeJson(res, 405, { ok: false, error: { code: "method-error", message: "method not allowed" } });
          return;
        }
        const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
        const method = pathname.startsWith("/skill-select/api/")
          ? pathname.slice("/skill-select/api/".length)
          : undefined;
        if (method === undefined || method.includes("/")) {
          writeError(res, new SkillSelectApiError("not-found", "unknown skill-select API method", 404));
          return;
        }
        try {
          const payload = await readJsonBody(req);
          writeOk(res, await this.#dispatch(method, payload));
        } catch (error) {
          writeError(res, error);
        }
      },
    }), "skill-select.api route");
  }
}

export { skillSelectDomainSpec, summaryStateSchema };
