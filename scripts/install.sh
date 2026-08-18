#!/usr/bin/env bash
# 安装 dsh-skill-select 到 web profile（与 dsh-pin 相同的手动安装方式）。
# 用法: bash scripts/install.sh
set -euo pipefail

PLUGIN_DIR="/Users/youngi/Documents/MiniWork/dsh插件/skill-select"
PROFILE_DIR="$HOME/.dsh/profiles/web"
PKG_JSON="$PROFILE_DIR/package.json"

echo "== 备份 profile package.json =="
cp "$PKG_JSON" "$PKG_JSON.bak-$(date +%s)"

echo "== 写入 dependencies 与 dsh.profile.bundles =="
node --input-type=module - "$PKG_JSON" "$PLUGIN_DIR" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const [file, pluginDir] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(file, "utf8"));
pkg.dependencies ??= {};
pkg.dependencies["dsh-skill-select"] = `file:${pluginDir}`;
pkg.dsh ??= {};
pkg.dsh.profile ??= {};
pkg.dsh.profile.bundles ??= [];
if (!pkg.dsh.profile.bundles.includes("dsh-skill-select")) {
  pkg.dsh.profile.bundles.push("dsh-skill-select");
}
writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
NODE

echo "== pnpm install =="
cd "$PROFILE_DIR"
pnpm install --prefer-offline

echo "== 同步插件文件（pnpm 对已满足的 file: 依赖不会重装） =="
INSTALLED="$PROFILE_DIR/node_modules/dsh-skill-select"
if [ -d "$INSTALLED" ]; then
  cp -f "$PLUGIN_DIR/lib/index.js" "$PLUGIN_DIR/lib/client.js" "$INSTALLED/lib/"
  cp -f "$PLUGIN_DIR/dsh.plugin.json" "$PLUGIN_DIR/cordis.patch.yml" "$PLUGIN_DIR/package.json" "$PLUGIN_DIR/README.md" "$INSTALLED/"
fi

echo "== 校验 =="
node --input-type=module - <<'NODE'
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
const pkg = JSON.parse(readFileSync(homedir() + "/.dsh/profiles/web/package.json", "utf8"));
const dep = pkg.dependencies?.["dsh-skill-select"];
const inBundles = pkg.dsh?.profile?.bundles?.includes("dsh-skill-select");
const linked = existsSync(homedir() + "/.dsh/profiles/web/node_modules/dsh-skill-select");
console.log("dependency:", dep ?? "MISSING");
console.log("bundle entry:", inBundles ? "ok" : "MISSING");
console.log("node_modules link:", linked ? "ok" : "MISSING");
if (!dep || !inBundles || !linked) process.exit(1);
NODE

echo "== 完成。请重启 dsh web（host 半生效），然后浏览器硬刷新（client 半生效）。 =="
