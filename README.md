# dsh-skill-select

DSH Web 插件：侧边栏 skill 选择器。

- 自动读取所有已配置的 skill，标注 **全局**（`~/.dsh/skills`）/ **局部**（项目 `.dsh/skills`）来源；
- 以页签形式合并进 **dsh-better-sidebar**（已安装时）；未安装则回退到内置侧栏按钮 + 浮动面板；
- 每个 skill 展示名称与简介：自带 frontmatter `description` 直接使用；缺失时用当前默认模型
  生成一句中文简介并缓存到插件自己的存储中 —— **绝不修改任何 skill 文件**；
- 勾选 skill 后，`/skill-name` 手势自动填入当前会话输入框，随下一条消息发送；DSH 宿主会在
  pre-step 边界自动把 skill 内容注入会话（对话框可见、可正常使用）。

## 安装（web profile）

```bash
# 1. 编辑 ~/.dsh/profiles/web/package.json
#    dependencies 增加: "dsh-skill-select": "file:/Users/youngi/Documents/MiniWork/dsh插件/skill-select"
#    dsh.profile.bundles 增加: "dsh-skill-select"
# 2. 安装依赖
cd ~/.dsh/profiles/web && pnpm install
# 3. 重启 dsh web（host 半生效），浏览器硬刷新 Cmd/Ctrl+Shift+R（client 半生效）
```

发布到 npm 后也可：`dsh plugin --profile web add dsh-skill-select`。

## 使用

1. 打开右侧 Side Card（dsh-better-sidebar），在 `+` 菜单选择 **技能** 页签；
2. 页签列出全部已配置 skill：名称、简介、来源徽标（局部/全局/内置）、勾选框；
3. 无简介的 skill 会自动生成（每次一个，生成结果缓存）；也可以点行内按钮手动生成；
4. 勾选 → 输入框草稿自动追加 `/skill-name`；取消勾选 → 移除；
5. 发送消息后，技能内容以"注入"行出现在对话中，模型即可按该技能工作。

## 开发

```bash
# 单测（需要把 web profile 的依赖解析进来）
ln -s ~/.dsh/profiles/web/node_modules node_modules
node --test tests/     # host 半单测
node --check lib/index.js && node --check lib/client.js
```

架构与契约详见 `docs/design.md`，实施分工见 `docs/plan.md`。
