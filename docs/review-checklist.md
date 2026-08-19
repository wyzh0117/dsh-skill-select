# dsh-skill-select 验收清单（Subagent C 使用）

> 依据 docs/design.md。本清单由主 agent 预核实过的运行时事实支撑。
> 本版针对「repo 徽标 + 三种排序 + 右侧抽屉 + 调用计数」迭代；既有条目仍有效。

## 已核实的运行时 ground truth（无需重新验证，可直接采信）

1. `@deepseek-ai/cordis` 根导出 `Service`（class 插件模式，参照 dsh-pin）。
2. profile 依赖树（`~/.dsh/profiles/node_modules`）可解析：`zod`、
   `@deepseek-ai/dsh-storage-domain`（`defineDomain`）、`dsh-skill`（`SkillRegistry`）、
   `dsh-session`（`SessionStore`）、`dsh-llm`、`dsh-settings`、`dsh-host-webserver`。
3. 服务名：`skills` / `sessions` / `webServer` / `storageDomain` / `settings` / `llm`；
   客户端服务名：`connection` / `conversation`；可选服务名：`betterSidebar`；
   客户端根 ctx 有 `sessions` 服务（`.list` 为 `{getSnapshot, subscribe}` store，
   `getSnapshot().current` = 当前会话 id）。
4. `ctx.settings.get("agent-default-model")` 返回 `{ provider, model, reasoningEffort? }`。
5. `ctx.skills.list({ cwd, scope })` 返回 `SkillSummary[]`（含 `source`、`description`、
   `whenToUse?`、`invocation.{modelInvocable,userInvocable}`）；
   `ctx.skills.get(name, { cwd, scope })` 返回含 `content` 与
   `resourceBase: {kind:"directory", path}` 的 `SkillDefinition`。
6. 客户端 `require` 模块 id = 包名：`react`、`react-dom`、
   `@deepseek-ai/dsh-client-runtime`（导出 `createScope`）均已在 web boot graph。
7. `ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {...})` 是
   waterfall 中间件（先 `await next()`、decision 原样返回）；`ctx.on` 返回 disposer。
8. better-sidebar 客户端服务：`ctx.betterSidebar.registerTab(descriptor)`，
   `TabComponentProps = { ctx, scope: {sessionId, cwd?}, tab, visible }`；
   `ctx.on("internal/service", (name, value) => ...)` 可监听服务出现。
9. 激活路径：用户消息文本匹配 `/(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g` 后，
   `dsh-tool-skill` 在 `agent/pre-step` 注入 `<skill_content>`（来源
   `kind:"skill-invocation"`），客户端渲染为 role:"inject" 上下文行。
10. composer 输入面：`ctx.conversation.input.for(actx)` →
    `{ setDraft(text), state.getSnapshot().draft }`；`actx = createScope(rootCtx, sessionId).ctx`。
11. 顶栏下方空白区测量锚点：DOM `[data-conversation-scroll]` 元素（会话滚动区）的
    `rect.top` = 会话顶栏底部；取不到时回退 56。
12. storage-domain 无迁移机制：domain version 必须保持 1，新字段只能 zod 默认值扩展。
13. 运行中的 DSH 实例未加载 dsh-better-sidebar（profile 有依赖但 boot entries 无），
    用户实际看到的是回退路径。

## 检查步骤

### 静态检查
- [ ] `cd /Users/youngi/Documents/MiniWork/dsh插件/skill-select`
- [ ] `node --check lib/index.js` 与 `node --check lib/client.js` 通过
- [ ] `node --test tests/` 全绿（host 半单测 + client 冒烟）
- [ ] host 半不 import 任何深层子路径；仅用包根导出
- [ ] host 半没有写任何 skill 文件（搜索 `writeFile|appendFile|createWriteStream|fs.`）
- [ ] client 半顶层无 import/export 语法；`exports = { apply, inject }` 赋值式
- [ ] client 半 `inject = ["conversation"]`（未硬注入 betterSidebar；slots 已不再需要）

### 契约交叉检查（design.md 3.1 / 3.2）
- [ ] 路由前缀 `/skill-select/api`，method 解析与 dispatch 一致
- [ ] `list` 响应 `{ok:true, value:{sessionId, skills:[SkillView]}}`；SkillView 字段名
      与 client 消费字段一一对应（name/description/whenToUse/source/repo/usage/
      defaultStart/modelInvocable/userInvocable）
- [ ] `summarize` 响应 `{ok:true, value:{name, description}}`；错误包络 `{ok:false,error:{code,message}}`
- [ ] `set-default` 请求 `{name, on:boolean}`（on 非 boolean → bad-request）、响应
      `{name, defaultStart}` 且写 domain defaults
- [ ] `set-checked` 请求 `{sessionId, skills:string[]}`（会话不存在 → session-not-found、
      skills 非 string 数组 → bad-request）、写宿主内存镜像
- [ ] 错误码集合：`session-not-found` / `skill-not-found` / `bad-request` / `not-found` / `internal`
- [ ] client fetch 路径与 method 名、请求体字段与 host 一致（含 set-default/set-checked）
- [ ] localStorage key：`dsh-skill-select:checked:<sessionId>`（勾选源头仍在客户端；
      set-checked 仅内存镜像）
- [ ] tab id `skill-select`；回退为 `mountStandalone`（右上角开关 + 右侧抽屉）

### 需求逐项核对
- [ ] R1 全局/局部：host 按 `source` 分类（project/user/bundled/other），client 有对应徽标
- [ ] R2 合并 sidebar：registerTab 路径存在；三保险探测（get + internal/service + 3.2s
      兜底）互斥；回退挂载右侧抽屉（固定 top=顶栏底部/right:0，translateX 滑入，
      非浮动窗口；右上角开关，打开态为 ×）
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
      持久化 localStorage；使用 createScope + conversation.input.for + setDraft；
      setChecked 变更与 loadSkills 成功时同步 set-checked（失败静默）
- [ ] 边界：无 sessionId 提示；userInvocable=false 的条目被过滤；list 网络失败 UI 提示
      不崩溃；并发 1 的简介生成队列；standalone 挂载/卸载安全（disposer 清理 DOM root）

### 修复闭环
将问题清单返回主 agent；主 agent 修复后复核（对照本清单的对应条目）。
