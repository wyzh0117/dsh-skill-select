<p align="center">
  <img src="assets/product.png" alt="dsh-SkillSelect — Pick skills from the sidebar." width="100%">
</p>

# dsh-SkillSelect

English · [中文](README_zh.md)

DSH web plugin: pick installed skills from a sidebar and inject them into the current session.

## Features

- Lists every configured skill. Marks **Global**, and a **repo** label when it can be inferred.
- **Skills**: session-only checks. A skill appends `/skill-name` to the composer; a fully checked repo writes `/repo` and expands on send. Hiding and reopening the tab clears this session's checks.
- **Auto-start**: persistent defaults, injected once on the first message of each session. Same grouping and checkboxes as Skills.
- Sort: **Repo** (default) / **Name** / **Most used** / **Source**. Repo and Source views fold by group.
- **Guard** (off by default): when on, model `skill` tool calls outside Auto-start ∪ this session's picks are rejected. Typed `/skill` is never blocked.
- Uses frontmatter `description` when present; otherwise generates one English line and caches it. Never writes skill files.
- Also lists Codex / Grok / Hermes user skills (builtins skipped). Duplicates across agents are listed separately. Checks write `/name@agent`; the plugin injects that source's `SKILL.md`. These are **not** registered in the model's `available_skills`.
- **Update** runs `git pull` on git-backed skills and re-fetches skills with a per-skill origin marker. Root-level markers and skills with no source are skipped. A changelog appears in the panel.

## Install

Web profile only.

```bash
dsh plugin --profile web add "github:wyzh0117/dsh-skill-select#main"

# local development — use link: so edits apply after restart
# dsh plugin --profile web add "link:/path/to/skill-select"
```

Restart `dsh web`, then hard-refresh the browser (`Cmd/Ctrl+Shift+R`).

## DSH compatibility

| Plugin | DSH | Notes |
|---|---|---|
| **0.2.0** (current) | `^0.2.0-rc.2` | Registers against the official right sidebar (see below). |
| 0.1.1 | `^0.1.0-rc.6 \|\| ^0.1.5-rc.1` | Last release for the 0.1.x lines; on 0.2.x the peer gate below skips it silently. |
| 0.1.0 | `^0.1.0-rc.6` | **Broken on 0.1.5+** — see below. |

**dsh 0.2.0-rc.2 gates compatibility hard.** `dsh-app-boot` reads the
`package.json` `peerDependencies` whose name is `@deepseek-ai/dsh` or starts
with `@deepseek-ai/dsh-`, runs
`semver.satisfies(runtimeVersion, range, { includePrerelease: true })`, and on
any failure it **skips the whole bundle**: the module is never imported and the
plugin row shows as disabled — silently. **If the plugin stops loading after a
DSH upgrade, check these peer ranges against `dsh --version` first.**
`engines.dsh` in `dsh.plugin.json` is not enforced in rc.2 (kept as metadata
only). Forced-load escape hatch when you really must: `dsh plugin
allow-version`, which writes `<profile>/compatibility.json`.

**rc.2 also split session reads into two tracks.** `ctx.sessions` is now an
in-memory store of **live** sessions: `sessions.get(id)` answers only for a
session this process has activated. A session you merely opened in the web UI is
**cold**, so the old single-path code returned `session "…" not found` (404) for
every session that was visibly on screen. `openSkillView()` covers both: a live
agent becomes the scope and `ctx.agentPresets.serviceFor(agent, "skills")` picks
the registry; a cold session is read with
`ctx.sessionQuery.observeSession(id, { projectionMode })` (→ `header.cwd`,
`projections.values.agentPreset`) and given a standing scope from
`ctx.agentPresets.acquireScope(preset)`, because listing skills for a session
that never entered the process still needs one. Each handle is released in a
`finally` (`Symbol.dispose` / `Symbol.asyncDispose`) — an unreleased scope pins
the preset registry. `SESSION_QUERY_SESSION_NOT_FOUND` maps to 404, any other
query failure to 500, and hosts without `sessionQuery` fall back to
`sessions.get()`. **Symptom to remember:** a 200 response with `skills: []`,
while the same session clearly has skills available to the model, means the cold
path could not obtain a scope — usually because a `@deepseek-ai/dsh-*` row in the
profile was version-skipped and `acquireScope` (which pulls in the shell /
sandbox / tool chain) threw.

DSH 0.1.5 changed the client module table: `@deepseek-ai/dsh-client-runtime` is no
longer a seed package, so `require("@deepseek-ai/dsh-client-runtime")` throws
`missed the module table` and the browser reports **Failed to load plugins**
(the host itself starts fine). 0.1.1 replaces it with `ctx.sessions.scope(sessionId)`
and declares the 0.1.5 range. Client code may only `require()` platform seed
modules — which is why sidebar icons are inline SVG components.

**Upgrading DSH?** DSH upgrades only the CLI — plugins already installed in the
profile keep the old API. Re-resolve them afterwards:

```bash
dsh plugin --profile web update     # re-resolve github:/registry plugins
# link:/ local checkouts are used in place — just restart dsh web
```

Then run `npm test` in this repo: `tests/dsh-compat.test.js` fails loudly when a
DSH named export disappears, a client seed package goes away, or a
`@deepseek-ai/dsh-*` peer range no longer covers the installed runtime.

## Sidebar

The plugin registers a tab in the **official DSH right sidebar** (dsh ≥ 0.2),
in two stages — both must be correct:

1. **Page type** — `ctx.sidebarRightTabs.register({ id: "dsh-skill-select", kind: "skill-select", priority: "extension", title: () => "Skills", guide: [{ id: "dsh-skill-select", order: 70, /* … */ icon: SkillIcon }] })`.
   `kind` is the discriminator `ctx.sidebarRight.openTab(kind)` uses; the
   `guide` entry is what shows **Skills** on the sidebar guide page.
   `guide[].id` is required — two entries without an `id` throw
   "duplicate guide entry id".
2. **Keyed slots** — `ctx.slots.register({ name: "sidebar.right.pane.tab", key: "dsh-skill-select", inject: () => ({ rootCtx: ctx }) }, SkillSelectTab)`
   for the body and `sidebar.right.pane.tab.title` for the pill title. The
   slot `key` must equal the stage-1 **id**, not the kind; a list-shaped
   `{id, order}` on a keyed slot is a failed registration. Both registrations
   run inside `ctx.effect(...)` via `ctx.slots.inject(slotName, cb)`, so load
   order can't break them.

Open the right sidebar and pick **Skills** on the guide page.
`ctx.sidebarRight.openTab("skill-select")` always expands the sidebar and
throws while no Session is on screen. The tab body receives `sessionId` plus
`useTabInfo()`, gates its skill fetch on `tab.visible`, and resets the
session's checks on hide→show.

No third-party sidebar and no self-drawn fallback UI: without the official
sidebar there is simply no tab.

## Develop

```bash
node --test
node --check lib/index.js && node --check lib/client.js
```

Design: [`docs/design.md`](docs/design.md).
