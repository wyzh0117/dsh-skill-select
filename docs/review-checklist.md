# dsh-skill-select 验收清单（Subagent C 使用）

> 依据 docs/design.md。本清单由主 agent 预核实过的运行时事实支撑。

## 已核实的运行时 ground truth（无需重新验证，可直接采信）

1. `@deepseek-ai/cordis` 根导出 `Service`（class 插件模式，参照 dsh-pin）。
2. profile 依赖树（`~/.dsh/profiles/node_modules`）可解析：`zod`、
   `@deepseek-ai/dsh-storage-domain`（`defineDomain`）、`dsh-skill`（`SkillRegistry`）、
   `dsh-session`（`SessionStore`）、`dsh-llm`、`dsh-settings`、`dsh-host-webserver`。
3. 服务名：`skills` / `sessions` / `webServer` / `storageDomain` / `settings` / `llm`；
   客户端服务名：`connection` / `conversation` / `slots`；可选服务名：`betterSidebar`。
4. `ctx.settings.get("agent-default-model")` 返回 `{ provider, model, reasoningEffort? }`。
5. `ctx.skills.list({ cwd })` 返回 `SkillSummary[]`（含 `source`、`description`、
   `whenToUse?`、`invocation.{modelInvocable,userInvocable}`）；
   `ctx.skills.get(name, { cwd })` 返回含 `content` 的 `SkillDefinition`。
6. 客户端 `require` 模块 id = 包名：`react`、`react-dom`、
   `@deepseek-ai/dsh-client-runtime`（导出 `createScope`/`scopeOf`）均已在
   web boot graph（三包均有 `dsh.client` 声明）。
7. 槽 API：`ctx.slots.inject(key, () => disposer)` + `ctx.slots.register(opts, Comp)`，
   opts 形如 `{ name, id, order, registrant }`（dsh-pin 生产验证）。
8. better-sidebar 客户端服务：`ctx.betterSidebar.registerTab(descriptor)`，
   `TabComponentProps = { ctx, scope: {sessionId, cwd?}, tab, visible }`；
   `ctx.on("internal/service", (name, value) => ...)` 可监听服务出现（cordis 内部事件）。
9. 激活路径：用户消息文本匹配 `/(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g` 后，
   `dsh-tool-skill` 在 `agent/pre-step` 注入 `<skill_content>`（来源
   `kind:"skill-invocation"`），客户端渲染为 role:"inject" 上下文行。
10. composer 输入面：`ctx.conversation.input.for(actx)` →
    `{ setDraft(text), state.getSnapshot().draft }`；`actx = createScope(rootCtx, sessionId).ctx`。

## 检查步骤

### 静态检查
- [ ] `cd /Users/youngi/Documents/MiniWork/dsh插件/skill-select`
- [ ] `node --check lib/index.js` 与 `node --check lib/client.js` 通过
- [ ] `node --test tests/` 全绿（host 半单测）
- [ ] host 半不 import 任何深层子路径；仅用包根导出
- [ ] host 半没有写任何 skill 文件（搜索 `writeFile|appendFile|createWriteStream|fs.`）
- [ ] client 半顶层无 import/export 语法；`exports = { apply, inject }` 赋值式
- [ ] client 半 `inject = ["conversation", "slots"]`（未硬注入 betterSidebar）

### 契约交叉检查（design.md 3.1 / 3.2）
- [ ] 路由前缀 `/skill-select/api`，method 解析与 dispatch 一致
- [ ] `list` 响应 `{ok:true, value:{sessionId, skills:[SkillView]}}`；SkillView 字段名
      与 client 消费字段一一对应（name/description/whenToUse/source/modelInvocable/userInvocable）
- [ ] `summarize` 响应 `{ok:true, value:{name, description}}`；错误包络 `{ok:false,error:{code,message}}`
- [ ] 错误码集合：`session-not-found` / `skill-not-found` / `bad-request` / `not-found` / `internal`
- [ ] client fetch 路径与 method 名、请求体字段（sessionId/name）与 host 一致
- [ ] localStorage key：`dsh-skill-select:checked:<sessionId>`
- [ ] tab id `skill-select`、回退槽注册 id `dsh-skill-select`

### 需求逐项核对
- [ ] R1 全局/局部：host 按 `source` 分类（project/user/bundled/other），client 有对应徽标
- [ ] R2 合并 sidebar：registerTab 路径存在；三保险探测（get + internal/service + 3s 重探测）
      互斥；回退 `sidebar.footer.action` 路径存在
- [ ] R3 简介：frontmatter 优先；缓存按 name+contentHash 校验；LLM 失败 fallback 提取；
      生成结果写插件 domain，不改 skill 文件
- [ ] R4 勾选→草稿：追加 ` /name`（词边界，不重复）；取消→移除；按 session 持久化；
      使用 createScope + conversation.input.for + setDraft
- [ ] 边界：无 sessionId 提示；userInvocable=false 的条目被过滤；list 网络失败 UI 提示不崩溃；
      并发 1 的简介生成队列

### 修复闭环
将问题清单返回主 agent；主 agent 修复后复核（对照本清单的对应条目）。
