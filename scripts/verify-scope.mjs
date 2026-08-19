/**
 * 一次性验证脚本（不进仓库测试集）：用真实 dsh-skill + dsh-scope 包证明
 * “provider 注册在 scoped 层时，skills.list 不带 scope 读不到、带 scope 读得到”。
 * 这正是 web 宿主里 skill-filesystem（挂在 agent preset 层）导致空列表的机制。
 */
import { Context } from "@deepseek-ai/cordis";
import { SkillRegistry } from "@deepseek-ai/dsh-skill";
import { createScope } from "@deepseek-ai/dsh-scope";

const ctx = new Context();
await ctx.plugin(SkillRegistry);

// 模拟 preset 层：把 provider 注册进某个 scope 的子 ctx（真实宿主为 agent preset 层）。
const scopeKey = { id: "agent-1" };
const scopedCtx = createScope(ctx, scopeKey).ctx;
scopedCtx.get("skills").registerProvider(() => ({
  name: "filesystem",
  list: async () => [{
    name: "preset-skill",
    description: "from preset layer",
    source: "user-dsh",
    provider: "filesystem",
    rank: 100,
    locator: { path: "/x/SKILL.md", directory: "/x" },
    invocation: { modelInvocable: true, userInvocable: true },
  }],
  get: async () => undefined,
}));

const withoutScope = await ctx.skills.list({ cwd: "/tmp/proj" });
const withScope = await ctx.skills.list({ cwd: "/tmp/proj", scope: scopeKey });

console.log("without scope:", withoutScope.map((s) => s.name));
console.log("with scope:   ", withScope.map((s) => s.name));
if (withoutScope.length !== 0 || withScope.length !== 1) {
  console.error("FAIL: 期望 [无 scope → 空, 有 scope → [preset-skill]]");
  process.exit(1);
}
console.log("OK: scope 是 scoped 层可见性的唯一开关，修复方向正确");
process.exit(0);
