/**
 * dsh-skill-select — host 半。
 *
 * 注册 `ctx.skillSelect`（SkillSelectService），提供 fenced `/skill-select/api`
 * JSON 路由：
 *   - list      { sessionId }            → 该会话 cwd 视角下的全部技能
 *                                          （含来源分类与简介解析）
 *   - summarize { sessionId, name }      → 为无 frontmatter 简介的技能生成一句
 *                                          简介（LLM，失败回退提取），写入插件
 *                                          自己的 storage domain 缓存
 *
 * 绝不读写任何 skill 文件；技能枚举与加载全部经由 `ctx.skills` 服务。
 * 信任围栏与 JSON 包络与 dsh-pin 完全一致。
 *
 * @module dsh-skill-select
 */
import { Service } from "@deepseek-ai/cordis";
import { defineDomain } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import { createHash } from "node:crypto";

// ── durable domain ─────────────────────────────────────────────────────────

/** 简介缓存 schema：按技能名记录，contentHash 用于内容变更后的失效。 */
const summaryStateSchema = z.object({
  summaries: z.record(z.object({
    description: z.string(),
    contentHash: z.string(),
    generatedAt: z.string(),
    mode: z.enum(["llm", "fallback"]),
  })),
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
 * @param {object} deps
 * @param {{get:(id:string)=>object|undefined}} deps.sessions - ctx.sessions
 * @param {{list:(opts:object)=>Promise<Array>}} deps.skills - ctx.skills
 * @param {Record<string,{description:string,contentHash:string}>|undefined} deps.summaries - 缓存
 * @param {string} deps.sessionId
 * @returns {Promise<{sessionId:string, skills:Array<object>}>}
 */
export async function resolveList({ sessions, skills, summaries, sessionId }) {
  const session = sessions.get(sessionId);
  if (session === undefined) {
    throw new SkillSelectApiError("session-not-found", `session "${sessionId}" not found`, 404);
  }
  const cwd = session.header?.cwd;
  const listed = await skills.list({ cwd });
  const cache = summaries ?? {};
  const views = [];
  for (const s of listed) {
    let description = typeof s.description === "string" && s.description.trim() !== ""
      ? s.description.trim()
      : null;
    if (description === null) {
      const cached = cache[s.name];
      if (cached !== undefined && typeof cached.contentHash === "string") {
        try {
          const def = await skills.get(s.name, { cwd });
          if (def !== undefined && hashContent(def.content) === cached.contentHash) {
            description = cached.description;
          }
        } catch {
          description = null;
        }
      }
    }
    views.push({
      name: s.name,
      description,
      ...(typeof s.whenToUse === "string" && s.whenToUse !== "" ? { whenToUse: s.whenToUse } : {}),
      source: classifySource(s.source),
      modelInvocable: s.invocation?.modelInvocable !== false,
      userInvocable: s.invocation?.userInvocable !== false,
    });
  }
  return { sessionId, skills: views };
}

const SUMMARY_SYSTEM_PROMPT = [
  "你是技能简介生成器。",
  "只输出一句不超过 40 字的中文简介，描述该技能做什么、何时使用。",
  "不要输出任何其他内容。",
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
    messages: [{ role: "user", content: `技能名：${name}\n\n技能内容：\n${content.slice(0, 4000)}` }],
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
 * @param {object} deps
 * @param {{get:(name:string,opts:object)=>Promise<object|undefined>}} deps.skills
 * @param {{get:(ns:string)=>unknown}} deps.settings
 * @param {{prepareCall:(cfg:object)=>Promise<object>}} deps.llm
 * @param {Record<string,object>|undefined} deps.summaries
 * @param {string} deps.name
 * @param {string|undefined} deps.cwd
 * @returns {Promise<{name:string,description:string,mode:string,fromCache:boolean,contentHash?:string}>}
 */
export async function resolveSummary({ skills, settings, llm, summaries, name, cwd }) {
  const skill = await skills.get(name, { cwd });
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
    throw new SkillSelectApiError("internal", `无法为技能 "${name}" 生成简介`, 500);
  }
  return { name, description, mode, fromCache: false, contentHash };
}

// ── service ────────────────────────────────────────────────────────────────

/**
 * 插件主体：打开 domain、注册围栏路由。发布为 `ctx.skillSelect`。
 */
export default class SkillSelectService extends Service {
  static inject = ["skills", "sessions", "webServer", "storageDomain", "settings", "llm"];

  #domain;
  #summaries;

  constructor(ctx) {
    super(ctx, "skillSelect");
  }

  async [Service.init]() {
    const domain = await this.ctx.storageDomain.open(skillSelectDomainSpec);
    this.ctx.effect(() => () => domain.close(), "skill-select.domainClose");
    this.#domain = domain;
    this.#summaries = domain.global.get().summaries;
    this.#registerRoute();
  }

  /** 当前缓存快照（未初始化时为空对象）。 */
  get summaries() {
    return this.#summaries ?? {};
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

  async #dispatch(method, payload) {
    switch (method) {
      case "list": {
        const sessionId = requireString(payload, "sessionId");
        return await resolveList({
          sessions: this.ctx.sessions,
          skills: this.ctx.skills,
          summaries: this.summaries,
          sessionId,
        });
      }
      case "summarize": {
        const sessionId = requireString(payload, "sessionId");
        const name = requireString(payload, "name");
        const cwd = this.#cwdOf(sessionId);
        const result = await resolveSummary({
          skills: this.ctx.skills,
          settings: this.ctx.settings,
          llm: this.ctx.llm,
          summaries: this.summaries,
          name,
          cwd,
        });
        if (!result.fromCache && result.contentHash !== undefined) {
          await this.#persistSummary(result.name, result);
        }
        return { name: result.name, description: result.description };
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
