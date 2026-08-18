# dsh-skill-select 交付说明与验收对照

> 最终状态：34/34 单测全绿；独立验收 agent（未参与实现）复核中；已安装进
> `~/.dsh/profiles/web`（dependency + bundle + node_modules 副本同步）。
> **激活方式**：重启 `dsh web`（host 半）→ 浏览器硬刷新 Cmd/Ctrl+Shift+R（client 半）。

## 需求 → 实现 → 证据

| # | 用户需求 | 实现位置 | 验证证据 |
|---|---------|---------|---------|
| 1 | 自动读取所有已配置 skill，区分全局/局部 | host `resolveList`：`ctx.sessions.get(sessionId).header.cwd` → `ctx.skills.list({cwd})`；`classifySource` 把 `project-dsh/project-agents`→局部、`user-dsh/user-agents`→全局、`bundled`→内置、其余→其他 | `tests/index.test.js` classifySource 全分支 + resolveList 映射测试；service.test.js 端到端 list 返回 `source:"user"` |
| 2 | 以 sidebar 展示；已装 sidebar 插件则合并 | client `apply`：探测可选服务 `betterSidebar`（立即探测 + `internal/service` 事件常驻 + 3.2s 兜底重探测，无竞态窗）→ `registerTab({id:"skill-select", title:"技能", single:true, order:90})`；未装则回退内置侧栏 `sidebar.footer.action` 按钮 + 浮动面板（`useSessions((s)=>s.current)` 取当前会话） | `tests/client.test.js`：立即注册/事件迟到/兜底窗口/回退四路径 + disposer 清理测试；`sidebar.footer.action` 槽存在性由验收 agent 在 `dsh-client-ui-sidebar/lib/client.js` 核实 |
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
