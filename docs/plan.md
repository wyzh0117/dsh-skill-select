# dsh-skill-select 实施计划

> 依据 `docs/design.md`（唯一事实来源）。分工：主 agent 统筹 + Subagent A（host 半）
> + Subagent B（client 半）并行实现 + Subagent C 独立验收。所有 subagent 的提示词
> 均引用设计文档路径与本文档。

## 任务 A：host 半 `lib/index.js` + `tests/index.test.js`

产出文件：
- `lib/index.js` — `SkillSelectService`（default export 类，`static inject =
  ["skills","sessions","webServer","storageDomain","settings","llm"]`，
  `super(ctx,"skillSelect")`，`async [Service.init]()` 打开 domain + 注册路由）
- `tests/index.test.js` — `node --test` 单测（纯函数 + 注入 fake ctx 的 Service 测试）

要点：
1. 信任围栏 `isTrustedRequest(req, trustedHosts)`、`readJsonBody`、
   `writeOk/writeError` 照设计文档 2.1/3.1（可逐字参考
   `/Users/youngi/Documents/MiniWork/dsh插件/dsh-pin/lib/index.js` 的实现，
   它是同构模板）。
2. 来源分类 `classifySource(source)`：`project-*`→`project`、`user-*`→`user`、
   `bundled`→`bundled`、其余→`other`。导出为具名导出便于单测。
3. `list`：`ctx.sessions.get(sessionId)`；无 → `session-not-found`。
   `ctx.skills.list({cwd: session.header.cwd})` → 映射 SkillView，description
   优先级：frontmatter → domain 缓存（校验 contentHash）→ null。
4. `summarize`：见设计文档 2.3；内容 hash = sha1(`skill.content`) 前 16 位；
   缓存写 domain；fallback 提取 = 去掉 YAML frontmatter 后第一个非空行/标题，
   截 80 字。15s 超时（`AbortSignal.timeout(15000)`）。
5. 路由 prefix `/skill-select/api`，method 从 pathname 取（`/skill-select/api/<m>`），
   dispatch `list`/`summarize`，未知 → `not-found` 404。
6. 依赖解析（测试用）：`node_modules` 符号链接 →
   `/Users/youngi/.dsh/profiles/web/node_modules`（ESM 向上查找）。
7. 单测覆盖：classifySource 全分支、list 映射与 session-not-found、
   summarize 缓存命中/LLM 失败 fallback（fake ctx：`skills.list/get`、
   `settings.get`、`llm.prepareCall`、`storageDomain.open` 全部注入假实现）。
   运行 `node --test tests/` 必须全绿；`node --check lib/index.js` 通过。

依赖（peerDependencies，运行时由 web profile 提供）：`@deepseek-ai/cordis`、
`@deepseek-ai/dsh-skill`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-llm`、
`@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-storage-domain`、
`@deepseek-ai/dsh-host-webserver`、`zod`。

## 任务 B：client 半 `lib/client.js`

产出：`lib/client.js` — `window.__ModuleLoader__.load({ id: "dsh-skill-select",
factory: (require) => { ...; return module.exports = { apply, inject } } })`。

要点（详见设计文档 2.2/3.2）：
1. `const React = require("react"); const { createPortal } = require("react-dom");
   const { createScope } = require("@deepseek-ai/dsh-client-runtime");`
   （运行时模块 id 即包名）。
2. `inject = ["conversation", "slots"]`；`apply(ctx)` 内三保险探测
   `betterSidebar`（`ctx.get` + `ctx.on("internal/service",...)` + 3s 重探测），
   就绪注册 tab `{id:"skill-select", title:"技能", single:true, order:90, component}`；
   否则注册 `ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
   name:"sidebar.footer.action", id:"dsh-skill-select", order: 100,
   registrant:"dsh-skill-select" }, FooterButton))`，FooterButton 点击打开
   createPortal 到 document.body 的浮动面板。
3. 技能列表：fetch `/skill-select/api/list`；错误时面板内提示；`userInvocable`
   过滤；搜索框过滤；来源徽标（project=局部/user=全局/bundled=内置/other=其他）；
   `description===null` 的条目进串行队列逐个 `summarize` 回填；手动刷新按钮；
   tab `visible` 变化时刷新。
4. 勾选状态：`localStorage["dsh-skill-select:checked:<sessionId>"]`（JSON 数组），
   组件内 `useSyncExternalStore` 驱动。勾选/取消 → 读草稿
   `conversation.input.for(actx).state.getSnapshot().draft`，追加/移除
   ` /name`（正则替换），`setDraft` 写回；`actx = createScope(rootCtx,
   sessionId).ctx`，按 sessionId 缓存 handle。
5. 样式全部内联 style 对象 + CSS 变量（`var(--dsw-alias-*)`，参考 dsh-pin 用法），
   不引入 CSS 文件。中文文案为主。
6. `node --check lib/client.js` 通过。

## 任务 C：独立验收 review

- 对照设计文档 5 项验收标准逐项检查 A/B 产出；
- 契约交叉检查（SkillView 字段、路由 method 名、响应包络 `{ok,value|error}`、
  localStorage key、tab id 与注册参数）；
- 检查 host 未触碰任何 skill 文件、未注册全局副作用；
- 给出问题清单，由主 agent 修复后复核。

## 任务 D：安装与手工验证（主 agent）

见设计文档第 4 节；重启提示交给用户执行（本会话运行中的 dsh web 不能重启）。
