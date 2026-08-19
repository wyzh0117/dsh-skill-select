# dsh-skill-select

DSH Web 插件：侧边栏 skill 选择器（英文 UI，side card 风格）。

- 自动读取所有已配置的 skill，标注 **Project**（项目 `.dsh/skills`）/ **Global**（`~/.dsh/skills`）
  来源，并在技能名后标注**所属 repo**（如 `brainstorming` → `superpowers`；内置映射表 +
  嵌套目录路径推断，判定不了则不显示）；
- 以页签形式合并进 **dsh-better-sidebar**（已安装时）；未安装/被禁用则回退到自绘 UI：
  **右侧缘竖向活动栏（技能图标）+ VSCode 式贴边右滑面板**（不再是浮动窗口）；
- 面板分两页：**Skills**（默认按 repo 分组：组头三态复选 + 折叠，默认收起；repo 全选时
  输入框只显示 `/repo名` 一个令牌，发送时自动展开为全部成员技能）与 **Auto-start**
  （选择默认启动的技能，每会话首条消息自动注入一次）；
- **不选不启动**：模型通过 `skill` 工具调用未在「默认启动名单 ∪ 本会话勾选名单」的技能
  会被拒绝（收到明确提示、绝不执行）；用户手动 `/skill` 手势不受限；
- 四种排序方式（Skills 页工具栏下拉框）：**Repo**（默认）/ **Name**（A–Z）/
  **Most used**（调用次数降序，同数按名）/ **Source**（按来源分组）；
- 调用次数为真实统计：`/skill-name` 手势、`/repo` 展开成员、默认注入均计数（同一步骤
  同一技能只 +1），持久化到插件存储（从安装后累计）；
- 每个 skill 展示名称与简介：自带 frontmatter `description` 直接使用；缺失时用当前默认模型
  生成一句英文简介并缓存到插件自己的存储中 —— **绝不修改任何 skill 文件**；
- 勾选 skill 后，`/skill-name` 手势自动填入当前会话输入框，随下一条消息发送；DSH 宿主会在
  pre-step 边界自动把 skill 内容注入会话（对话框可见、可正常使用）；
- 额外扫描 **Codex / Grok / Hermes 的用户技能**（`~/.codex/skills`、`~/.grok/skills`、
  `~/.hermes/skills`，自动跳过其内置：如 codex 的 `.system` 点目录），每条带
  **Codex / Grok / Hermes 来源徽标**；不同 agent 下的重名技能**全部列出、可分别勾选**；
- 勾选外部技能后草稿写入带来源令牌 **`/name@agent`**（如 `/ego-browser@grok`），发送时
  插件注入**该来源**的技能内容（DSH 技能仍用普通 `/name`）；
- 面板工具栏 **Update** 按钮一键更新全部技能：git 仓库型 `git pull`、带 per-skill 来源标记
  （技能目录内 `.superpowers-origin.txt`）的技能按 URL 重拉，面板内就地展示**变更摘要**
  （每项 updated / skipped / failed 与 before → after），无需新建会话。

> 外部 agent 技能**不注册**进模型的 `available_skills` 目录：模型不能自行调用它们，只能经
> 勾选 → `/name@agent` 令牌 → 插件读取文件直接注入这一路径使用。

> 列表枚举依赖会话 scope：web 宿主把 `skill-filesystem` 挂进 agent preset 的 scoped 层，
> 本插件通过 `ctx.agents.get(sessionId)` 取得该 scope 再调用 `ctx.skills.list`，与宿主
> `dsh-tool-skill` 的调用方式一致（详见 `docs/design.md` 2.1）。

## 安装（web profile）

```bash
# 1. 编辑 ~/.dsh/profiles/web/package.json
#    dependencies 增加: "dsh-skill-select": "link:/path/to/skill-select"
#    （本地开发务必用 link: —— pnpm 对 file: 依赖是硬链接副本，改代码不会同步，
#     会导致"改了没变化"；link: 是软链，改完重启 dsh web 即生效）
#    dsh.profile.bundles 增加: "dsh-skill-select"
# 2. 安装依赖
cd ~/.dsh/profiles/web && pnpm install
# 3. 重启 dsh web（host 半生效），浏览器硬刷新 Cmd/Ctrl+Shift+R（client 半生效）
```

发布到 npm 后也可：`dsh plugin --profile web add dsh-skill-select`。

## 使用

1. 已安装 dsh-better-sidebar 时：打开右侧 Side Card，在 `+` 菜单选择 **Skills** 页签
   （带技能图标）；未安装/未加载 better-sidebar 时：点击 DSH **右侧缘竖向活动栏**的
   技能图标，VSCode 式面板从右侧滑出（贴边、无遮罩），× 关闭；
2. 面板分 **Skills** / **Auto-start** 两页：
   - Skills：默认按 repo 分组（组头三态复选 + 折叠箭头，默认收起）；勾选单个技能 →
     草稿追加 `/skill-name`；勾满整个 repo → 草稿只显示 `/repo名`，发送时自动展开为
     全部成员技能；组内部分勾选则逐个写 `/skill`；Codex/Grok/Hermes 外部技能同列表
     展示（带来源徽标），勾选后草稿写入 **`/name@agent`**（如 `/ego-browser@grok`）；
   - Auto-start：打开某技能的开关 → 存入默认启动名单（全局）；每个新会话的首条消息
     自动注入这些技能一次（外部技能同样可默认启动）；
3. 外部 agent 技能**不注册**进模型的 `available_skills` 目录：模型无法自行调用它们，只能
   经勾选（本会话或默认启动）→ 草稿 `/name@agent` 令牌 → 发送时插件读取该来源的
   `SKILL.md` 直接注入这一路径使用；
4. **不选不启动**：模型想通过 `skill` 工具加载的技能必须在你勾选过（本会话）或默认启动
   名单里，否则被拒绝并提示去面板启用；你自己手输的 `/skill` 手势不受此限；
5. Skills 页工具栏下拉框切换排序：Repo（默认）/ Name / Most used / Source（Source 下
   外部技能按 Codex/Grok/Hermes 分组）；
6. Skills 页工具栏 **Update** 按钮：一键更新全部技能（git 仓库 `git pull`；带
   `.superpowers-origin.txt` 来源标记的技能按 URL 重拉），面板内就地展示变更摘要，
   无需新建会话；无更新源的手工技能标记为 skipped；
7. 无简介的 skill 会自动生成（每次一个，英文一句话，生成结果缓存）；也可以点行内按钮手动生成；
8. 发送消息后，技能内容以"注入"行出现在对话中（repo 全选时注入行标签为 repo 名），
   模型即可按该技能工作；调用次数 +1（Most used 排序据此更新）。

## 发布到 GitHub

**不需要带上 dsh-better-sidebar（side card）的仓库。** 本仓库是独立插件：

- 对 better-sidebar 只有**运行时可选的集成**：探测到 `ctx.betterSidebar` 就注册页签，
  探测不到就回退到**右侧缘竖向活动栏 + VSCode 式右滑面板**（非浮动窗口），两种路径都完整可用；
- 仓库内没有任何 side card 的代码/资源，它只是用户环境中"可能已安装"的对等插件；
- 建议随仓库补一份 `LICENSE`（package.json 已声明 MIT），并删除 `~/.dsh/profiles/web/package.json`
  里的 `file:`/`link:` 本地依赖，改用 `github:` 形式安装：

```bash
# 克隆后本地开发（link: 软链，改代码重启即生效；file: 是过期副本，勿用于开发）
dsh plugin --profile web add "link:/path/to/skill-select"
# 从 GitHub 安装（发布后）
dsh plugin --profile web add "github:<your-name>/dsh-skill-select#main"
```

## 开发

```bash
# 单测（node_modules 必须是真实目录：ESM 不跟随目录符号链接，故对每个包建符号链接）
mkdir -p node_modules/@deepseek-ai
for p in cordis dsh-skill dsh-scope dsh-session dsh-llm dsh-settings dsh-storage-domain dsh-host-webserver; do
  ln -sfn ~/.dsh/profiles/node_modules/@deepseek-ai/$p node_modules/@deepseek-ai/$p
done
ln -sfn ~/.dsh/profiles/node_modules/zod node_modules/zod
node --test                 # host 半单测 + client 冒烟测试
node --check lib/index.js && node --check lib/client.js
# 单测覆盖外部技能解析（codex/grok/hermes、跳过内置）、/name@agent 注入、
# update（git pull + 来源标记重拉）与活动栏回退，全绿为合入前提。

# scope 机制回归验证（真实 dsh-skill/dsh-scope 包，无需重启宿主）
node scripts/verify-scope.mjs
```

架构与契约详见 `docs/design.md`，实施分工见 `docs/plan.md`。
