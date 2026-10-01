# dsh-skill-select 交付说明与验收对照

> 最终状态：122/122 单测全绿（2026-10 dsh 0.2.0-rc.2 迁移后复跑）；已安装进
> `~/.dsh/profiles/web`（`link:` 依赖 + bundle，改代码重启 `dsh web` 即生效）。
> **激活方式**：重启 `dsh web`（host 半）→ 浏览器硬刷新 Cmd/Ctrl+Shift+R（client 半）。
> **插件静默不加载时第一步**：对照 `dsh --version` 检查 `package.json`
> peerDependencies 中 `@deepseek-ai/dsh-*` 的范围（rc.2 起为 boot 硬门禁，详见
> 下条与 design.md §4）。

## 后续修订（2026-08-18 起）

- **dsh 0.2.0-rc.2 迁移（2026-10）**：插件版本 0.1.1 → **0.2.0**（`package.json` /
  `dsh.plugin.json`，`engines.dsh: ^0.2.0-rc.2`）。client 改接 **dsh 官方右侧栏**：
  阶段一 `ctx.sidebarRightTabs.register({ id: "dsh-skill-select", kind: "skill-select",
  priority: "extension", title: () => "Skills", guide: [{ id, order: 70, icon: SkillIcon }] })`，
  阶段二 keyed 插槽 `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title`
  （key 必须等于阶段一的 **id**），两阶段包 `ctx.effect` 并经 `ctx.slots.inject`
  兜加载顺序；页签主体按 `useTabInfo().tab.visible` 门控拉取、隐藏→重新显示时
  重置本会话勾选。**彻底移除 DSH-better-sidebar 依赖与全部自绘回退代码**
  （`SkillsDrawer`/`mountStandalone`/`SIDEBAR_CSS`/`PanelRightIcon`），不再有
  三档侧边栏策略。`lib/client.js` 的 `inject` 改为
  `["conversation", "slots", "sidebarRightTabs"]`；`package.json` 的
  `dsh.client.inject` 改为 `@deepseek-ai/dsh-client-ui-conversation` +
  `@deepseek-ai/dsh-client-ui-sidebar-right`。**rc.2 硬门禁**：`dsh-app-boot` 拿
  `package.json` peerDependencies 中 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`
  的条目对运行时版本做 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`，
  任一不满足即**整棵 bundle 静默跳过**（模块不会被 import、插件行禁用）；
  `dsh.plugin.json` 的 `engines.dsh` 在 rc.2 不参与判定。插件无声停止加载时先查
  peer 范围，逃生门 `dsh plugin allow-version`（写 `<profile>/compatibility.json`）。
  **同一版本还把会话读取拆成冷/活两条路**：`ctx.sessions` 只装活会话，网页端从
  历史打开的会话读不到，`sessions.get()` 返回 `undefined`，插件因此对每个屏幕上
  存在的会话报 404 `session "…" not found`；`openSkillView()` 冷路改走
  `ctx.sessionQuery.observeSession()` + `ctx.agentPresets.acquireScope()`，
  observation 与 lease 都在 `finally` 释放，`SESSION_QUERY_SESSION_NOT_FOUND`
  映射 404、其余查询错误映射 500，旧宿主（无 `sessionQuery` / `agentPresets`）
  分别退回 `sessions.get()` 与 `ctx.skills`。顺带修掉一个环境缺陷：web profile 里
  `@deepseek-ai/dsh-sandbox-local` 仍停在 `0.1.5-rc.3`、被版本门禁禁用，使
  `acquireScope`（牵动 shell / sandbox / tool 链）抛错，表现为 `list` 返回 200 却
  是空数组——该依赖已升到 `0.2.0-rc.2`。
  `tests/dsh-compat.test.js` 补了 peer 覆盖断言，冷/活两条路各有专项用例；
  122/122 单测全绿。详见 docs/design.md §2.1/§2.2/§2.7。

- **repo 分组 + Auto-start 分页 + 不选不启动（设计 v4，2026-08-19）**：面板分
  Skills / Auto-start 两页；Skills 默认按 repo 分组（组头三态复选 + 折叠、默认
  收起、来源行内徽标），repo 满选时草稿只写一个 `/repo名` 令牌（`composeDraft`
  纯函数重算），发送时宿主把令牌展开为全部成员技能（单条 `skill-invocation`
  注入行、官方 `renderSkillContent`）并计数；Auto-start 开关经 `set-default`
  持久化到 domain（`defaults` zod 默认扩展、version 仍 1），每会话首条用户消息
  注入默认技能一次（WeakSet 去重）；`ctx.tools.guard` 全局守卫拦截模型对
  「默认名单 ∪ 会话勾选名单（`set-checked` 同步的内存镜像）」之外技能的 `skill`
  工具调用（返回明确 not enabled 提示、绝不执行），用户手势不受限。85/85 单测
  全绿。详见 docs/design.md。
- **repo 徽标 + 三种排序 + 调用计数（2026-08-19）**：技能名后显示所属
  repo 徽标（`SKILL_REPOS` 内置映射 14 个 superpowers 技能 + Auto-Empirical-Research-Skills，
  嵌套目录 `<repo>/<skill>` 路径推断兜底）；工具栏排序下拉框 Source / Most used /
  Name / Repo；宿主侧 `agent/pre-step` 观察者按
  `/skill-name` 手势统计真实调用次数并写入插件 domain（schema zod 默认扩展、
  domain version 保持 1）。详见 docs/design.md 1/2.1/2.2/2.4/3.1/5。
  独立验收结论：有条件通过 → 已修复 4 项（无会话时补 "No open session." 提示、
  package.json 移除遗留 slots 声明、README 残留「浮动面板」表述、design 措辞精确化），
  修复后 66/66 单测全绿；`agent/pre-step` 计数路径另经真实 cordis waterfall 功能验证
  （去重/累计/非 user 忽略/decision 透传）。（该条目当时的「右侧抽屉」回退 UI
  已在 2026-10 的 0.2.0 迁移中整体删除，见上条。）
- **修复空列表根因**：web 宿主把 `skill-filesystem` 挂进 agent preset 的 scoped 层
  （全局层禁用），`ctx.skills.list({cwd})` 不带 scope 只能读到空全局层。现改为
  `ctx.skills.list/get({ cwd, scope })`，scope 取 `ctx.agents.get(sessionId)`
  （与 `dsh-tool-skill` 一致；agents 缺失时退化为全局层）。测试增至 42 例；
  机制回归证明脚本 `scripts/verify-scope.mjs`。
- **英文文案与图标（2026-08-19）**：UI 文案全英文化（Skills / Project / Global / Bundled /
  Other / Search skills / Generating description / Retry…），页签增加 16px
  卡片+星芒线性图标（内联 SVG）；LLM 生成简介改为英文一句话。
- **部署修复（2026-08-19）**：web profile 里 `file:` 依赖是 pnpm 硬链接副本，
  改项目代码不会同步（"改了没变化"的根因）。已把
  `~/.dsh/profiles/web/package.json` 改为 `link:` 并 `pnpm install`，此后
  重启 `dsh web` 即加载项目最新代码；client bundle 按请求实时读盘，硬刷新
  即可生效。

## 需求 → 实现 → 证据

| # | 用户需求 | 实现位置 | 验证证据 |
|---|---------|---------|---------|
| 1 | 自动读取所有已配置 skill，区分全局/局部 | host `resolveList`：`ctx.sessions.get(sessionId).header.cwd` → `ctx.skills.list({cwd})`；`classifySource` 把 `project-dsh/project-agents`→局部、`user-dsh/user-agents`→全局、`bundled`→内置、其余→其他 | `tests/index.test.js` classifySource 全分支 + resolveList 映射测试；service.test.js 端到端 list 返回 `source:"user"` |
| 2 | 以 sidebar 展示（官方右侧栏） | client `apply` 两阶段注册：阶段一 `ctx.sidebarRightTabs.register({id:"dsh-skill-select", kind:"skill-select", priority:"extension", title:()=>"Skills", guide:[{id:"dsh-skill-select", order:70, title/description 懒回调, icon:SkillIcon 内联 SVG}]})`，guide 页出现 Skills 入口；阶段二 keyed 插槽 `sidebar.right.pane.tab`（主体 `SkillSelectTab`，`inject:()=>({rootCtx:ctx})`）与 `sidebar.right.pane.tab.title`（标题 `SkillSelectTitle`），key 必须等于阶段一的 id；均包 `ctx.effect` 并经 `ctx.slots.inject` 兜加载顺序。主体收 `sessionId` 标准 prop + `useTabInfo()`，按 `tab.visible` 门控 `loadSkills`、隐藏→重新显示时 `resetCheckedForSession`；无会话显示 "No open session."。已无第三方侧边栏与自绘回退 | `tests/client.test.js`：阶段一/阶段二（key===id）/ctx.effect 逐一撤销/visible 门控与再显示拉取测试 |
| 3 | 名称+简介展示；无简介 LLM 生成并缓存，不改原文件 | host `resolveSummary`：frontmatter `description` 优先 → 插件 domain 缓存（name+contentHash 校验）→ `ctx.llm.prepareCall` 用默认模型生成一句英文简介（15s 超时）→ 失败回退提取 SKILL.md 首段；缓存写 `storageDomain` domain `skill_select`；全程不触碰任何 skill 文件（host 零 fs 写操作，验收 agent 已静态确认） | `tests/index.test.js` 缓存命中/失效、LLM 成功、LLM 失败回退、internal 错误 4 用例；service.test.js 端到端 summarize + domain 写入断言；client 端串行队列（并发 1 + 去重） |
| 4 | 勾选后 skill 出现在当前 session 对话框并可正常使用 | client `applyChecked`：勾选 → `ctx.sessions.scope(sessionId)`（0.1.5 起替代 `dsh-client-runtime` 的 `createScope`，带按会话缓存）取 agent 作用域 + `conversation.input.for(actx).setDraft` 按 `composeDraft` 重算 `/skill-name` 令牌（词边界、幂等）；取消勾选移除；勾选态按 session 存 localStorage；用户发送后 DSH 宿主 `dsh-tool-skill` 在 `agent/pre-step` 把 `<skill_content>` 以 `skill-invocation` 来源注入会话（对话框渲染为带技能名的注入行，持久、模型可见） | `tests/client.test.js` composeDraft/tokensForChecked/stripManagedTokens 追加/幂等/移除/词边界；注入机制为 DSH 官方文档化路径（design 3.2），宿主正则逐字兼容由验收 agent 核实 |

## 边界处理（验收 agent 确认）

- `userInvocable === false` 的技能过滤不显示；
- 无当前会话时页签显示提示、勾选框禁用；
- list/summarize 网络失败：UI 内联错误提示，不抛到渲染层；
- summary 生成串行 + `sessionId:name` 去重，刷新不重复请求；
- 路由信任围栏与 `/api` 网关同构（loopback/trusted-host/sec-fetch-site/origin，与 dsh-pin 逐字一致），非可信 Host 403；
- client HMR 安全：apply 的全部注册（页面类型 + keyed 插槽）都挂在 `ctx.effect` 上，随插件 fiber 结束由框架自动撤销，不留手工全局监听/定时器。

## 文件清单

- `lib/index.js` — host 半（Service + 路由 + 枚举 + 简介缓存）
- `lib/client.js` — client 半（ModuleLoader bundle）
- `tests/index.test.js` / `tests/client.test.js` / `tests/service.test.js` / `tests/dsh-compat.test.js` — 122 项测试
- `scripts/install.sh` — 一键安装/同步（幂等）
- `docs/design.md` / `docs/plan.md` / `docs/review-checklist.md` / `docs/delivery.md`
- `package.json` / `dsh.plugin.json` / `cordis.patch.yml` / `README.md` / `README_zh.md`

## 重启后的手工验收步骤

1. 重启 `dsh web`，浏览器硬刷新；
2. 打开官方右侧栏 → 在 guide 页点 **Skills** 入口，出现「Skills」页签；
3. 应看到 `~/.dsh/skills` 下全部技能，带「Global」徽标与简介；在项目里放一个
   `.dsh/skills/<name>/SKILL.md` 后点刷新，应出现「Project」徽标；
4. 勾选任一技能 → 输入框草稿末尾出现 `/skill-name`，取消勾选消失；
5. 发送消息 → 对话中出现带技能名的注入行，模型按该技能工作；
6. 无简介技能（去掉 frontmatter description）会自动生成简介并缓存；
   确认该 SKILL.md 文件未被修改。
7. 隐藏页签再重新打开：本会话 Skills 勾选应清空、草稿令牌剥离（Auto-start 与
   默认启动名单不受影响）；切换会话只刷新列表、不清空本会话勾选。
