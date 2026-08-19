# dsh-skill-select 实施计划

> 依据 `docs/design.md`（唯一事实来源，已含四项改动 + B2 令牌方案）。分工：主 agent
> 统筹 + Subagent A（host 半）+ Subagent B（client 半）并行实现 + Subagent C 独立验收。
> 所有 subagent 提示词均引用设计文档路径与本文档。

## 改动总览

| # | 改动 | 半 | 文件 |
|---|------|----|------|
| 1/1.2 | repo 页字体/层级、Other 计数与三态 | client | `lib/client.js` |
| 2 | 外部 agent 技能（codex/grok/hermes，`/name@agent` 令牌） | host+client | `lib/index.js`、`lib/client.js` |
| 3 | 一键更新 + 面板内摘要 | host+client | `lib/index.js`、`lib/client.js` |
| 4 | 活动栏 + VSCode 式右滑面板 | client | `lib/client.js` |
| — | 新依赖 `yaml` | host | `package.json` |

## 任务 A：host 半 `lib/index.js` + `tests/index.test.js`

产出文件：
- `lib/index.js` — 新增外部技能枚举/解析/注入、`scanExternalGestures`、`update`
  API、契约扩展（`list` 返回 `external`、`summarize`/`set-default`/`set-checked`
  接受复合 id）。
- `tests/index.test.js` — `node --test` 单测。
- `package.json` — `dependencies` 增加 `"yaml"`。

要点：
1. **依赖**：`import { parse } from "yaml";`、`import { homedir } from "node:os";`、
   `import { readdir, readFile, stat } from "node:fs/promises";`、
   `import { execFile } from "node:child_process";`（`promisify`）。`yaml` 加入
   `dependencies`。
2. **外部技能根**：常量 `EXTERNAL_AGENTS = [{agent:"codex",dir:"~/.codex/skills"},
   {agent:"grok",dir:"~/.grok/skills"},{agent:"hermes",dir:"~/.hermes/skills"}]`，
   `homedir()` 解析 `~`。枚举：`readdir(withFileTypes)`，跳过点开头项、非目录项；
   目录名须 `isSkillName`；每目录读 `SKILL.md`。
3. **解析**：`readExternalSkill(agent, name)` → 读 `SKILL.md`，用 `yaml` 解析
   frontmatter 取 `description`/`whenToUse`，body 作 `content`，返回
   `{name, description, whenToUse?, content, resourceBase:{kind:"directory",path}}`。
   frontmatter 用 `---\n...\n---` 分隔（与 `extractFallbackDescription` 同法切分）。
   读不到/解析失败 → 抛错由调用方跳过并 `logger.warn`。
4. **`list` 返回 `external`**：`resolveList` 内部对 `EXTERNAL_AGENTS` 枚举
   `readExternalSkill`，映射 `ExternalSkillView`：`id = agent:name`、`repo = agent`、
   `usage = usage?.[id]?.count ?? 0`、`defaultStart = defaults.includes(id)`；
   `description` 优先级 frontmatter → 缓存（`hashContent(content)` 命中才用）→ `null`。
   返回 `{ sessionId, skills, external }`。单测断言契约字段。
5. **`scanExternalGestures(messages)`**：新正则
   `/(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)@([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g`，
   返回去重的复合 id 数组（`agent:name`）。只扫 `source.kind==="user"` 文本块
   （与 `scanSkillGestures` 同源）。
6. **`#onPreStep` 注入扩展**：在 repo 令牌展开后，对 `scanExternalGestures` 的每个
   复合 id：`agent` 必须在 `EXTERNAL_AGENTS` 内且 `readExternalSkill` 成功 →
   `renderSkillContent` 注入（`source.kind:"skill-invocation"`，`name`=技能名），
   加入 `counted`（key=复合 id）；失败静默跳过。默认注入循环：`defaults` 中的
   复合 id 走 `readExternalSkill` 路径（与 DSH 技能共用 `counted` 去重）。
7. **`summarize` 复合 id**：`name` 若匹配 `^([a-z0-9-]+):([a-z0-9-]+)$` 且前段为已知
   agent → `readExternalSkill` 后复用 `generateLlmSummary`/`extractFallbackDescription`，
   缓存 key 用复合 id；否则走原 `ctx.skills` 路径。`set-default`/`set-checked` 已按
   字符串处理，无需改动（复合 id 直接作 key）；`set-checked` 加轻校验：每项须为
   kebab 或 `agent:kebab`。
8. **`update` API**：新增 `update` 方法。扫描根：`~/.dsh/skills`（dsh-global）、
   三个 agent 根（§2.5）、`~/.agents/skills`（agents）。每目录：
   - 有 `.git` → `git -C <dir> rev-parse HEAD`（before）→ `git -C <dir> pull
     --ff-only` → `rev-parse HEAD`（after）→ `git -C <dir> log --oneline
     before..after`（changes）。
   - 无 `.git` 但根目录有来源标记（`.superpowers-origin.txt` 解析 `source=`/
     `commit=`/`version=`）→ `git clone --depth 1 <source>` 到临时目录后替换技能
     目录内容，记 `before=commit`、`after=新 HEAD`、`changes=[version 差说明]`。
   - 否则 → `skipped`（reason="no update source"）。
   - 单条 git 失败不抛断整体，记 `failed` + reason。用 `execFile` + 超时
     （`AbortSignal.timeout(30000)`），`maxBuffer` 放大。
   返回 `{ items: UpdateItem[] }`（契约见设计 §3.1）。抽 `classifyUpdateItem(dir)`
   纯函数供单测（用临时 git 仓库/假目录验证 updated/skipped/failed 分类）。
9. **单测**：`scanExternalGestures` 全分支、`readExternalSkill`（临时目录写
   SKILL.md，含 `description: >` 折叠标量）、`list` 返回 `external` 与 `defaultStart`/
   `usage` 复合 id、`summarize` 复合 id 走外部路径、`update` 分类（临时 git 仓库
   pull 成功 / 无 .git 无标记 skipped / clone 失败 failed）。运行
   `node --test tests/` 全绿；`node --check lib/index.js` 通过。

## 任务 B：client 半 `lib/client.js` + `tests/client.test.js`

产出：`lib/client.js` 全量改动（见下）。`node --check lib/client.js` 通过；
`tests/client.test.js` 冒烟覆盖纯函数。

要点（详见设计 §2.2/§2.5/§2.6/§2.7）：
1. **合并行模型**：`loadSkills` 存 `{skills, external}`；面板内合并为统一行
   `{id, kind:"dsh"|"external", agent?, name, description, whenToUse, repo,
   source, usage, defaultStart, modelInvocable, userInvocable}`；DSH 行 `id=name`，
   外部行 `id=agent:name`。**所有勾选匹配改用 `id`**（DSH 的 id 即 name，无行为变化）。
2. **来源徽标**：`SOURCE_LABEL`/`SOURCE_COLOR` 增加 `codex`/`grok`/`hermes`
   （label `Codex`/`Grok`/`Hermes`，配色各自一色）。外部行 source=agent。
3. **UI 一致性（#1/#1.2）**：
   - repo 组头名：`fontFamily: var(--ds-font-family-code)`, `fontSize: 13`,
     `fontWeight: 600`（技能名仍 12.5）。
   - repo 模式技能行缩进：`renderRow` 在 `sortMode==="repo"` 时 `padding-left` 增加
     ~16px（组头不缩进）。
   - `repoCheckState(skills, repo, checked)` 与组头 `members` 改用 `(s.repo ?? "")`
     归一化；“Other”组计数改用 `group.items.length`，三态按 `m.id` 判定。
4. **外部技能勾选/草稿（B2）**：
   - `tokensForChecked(skills, checked)`：外部行（`kind==="external"`）输出
     `/name@agent`（用 `id` 拆 `name@agent`）；DSH 行走原 repo/技能令牌逻辑。
   - `stripManagedTokens(draft, managed)`：新增外部令牌正则，同时移除
     `/name@agent` 与 `/name`。
   - `composeDraft`：管理集 = DSH 名 + repo 令牌 + `name@agent` 令牌。
   - `applyCheckedBulk` 存/删 `id`；`setChecked`/`syncChecked` 原样传复合 id。
5. **活动栏 + VSCode 式面板（#4）**：`SkillsDrawer` 重写——
   - 活动栏：`position:fixed; right:0; top:<会话顶栏底部>; bottom:0; width≈40px`,
     顶部 Skills 图标按钮，开合态切 ×。
   - 面板：`top/right/bottom` 贴边、`width:380px`、`translateX(100%↔0)` 滑入、
     左分隔线、无遮罩；头部标题栏 + Skills/Auto-start 子页签，内容复用
     `SkillPanel`。`mountStandalone` 不变（portal 到 body）。
6. **更新按钮 + 摘要（#3）**：工具栏加 “Update skills” 按钮（`apiCall("update",
   {})`，进行中旋转/禁用防重入）；成功后渲染面板内摘要区（每项：技能名 + 状态
   徽标 `updated`/`skipped`/`failed` + `changes` 摘要行；`reason` 附说明）。失败
   显示错误行。
7. **冒烟测试**：`groupByRepo`（含外部行 agent 分组）、`repoCheckState`（null repo
   归一化）、`tokensForChecked`（外部输出 `/name@agent`、DSH repo 满选 `/repo`）、
   `stripManagedTokens`（同时剥 `/name` 与 `/name@agent`）、`composeDraft`。

## 任务 C：独立验收 review

- 对照设计 §5 验收标准 R1–R12 逐项检查 A/B 产出；
- 契约交叉检查（`list` 的 `external` 字段、`UpdateItem` 字段、复合 id 在
  summarize/set-default/set-checked 的通路、`/name@agent` 正则与 DSH 手势正则不冲突、
  localStorage key、tab id 与注册参数）；
- 检查 host 未触碰任何 skill 文件、外部枚举不写文件、未注册全局副作用；
- 给出问题清单，由主 agent 修复后复核。

## 任务 D：安装与手工验证（主 agent）

见设计 §4；重启提示交给用户执行（本会话运行中的 dsh web 不能重启）。
手工验证重点：外部技能出现在列表且来源徽标正确、勾选后草稿出现 `/name@agent`、
发送后注入行出现、活动栏面板滑出、更新按钮返回摘要。
