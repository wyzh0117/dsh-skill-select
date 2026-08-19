# dsh-skill-select 设计文档

> DSH Web 插件：侧边栏 skill 选择器（英文 UI）。读取已配置的全部 skill（标注
> Project/Global 与所属 repo，并额外扫描 codex/grok/hermes 的用户技能），以页签
> 形式合并进 dsh-better-sidebar（未安装/被禁用时回退到**右侧缘活动栏 + VSCode 式
> 右滑面板**）。勾选后把 `/skill` 手势填入当前会话输入框草稿（外部 agent 技能改为
> 下一条消息直接注入），随用户下一条消息生效（由 DSH 宿主在 pre-step 边界自动注入
> `<skill_content>`）。无简介的 skill 由宿主侧 LLM 生成一句英文简介并缓存；提供
> **一键更新**所有 skill 并在面板内展示精简变更摘要。绝不改写 skill 原文件。

## 1. 目标与非目标

**目标（对应用户需求）**
1. 自动读取所有已下载/配置的 skill，并区分全局（`~/.dsh/skills` 等 user 根）与
   局部（项目 `.dsh/skills` 等 project 根）skill。
2. 以 sidebar 形式展示；已安装 dsh-better-sidebar 时自动注册为其页签
   （`ctx.betterSidebar.registerTab`）；未安装/被禁用时回退到**右侧缘竖向活动栏 +
   从 DSH 右侧滑出的 VSCode 式面板**（对齐 better-sidebar 的拓展点位置、展示与
   弹出方式），而非浮动窗口或悬浮圆钮。
3. 展示每个 skill 的名称、简介与**所属 repo 徽标**：repo 由内置映射表
   （superpowers 全家桶等）+ 嵌套目录（`<repo>/<skill>`）路径推断得出，两者都
   无法判定时不显示；判定过程绝不修改 skill 文件。
4. 面板分两页：**Skills**（列表与勾选）与 **Auto-start**（默认启动管理）。
   Skills 页默认按 **repo 分组**：组头三态复选框（全选/半选/全不选）+ 折叠
   （默认收起）；repo 全部技能被勾选时，输入框草稿只写一个 `/repo名` 令牌
   （简洁显示），发送时由宿主展开为全部成员技能。另保留 Name / Most used /
   Source 三种排序视图。
5. **默认启动（Auto-start）**：用户勾选的技能存入插件 domain（全局生效）；
   每个会话的首条用户消息时，宿主把默认技能内容注入会话一次（`skill-invocation`
   来源、官方 `renderSkillContent` 渲染），并计入调用次数。
6. **不选不启动**：宿主注册 `ctx.tools.guard` 守卫——模型通过 `skill` 工具
   调用**不在**「默认启动名单 ∪ 本会话已勾选名单」的技能时被拒绝（模型收到
   明确错误、绝不执行）；用户手动 `/skill` 手势不受限；技能目录不隐藏。
7. 调用次数为真实调用统计：`/skill-name` 手势、`/repo名` 展开的成员、默认注入
   的技能都计入（同一步骤同一技能只 +1），写入插件 storage domain；仅从安装后
   累计，不回填历史。
8. 简介：自带 frontmatter `description` 直接用；缺失时宿主侧 LLM 生成一句英文
   简介并缓存（LLM 失败回退取 SKILL.md 首段）；缓存存于插件自有 storage domain，
   不改动 skill 原 .md 或其他文件。
9. 勾选一个或多个 skill 时，对应 `/skill-name` 手势自动填入当前 session 输入框
   草稿；随下一条消息发送后，DSH 的 `dsh-tool-skill` pre-step 钩子将渲染后的
   `<skill_content>` 以 `skill-invocation` 来源注入会话（对话框可见、持久、可被
   模型正常使用）。
10. **外部 agent 技能**：除 `~/.dsh/skills` 外，扫描 codex/grok/hermes 的用户技能
    目录（排除各自内置），以复合身份 `agent:name` 展示，重名全列、可分别勾选；
    勾选或加入 Auto-start 后由插件**直接注入**（不进 `ctx.skills`，见 §2.5）。
11. **一键更新**：对 git 仓库型技能 `git pull`、对带来源标记的技能按 URL 重拉
    （§2.6），结果在面板内以精简摘要展示，**不新建会话**。
12. **UI 一致性**：repo 组头名用与技能名一致的等宽字体且略大（13px vs 12.5px）；
    repo 展开后组内技能行缩进体现层级；修正 “Other” 组计数与三态。

**非目标**
- 不修改 DSH 核心包、不修改任何 skill 文件、不新增 slash 命令。
- 外部 agent 技能**不注册**进 `ctx.skills`：不进模型 `available_skills` 目录、
  不能经 `skill` 工具按名调用（与「勾选后注入即可用」的模型一致）。
- 更新只处理 git 仓库与带来源标记的技能；无更新源的手工技能标记为 `skipped`，
  不做内容快照/回滚。
- 不实现 skill 的下载/安装管理；不展开 AERS 的 vendored 子技能。
- 不做多语言完整 i18n（英文 UI）；不持久化排序/折叠偏好。
- 不在会话历史中“撤销”已注入的 skill；不回填安装前历史调用量；不统计模型
  `skill` 工具调用（仅统计注入路径）。
- 不隐藏技能目录（available_skills 由 dsh-tool-skill 管理）；拦截以工具调用守卫
  实现，模型收到明确拒绝理由。

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
│   ├── index.test.js     # host 半单元测试（node --test）
│   └── client.test.js    # client 半冒烟测试
├── docs/
└── README.md
```

新增运行时依赖：`yaml`（前端解析外部 SKILL.md frontmatter；`description: >`
折叠标量等正则不可靠，`yaml` 已在依赖树中）。

### 2.1 Host 半（lib/index.js）

Cordis Service 类插件（loader 直接挂类，参照 dsh-pin 的 PinRegistry）：

```js
export default class SkillSelectService extends Service {
  static inject = ["skills", "sessions", "webServer", "storageDomain", "settings", "llm", "tools"];
  constructor(ctx) { super(ctx, "skillSelect"); }
  async [Service.init]() { /* 打开 domain、注册路由、注册 guard 与 pre-step 观察者 */ }
}
```

职责（与上一版一致的部分从略，仅列关键点）：
- **枚举**：`ctx.sessions.get(sessionId)` → `session.header.cwd` →
  `ctx.skills.list({ cwd, scope })`。scope 取自 `ctx.agents.get(sessionId)`
  （与 `dsh-tool-skill` 一致）；`agents` 缺失时退化为仅全局层。
- **来源分类**：`classifySource(source)` → `project`/`user`/`bundled`/`other`。
- **简介补齐**：`summary.description` 非空直接用；为空查 domain 缓存（name+hash）；
  仍无则客户端调 `summarize` 生成。
- **repo 归属**：`resolveRepo(name, dirPath)` 先查内置映射 `SKILL_REPOS`，未命中对
  未映射技能补一次 `ctx.skills.get()` 用 `resourceBase.path` 推断。
- **调用计数**：`ctx.on("agent/pre-step")` 观察者扫描 `/skill` 手势与 repo 令牌、
  默认注入，串行写 domain（`mergeUsage`）。
- **repo 令牌展开**：repo 索引（`buildRepoIndex`）展开成员，渲染单条注入行。
- **默认技能注入**：每个 agent 对象（WeakSet）首条含用户消息的步骤注入一次。
- **skill 工具守卫**：`ctx.tools.guard` 拒绝「默认名单 ∪ 会话勾选名单」外的调用。
- **summarize**：`ctx.skills.get` → frontmatter → 缓存 → LLM → 回退提取。
- **路由**：`/skill-select/api` 围栏路由，信任围栏逐字复用 dsh-pin 的
  `isTrustedRequest`。

### 2.2 Client 半（lib/client.js）

`window.__ModuleLoader__.load({ id: "dsh-skill-select", factory })`，
`exports = { apply, inject: ["conversation"] }`。

- **better-sidebar 探测（三保险，可选服务）**：`ctx.get("betterSidebar")` +
  `internal/service` 事件 + 3.2s 兜底。就绪则 `registerTab`；否则 `mountStandalone`
  挂载自绘 UI（见 §2.7 活动栏）。
- **tab 描述符**：`{ id: "skill-select", title: "Skills", icon, single: true,
  order: 90, component }`；`component` 接收 `{ ctx, scope, tab, visible }`。
- **数据**：`POST /skill-select/api/list {sessionId}` → `{ skills, external }`
  合并展示；仅展示 `userInvocable` 项；`description` 为 `null` 进串行
  `summarize` 队列回填。tab/抽屉打开与 `visible` 变化刷新，另设手动刷新 + 搜索。
- **面板分页**：Skills / Auto-start 两页。
- **排序下拉框**：Repo（默认）/ Name / Most used / Source；纯函数
  `sortByName`/`sortByUsage`/`groupByRepo`。
- **repo 分组视图**：组头 = 三态复选框 + repo 名（或 Other）+ 数量 + 折叠箭头，
  默认收起；组按名升序、无 repo 最后；组头复选作用于全组成员。
- **行内**：技能名 + 来源小徽标；repo 模式由组头承载 repo 名（不逐行重复）。
- **勾选 → 草稿（简洁令牌）**：勾选状态按 session 存 localStorage
  （`dsh-skill-select:checked:<sessionId>`），经 `set-checked` 同步宿主。草稿纯函数
  `composeDraft`：移除本插件管理令牌后按 `tokensForChecked` 追加（repo 满选 → 单
  `/repo名`，否则逐个 `/skill`）。**外部技能不写草稿令牌**（§2.5）。
- **UI 一致性（§1.12）**：repo 组头名 `fontFamily: var(--ds-font-family-code)`,
  `fontSize: 13`（技能名 12.5）、字重 600；repo 模式下组内技能行 `padding-left`
  增加 ~16px 缩进；“Other”组计数与三态用 `(s.repo ?? "")` 归一化。

### 2.3 LLM 简介生成（host）

与上一版一致：`agent-default-model` → `llm.prepareCall` → `stream` 聚合
`text-delta`；系统提示要求一句、≤80 字符、英文；15s 超时；异常回退提取。
外部技能同样复用此流程（内容来自 `readExternalSkill`，缓存 key 用复合 id）。

### 2.4 持久化（storage domain）

`defineDomain({ name: "skill_select", version: 1, ... })`；**schema 不变**——
`summaries`/`usage` 仍是 `z.record`，`defaults` 仍是 `z.array(z.string())`，复合 id
（`agent:name`）直接作为 string key 使用，无需迁移：

```js
z.object({
  summaries: z.record(z.object({
    description: z.string(),
    contentHash: z.string(),     // sha1(skill.content) 前 16 位（外部技能同）
    generatedAt: z.string(),
    mode: z.enum(["llm", "fallback"]),
  })),
  usage: z.record(z.object({
    count: z.number(),
    lastUsedAt: z.string(),
  })).default({}),
  defaults: z.array(z.string()).default([]),  // 技能名或复合 id（全局）
})
```

### 2.5 外部 agent 技能（方案 A：插件自持 + 直接注入）

**身份模型**：外部技能以复合 id `agent:name` 标识（如 `grok:ego-browser`），与
DSH 技能（`name`）并列存在于同一列表视图；重名技能因 agent 不同而各自独立、
可分别勾选。

**扫描根（host，`homedir()` 解析 `~`）**：
| agent | 目录 | 内置排除 |
|-------|------|----------|
| codex | `~/.codex/skills` | 跳过点目录（`.system`，其内 `.codex-system-skills.marker` 佐证为内置） |
| grok  | `~/.grok/skills` | 跳过点目录/纯文件（内置在 `~/.grok/bundled/`，天然不扫） |
| hermes| `~/.hermes/skills` | 跳过点目录/纯文件（内置在别处） |

目录名即技能名（kebab，忽略 frontmatter 中可能的大小写 `name`）；跟随符号链接
（`ego-browser` 是软链）；每目录读 `SKILL.md`。

**解析（`readExternalSkill(agent, dirName)`）**：`yaml` 解析 frontmatter 取
`description`/`whenToUse`；body 作为 `content`；`resourceBase =
{ kind: "directory", path: <技能目录> }`；返回可供 `renderSkillContent` 直接
使用的 skill 对象。

**list**：返回值增加 `external: ExternalSkillView[]`，与 `skills` 并行：
```ts
interface ExternalSkillView {
  id: string;              // "agent:name"
  agent: "codex" | "grok" | "hermes";
  name: string;            // kebab
  description: string | null;
  whenToUse?: string;
  repo: string;            // 显示为 agent 名，作分组/徽标
  usage: number;
  defaultStart: boolean;
}
```

**set-checked**：`skills` 数组可含技能名或复合 id；宿主分别维护
`#checkedBySession`（DSH 技能，供守卫）与 `#checkedExternalBySession`（复合 id）。

**summarize**：`name` 允许传复合 id；命中外部技能则 `readExternalSkill` 读文件
生成简介（缓存 key 用复合 id），不再走 `ctx.skills.get`。

**注入**：pre-step 观察者新增一步——对 `#checkedExternalBySession[sessionId]` 中
本会话尚未注入的复合 id（每会话去重：记录本会话已注入的复合 id 集合，字符串，
非对象 WeakSet），`readExternalSkill` + `renderSkillContent` 注入
（`source.kind:"skill-invocation"`，标签=技能名），计入 `usage`。**不写草稿令牌**
（直接注入，时序等同 Auto-start，避开 `/name` 重名歧义）。Auto-start（`defaults`）
同样接受复合 id，注入逻辑与 DSH 技能一致；勾选注入与默认注入共用 `counted` 去重，
避免同一复合 id 重复注入/计数。

**守卫**：外部技能不进 `ctx.skills`，`skill` 工具本就无法按名解析，无需额外拦截；
`isAllowedSkill` 对复合 id 天然按字符串匹配即可。

### 2.6 一键更新（host + client）

**Host `update` API**（`node:child_process` 的 `execFile("git", ...)`）：
- 扫描范围：dsh 全局（`~/.dsh/skills`）、项目（`.dsh/skills`）、三个 agent 技能根
  （§2.5），以及 `~/.agents/skills`（user-agents）中的技能目录。
- 每项判定：有 `.git` → `git -C <dir> pull --ff-only`，记 before/after HEAD 与
  `git -C <dir> log --oneline old..new`；无 `.git` 但有来源标记（如
  `~/.grok/skills/.superpowers-origin.txt` 的 `source=`/`commit=`/`version=`）→
  按 URL 重新拉取到临时目录后替换，记版本/commit 差；否则 → `skipped`。
- 返回：`{ items: [{ id, name, source, status: "updated"|"skipped"|"failed",
  before, after, changes: string[] }] }`。任何 git 失败不抛断整体，单条记 `failed`
  带原因。

**Client**：工具栏加 “Update skills” 按钮（进行中旋转态、防重入）；成功后渲染
面板内摘要区（每项：技能名 + 状态徽标 + 变更摘要行；`skipped`/`failed` 附说明）。
**不新建会话**（按用户选择）。

> 现实提示：当前仅 `~/.hermes/skills/xiaohongshu-skills` 为 git 仓库、grok 的
> superpowers 有来源标记；其余技能会显示“无更新源/跳过”。机制已就位，将来以
> git/来源方式安装即自动可更新。

### 2.7 回退 UI：活动栏 + VSCode 式右滑面板

无 better-sidebar 时的自绘 UI（`SkillsDrawer`/`mountStandalone`）：
- **拓展点（活动栏）**：右侧缘竖向细条（`position:fixed; right:0;
  top:<会话顶栏底部>; bottom:0; width≈40px`），顶部放 Skills 图标按钮；开合态
  图标切换 ×。不再用右上角悬浮圆钮。
- **展示方式**：面板顶部保留标题栏 + Skills/Auto-start 子页签，内部复用
  `SkillPanel`。
- **弹出方式**：面板 `top/right/bottom` 贴边、`width:380px`（`maxWidth:92vw`）、
  `translateX(100%↔0)` 滑入、左分隔线、无遮罩（对话区仍可交互）——整体对齐
  better-sidebar 的视觉与弹出。
- 当前会话：`ctx.get("sessions").list` snapshot 的 `current`；打开时刷新列表。
- better-sidebar 存在时仍走页签（现有逻辑不动）。

## 3. 契约

### 3.1 路由 `POST /skill-select/api/<method>`（JSON body）

统一响应：成功 `{ok:true, value}`；失败 `{ok:false, error:{code, message}}`。

**list**
- 请求：`{ "sessionId": "<id>" }`
- 成功：`{ "sessionId", "skills": SkillView[], "external": ExternalSkillView[] }`

```ts
interface SkillView {
  name: string;
  description: string | null;
  whenToUse?: string;
  source: "project" | "user" | "bundled" | "other";
  repo: string | null;
  usage: number;
  defaultStart: boolean;
  modelInvocable: boolean;
  userInvocable: boolean;
}
// ExternalSkillView 见 §2.5
```

**set-default**
- 请求：`{ "name": "<skill-name|agent:name>", "on": boolean }`
- 成功：`{ "name", "defaultStart" }`；写插件 domain（全局生效）

**set-checked**
- 请求：`{ "sessionId": "<id>", "skills": ["<skill-name|agent:name>", ...] }`
- 成功：`{ "sessionId", "count" }`；写入宿主内存镜像（DSH 技能供守卫；复合 id 供
  外部注入）；会话不存在返回 `session-not-found`

**summarize**
- 请求：`{ "sessionId": "<id>", "name": "<skill-name|agent:name>" }`
- 成功：`{ "name", "description" }`
- 错误码：`session-not-found`、`skill-not-found`、`bad-request`、`internal`

**update**
- 请求：`{}`（无需 session）
- 成功：`{ "items": UpdateItem[] }`
```ts
interface UpdateItem {
  id: string;              // 技能名或复合 id
  name: string;
  source: string;          // dsh-global | dsh-project | codex | grok | hermes | agents
  status: "updated" | "skipped" | "failed";
  before?: string;         // 旧 HEAD / 旧 commit / 旧 version
  after?: string;          // 新 HEAD / 新 commit / 新 version
  changes: string[];       // git log 摘要行或版本差说明
  reason?: string;         // skipped/failed 原因
}
```

### 3.2 激活路径（无需自定义 wire）

- **DSH 技能**：勾选 → 草稿追加 ` /name`（repo 满选 → `/repo名`）→ 发送 →
  `dsh-tool-skill` 注入 `<skill_content>`。
- **外部技能**：勾选（复合 id）→ 同步 `set-checked` → 下一条用户消息 pre-step 由
  本插件直接注入（不写草稿令牌）。
- **默认技能（DSH 或外部）**：每会话首条用户消息注入一次。

## 4. 安装

1. `~/.dsh/profiles/web/package.json`：
   - `dependencies` 增加 `"dsh-skill-select": "link:/Users/youngi/Documents/MiniWork/dsh插件/skill-select"`
   - `dsh.profile.bundles` 增加 `"dsh-skill-select"`
2. 该目录 `pnpm install`（新依赖 `yaml`）。
3. 重启 `dsh web`（host 半生效），浏览器硬刷新（client 半生效）。

## 5. 验收标准

- [ ] R1 列表包含 `~/.dsh/skills` 下全部 skill 且标记“全局”，项目 `.dsh/skills`
      的标记“局部”。
- [ ] R2 better-sidebar 存在时注册 Skills 页签；不存在/被禁用时，右侧缘出现竖向
      活动栏图标，点击后 VSCode 式面板从右侧滑出（贴边、无遮罩、× 关闭），视觉
      与弹出对齐 better-sidebar。
- [ ] R3 repo 徽标/分组：技能名后显示 repo 徽标；Skills 页默认 repo 分组、组头
      三态复选 + 折叠（默认收起）；repo 全选草稿只写 `/repo名`，发送后成员注入
      且各 +1；repo 组头名等宽字体、略大于技能名，组内技能行缩进。
- [ ] R4 排序下拉框：Repo（默认）/ Name / Most used / Source；Most used 按调用
      次数降序。
- [ ] R5 分页：Skills / Auto-start；set-default 持久化到 domain，list 返回
      defaultStart；新会话首条用户消息默认技能注入一次。
- [ ] R6 不选不启动：模型 `skill` 工具调用未在名单的技能被 guard 拒绝；名单内
      放行；用户 `/skill` 手势不受限；guard 不抛异常。
- [ ] R7 调用计数：`/name` 手势、`/repo` 成员、默认注入均计数；同一步骤同技能
      只计一次；计数失败不影响 agent 流程。
- [ ] R8 有 frontmatter 简介原样展示；缺失的生成后展示并缓存于 plugin domain；
      skill 原文件未被修改。
- [ ] R9 勾选后草稿出现 ` /name`（或满选 repo 的 `/repo名`）；取消移除；发送后
      注入行出现在对话且模型可正常使用。
- [ ] R10 外部技能：codex/grok/hermes 用户技能出现在列表（排除内置），来源徽标
      区分；重名技能全列可分别勾选；勾选/Auto-start 后下一条消息直接注入对应
      文件内容、计入调用；不污染 `ctx.skills`/`available_skills`。
- [ ] R11 一键更新：git 仓库技能 pull、带来源标记技能重拉，`skipped`/`failed`
      如实标注；面板内展示精简变更摘要，不新建会话。
- [ ] R12 “Other” 组计数与三态正确（null repo 归一化），无 (0) 误显。
- [ ] 单测通过（`node --test`），host 路由契约与本文档一致。
