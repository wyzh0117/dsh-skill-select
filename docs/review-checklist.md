# dsh-skill-select 验收清单（Subagent C 使用）

> 依据 docs/design.md。本清单由主 agent 预核实过的运行时事实支撑。
> 本版针对 dsh 0.2.0-rc.2 / 官方右侧栏页签迁移（旧的「右侧抽屉」回退 UI 已删除）；
> 既有条目仍有效。

## 已核实的运行时 ground truth（无需重新验证，可直接采信）

1. `@deepseek-ai/cordis` 根导出 `Service`（class 插件模式，参照 dsh-pin）。
2. profile 依赖树（`~/.dsh/profiles/node_modules`）可解析：`zod`、
   `@deepseek-ai/dsh-storage-domain`（`defineDomain`）、`dsh-skill`（`SkillRegistry`）、
   `dsh-session`（`SessionStore`）、`dsh-llm`、`dsh-settings`、`dsh-host-webserver`。
3. host 服务名：`skills` / `sessions` / `webServer` / `storageDomain` /
   `agentDefaultModel` / `llm` / `tools`（`SkillSelectService.static inject`；
   `sessionQuery` / `agents` / `agentPresets` 是**可选**服务，经 `ctx.get()` 取，
   不写进 inject）；client
   `exports.inject = ["conversation", "slots", "sidebarRightTabs"]`——`slots` 与
   `sidebarRightTabs` 是 dsh ≥ 0.2 网页端始终提供的服务，直接硬注入（缺任何一项
   就没有页签可注册，静默降级只会让用户以为插件坏了）；client 根 ctx 的
   `sessions` 服务提供 `scope(sessionId)`，只用于 composer 输入面（见第 10 条），
   **不是** host 侧的技能 scope。已无 `betterSidebar` 可选服务探测。
4. `ctx.settings.get("agent-default-model")` 返回 `{ provider, model, reasoningEffort? }`。
5. `ctx.skills.list({ cwd, scope })` 返回 `SkillSummary[]`（含 `source`、`description`、
   `whenToUse?`、`invocation.{modelInvocable,userInvocable}`）；
   `ctx.skills.get(name, { cwd, scope })` 返回含 `content` 与
   `resourceBase: {kind:"directory", path}` 的 `SkillDefinition`。
6. client bundle 只能 `require()` 平台种子模块：`react`、`react-dom`、
   `react-dom/client`、`react/jsx-runtime`、`@deepseek-ai/cordis`、
   `@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、
   `@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`；
   `@deepseek-ai/dsh-client-runtime`（曾导出 `createScope`）自 0.1.5 起已不在
   种子表，require 它会抛 `missed the module table` 炸掉整个 bundle——侧栏
   图标因此必须是内联 SVG 组件，不能引外部图标包。
7. `ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {...})` 是
   waterfall 中间件（先 `await next()`、decision 原样返回）；`ctx.on` 返回 disposer。
8. 官方右侧栏两阶段注册契约：阶段一
   `ctx.sidebarRightTabs.register({ id, kind, priority, title, guide })`——`kind`
   是 `ctx.sidebarRight.openTab(kind)` 的判别式，`guide[].id` 必填（两个条目同时
   省略 `id` 会抛 "duplicate guide entry id"）。阶段二 keyed 插槽
   `ctx.slots.register({ name: "sidebar.right.pane.tab", key: <阶段一的 id，不是
   kind>, inject: () => ({ rootCtx }) }, Body)` 与 `sidebar.right.pane.tab.title`；
   给 keyed 插槽挂 list 形 `{id, order}` 属注册失败。注册包 `ctx.effect(...)` 并
   经 `ctx.slots.inject(slotName, cb)` 兜加载顺序。页签主体拿 `sessionId`（会话
   作用域标准 prop）与 `useTabInfo()` hook，拿不到 `tab`/`visible` 普通 props
   （owner 侧共享是 `{}`），可见性只能读 `useTabInfo().tab.visible`。
   `ctx.sidebarRight.openTab(kind, ...)` 总会展开侧栏，画面内没有 Session 时抛错。
9. 激活路径：用户消息文本匹配 `/(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g` 后，
   `dsh-tool-skill` 在 `agent/pre-step` 注入 `<skill_content>`（来源
   `kind:"skill-invocation"`），客户端渲染为 role:"inject" 上下文行。
10. composer 输入面：`rootCtx.conversation.input.for(actx)` →
    `{ setDraft(text), state.getSnapshot().draft }`；`actx = ctx.sessions.scope(sessionId)`
    （0.1.5 起替代 `dsh-client-runtime` 的 `createScope`，插件内按会话缓存）。
11. 页签主体可见性门控：`SkillSelectTab` 在 `useTabInfo().tab.visible` 为真时
    `loadSkills(sessionId)`，仅在隐藏→重新显示时 `resetCheckedForSession`
    （清 localStorage + 同步 `set-checked` + 剥离草稿令牌），会话切换只刷新不清空。
12. storage-domain 无迁移机制：domain version 必须保持 1，新字段只能 zod 默认值扩展。
13. dsh 0.2.0-rc.2 兼容硬门禁：`dsh-app-boot` 读 `package.json` peerDependencies 中
    名字为 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-` 开头的条目，对运行时版本执行
    `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`，任一不满足
    **整棵 bundle 跳过**（模块不会被 import、插件行禁用、无报错）。
    `dsh.plugin.json` 的 `engines.dsh` 在 rc.2 不参与判定。插件静默停止加载时
    先对照 `dsh --version` 查 peer 范围；逃生门 `dsh plugin allow-version`
    （写 `<profile>/compatibility.json`）。
14. rc.2 的会话读取是冷/活两条路（本版修复的根因）：`ctx.sessions` 只装**活会话**，
    网页端从历史打开的会话是**冷会话**，`sessions.get(id)` 对它返回 `undefined`，
    旧单路径代码因此对每个可见会话抛 404 `session "…" not found`。
    `openSkillView()`：活路 `ctx.agents.get(id)` 作 scope +
    `agentPresets.serviceFor(agent, "skills")` 取注册表；冷路
    `ctx.sessionQuery.observeSession(id, { projectionMode })` 读
    `header.cwd` / `projections.values.agentPreset`，再用
    `agentPresets.acquireScope(preset)` 取常驻 scope。observation 与 lease 必须在
    `finally` 释放（`Symbol.dispose` / `Symbol.asyncDispose`）；
    `SESSION_QUERY_SESSION_NOT_FOUND` → 404，其余查询错误 → 500；
    `sessionQuery` / `agentPresets` 缺席的旧宿主分别退回 `sessions.get()` 与
    `ctx.skills`。症状对照：200 且 `skills: []` = 冷路没拿到 scope，通常因为
    profile 里有条 `@deepseek-ai/dsh-*` 被版本门禁跳过，`acquireScope` 牵动的
    shell / sandbox / tool 链因此断掉。

## 检查步骤

### 静态检查
- [ ] `cd <skill-select 仓库根目录>`
- [ ] `node --check lib/index.js` 与 `node --check lib/client.js` 通过
- [ ] 仓库根目录执行 `node --test` 全绿（host 半单测 + client 冒烟 + 兼容护栏；
      `node --test tests/` 在本机会 MODULE_NOT_FOUND，不要用）
- [ ] host 半不 import 任何深层子路径；仅用包根导出
- [ ] host 半没有写任何 skill 文件（搜索 `writeFile|appendFile|createWriteStream|fs.`）
- [ ] client 半顶层无 import/export 语法；`exports = { apply, inject }` 赋值式
- [ ] client 半 `inject = ["conversation", "slots", "sidebarRightTabs"]`（官方侧栏服务直接硬注入，不做可选探测）
- [ ] 冷会话可读（见第 14 条）：`tests/index.test.js` 的 `readSessionCwd` /
      `openSkillView` 段落 + `tests/service.test.js` 的 `coldSession` 用例全绿，
      observation 与 preset lease 都在 `finally` 释放

### 契约交叉检查（design.md 3.1 / 3.2）
- [ ] 路由前缀 `/skill-select/api`，method 解析与 dispatch 一致
- [ ] `list` 响应 `{ok:true, value:{sessionId, skills:[SkillView], external:[ExternalSkillView], guard:boolean}}`；SkillView 字段名
      与 client 消费字段一一对应（name/description/whenToUse/source/repo/usage/
      defaultStart/modelInvocable/userInvocable）
- [ ] `summarize` 响应 `{ok:true, value:{name, description}}`；错误包络 `{ok:false,error:{code,message}}`
- [ ] `set-default` 请求 `{name, on:boolean}`（on 非 boolean → bad-request）、响应
      `{name, defaultStart}` 且写 domain defaults；`set-defaults` 请求
      `{names:string[], on:boolean}`（非法 names → bad-request）、响应 `{count}`；
      `set-guard` 请求 `{on:boolean}`、响应 `{guard}` 且持久化到 domain
- [ ] `set-checked` 请求 `{sessionId, skills:string[]}`（会话不存在 → session-not-found、
      skills 非 string 数组 → bad-request）、写宿主内存镜像
- [ ] 错误码集合：`session-not-found` / `skill-not-found` / `bad-request` / `not-found` / `internal`；
      路由级另有 `forbidden`（非可信 Host 403）与 `method-error`（非 POST 405）
- [ ] client fetch 路径与 method 名、请求体字段与 host 一致（含 set-default/set-defaults/set-guard/set-checked/update）
- [ ] localStorage key：`dsh-skill-select:checked:<sessionId>`（勾选源头仍在客户端；
      set-checked 仅内存镜像）
- [ ] 阶段一 id `dsh-skill-select`、kind `skill-select`；阶段二 keyed 插槽
      `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` 的 key = 阶段一 id；
      无任何自绘回退 UI（`SkillsDrawer`/`mountStandalone`/`SIDEBAR_CSS`/
      `PanelRightIcon` 应已不存在于 lib/client.js）

### 需求逐项核对
- [ ] R1 全局/局部：host 按 `source` 分类（project/user/bundled/other），client 有对应徽标
- [ ] R2 官方右侧栏页签：阶段一 `ctx.sidebarRightTabs.register` 声明页面类型
      （id `dsh-skill-select`、kind `skill-select`、priority `extension`、guide 条目带
      必填 `id`、order 70、内联 SVG 图标），右侧栏 guide 页出现 "Skills" 入口；
      阶段二 keyed 插槽 `sidebar.right.pane.tab` / `.title`（key = 阶段一 id，不是
      kind）渲染主体与胶囊标题；注册包 `ctx.effect`（fiber 结束自动撤销）并经
      `ctx.slots.inject` 兜加载顺序；主体按 `useTabInfo().tab.visible` 门控拉取、
      隐藏→重新显示时重置本会话勾选并再拉一次。无 better-sidebar 集成与自绘回退代码。
- [ ] R3 repo 徽标/分组：SKILL_REPOS 内置映射（14 个 superpowers 技能 + AERS）；
      `resolveRepo` 嵌套目录推断（父目录名≠skills 且目录名=技能名才采用）；
      repo 分组默认视图：组头三态复选框（repoCheckState 派生 all/some/none）+
      折叠（默认收起）；repo 全选 → composeDraft 只写 `/repo名`（repoTokens 校验
      kebab 且无同名技能）；部分 → 逐个 `/skill`；发送后 host 展开 `/repo` 为单条
      注入行（标签=repo 名，内容含全部成员 renderSkillContent）
- [ ] R4 排序：Skills 页下拉框四选项（Repo 默认/Name/Most used/Source）；sortByUsage
      降序同数按名；groupByRepo 同 repo 相邻、组内按名、无 repo 最后；纯函数不 mutate
- [ ] R5 分页 + 默认启动：Skills/Auto-start 两页；Auto-start 开关调 set-default 并本地
      回填 defaultStart；domain `defaults` zod 默认扩展、version 仍 1；每会话（WeakSet
      per agent）首条含 user 消息的步骤注入默认技能一次、不重复、各 +1 计数
- [ ] R6 不选不启动：`ctx.tools.guard` 全局守卫；只拦 `name==="skill"` 且参数为合法
      技能名（isSkillName）的调用；允许名单 = defaults ∪ checkedBySession[agent.session.id]；
      拒绝返回 not enabled 理由；guard 绝不抛异常、非 skill 工具放行；用户手势路径不经守卫
- [ ] R7 调用计数：scanSkillGestures 正则与 dsh-tool-skill 逐字一致、只扫
      source.kind==="user" 的 content 文本块、去重；mergeUsage 累加；观察者
      `await next()` 在 try 外、decision 原样返回、reject 原样透传、异常不吞、
      计数失败仅记日志；手势/repo 成员/默认注入同步骤同技能只 +1
- [ ] R8 简介：frontmatter 优先；缓存按 name+contentHash 校验；LLM 失败 fallback 提取；
      生成结果写插件 domain，不改 skill 文件
- [ ] R9 勾选→草稿：composeDraft/stripManagedTokens/tokensForChecked 纯函数；按 session
      持久化 localStorage；使用 `ctx.sessions.scope(sessionId)` +
      conversation.input.for + setDraft；
      setChecked 变更与 loadSkills 成功时同步 set-checked（失败静默）
- [ ] 边界：无 sessionId 提示；userInvocable=false 的条目被过滤；list 网络失败 UI 提示
      不崩溃；并发 1 的简介生成队列；apply 注册全挂 `ctx.effect`，卸载/HMR 由框架
      回收、无 DOM root 残留

### 修复闭环
将问题清单返回主 agent；主 agent 修复后复核（对照本清单的对应条目）。
