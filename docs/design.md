# dsh-skill-select 设计文档

> DSH Web 插件：侧边栏 skill 选择器（英文 UI）。读取已配置的全部 skill（标注
> Project/Global 与所属 repo，并额外扫描 codex/grok/hermes 的用户技能），以
> **两阶段注册**（页面类型 + keyed 插槽）接入 dsh **官方右侧栏**（sidebar-right，
> dsh ≥ 0.2；不依赖任何第三方侧边栏，也没有自绘回退 UI）。勾选后把 `/skill` 手势填入
> 当前会话输入框草稿（外部 agent 技能改为
> 下一条消息直接注入），随用户下一条消息生效（由 DSH 宿主在 pre-step 边界自动注入
> `<skill_content>`）。无简介的 skill 由宿主侧 LLM 生成一句英文简介并缓存；提供
> **一键更新**所有 skill 并在面板内展示精简变更摘要。绝不改写 skill 原文件。

## 1. 目标与非目标

**目标（对应用户需求）**
1. 自动读取所有已下载/配置的 skill，并区分全局（`~/.dsh/skills` 等 user 根）与
   局部（项目 `.dsh/skills` 等 project 根）skill。
2. 以 sidebar 形式展示：注册进 dsh **官方右侧栏**（sidebar-right，dsh ≥ 0.2），
   两阶段注册——阶段一 `ctx.sidebarRightTabs.register` 声明页面类型（id
   `dsh-skill-select`、kind `skill-select`、guide 入口），阶段二 keyed 插槽
   `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` 提供主体与胶囊
   标题（见 §2.7）。不依赖 dsh-better-sidebar 等第三方侧边栏，也不再有自绘
   回退抽屉（`SkillsDrawer`/`mountStandalone` 已删除）。
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
6. **Guard 开关（默认关闭）**：宿主始终注册 `ctx.tools.guard` 守卫，但守卫仅在
   开关打开时生效——打开时模型通过 `skill` 工具调用**不在**「默认启动名单 ∪
   本会话已勾选名单」的技能被拒绝（模型收到明确错误、绝不执行）；关闭时完全放行，
   回到无本插件的默认工作流。开关经 `set-guard` 持久化到 domain，UI 位于面板
   标题栏（Skills/Auto-start 页签旁）。用户手动 `/skill` 手势始终不受限；技能目录不隐藏。
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
    勾选后在草稿写入 `/name@agent` 带来源令牌，发送时由插件识别并**直接注入**
    （不进 `ctx.skills`，见 §2.5）；Auto-start 同样支持。
11. **一键更新**：对 git 仓库型技能 `git pull`、对带**单个技能目录内**来源标记的
    技能按 URL 重拉（根级整组标记不重拉，报 skipped，§2.6），结果在面板内以精简
    摘要展示，**不新建会话**。
12. **UI 一致性**：repo 组头名用与技能名一致的等宽字体且略大（13px vs 12.5px）；
    repo 展开后组内技能行缩进体现层级；修正 “Other” 组计数与三态。

**非目标**
- 不修改 DSH 核心包、不修改任何 skill 文件、不新增 slash 命令。
- 外部 agent 技能**不注册**进 `ctx.skills`：不进模型 `available_skills` 目录、
  不能经 `skill` 工具按名调用（与「勾选后注入即可用」的模型一致）。
- 更新只处理 git 仓库与带（单个技能目录内）来源标记的技能；无更新源的手工技能标记为
  `skipped`，不做内容快照/回滚。
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
│   ├── client.test.js    # client 半冒烟测试
│   ├── service.test.js   # SkillSelectService 装配冒烟（domain/路由/guard/pre-step）
│   └── dsh-compat.test.js # DSH 兼容护栏（peer 范围 / 种子模块表 / 具名导出）
├── docs/
└── README.md
```

新增运行时依赖：`yaml`（宿主侧解析外部 SKILL.md frontmatter；`description: >`
折叠标量等正则不可靠，`yaml` 已在依赖树中）。

### 2.1 Host 半（lib/index.js）

Cordis Service 类插件（loader 直接挂类，参照 dsh-pin 的 PinRegistry）：

```js
export default class SkillSelectService extends Service {
  static inject = ["skills", "sessions", "webServer", "storageDomain", "agentDefaultModel", "llm", "tools"];
  constructor(ctx) { super(ctx, "skillSelect"); }
  async [Service.init]() { /* 打开 domain、注册路由、注册 guard 与 pre-step 观察者 */ }
}
```

职责（与上一版一致的部分从略，仅列关键点）：
- **枚举（rc.2 的冷/活两条路）**：`ctx.sessions` 在 rc.2 只是**活会话**的内存
  store，网页端从历史打开的会话不在其中，`sessions.get(id)` 返回 `undefined`
  ——早期单路径实现因此对屏幕上明明存在的会话报 404 `session "…" not found`。
  `openSkillView()` 对齐官方 `SessionSkillCatalog` 的读法：活会话
  （`ctx.agents.get(id)`）直接当 scope，注册表取
  `ctx.agentPresets.serviceFor(agent, "skills")`；冷会话经
  `ctx.sessionQuery.observeSession(id, { projectionMode })` 读
  `header.cwd` 与 `projections.values.agentPreset`，再用
  `ctx.agentPresets.acquireScope(preset)` 拿常驻 scope
  （`{ key } & AsyncDisposable`）。observation 与 lease 都在 `finally` 里释放
  （`Symbol.dispose` / `Symbol.asyncDispose`）。
  `SESSION_QUERY_SESSION_NOT_FOUND` → 404，其余查询错误 → 500；
  `agentPresets` 缺失（旧宿主）时注册表退回 `ctx.skills`、`sessionQuery` 缺失时
  退回 `sessions.get()`。两条路汇合后仍是一条
  `skills.list({ cwd, scope })`。冷读失败最常见的表现是 200 且 `skills: []`：
  `acquireScope` 牵动 shell / sandbox / tool 依赖链，profile 里任一条
  `@deepseek-ai/dsh-*` 被版本门禁跳过都会让它抛错。
- **来源分类**：`classifySource(source)` → `project`/`user`/`bundled`/`other`。
- **简介补齐**：`summary.description` 非空直接用；为空查 domain 缓存（name+hash）；
  仍无则客户端调 `summarize` 生成。
- **repo 归属**：`resolveRepo(name, dirPath)` 先查内置映射 `SKILL_REPOS`，未命中对
  未映射技能补一次 `ctx.skills.get()` 用 `resourceBase.path` 推断。
- **调用计数**：`ctx.on("agent/pre-step")` 观察者扫描 `/skill` 手势与 repo 令牌、
  默认注入，串行写 domain（`mergeUsage`）。
- **repo 令牌展开**：repo 索引（`buildRepoIndex`）展开成员，渲染单条注入行。
- **默认技能注入**：每个 agent 对象（WeakSet）首条含用户消息的步骤注入一次。
- **skill 工具守卫**：`ctx.tools.guard` 始终注册；开关打开时拒绝「默认名单 ∪ 会话勾选名单」
  外的调用，关闭时放行（回到默认工作流）。
- **summarize**：`ctx.skills.get` → frontmatter → 缓存 → LLM → 回退提取。
- **路由**：`/skill-select/api` 围栏路由，信任围栏逐字复用 dsh-pin 的
  `isTrustedRequest`。

### 2.2 Client 半（lib/client.js）

`window.__ModuleLoader__.load({ id: "dsh-skill-select", factory })`，
`exports = { apply, inject: ["conversation", "slots", "sidebarRightTabs"] }`。
`slots` 与 `sidebarRightTabs` 是 dsh ≥ 0.2 网页端始终提供的服务，直接写进
inject；package.json `dsh.client.inject` 对应列
`["@deepseek-ai/dsh-client-ui-conversation", "@deepseek-ai/dsh-client-ui-sidebar-right"]`。

- **官方右侧栏集成（两阶段，见 §2.7）**：阶段一
  `ctx.sidebarRightTabs.register` 声明页面类型；阶段二 keyed 插槽
  `sidebar.right.pane.tab`（主体）与 `sidebar.right.pane.tab.title`（胶囊
  标题）。全部注册包在 `ctx.effect(...)` 里，卸载/HMR 由框架回收。
- **页签主体 props**：框架给 `sessionId`（会话作用域标准 prop）与
  `useTabInfo()` hook；owner `inject` 共享是 `{}`，`tab`/`visible` 不会作为
  普通 props 传进来。主体按 `useTabInfo().tab.visible` 门控
  `loadSkills()`，隐藏→重新显示时重置本会话勾选（会话切换只刷新、不清空）。
- **数据**：`POST /skill-select/api/list {sessionId}` → `{ skills, external, guard }`
  合并展示；仅展示 `userInvocable` 项；`description` 为 `null` 进串行
  `summarize` 队列回填。页签可见时刷新，另设手动刷新 + 搜索。
- **面板分页**：Skills / Auto-start 两页。
- **排序下拉框**：Repo（默认）/ Name / Most used / Source；纯函数
  `sortByName`/`sortByUsage`/`groupByRepo`；两页共用同一排序选择。
- **分组折叠视图**：Repo 与 Source 两种分组都默认按组收起（折叠键 =
  `tab:sortMode:groupKey`）；Skills 的 repo 组头 = 三态复选框 + repo 名（或 Other）
  + 数量 + 折叠箭头，组头复选作用于全组成员（`applyCheckedBulk`）；Auto-start 的
  repo 组头同样带三态复选框（`defaultCheckState` → `setDefaultsBulk` 批量
  `set-defaults`），Source 组头只做折叠。组按名升序、无 repo 最后。
- **行内**：复选框在名字左侧；技能名 + 来源小徽标；repo/source 模式由组头承载组名
  （不逐行重复），组内行 `padding-left` 缩进。
- **勾选语义**：Skills 勾选是本会话临时选择，**页签每次隐藏→重新显示都重置为未勾选**
  （`resetCheckedForSession`，清 localStorage + 同步 `set-checked` + 剥离草稿令牌）；
  Auto-start 勾选走 `set-default`/`set-defaults` 持久化到 domain，跨打开、跨重启保持。
- **勾选 → 草稿（简洁令牌）**：勾选状态按 session 存 localStorage
  （`dsh-skill-select:checked:<sessionId>`），经 `set-checked` 同步宿主。草稿纯函数
  `composeDraft`：移除本插件管理令牌后按 `tokensForChecked` 追加（repo 满选 → 单
  `/repo名`，否则逐个 `/skill`）；**外部技能写 `/name@agent` 带来源令牌**（§2.5）。
- **UI 一致性（§1.12）**：repo 组头名 `fontFamily: var(--ds-font-family-code)`,
  `fontSize: 13`（技能名 12.5）、字重 600；分组模式下组内技能行 `padding-left`
  增加 ~16px 缩进；“Other”组计数与三态用 `(s.repo ?? "")` 归一化。

### 2.3 LLM 简介生成（host）

与上一版一致：`agent-default-model` → `llm.prepareCall` → `stream` 聚合
`text-delta`；系统提示要求一句、≤80 字符、英文；15s 超时；异常回退提取。
外部技能同样复用此流程（内容来自 `readExternalSkill`，缓存 key 用复合 id）。

### 2.4 持久化（storage domain）

`defineDomain({ name: "skill_select", version: 1, ... })`；domain 保持
version 1，新字段只按 zod 默认值扩展——`summaries`/`usage` 仍是 `z.record`，
`defaults` 仍是 `z.array(z.string())`，复合 id（`agent:name`）直接作为 string
key 使用，Guard 开关是后加的 `guard: z.boolean().default(false)`（缺省即关闭），
均无需迁移：

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
  guard: z.boolean().default(false),          // Guard 开关（全局）
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

**set-checked**：`skills` 数组可含技能名或复合 id；宿主统一存 `#checkedBySession`
（供守卫；复合 id 与任何 DSH 技能名不冲突，守卫按名判定即可）。外部技能注入由
`/name@agent` 手势驱动，不依赖该镜像。

**summarize**：`name` 允许传复合 id；命中外部技能则 `readExternalSkill` 读文件
生成简介（缓存 key 用复合 id），不再走 `ctx.skills.get`。

**注入（令牌驱动 `/name@agent`）**：外部技能勾选后，客户端在草稿写入带来源令牌
`/name@agent`（如 `/ego-browser@grok`）；`@` 不在 DSH 手势语法内，`dsh-tool-skill`
不会误注。Host pre-step 观察者新增 `scanExternalGestures(messages)` 扫描
`/name@agent`，解析为复合 id `agent:name`，`readExternalSkill` + `renderSkillContent`
注入（`source.kind:"skill-invocation"`，标签=技能名），计入 `usage`；解析不到对应
技能则跳过（与 DSH 未知 `/name` 一致）。Auto-start（`defaults`）接受复合 id，每会话
首条用户消息注入一次；与手势注入共用 `counted` 去重，避免重复注入/计数。外部技能
不进 `ctx.skills`，`/name@agent` 属用户手势，不受 guard 限制。

**守卫**：外部技能不进 `ctx.skills`，`skill` 工具本就无法按名解析，无需额外拦截；
`isAllowedSkill` 对复合 id 天然按字符串匹配即可。

### 2.6 一键更新（host + client）

**Host `update` API**（`node:child_process` 的 `execFile("git", ...)`）：
- 扫描范围：dsh 全局（`~/.dsh/skills`）、三个 agent 技能根（§2.5），以及
  `~/.agents/skills`（user-agents）中的技能目录。`update` 请求无 session，项目
  `.dsh/skills` **不在扫描范围**（`source` 无 `dsh-project`）。
- 每项判定：有 `.git` → `git -C <dir> pull --ff-only`，记 before/after HEAD 与
  `git -C <dir> log --oneline old..new`（HEAD 不变 → `skipped`，reason
  "already up to date"）；无 `.git` 但有**单个技能目录内**的来源标记
  （`<skillDir>/.superpowers-origin.txt` 的 `source=`/`commit=`/`version=`）→
  按 URL 重新拉取到临时目录后替换，记版本/commit 差；否则 → `skipped`。
- **根级来源标记不自动重拉**：`~/.grok/skills` 根上的 `.superpowers-origin.txt`
  （整组技能集，如 grok 的 superpowers）**不**作为 re-fetch 来源——这类技能报
  `skipped` 并带原因，因为按整组标记逐技能重拉会覆盖每个技能目录，属破坏性操作；
  仅 per-skill 标记才触发重拉。
- 返回：`{ items: [{ id, name, source, status: "updated"|"skipped"|"failed",
  before, after, changes: string[] }] }`。任何 git 失败不抛断整体，单条记 `failed`
  带原因。

**Client**：工具栏加 “Update skills” 按钮（进行中旋转态、防重入）；成功后渲染
面板内摘要区（每项：技能名 + 状态徽标 + 变更摘要行；`skipped`/`failed` 附说明）。
**不新建会话**（按用户选择）。

> 现实提示：当前仅 `~/.hermes/skills/xiaohongshu-skills` 为 git 仓库；grok 的
> superpowers 只有整组根级来源标记，更新时被报为 `skipped`（不重拉）；其余技能
> 显示“无更新源/跳过”。机制已就位，将来以 git/per-skill 来源方式安装即自动可更新。

### 2.7 官方右侧栏页签（两阶段注册契约）

dsh ≥ 0.2 网页端的 `sidebar-right` 按「页面类型 + keyed 插槽」两阶段注册页签，
两阶段都包在 `ctx.effect(...)` 里（插件 fiber 结束时自动撤销，HMR/卸载不留
第二次注册的冲突）：

- **阶段一：页面类型**——`ctx.sidebarRightTabs.register({ id: "dsh-skill-select",
  kind: "skill-select", priority: "extension", title: () => "Skills",
  guide: [{ id: "dsh-skill-select", order: 70, title: () => "Skills",
  description: () => "Pick which skills this session may run", icon: SkillIcon }] })`：
  - `id` 是页签系统的实现身份（也是阶段二 keyed 插槽的 key）；`kind` 是传给
    `ctx.sidebarRight.openTab(kind)` 的判别式；页面类型不声明 patterns（按 kind
    打开，不认领任何资源地址）；
  - `guide` 决定右侧栏 guide 页的入口：`guide[].id` **必填**——两个都省略 `id`
    的 guide 条目会被注册表判为 "duplicate guide entry id" 直接抛错；
  - 图标必须是**内联 SVG 组件**（`SkillIcon`）：client bundle 只能 `require()`
    平台种子模块（`react`、`react-dom`、`react-dom/client`、`react/jsx-runtime`、
    `@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、
    `@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、
    `@deepseek-ai/dsh-client-ui-dockkit`），外部图标包一律引不到。
- **阶段二：keyed 插槽**提供实现——主体
  `ctx.slots.register({ name: "sidebar.right.pane.tab", key: "dsh-skill-select",
  inject: () => ({ rootCtx: ctx }) }, SkillSelectTab)`，胶囊标题
  `ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: "dsh-skill-select" },
  SkillSelectTitle)`（图标 + tab 记录里的标题）：
  - `key` 必须等于阶段一 `register` 的 **id**（不是 kind）；给 keyed 插槽挂
    list 形的 `{id, order}` 是注册失败；
  - 外层经 `ctx.slots.inject(slotName, cb)` 登记，插槽宿主出现晚于插件 apply
    也能补挂（加载顺序安全）。
- **页签主体 props**：框架给 `sessionId`（`sidebar.right.pane.tab` 的会话作用域
  标准 prop）与 `useTabInfo()` hook；`rootCtx` 由插件自己的 `inject` 声明注入，
  而宿主 owner 的共享是 `{}`，所以 `tab`/`visible` 不会作为普通 props 传进来，
  可见性只能读 `useTabInfo().tab.visible`。`SkillSelectTab` 以它门控
  `loadSkills()`，仅在隐藏→重新显示时 `resetCheckedForSession`（会话切换只刷新
  不清空）；无会话时显示 "No open session."。
- **openTab 语义**：`ctx.sidebarRight.openTab(kind, ...)` 总会展开侧栏，画面内
  没有 Session 时抛错。
- 旧的三档策略（官方/better-sidebar/自绘抽屉）与 `SkillsDrawer`/`mountStandalone`/
  `SIDEBAR_CSS`/`PanelRightIcon` 等自绘回退代码已全部删除，不再有回退 UI。

## 3. 契约

### 3.1 路由 `POST /skill-select/api/<method>`（JSON body）

统一响应：成功 `{ok:true, value}`；失败 `{ok:false, error:{code, message}}`。
路由级错误：非可信 Host → `forbidden`（403）、非 POST → `method-error`（405）、
未知 method → `not-found`（404）。

**list**
- 请求：`{ "sessionId": "<id>" }`
- 成功：`{ "sessionId", "skills": SkillView[], "external": ExternalSkillView[], "guard": boolean }`

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

**set-defaults**
- 请求：`{ "names": ["<skill-name|agent:name>", ...], "on": boolean }`
- 成功：`{ "count" }`（新默认名单长度）；repo 组头批量切换默认启动用

**set-guard**
- 请求：`{ "on": boolean }`
- 成功：`{ "guard" }`；持久化到 domain（全局生效），list 回带当前值

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
  source: string;          // dsh-global | agents | codex | grok | hermes（无 dsh-project：update 无会话）
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
- **外部技能**：勾选（复合 id）→ 草稿写入 `/name@agent` → 发送 → 本插件 pre-step
  识别该手势并注入对应来源的文件内容。
- **默认技能（DSH 或外部）**：每会话首条用户消息注入一次。

## 4. 安装

0. **版本硬门禁——插件静默不加载时最先查这里**：dsh 0.2.0-rc.2 起 `dsh-app-boot`
   取 `package.json` peerDependencies 中名为 `@deepseek-ai/dsh` 或以
   `@deepseek-ai/dsh-` 开头的每条范围，对运行时版本做
   `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`；任一
   不满足即**整棵 bundle 被跳过**——模块根本不会被 import、插件行显示禁用、
   没有任何报错。本插件要求 `^0.2.0-rc.2`。`dsh.plugin.json` 的 `engines.dsh`
   在 rc.2 不参与判定（仅元数据）。确需强行加载的逃生门：
   `dsh plugin allow-version`（写入 `<profile>/compatibility.json`）。
1. `~/.dsh/profiles/web/package.json`：
   - `dependencies` 增加 `"dsh-skill-select": "link:/path/to/skill-select"`
   - `dsh.profile.bundles` 增加 `"dsh-skill-select"`
2. 该目录 `pnpm install`（新依赖 `yaml`）。
3. 重启 `dsh web`（host 半生效），浏览器硬刷新（client 半生效）。

## 5. 验收标准

- [ ] R1 列表包含 `~/.dsh/skills` 下全部 skill 且标记“全局”，项目 `.dsh/skills`
      的标记“局部”。
- [ ] R2 官方右侧栏：阶段一 `ctx.sidebarRightTabs.register` 声明页面类型（id
      `dsh-skill-select`、kind `skill-select`、带 `id`/`order`/内联 SVG 图标的 guide
      条目），右侧栏 guide 页出现 "Skills" 入口；阶段二 keyed 插槽
      `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title`（key = 阶段一 id）渲染
      主体与胶囊标题；主体按 `useTabInfo().tab.visible` 门控拉取，隐藏→重新显示时
      重置本会话勾选；已无 better-sidebar 集成与自绘回退代码。
- [ ] R3 repo 徽标/分组：技能名后显示 repo 徽标；Skills 页默认 repo 分组、组头
      三态复选 + 折叠（默认收起）；repo 全选草稿只写 `/repo名`，发送后成员注入
      且各 +1；repo 组头名等宽字体、略大于技能名，组内技能行缩进。
- [ ] R4 排序下拉框：Repo（默认）/ Name / Most used / Source；Most used 按调用
      次数降序。
- [ ] R5 分页：Skills / Auto-start；set-default 持久化到 domain，list 返回
      defaultStart；新会话首条用户消息默认技能注入一次。
- [ ] R6 Guard 开关：默认关闭时 guard 全部放行（回到默认工作流）；打开后模型
      `skill` 工具调用未在名单的技能被拒绝、名单内放行；用户 `/skill` 手势不受限；
      guard 不抛异常；`set-guard` 持久化到 domain。
- [ ] R7 调用计数：`/name` 手势、`/repo` 成员、默认注入均计数；同一步骤同技能
      只计一次；计数失败不影响 agent 流程。
- [ ] R8 有 frontmatter 简介原样展示；缺失的生成后展示并缓存于 plugin domain；
      skill 原文件未被修改。
- [ ] R9 勾选后草稿出现 ` /name`（或满选 repo 的 `/repo名`）；取消移除；发送后
      注入行出现在对话且模型可正常使用。
- [ ] R10 外部技能：codex/grok/hermes 用户技能出现在列表（排除内置），来源徽标
      区分；重名技能全列可分别勾选；勾选后草稿出现 `/name@agent`，发送后注入对应
      文件内容、计入调用；Auto-start 首条消息注入一次；不污染
      `ctx.skills`/`available_skills`。
- [ ] R11 一键更新：git 仓库技能 pull、带来源标记技能重拉，`skipped`/`failed`
      如实标注；面板内展示精简变更摘要，不新建会话。
- [ ] R12 “Other” 组计数与三态正确（null repo 归一化），无 (0) 误显。
- [ ] 单测通过（`node --test`），host 路由契约与本文档一致。
