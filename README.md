<p align="center">
  <img src="assets/product.png" alt="dsh-SkillSelect — Pick skills from the sidebar." width="100%">
</p>

# dsh-SkillSelect

English · [中文](README_zh.md)

DSH web plugin: pick installed skills from a sidebar and inject them into the current session.

## Features

- Lists every configured skill. Marks **Global**, and a **repo** label when it can be inferred.
- **Skills**: session-only checks. A skill appends `/skill-name` to the composer; a fully checked repo writes `/repo` and expands on send. Reopening the sidebar clears this tab.
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
| **0.1.1** (current) | `^0.1.0-rc.6 \|\| ^0.1.5-rc.1` | Works on both the old and the 0.1.5 lines. |
| 0.1.0 | `^0.1.0-rc.6` | **Broken on 0.1.5+** — see below. |

DSH 0.1.5 changed the client module table: `@deepseek-ai/dsh-client-runtime` is no
longer a seed package, so `require("@deepseek-ai/dsh-client-runtime")` throws
`missed the module table` and the browser reports **Failed to load plugins**
(the host itself starts fine). 0.1.1 replaces it with `ctx.sessions.scope(sessionId)`
and declares the 0.1.5 range.

**Upgrading DSH?** DSH upgrades only the CLI — plugins already installed in the
profile keep the old API. Re-resolve them afterwards:

```bash
dsh plugin --profile web update     # re-resolve github:/registry plugins
# link:/ local checkouts are used in place — just restart dsh web
```

Then run `npm test` in this repo: `tests/dsh-compat.test.js` fails loudly when a
DSH named export disappears or a client seed package goes away.

## Sidebar compatibility

This plugin does not bundle another sidebar.

If [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) is installed, it registers a **Skills** tab there (`ctx.betterSidebar.registerTab`). Open the side card and pick **Skills** from the `+` menu.

![Skills tab inside dsh-better-sidebar](assets/better-sidebar.png)

If [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) is missing or disabled, it draws its own right sidebar in the same place: toggle to the right of **Session log**, layout via `#root { margin-right }`, click outside to close.

To force the standalone sidebar:

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- { id: better-sidebar, disabled: true }
```

## Develop

```bash
node --test
node --check lib/index.js && node --check lib/client.js
```

Design: [`docs/design.md`](docs/design.md).
