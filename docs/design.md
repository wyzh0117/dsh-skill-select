# dsh-skill-select 设计文档

> DSH Web 插件：侧边栏 skill 选择器。读取已配置的全部 skill（标注全局/局部），以
> 页签形式合并进 dsh-better-sidebar（未安装时回退到内置侧栏），勾选后把 `/skill`
> 手势填入当前会话输入框草稿，随用户下一条消息生效（由 DSH 宿主在 pre-step 边界
> 自动注入 `<skill_content>`）。无简介的 skill 由宿主侧 LLM 生成一句简介并缓存，
> 绝不改写 skill 原文件。

## 1. 目标与非目标

**目标（对应用户需求）**
1. 自动读取所有已下载/配置的 skill，并区分全局（`~/.dsh/skills` 等 user 根）与
   局部（项目 `.dsh/skills` 等 project 根）skill。
2. 以 sidebar 形式展示；已安装 dsh-better-sidebar 时自动注册为其页签
   （`ctx.betterSidebar.registerTab`）；未安装时回退到内置侧栏
   `sidebar.footer.action` 槽 + 自绘浮动面板。
3. 展示每个 skill 的名称与简介：自带 frontmatter `description` 直接用；缺失时
   宿主侧 LLM 生成一句中文简介并缓存（LLM 失败回退取 SKILL.md 首段）；缓存存于
   插件自有 storage domain，不改动 skill 原 .md 或其他文件。
4. 勾选一个或多个 skill 时，对应 `/skill-name` 手势自动填入当前 session 输入框
   草稿；随下一条消息发送后，DSH 的 `dsh-tool-skill` pre-step 钩子将渲染后的
   `<skill_content>` 以 `skill-invocation` 来源注入会话（对话框可见、持久、可被
   模型正常使用）。

**非目标**
- 不修改 DSH 核心包、不修改任何 skill 文件、不新增 slash 命令。
- 不实现 skill 的下载/安装管理（只读已配置的 skill）。
- 不做多语言完整 i18n（中文为主，英文兜底少量文案）。
- 不在会话历史中"撤销"已注入的 skill（勾选只管理草稿手势）。

## 2. 架构

单 npm 包、host/client 双半、纯 ESM、无构建步骤（完全对齐用户已有插件
`dsh-pin` 的模式）：

```
skill-select/
├── package.json          # main: lib/index.js; exports["./client"]; dsh.client 声明
├── dsh.plugin.json       # 插件清单（inventory 用它服务 /plugins/<id>/client.js）
├── cordis.patch.yml      # bundle 挂载行（profile loader 用它挂 host 半）
├── lib/
│   ├── index.js          # host 半：SkillSelectService + /skill-select/api 围栏路由
│   └── client.js         # client 半：window.__ModuleLoader__.load(...)
├── tests/
│   └── index.test.js     # host 半单元测试（node --test）
├── docs/
└── README.md
```

### 2.1 Host 半（lib/index.js）

Cordis Service 类插件（loader 直接挂类，参照 dsh-pin 的 PinRegistry）：

```js
export default class SkillSelectService extends Service {
  static inject = ["skills", "sessions", "webServer", "storageDomain", "settings", "llm"];
  constructor(ctx) { super(ctx, "skillSelect"); }
  async [Service.init]() { /* 打开 domain、注册路由 */ }
}
```

职责：
- **枚举**：`ctx.sessions.get(sessionId)` → `session.header.cwd` →
  `ctx.skills.list({ cwd })`（SkillSummary[]）。会话不存在时返回
  `{code:"session-not-found"}`。
- **来源分类**：按 `summary.source` 归为四类：
  - `project-dsh` / `project-agents` → `"project"`（局部/项目）
  - `user-dsh` / `user-agents` → `"user"`（全局/用户）
  - `bundled` → `"bundled"`（内置）
  - 其余（`custom`/`runtime`/未知）→ `"other"`
- **简介补齐**：`summary.description` 非空直接用；为空查插件 domain 缓存
  （按 `name` + 内容 hash 存）；仍无则客户端可调 `summarize` 生成。
- **summarize**：`ctx.skills.get(name,{cwd})` → 有 frontmatter description 直接
  返回；否则读缓存；否则 LLM 生成（见 2.3）；LLM 失败回退提取 body 首个非空
  段落/标题。生成结果写 domain（key=`name`，value 含 `description`、
  `contentHash`、`generatedAt`、`mode: 'llm'|'fallback'`）。
- **路由**：`ctx.webServer.register({kind:"prefix", path:"/skill-select/api",
  handler})`，信任围栏逐字复用 dsh-pin 的 `isTrustedRequest`（Host/Origin/
  sec-fetch-site 检查 + `ctx.get("webRuntime")?.trustedHosts`）。

### 2.2 Client 半（lib/client.js）

`window.__ModuleLoader__.load({ id: "dsh-skill-select", factory })`，
`exports = { apply, inject: ["conversation", "slots"] }`。

- **better-sidebar 探测（三保险，可选服务）**：apply 时 `ctx.get("betterSidebar")`；
  未就绪则监听 `internal/service` 事件（`(name, value)` 匹配 `"betterSidebar"`）；
  再补一个 3s 延迟重探测。就绪后 `registerTab`；从未出现则注册内置侧栏回退
  （`sidebar.footer.action` 槽按钮 + 固定定位浮动面板，`react-dom` portal 渲染到
  document.body）。
- **tab 描述符**：`{ id: "skill-select", title: "技能", single: true, order: 90,
  component }`；`component` 接收 `{ ctx, scope, tab, visible }`，
  `scope.sessionId` 为当前会话。
- **数据**：`POST /skill-select/api/list {sessionId}` → 技能数组；仅展示
  `userInvocable` 项；来源渲染徽标（局部/全局/内置/其他）；`description` 为
  `null` 的条目进入串行生成队列，逐个 `POST /skill-select/api/summarize`
  （并发 1），结果原地回填。tab 挂载与 `visible` 变化时刷新，另设手动刷新按钮、
  关键词搜索过滤。
- **勾选 → 草稿注入**：勾选状态按 session 存 localStorage
  （key `dsh-skill-select:checked:<sessionId>`，JSON 数组）。勾选时：
  `const {ctx: actx} = createScope(rootCtx, sessionId)`（缓存 handle 复用）；
  `rootCtx.conversation.input.for(actx)` → `setDraft`：把当前草稿与
  ` /name`（不存在才加）拼接。取消勾选时从草稿中移除该手势。
- 所有 fetch 走页面同源相对路径 `/skill-select/api/<method>`（与 dsh-pin 相同）。

### 2.3 LLM 简介生成（host）

- 模型选择：`ctx.settings.get("agent-default-model")` 读 `{provider, model}`；
  缺失则抛错进入 fallback。
- `const prepared = await ctx.llm.prepareCall({ provider, model, maxTokens: 200 })`；
  `const stream = prepared.stream({ ...prepared.config, system: <系统提示>,
  messages: [{ role: "user", content: <skill 名称 + SKILL.md 前 4000 字符> }],
  signal })`；聚合 `type === "text-delta"` 的 `text` 字段。
- 系统提示要求输出**一句、不超过 40 字、中文**的用途简介，仅返回简介本身。
- 任何异常（LlmError/网络/超时 15s AbortSignal.timeout）→ fallback 提取。

### 2.4 持久化（storage domain）

`defineDomain({ name: "skill-select", version: 1, global: { schema, initial },
tables: {} })`，schema（zod）：

```js
z.object({
  summaries: z.record(z.object({
    description: z.string(),
    contentHash: z.string(),     // sha1(skill.content) 前 16 位
    generatedAt: z.string(),     // ISO-8601
    mode: z.enum(["llm", "fallback"]),
  })),
})
```

## 3. 契约

### 3.1 路由 `POST /skill-select/api/<method>`（JSON body）

统一响应：成功 `{ok:true, value}`；失败 `{ok:false, error:{code, message}}`。

**list**
- 请求：`{ "sessionId": "<id>" }`
- 成功：`{ "sessionId", "skills": SkillView[] }`

```ts
interface SkillView {
  name: string;            // kebab-case
  description: string | null;  // frontmatter 或缓存简介；null = 待生成
  whenToUse?: string;
  source: "project" | "user" | "bundled" | "other";
  modelInvocable: boolean;
  userInvocable: boolean;
}
```

**summarize**
- 请求：`{ "sessionId": "<id>", "name": "<skill-name>" }`
- 成功：`{ "name", "description" }`
- 错误码：`session-not-found`、`skill-not-found`、`bad-request`、
  `internal`（含 LLM 失败但 fallback 也失败时）

### 3.2 激活路径（无需自定义 wire）

勾选 → 草稿追加 ` /name` → 用户发送 → `session.prompt` 入队 → 宿主
`dsh-tool-skill` 的 `agent/pre-step` 钩子识别 `/(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g`
手势 → 注入渲染后的 `<skill_content>`（`source.kind === "skill-invocation"`）
→ 客户端把该来源渲染为 `role:"inject"` 上下文行（标签=技能名）。

## 4. 安装

1. `~/.dsh/profiles/web/package.json`：
   - `dependencies` 增加 `"dsh-skill-select": "file:/Users/youngi/Documents/MiniWork/dsh插件/skill-select"`
   - `dsh.profile.bundles` 增加 `"dsh-skill-select"`
2. 该目录 `pnpm install`。
3. 重启 `dsh web`（host 半生效），浏览器硬刷新（client 半生效）。

## 5. 验收标准

- [ ] R1 列表包含 `~/.dsh/skills` 下全部 skill 且标记"全局"，项目 `.dsh/skills`
      的标记"局部"。
- [ ] R2 在已安装 dsh-better-sidebar 的环境下，侧栏 + 菜单出现"技能"页签；
      卸载 better-sidebar 时回退到内置侧栏按钮+浮动面板（代码路径 review 验证）。
- [ ] R3 有 frontmatter 简介的 skill 原样展示；缺失的生成后展示并缓存于插件
      domain；skill 原文件未被修改（git status 对比验证）。
- [ ] R4 勾选后输入框草稿出现 ` /name`；取消勾选后移除；发送后技能注入行出现
      在对话中且模型可正常使用该技能。
- [ ] 单测通过（`node --test`），host 路由契约与本文档一致。
