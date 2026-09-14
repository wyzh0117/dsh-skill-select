/**
 * DSH 版本兼容回归测试。
 *
 * 背景（2026-09 DSH 0.1.5 升级事故）：
 *  1. `@deepseek-ai/dsh-settings` 删掉了 `settingsNamespace` / `installSettingsSection`
 *     等运行时 named export —— ESM 缺 named export 是 SyntaxError，cordis 整棵
 *     插件树加载失败，`dsh web` 进程直接退出。
 *  2. `@deepseek-ai/dsh-client-runtime` 不再是 0.1.5 模块表的种子包 ——
 *     client bundle 里 `require("@deepseek-ai/dsh-client-runtime")` 会抛
 *     "missed the module table"，页面报 "Failed to load plugins"。
 *
 * 本文件把这两条教训固化成断言：以后升级 DSH 时跑 `npm test` 就能提前发现
 * 已删除的 named export / 已失效的 client 种子包，而不是等宿主或页面炸掉。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "dsh.plugin.json"), "utf8"));
const clientSource = readFileSync(join(root, "lib/client.js"), "utf8");
const hostSource = readFileSync(join(root, "lib/index.js"), "utf8");

/** client bundle 里唯一允许 require 的模块：模块表种子包。 */
const SEED_ALLOWLIST = new Set(["react", "react-dom"]);
/** 0.1.5 起不再存在 / 不再是种子包的模块，出现即回归。 */
const REMOVED_MODULES = ["@deepseek-ai/dsh-client-runtime"];

/** 定位本机 DSH 安装；找不到就跳过依赖它的断言（CI 无 DSH 时仍跑其余断言）。 */
function locateDshModules() {
  const candidates = [];
  if (process.env.DSH_HOME) candidates.push(join(process.env.DSH_HOME, "profiles", "node_modules"));
  candidates.push(join(process.env.HOME ?? "", ".dsh", "profiles", "node_modules"));
  for (const dir of candidates) {
    if (dir && existsSync(join(dir, "@deepseek-ai", "dsh"))) {
      const nested = join(dir, "@deepseek-ai", "dsh", "node_modules");
      return existsSync(nested) ? nested : dir;
    }
  }
  return undefined;
}

function moduleSpecs(source) {
  const specs = [...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  for (const m of source.matchAll(/^\s*import\s+(?:[\w*\s{},$]+?\s+from\s+)?["']([^"']+)["']/gm)) specs.push(m[1]);
  return specs;
}

function namedImports(source) {
  const out = new Map();
  for (const m of source.matchAll(/^\s*import\s+(?:([\w*\s{},$]+?)\s+from\s+)?["']([^"']+)["']/gm)) {
    if (!m[1] || m[2].startsWith(".") || m[2].startsWith("node:")) continue;
    const names = m[1]
      .replace(/[{}]/g, " ")
      .split(",")
      .map((part) => part.trim().split(/\s+as\s+/)[0].trim())
      .filter((name) => name && name !== "*" && name !== "default");
    if (names.length > 0) out.set(m[2], names);
  }
  return out;
}

/** 从包入口收集 export 出来的标识符（够用的近似：实际项目都用静态导出）。 */
function exportedNames(packageDir) {
  const manifestPath = join(packageDir, "package.json");
  if (!existsSync(manifestPath)) return undefined;
  const entry = JSON.parse(readFileSync(manifestPath, "utf8")).main ?? "index.js";
  const names = new Set();
  for (const candidate of [entry, "lib/index.js", "index.js", "lib/index.d.ts", "index.d.ts"]) {
    const file = join(packageDir, candidate);
    if (!existsSync(file)) continue;
    const source = readFileSync(file, "utf8");
    for (const block of source.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const part of block[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name) names.add(name);
      }
    }
    for (const m of source.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of source.matchAll(/export\s+type\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    if (names.size > 0) break;
  }
  return names;
}

test("compat: client bundle 只 require 模块表种子包", () => {
  const specs = [...new Set(moduleSpecs(clientSource))].filter((spec) => !spec.startsWith("."));
  for (const spec of specs) {
    assert.ok(SEED_ALLOWLIST.has(spec), `client bundle 不该 require "${spec}"：DSH 0.1.5 的模块表不保证提供它，请改用 ctx 服务（如 ctx.sessions.scope）`);
  }
});

test("compat: 不再引用 0.1.5 已移除的模块", () => {
  const referenced = new Set([...moduleSpecs(clientSource), ...moduleSpecs(hostSource)]);
  for (const mod of REMOVED_MODULES) {
    assert.ok(!referenced.has(mod), `lib/ 仍 import/require 已移除的 ${mod}（注释里提到它没关系，实际引用不行）`);
    assert.ok(!(pkg.peerDependencies ?? {})[mod], `package.json peerDependencies 仍声明已移除的 ${mod}`);
    assert.ok(!(pkg.dependencies ?? {})[mod], `package.json dependencies 仍声明已移除的 ${mod}`);
  }
});

test("compat: dsh.client.inject 只列真实存在的 client 模块", () => {
  const inject = pkg.dsh?.client?.inject ?? [];
  assert.ok(!inject.includes("@deepseek-ai/dsh-client-runtime"), "0.1.5 起 dsh-client-runtime 不是 client 模块，必须从 inject 移除");
  const modules = locateDshModules();
  if (!modules) return; // 本机没有 DSH 安装：跳过存在性校验
  for (const spec of inject) {
    assert.ok(existsSync(join(modules, spec)), `dsh.client.inject 列了 DSH 安装里不存在的模块：${spec}`);
  }
});

test("compat: host 半引用的 named export 在当前 DSH 里仍然存在", () => {
  const modules = locateDshModules();
  if (!modules) return;
  for (const [spec, names] of namedImports(hostSource)) {
    if (!spec.startsWith("@deepseek-ai/")) continue;
    const dir = join(modules, spec);
    if (!existsSync(dir)) continue; // 由插件自身依赖提供，不在 DSH 安装里
    const exported = exportedNames(dir);
    if (!exported || exported.size === 0) continue;
    for (const name of names) {
      assert.ok(exported.has(name), `${spec} 不再导出 ${name}（ESM 缺 named export = 插件树加载失败，需按新版 API 改写）`);
    }
  }
});

test("compat: 声明支持 0.1.5 版本线", () => {
  const range = manifest.engines?.dsh ?? "";
  assert.match(range, /0\.1\.5/, `dsh.plugin.json engines.dsh 未声明 0.1.5 支持：${range}`);
  for (const [name, spec] of Object.entries(pkg.peerDependencies ?? {})) {
    if (!name.startsWith("@deepseek-ai/dsh-")) continue;
    assert.ok(spec.includes("0.1.5"), `peerDependencies.${name} 未声明 0.1.5 支持：${spec}`);
  }
});

test("compat: 版本号在各处一致", () => {
  assert.equal(pkg.version, manifest.version, "package.json 与 dsh.plugin.json 的 version 必须一致");
  assert.ok(readdirSync(root).includes("cordis.patch.yml"), "缺少 cordis.patch.yml（bundle 挂载声明）");
});
