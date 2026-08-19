# dsh-skill-select 交付说明与验收对照

> 最终状态：34/34 单测全绿；独立验收 agent（未参与实现）复核中；已安装进
> `~/.dsh/profiles/web`（dependency + bundle + node_modules 副本同步）。
> **激活方式**：重启 `dsh web`（host 半）→ 浏览器硬刷新 Cmd/Ctrl+Shift+R（client 半）。

## 后续修订（2026-08-18）

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
- **repo 徽标 + 三种排序 + 右侧抽屉 + 调用计数（2026-08-19）**：技能名后显示所属
  repo 徽标（`SKILL_REPOS` 内置映射 14 个 superpowers 技能 + Auto-Empirical-Research-Skills，
  嵌套目录 `<repo>/<skill>` 路径推断兜底）；工具栏排序下拉框 Source / Most used /
  Name / Repo；回退路径由「侧栏底部按钮 + 浮动小窗」改为「右上角（会话顶栏下方空白区）
  展开图标 + 从 DSH 右侧滑出的侧抽屉」；宿主侧 `agent/pre-step` 观察者按
  `/skill-name` 手势统计真实调用次数并写入插件 domain（schema zod 默认扩展、
  domain version 保持 1）。详见 docs/design.md 1/2.1/2.2/2.4/3.1/5。
  独立验收结论：有条件通过 → 已修复 4 项（抽屉无会话时补 "No open session." 提示、
  package.json 移除遗留 slots 声明、README 残留「浮动面板」表述、design 措辞精确化），
  修复后 66/66 单测全绿；`agent/pre-step` 计数路径另经真实 cordis waterfall 功能验证
  （去重/累计/非 user 忽略/decision 透传）。
- **修复空列表根因**：web 宿主把 `skill-filesystem` 挂进 agent preset 的 scoped 层
  （全局层禁用），`ctx.skills.list({cwd})` 不带 scope 只能读到空全局层。现改为
  `ctx.skills.list/get({ cwd, scope })`，scope 取 `ctx.agents.get(sessionId)`
  （与 `dsh-tool-skill` 一致；agents 缺失时退化为全局层）。测试增至 42 例；
  机制回归证明脚本 `scripts/verify-scope.mjs`。
- **side card 风格**：UI 文案全英文化（Skills / Project / Global / Bundled /
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
| 2 | 以 sidebar 展示；已装 sidebar 插件则合并 | client `apply`：探测可选服务 `betterSidebar`（立即探测 + `internal/service` 事件常驻 + 3.2s 兜底重探测，无竞态窗）→ `registerTab({id:"skill-select", title:"Skills", single:true, order:90})`；未装则 `mountStandalone` 挂载自绘 UI：右上角（会话顶栏下方空白区，`[data-conversation-scroll]` 测量定位）展开图标 + 从 DSH 右侧滑出的侧抽屉（portal 常驻、translateX 滑入、无遮罩），当前会话取自 `ctx.get("sessions").list` 的 `current` | `tests/client.test.js`：立即注册/事件迟到/兜底窗口/standalone 挂载与卸载 + disposer 清理测试 |
| 3 | 名称+简介展示；无简介 LLM 生成并缓存，不改原文件 | host `resolveSummary`：frontmatter `description` 优先 → 插件 domain 缓存（name+contentHash 校验）→ `ctx.llm.prepareCall` 用默认模型生成一句中文简介（15s 超时）→ 失败回退提取 SKILL.md 首段；缓存写 `storageDomain` domain `skill_select`；全程不触碰任何 skill 文件（host 零 fs 写操作，验收 agent 已静态确认） | `tests/index.test.js` 缓存命中/失效、LLM 成功、LLM 失败回退、internal 错误 4 用例；service.test.js 端到端 summarize + domain 写入断言；client 端串行队列（并发 1 + 去重） |
| 4 | 勾选后 skill 出现在当前 session 对话框并可正常使用 | client `applyChecked`：勾选 → `createScope(rootCtx, sessionId)` + `conversation.input.for(actx).setDraft` 把 `/skill-name` 追加进草稿（词边界、幂等）；取消勾选移除；勾选态按 session 存 localStorage；用户发送后 DSH 宿主 `dsh-tool-skill` 在 `agent/pre-step` 把 `<skill_content>` 以 `skill-invocation` 来源注入会话（对话框渲染为带技能名的注入行，持久、模型可见） | `tests/client.test.js` draftGesture 追加/幂等/移除/词边界；注入机制为 DSH 官方文档化路径（design 3.2），宿主正则逐字兼容由验收 agent 核实 |

## 边界处理（验收 agent 确认）

- `userInvocable === false` 的技能过滤不显示；
- 无当前会话时页签显示提示、勾选框禁用；
- list/summarize 网络失败：UI 内联错误提示，不抛到渲染层；
- summary 生成串行 + `sessionId:name` 去重，刷新不重复请求；
- 路由信任围栏与 `/api` 网关同构（loopback/trusted-host/sec-fetch-site/origin，与 dsh-pin 逐字一致），非可信 Host 403；
- client HMR 安全：apply 返回 disposer 清理事件监听/定时器/tab 与 footer 注册。

## 文件清单

- `lib/index.js` — host 半（Service + 路由 + 枚举 + 简介缓存）
- `lib/client.js` — client 半（ModuleLoader bundle）
- `tests/index.test.js` / `tests/client.test.js` / `tests/service.test.js` — 34 项测试
- `scripts/install.sh` — 一键安装/同步（幂等）
- `docs/design.md` / `docs/plan.md` / `docs/review-checklist.md` / `docs/delivery.md`
- `package.json` / `dsh.plugin.json` / `cordis.patch.yml` / `README.md`

## 重启后的手工验收步骤

1. 重启 `dsh web`，浏览器硬刷新；
2. 打开右侧 Side Card → `+` 菜单 → 选「技能」页签；
3. 应看到 `~/.dsh/skills` 下 15 个技能，全部带「全局」徽标与简介；在项目里放一个
   `.dsh/skills/<name>/SKILL.md` 后点刷新，应出现「局部」徽标；
4. 勾选任一技能 → 输入框草稿末尾出现 `/skill-name`，取消勾选消失；
5. 发送消息 → 对话中出现带技能名的注入行，模型按该技能工作；
6. 无简介技能（去掉 frontmatter description）会自动生成简介并缓存；
   确认该 SKILL.md 文件未被修改。
