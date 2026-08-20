/**
 * dsh-skill-select — client 半（web ModuleLoader bundle）。
 *
 * 功能：
 *  - 已安装 dsh-better-sidebar 时注册为其页签（融入侧边栏）；未安装则挂载
 *    自绘侧边栏，其开关位置（右上角、"Session log" 右侧）与布局推进
 *    （#root margin-right 挤开主内容）完全参照 better-sidebar；
 *  - 面板列出宿主 `/skill-select/api/list` 返回的技能（名称、简介、来源徽标、
 *    repo 徽标、勾选框），简介缺失时串行调用 `summarize` 生成回填；
 *  - 标题栏 "Skills" 旁提供 **Guard** 开关：开=守卫拦截未勾选技能，关=回到
 *    无本插件的默认工作流；状态经 `set-guard` 持久化到宿主 domain；
 *  - 勾选后把 `/skill-name` 手势追加进当前会话输入框草稿（取消勾选移除），
 *    勾选状态按 session 持久化到 localStorage；随下一条消息发送后由 DSH
 *    宿主 pre-step 钩子自动注入 `<skill_content>`。
 *
 * 运行环境：`window.__ModuleLoader__`（模块 id = 包名；require 注入）。
 */
window.__ModuleLoader__.load({
  id: "dsh-skill-select",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let React = require("react");
    let ReactDOM = require("react-dom");
    let Runtime = require("@deepseek-ai/dsh-client-runtime");
    let createScope = Runtime.createScope;

    // ── 常量 ────────────────────────────────────────────────────────────────
    const LS_PREFIX = "dsh-skill-select:checked:";
    const SOURCE_LABEL = {
      project: "Project",
      user: "Global",
      bundled: "Bundled",
      other: "Other",
      codex: "Codex", grok: "Grok", hermes: "Hermes",
    };
    const SOURCE_COLOR = {
      project: "var(--dsw-alias-state-business-primary, #4c8dff)",
      user: "var(--dsw-alias-state-success-primary, #2fbf71)",
      bundled: "var(--dsw-alias-state-warn-primary, #e6a23c)",
      other: "var(--dsw-alias-label-tertiary, #8a8f98)",
      codex: "#f0a24c", grok: "#c792ea", hermes: "#56b6c2",
    };

    // ── 技能列表 store（可观察）────────────────────────────────────────────
    let skillState = { sessionId: undefined, skills: [], error: null, loading: false };
    const skillListeners = new Set();
    const subscribeSkills = (fn) => {
      skillListeners.add(fn);
      return () => { skillListeners.delete(fn); };
    };
    const getSkillSnapshot = () => skillState;
    const setSkillState = (patch) => {
      skillState = { ...skillState, ...patch };
      for (const fn of skillListeners) fn();
    };

    // ── 守卫开关 store（全局，随 list 返回读取 / set-guard 写回）──────────────
    let guardState = { guard: false };
    const guardListeners = new Set();
    const subscribeGuard = (fn) => {
      guardListeners.add(fn);
      return () => { guardListeners.delete(fn); };
    };
    const getGuardSnapshot = () => guardState;
    const setGuardState = (patch) => {
      guardState = { ...guardState, ...patch };
      for (const fn of guardListeners) fn();
    };

    /** 开/关守卫：调 host set-guard，成功后本地回填；失败静默。 */
    async function setGuard(on) {
      try {
        const value = await apiCall("set-guard", { on });
        setGuardState({ guard: value.guard === true });
      } catch (error) {
        console.error("[dsh-skill-select] set-guard failed:", error);
      }
    }

    // ── 勾选状态 store（按 session，localStorage 持久化）─────────────────────
    // 注意 useSyncExternalStore 以 Object.is 比较快照，任何写入必须替换
    // checkedBySession 引用（新 Map），绝不原地 mutate。
    let checkedBySession = new Map();
    const checkedListeners = new Set();
    const subscribeChecked = (fn) => {
      checkedListeners.add(fn);
      return () => { checkedListeners.delete(fn); };
    };
    const getCheckedSnapshot = () => checkedBySession;
    const readChecked = (sessionId) => {
      try {
        const raw = localStorage.getItem(LS_PREFIX + sessionId);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list.filter((n) => typeof n === "string") : [];
      } catch {
        return [];
      }
    };
    const checkedFor = (sessionId) => {
      let list = checkedBySession.get(sessionId);
      if (list === undefined) {
        list = readChecked(sessionId);
        const next = new Map(checkedBySession);
        next.set(sessionId, list);
        checkedBySession = next;
      }
      return list;
    };
    const setChecked = (sessionId, list) => {
      const next = new Map(checkedBySession);
      next.set(sessionId, [...list]);
      checkedBySession = next;
      try {
        localStorage.setItem(LS_PREFIX + sessionId, JSON.stringify(list));
      } catch { /* localStorage 不可用时仅内存态 */ }
      syncChecked(sessionId, list);
      for (const fn of checkedListeners) fn();
    };

    // ── 草稿作用域缓存（sessionId → AgentScopeHandle）───────────────────────
    const scopeHandles = new Map();
    function scopeCtxFor(rootCtx, sessionId) {
      let handle = scopeHandles.get(sessionId);
      if (handle === undefined) {
        handle = createScope(rootCtx, sessionId);
        scopeHandles.set(sessionId, handle);
      }
      return handle.ctx;
    }

    // ── /skill-select/api 客户端 ────────────────────────────────────────────
    async function apiCall(method, payload) {
      let response;
      try {
        response = await fetch(`/skill-select/api/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload || {}),
        });
      } catch (error) {
        throw new Error(`network: ${error instanceof Error ? error.message : String(error)}`);
      }
      const parsed = await response.json().catch(() => null);
      if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
        throw new Error(parsed?.error?.message ?? `HTTP ${response.status}`);
      }
      return parsed.value;
    }

    // 同 session 的在途去重：tab visible effect 与面板 effect 首次挂载都会触发，
    // 复用同一 promise，只发一次请求（C 复核唯一剩余低危项）。
    const listInFlight = new Map();
    function loadSkills(sessionId) {
      if (!sessionId) return;
      if (listInFlight.has(sessionId)) return listInFlight.get(sessionId);
      const promise = (async () => {
        setSkillState({ sessionId, loading: true, error: null });
        try {
          const value = await apiCall("list", { sessionId });
          const dsh = (value.skills ?? []).filter((s) => s.userInvocable !== false)
            .map((s) => ({ ...s, id: s.name, kind: "dsh" }));
          const external = (value.external ?? []).map((e) => ({
            ...e, source: e.agent, kind: "external",
          }));
          const skills = [...dsh, ...external].sort((a, b) => a.name.localeCompare(b.name));
          setSkillState({ sessionId, skills, loading: false, error: null });
          setGuardState({ guard: value.guard === true });
          syncChecked(sessionId, checkedFor(sessionId));
          startSummaryQueue(sessionId, skills);
        } catch (error) {
          console.error("[dsh-skill-select] list failed:", error);
          setSkillState({ loading: false, error: error instanceof Error ? error.message : String(error) });
        } finally {
          listInFlight.delete(sessionId);
        }
      })();
      listInFlight.set(sessionId, promise);
      return promise;
    }

    // ── 简介生成队列（并发 1）───────────────────────────────────────────────
    let summaryQueue = Promise.resolve();
    const summaryInFlight = new Set();
    function summarizeOne(sessionId, name) {
      const key = `${sessionId}:${name}`;
      if (summaryInFlight.has(key)) return;
      summaryInFlight.add(key);
      summaryQueue = summaryQueue.then(async () => {
        try {
          const value = await apiCall("summarize", { sessionId, name });
          if (typeof value?.description === "string" && value.description !== "") {
            const current = skillState.sessionId === sessionId ? skillState.skills : [];
            setSkillState({
              skills: current.map((s) => (s.id === name ? { ...s, description: value.description } : s)),
            });
          }
        } catch (error) {
          console.error(`[dsh-skill-select] summarize ${name} failed:`, error);
        } finally {
          summaryInFlight.delete(key);
        }
      });
    }

    function startSummaryQueue(sessionId, skills) {
      const missing = skills.filter((s) => s.description === null || s.description === undefined);
      for (const skill of missing) summarizeOne(sessionId, skill.id);
    }

    /** 切换默认启动：调 host set-default，成功后本地回填；失败重拉校正。 */
    async function setDefaultStart(name, on) {
      try {
        await apiCall("set-default", { name, on });
        const current = skillState.skills;
        setSkillState({
          skills: current.map((s) => (s.id === name ? { ...s, defaultStart: on } : s)),
        });
      } catch (error) {
        console.error(`[dsh-skill-select] set-default ${name} failed:`, error);
        if (skillState.sessionId) loadSkills(skillState.sessionId);
      }
    }

    /** 批量切换默认启动（repo 组头全选/全不选用）：单次 set-defaults 后本地回填。 */
    async function setDefaultsBulk(names, on) {
      if (!Array.isArray(names) || names.length === 0) return;
      try {
        await apiCall("set-defaults", { names, on });
        const target = new Set(names);
        const current = skillState.skills;
        setSkillState({
          skills: current.map((s) => (target.has(s.id) ? { ...s, defaultStart: on } : s)),
        });
      } catch (error) {
        console.error("[dsh-skill-select] set-defaults failed:", error);
        if (skillState.sessionId) loadSkills(skillState.sessionId);
      }
    }

    // ── 草稿令牌重算（纯函数，导出供单测）────────────────────────────────────
    const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    const GESTURE_TOKEN_RE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;
    const EXTERNAL_TOKEN_RE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)@([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;

    /** 可作为 `/repo` 令牌的 repo 名：合法 kebab 且不存在同名成员技能。 */
    function repoTokens(skills) {
      const byName = new Set(skills.map((s) => s.name));
      const tokens = new Set();
      for (const s of skills) {
        if (typeof s.repo !== "string" || s.repo === "") continue;
        if (byName.has(s.repo)) continue;
        if (!KEBAB_RE.test(s.repo)) continue;
        tokens.add(s.repo);
      }
      return tokens;
    }

    /** 由勾选名单推导草稿令牌：外部 → /name@agent；repo 满选 → 一个 /repo；否则逐个 /skill。 */
    function tokensForChecked(skills, checked) {
      const checkedSet = new Set(checked);
      const tokens = [];
      for (const s of skills) {
        if (s.kind === "external" && checkedSet.has(s.id)) tokens.push(`/${s.name}@${s.agent}`);
      }
      const dsh = skills.filter((s) => s.kind !== "external");
      const remaining = new Set(checked.filter((c) => !c.includes(":")));
      const byRepo = new Map();
      for (const s of dsh) {
        if (typeof s.repo !== "string" || s.repo === "") continue;
        if (!byRepo.has(s.repo)) byRepo.set(s.repo, []);
        byRepo.get(s.repo).push(s);
      }
      const usable = repoTokens(dsh);
      for (const [repo, members] of byRepo) {
        if (!usable.has(repo) || members.length === 0) continue;
        if (members.every((m) => checkedSet.has(m.id))) {
          tokens.push(`/${repo}`);
          for (const m of members) remaining.delete(m.id);
        }
      }
      for (const id of remaining) tokens.push(`/${id}`);
      return tokens;
    }

    /** 从草稿移除本插件管理的 `/name` 与 `/name@agent` 手势，清理空白。 */
    function stripManagedTokens(draft, managed) {
      if (typeof draft !== "string") return "";
      return draft
        .replace(EXTERNAL_TOKEN_RE, (m, lead, name, agent) => (managed.has(`${agent}:${name}`) ? "" : m))
        .replace(GESTURE_TOKEN_RE, (m, lead, token) => (managed.has(token) ? "" : m))
        .replace(/\s{2,}/g, " ").trim();
    }

    /** 重算草稿：移除管理内旧令牌后，按勾选名单追加当前令牌集合。 */
    function composeDraft(skills, checked, currentDraft) {
      const managed = new Set(skills.map((s) => s.id));
      for (const token of repoTokens(skills.filter((s) => s.kind !== "external"))) managed.add(token);
      const base = stripManagedTokens(currentDraft, managed);
      const tokens = tokensForChecked(skills, checked);
      if (tokens.length === 0) return base;
      return base ? `${base} ${tokens.join(" ")}` : tokens.join(" ");
    }

    /** 把勾选名单同步给宿主（守卫判定用）；失败静默。 */
    function syncChecked(sessionId, skills) {
      try {
        if (typeof fetch !== "function" || !sessionId) return;
        fetch("/skill-select/api/set-checked", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, skills }),
        }).catch(() => {});
      } catch { /* 同步失败不影响本地勾选 */ }
    }

    function applyChecked(rootCtx, sessionId, name, on) {
      applyCheckedBulk(rootCtx, sessionId, [{ name, on }]);
    }

    function applyCheckedBulk(rootCtx, sessionId, changes) {
      if (!sessionId) return;
      const list = checkedFor(sessionId);
      const next = [...list];
      for (const change of changes) {
        const { name, on } = change;
        if (on && !next.includes(name)) next.push(name);
        if (!on) {
          const index = next.indexOf(name);
          if (index !== -1) next.splice(index, 1);
        }
      }
      setChecked(sessionId, next);
      try {
        const actx = scopeCtxFor(rootCtx, sessionId);
        const input = rootCtx.conversation.input.for(actx);
        const current = input.state.getSnapshot().draft;
        input.setDraft(composeDraft(skillState.skills, next, current));
      } catch (error) {
        console.error("[dsh-skill-select] draft update failed:", error);
      }
    }

    /**
     * 重置本会话的「Skills 勾选」为未勾选（每次重新打开侧边栏时调用）。
     * Auto-start（默认启动）不受影响——它走 set-default 持久化到 domain。
     * 同时把草稿里本插件管理的 /name、/name@agent、/repo 令牌清掉。
     */
    function resetCheckedForSession(rootCtx, sessionId) {
      if (!sessionId) return;
      const old = checkedFor(sessionId);
      if (old.length === 0) return;
      setChecked(sessionId, []);
      try {
        const actx = scopeCtxFor(rootCtx, sessionId);
        const input = rootCtx.conversation.input.for(actx);
        const current = input.state.getSnapshot().draft;
        const managed = new Set(old);
        const skills = skillState.sessionId === sessionId ? skillState.skills : [];
        for (const token of repoTokens(skills.filter((s) => s.kind !== "external"))) managed.add(token);
        input.setDraft(stripManagedTokens(current, managed));
      } catch (error) {
        console.error("[dsh-skill-select] checked reset draft cleanup failed:", error);
      }
    }

    // ── 排序与分组（纯函数，导出供单测）───────────────────────────────────────
    function sortByName(skills) {
      return [...skills].sort((a, b) => a.name.localeCompare(b.name));
    }

    function sortByUsage(skills) {
      return [...skills].sort((a, b) => {
        const diff = (b.usage ?? 0) - (a.usage ?? 0);
        return diff !== 0 ? diff : a.name.localeCompare(b.name);
      });
    }

    function groupByRepo(skills) {
      if (skills.length === 0) return [];
      const groups = new Map();
      for (const s of skills) {
        const repo = s.repo ?? "";
        if (!groups.has(repo)) groups.set(repo, []);
        groups.get(repo).push(s);
      }
      for (const items of groups.values()) items.sort((a, b) => a.name.localeCompare(b.name));
      const entries = [...groups.entries()].sort(([ra], [rb]) => {
        if (ra === rb) return 0;
        if (ra === "") return 1;
        if (rb === "") return -1;
        return ra.localeCompare(rb);
      });
      return entries.map(([repo, items]) => ({ repo, items }));
    }

    /** repo 组的三态：all（全选）/ some（部分）/ none（全不选）。 */
    function repoCheckState(skills, repo, checked) {
      const members = skills.filter((s) => (s.repo ?? "") === (repo ?? ""));
      if (members.length === 0) return "none";
      const checkedCount = members.filter((m) => checked.includes(m.id)).length;
      if (checkedCount === 0) return "none";
      if (checkedCount === members.length) return "all";
      return "some";
    }

    /** Auto-start 组的三态：按 defaultStart 派生（供 repo 组头全选）。 */
    function defaultCheckState(members) {
      if (members.length === 0) return "none";
      const on = members.filter((m) => m.defaultStart === true).length;
      if (on === 0) return "none";
      if (on === members.length) return "all";
      return "some";
    }

    // ── 图标与小组件 ────────────────────────────────────────────────────────
    // side card 风格：16px 线性轮廓图标（卡片 + 星芒），currentColor 随主题。
    function SkillIcon({ size = 14 }) {
      return React.createElement("svg", {
        viewBox: "0 0 16 16", width: size, height: size, "aria-hidden": true,
        fill: "none", style: { display: "block", flexShrink: 0 },
      },
        React.createElement("path", {
          d: "M2.5 1.5h7a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z",
          stroke: "currentColor", strokeWidth: 1.2, strokeLinejoin: "round",
        }),
        React.createElement("path", {
          d: "M4.5 5.2h4.4M4.5 8h4.4M4.5 10.8h2.8",
          stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round",
        }),
        React.createElement("path", {
          d: "M12.6 2.2l.45 1.35c.06.18.22.34.4.4l1.35.45-1.35.45a.52.52 0 0 0-.4.4l-.45 1.35-.45-1.35a.52.52 0 0 0-.4-.4l-1.35-.45 1.35-.45a.52.52 0 0 0 .4-.4l.45-1.35z",
          fill: "currentColor",
        }));
    }

    function Badge({ source }) {
      return React.createElement("span", {
        style: {
          flexShrink: 0, fontSize: 10, lineHeight: "14px", padding: "0 6px",
          borderRadius: 999, border: `1px solid ${SOURCE_COLOR[source] ?? SOURCE_COLOR.other}`,
          color: SOURCE_COLOR[source] ?? SOURCE_COLOR.other,
          background: "transparent",
        },
      }, SOURCE_LABEL[source] ?? "Other");
    }

    function Checkbox({ checked, onChange, disabled, label, indeterminate }) {
      return React.createElement("label", {
        style: {
          display: "inline-flex", alignItems: "center", gap: 6, cursor: disabled ? "default" : "pointer",
          flexShrink: 0,
        },
        title: label,
      }, React.createElement("input", {
        type: "checkbox", checked, disabled,
        onChange: (event) => onChange(event.target.checked),
        ref: (el) => { if (el) el.indeterminate = Boolean(indeterminate && !checked); },
        style: { width: 14, height: 14, accentColor: "var(--dsw-alias-state-business-primary, #4c8dff)", cursor: disabled ? "default" : "pointer", margin: 0 },
      }));
    }

    /** 紧凑开关：短标签 + 迷你轨道/滑块，标题栏内不占空间。 */
    function Toggle({ checked, onChange, label, title, disabled }) {
      return React.createElement("button", {
        type: "button",
        role: "switch",
        "aria-checked": checked,
        "aria-label": label,
        disabled,
        onClick: () => onChange(!checked),
        title,
        style: {
          display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0,
          background: "transparent", border: "none", cursor: disabled ? "default" : "pointer",
          padding: "2px 6px", borderRadius: 999,
          color: "var(--dsw-alias-label-primary, #e8eaf0)",
        },
      },
        React.createElement("span", { style: { fontSize: 11, fontWeight: 600, lineHeight: "14px" } }, label),
        React.createElement("span", {
          style: {
            position: "relative", width: 26, height: 14, borderRadius: 7, flexShrink: 0,
            background: checked
              ? "var(--dsw-alias-state-business-primary, #4c8dff)"
              : "var(--dsw-alias-divider-primary, rgba(128,128,128,0.4))",
            transition: "background .15s ease",
          },
        },
          React.createElement("span", {
            style: {
              position: "absolute", top: 2, left: checked ? 14 : 2, width: 10, height: 10,
              borderRadius: 5, background: "#fff", transition: "left .15s ease",
            },
          })));
    }

    /** 守卫开关（放抽屉标题栏 "Skills" 旁）：开=拦截未勾选技能，关=默认工作流。 */
    function GuardToggle() {
      const guard = React.useSyncExternalStore(subscribeGuard, getGuardSnapshot).guard;
      return React.createElement(Toggle, {
        checked: guard === true,
        label: "Guard",
        title: guard
          ? "Guard on — only checked / auto-start skills can enter the workflow"
          : "Guard off — default workflow (no blocking of unchecked skills)",
        onChange: (on) => setGuard(on),
      });
    }

    // ── 技能面板（页签与抽屉共用）────────────────────────────────────────────
    function SkillPanel({ rootCtx, sessionId, embedded }) {
      const state = React.useSyncExternalStore(subscribeSkills, getSkillSnapshot);
      const checkedMap = React.useSyncExternalStore(subscribeChecked, getCheckedSnapshot);
      const [query, setQuery] = React.useState("");
      const [tab, setTab] = React.useState("skills");
      const [sortMode, setSortMode] = React.useState("repo");
      const [expanded, setExpanded] = React.useState({});
      const [updating, setUpdating] = React.useState(false);
      const [updateResult, setUpdateResult] = React.useState(null);
      const [updateError, setUpdateError] = React.useState(null);
      const runUpdate = async () => {
        if (updating) return;
        setUpdating(true); setUpdateError(null); setUpdateResult(null);
        try {
          const value = await apiCall("update", {});
          setUpdateResult(value.items ?? []);
          // 更新可能改动了磁盘上的技能，重拉一次让列表与计数/默认状态保持一致。
          if (sessionId) loadSkills(sessionId);
        } catch (error) {
          setUpdateError(error instanceof Error ? error.message : String(error));
        } finally {
          setUpdating(false);
        }
      };
      // 经 checkedFor 读取：懒加载 localStorage，刷新/重挂载后勾选态不丢。
      void checkedMap; // 订阅保持勾选变化触发重渲染
      const checked = sessionId ? checkedFor(sessionId) : [];

      React.useEffect(() => {
        if (sessionId && state.sessionId !== sessionId) {
          loadSkills(sessionId);
        }
      }, [sessionId, state.sessionId]);

      const refresh = () => sessionId && loadSkills(sessionId);

      // 搜索过滤先于排序/分组。
      const q = query.trim().toLowerCase();
      const filtered = state.skills.filter((s) => {
        if (!q) return true;
        return s.name.toLowerCase().includes(q)
          || (s.description ?? "").toLowerCase().includes(q);
      });

      const sourceBadge = (skill) => React.createElement("span", {
        title: `${SOURCE_LABEL[skill.source] ?? "Other"} skill`,
        style: {
          fontSize: 10, lineHeight: "14px", color: "var(--dsw-alias-label-tertiary, #8a8f98)",
          flexShrink: 0,
        },
      }, SOURCE_LABEL[skill.source] ?? "Other");

      const repoChip = (skill) => (typeof skill.repo === "string" && skill.repo !== ""
        ? React.createElement("span", {
            title: skill.repo,
            style: {
              fontSize: 10, lineHeight: "14px", padding: "0 5px", borderRadius: 999,
              border: "1px solid var(--dsw-alias-divider-primary, rgba(128,128,128,0.3))",
              color: "var(--dsw-alias-label-tertiary, #8a8f98)", marginLeft: 4,
            },
          }, skill.repo)
        : null);

      const renderRow = (skill) => {
        const isChecked = checked.includes(skill.id);
        return React.createElement("div", {
          key: skill.id,
          style: {
            display: "flex", alignItems: "flex-start", gap: 8,
            padding: (sortMode === "repo" || sortMode === "source") ? "7px 12px 7px 28px" : "7px 12px",
            borderBottom: "1px solid var(--dsw-alias-divider-primary, rgba(128,128,128,0.15))",
          },
        }, React.createElement(Checkbox, {
          checked: isChecked,
          disabled: !sessionId,
          label: `Enable skill ${skill.name}`,
          onChange: (on) => applyChecked(rootCtx, sessionId, skill.id, on),
        }), React.createElement("div", { style: { flex: 1, minWidth: 0 } },
          React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
            React.createElement("span", {
              style: {
                fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)",
                fontSize: 12.5, color: "var(--dsw-alias-label-primary, #e8eaf0)",
              },
            }, skill.name),
            sortMode !== "repo" ? repoChip(skill) : null,
            sourceBadge(skill),
            skill.whenToUse ? React.createElement("span", {
              title: skill.whenToUse,
              style: { fontSize: 10, color: "var(--dsw-alias-label-tertiary, #8a8f98)" },
            }, "↗") : null,
          ),
          React.createElement("div", {
            title: typeof skill.description === "string" ? skill.description : undefined,
            style: {
              fontSize: 12, lineHeight: "17px", marginTop: 2,
              color: "var(--dsw-alias-label-secondary, #9aa0a8)",
              whiteSpace: "normal", wordBreak: "break-word",
              // 最多 2 行，超出省略；悬停 title 显示全文（frontmatter 原文不做截断改写）。
              display: "-webkit-box", WebkitBoxOrient: "vertical",
              WebkitLineClamp: 2, overflow: "hidden",
            },
          }, skill.description === null || skill.description === undefined
            ? React.createElement("span", {
                style: { display: "inline-flex", alignItems: "center", gap: 6 },
              }, "Generating description…",
                React.createElement("a", {
                  href: "#", onClick: (event) => {
                    event.preventDefault();
                    if (sessionId) summarizeOne(sessionId, skill.id);
                  },
                  style: { color: "var(--dsw-alias-state-business-primary, #4c8dff)", textDecoration: "none", fontSize: 11 },
                }, "Retry"))
            : skill.description)));
      };

      const groupHeaderStyle = {
        fontSize: 11, fontWeight: 600, color: "var(--dsw-alias-label-secondary, #6b7078)",
        padding: "8px 12px 4px", display: "flex", alignItems: "center", gap: 6,
      };

      // ── 折叠辅助：repo 与 source 分组都默认收起（键 = tab:sortMode:groupKey）──
      const groupKeyOf = (groupKey) => `${tab}:${sortMode}:${groupKey}`;
      const isGroupOpen = (groupKey) => expanded[groupKeyOf(groupKey)] === true;
      const toggleGroup = (groupKey) => setExpanded({ ...expanded, [groupKeyOf(groupKey)]: !isGroupOpen(groupKey) });
      const groupArrow = (open) => React.createElement("span", {
        style: { fontSize: 11, fontWeight: 600, color: "var(--dsw-alias-label-secondary, #6b7078)" },
      }, open ? "▾" : "▸");
      const collapsibleHeader = (key, groupKey, open, labelNodes, count) => React.createElement("div", {
        key,
        style: { ...groupHeaderStyle, cursor: "pointer", userSelect: "none" },
        onClick: () => toggleGroup(groupKey),
        title: open ? "Collapse" : "Expand",
      }, groupArrow(open), ...labelNodes, ` (${count})`);
      const sourceGroups = () => {
        const groupOrder = ["project", "user", "bundled", "codex", "grok", "hermes", "other"];
        return groupOrder.map((source) => ({
          source,
          items: filtered.filter((s) => s.source === source),
        })).filter((g) => g.items.length > 0);
      };

      // ── 分页：排序/分组视图 ─────────────────────────────────────────────────
      const rows = [];
      if (tab === "skills") {
        if (sortMode === "source") {
          for (const group of sourceGroups()) {
            const open = isGroupOpen(group.source);
            rows.push(collapsibleHeader(
              `group-${group.source}`, group.source, open,
              [React.createElement(Badge, { source: group.source }), `${SOURCE_LABEL[group.source]} skills`],
              group.items.length,
            ));
            if (open) for (const skill of group.items) rows.push(renderRow(skill));
          }
        } else if (sortMode === "repo") {
          const groups = groupByRepo(filtered);
          for (const group of groups) {
            const repoKey = group.repo || "other";
            const stateOf = repoCheckState(state.skills, group.repo, checked);
            const isOpen = isGroupOpen(repoKey);
            const members = state.skills.filter((s) => (s.repo ?? "") === (group.repo ?? ""));
            const toggleAll = () => {
              const target = stateOf === "all" ? false : true;
              applyCheckedBulk(rootCtx, sessionId, members.map((m) => ({ name: m.id, on: target })));
            };
            rows.push(React.createElement("div", {
              key: `repo-${repoKey}`,
              style: { ...groupHeaderStyle, cursor: "pointer", userSelect: "none" },
              onClick: (event) => {
                // 点复选框不触发折叠切换。
                if (event.target.closest && event.target.closest("label")) return;
                toggleGroup(repoKey);
              },
              title: isOpen ? "Collapse" : "Expand",
            },
              React.createElement("span", {
                onClick: (event) => event.stopPropagation(),
                style: { display: "inline-flex" },
              },
                React.createElement(Checkbox, {
                  checked: stateOf === "all",
                  indeterminate: stateOf === "some",
                  disabled: !sessionId,
                  label: `Toggle all skills in ${group.repo || "Other"}`,
                  onChange: toggleAll,
                })),
              groupArrow(isOpen),
              React.createElement("span", {
                style: { fontSize: 13, fontWeight: 600, fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)", color: "var(--dsw-alias-label-primary, #e8eaf0)" },
              }, group.repo || "Other"),
              ` (${group.items.length})`));
            if (isOpen) for (const skill of group.items) rows.push(renderRow(skill));
          }
        } else if (sortMode === "usage") {
          for (const skill of sortByUsage(filtered)) rows.push(renderRow(skill));
        } else {
          for (const skill of sortByName(filtered)) rows.push(renderRow(skill));
        }
      } else {
        // ── Auto-start 分页：默认启动开关（与 Skills 页共用排序/折叠/左侧勾选）──
        const renderAutoRow = (skill) => React.createElement("div", {
          key: skill.id,
          style: {
            display: "flex", alignItems: "center", gap: 8,
            padding: (sortMode === "repo" || sortMode === "source") ? "7px 12px 7px 28px" : "7px 12px",
            borderBottom: "1px solid var(--dsw-alias-divider-primary, rgba(128,128,128,0.15))",
          },
        },
          React.createElement(Checkbox, {
            checked: skill.defaultStart === true,
            disabled: !sessionId,
            label: `Auto-start ${skill.name}`,
            onChange: (on) => { setDefaultStart(skill.id, on); },
          }),
          React.createElement("div", { style: { flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
            React.createElement("span", {
              style: {
                fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)",
                fontSize: 12.5, color: "var(--dsw-alias-label-primary, #e8eaf0)",
              },
            }, skill.name),
            sortMode !== "repo" ? repoChip(skill) : null,
            sourceBadge(skill)));

        if (sortMode === "source") {
          for (const group of sourceGroups()) {
            const open = isGroupOpen(group.source);
            rows.push(collapsibleHeader(
              `auto-group-${group.source}`, group.source, open,
              [React.createElement(Badge, { source: group.source }), `${SOURCE_LABEL[group.source]} skills`],
              group.items.length,
            ));
            if (open) for (const skill of group.items) rows.push(renderAutoRow(skill));
          }
        } else if (sortMode === "repo") {
          const groups = groupByRepo(filtered);
          for (const group of groups) {
            const repoKey = group.repo || "other";
            const members = state.skills.filter((s) => (s.repo ?? "") === (group.repo ?? ""));
            const stateOf = defaultCheckState(members);
            const isOpen = isGroupOpen(repoKey);
            const toggleAll = () => {
              const target = stateOf === "all" ? false : true;
              setDefaultsBulk(members.map((m) => m.id), target);
            };
            rows.push(React.createElement("div", {
              key: `auto-repo-${repoKey}`,
              style: { ...groupHeaderStyle, cursor: "pointer", userSelect: "none" },
              onClick: (event) => {
                // 点复选框不触发折叠切换。
                if (event.target.closest && event.target.closest("label")) return;
                toggleGroup(repoKey);
              },
              title: isOpen ? "Collapse" : "Expand",
            },
              React.createElement("span", {
                onClick: (event) => event.stopPropagation(),
                style: { display: "inline-flex" },
              },
                React.createElement(Checkbox, {
                  checked: stateOf === "all",
                  indeterminate: stateOf === "some",
                  disabled: !sessionId,
                  label: `Toggle auto-start for all skills in ${group.repo || "Other"}`,
                  onChange: toggleAll,
                })),
              groupArrow(isOpen),
              React.createElement("span", {
                style: { fontSize: 13, fontWeight: 600, fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)", color: "var(--dsw-alias-label-primary, #e8eaf0)" },
              }, group.repo || "Other"),
              ` (${group.items.length})`));
            if (isOpen) for (const skill of group.items) rows.push(renderAutoRow(skill));
          }
        } else if (sortMode === "usage") {
          for (const skill of sortByUsage(filtered)) rows.push(renderAutoRow(skill));
        } else {
          for (const skill of sortByName(filtered)) rows.push(renderAutoRow(skill));
        }
      }

      if (rows.length === 0 && !state.loading) {
        rows.push(React.createElement("div", {
          key: "empty", style: { padding: "16px 12px", fontSize: 12, color: "var(--dsw-alias-label-tertiary, #8a8f98)" },
        }, query.trim() ? "No matching skills" : "No skills found. Check that skills are installed and configured."));
      }

      const tabButton = (id, label) => React.createElement("button", {
        type: "button",
        onClick: () => setTab(id),
        style: {
          flex: 1, fontSize: 12, fontWeight: 600, padding: "7px 0", background: "transparent",
          border: "none", cursor: "pointer",
          color: tab === id ? "var(--dsw-alias-label-primary, #e8eaf0)" : "var(--dsw-alias-label-tertiary, #8a8f98)",
          borderBottom: tab === id
            ? "2px solid var(--dsw-alias-state-business-primary, #4c8dff)"
            : "2px solid transparent",
        },
      }, label);

      return React.createElement("div", {
        style: {
          display: "flex", flexDirection: "column", height: "100%", minHeight: 0,
          background: embedded ? "transparent" : "var(--dsw-specific-panel, #17191d)",
          color: "var(--dsw-alias-label-primary, #e8eaf0)",
          fontFamily: "inherit",
        },
      },
        React.createElement("div", {
          style: { display: "flex", padding: "0 12px", borderBottom: "1px solid var(--dsw-alias-divider-primary, rgba(128,128,128,0.15))" },
        },
          tabButton("skills", "Skills"),
          tabButton("autostart", "Auto-start")),
        React.createElement("div", {
          style: { display: "flex", gap: 8, padding: "8px 12px", alignItems: "center" },
        },
          React.createElement("input", {
            type: "text", placeholder: "Search skills…", value: query,
            onChange: (event) => setQuery(event.target.value),
            style: {
              flex: 1, minWidth: 0, fontSize: 12.5, padding: "5px 10px",
              borderRadius: 6, border: "1px solid var(--dsw-alias-divider-primary, rgba(128,128,128,0.25))",
              background: "var(--dsw-specific-input-major, #20242b)",
              color: "var(--dsw-alias-label-primary, #e8eaf0)", outline: "none",
            },
          }),
          React.createElement("select", {
            value: sortMode,
            onChange: (event) => setSortMode(event.target.value),
            "aria-label": "Sort skills",
            style: {
              fontSize: 11.5, padding: "4px 6px", borderRadius: 6,
              border: "1px solid var(--dsw-alias-divider-primary, rgba(128,128,128,0.25))",
              background: "var(--dsw-specific-input-major, #20242b)",
              color: "var(--dsw-alias-label-primary, #e8eaf0)",
              flexShrink: 0, outline: "none",
            },
          },
            React.createElement("option", { value: "repo" }, "Repo"),
            React.createElement("option", { value: "name" }, "Name"),
            React.createElement("option", { value: "usage" }, "Most used"),
            React.createElement("option", { value: "source" }, "Source")),
          React.createElement("button", {
            type: "button", onClick: runUpdate, disabled: updating,
            title: "Update skills",
            style: {
              fontSize: 11.5, padding: "4px 8px", borderRadius: 6, cursor: updating ? "default" : "pointer",
              border: "1px solid var(--dsw-alias-divider-primary, rgba(128,128,128,0.25))",
              background: "var(--dsw-specific-input-major, #20242b)",
              color: "var(--dsw-alias-label-primary, #e8eaf0)", flexShrink: 0, opacity: updating ? 0.6 : 1,
            },
          }, updating ? "Updating…" : "Update"),
          React.createElement("button", {
            type: "button", onClick: refresh, disabled: !sessionId || state.loading,
            title: "Refresh",
            style: {
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 28, height: 28, borderRadius: 6, border: "none", cursor: "pointer",
              background: "transparent", color: "var(--dsw-alias-label-tertiary, #8a8f98)",
              opacity: state.loading ? 0.5 : 1,
            },
          }, React.createElement(SkillIcon, { size: 14 })),
        ),
        state.error !== null && React.createElement("div", {
          style: { padding: "4px 12px", fontSize: 11.5, color: "var(--dsw-alias-state-error-primary, #f56c6c)" },
        }, `Failed to load: ${state.error}`),
        updateError !== null && React.createElement("div", { style: { padding: "4px 12px", fontSize: 11.5, color: "var(--dsw-alias-state-error-primary, #f56c6c)" } }, `Update failed: ${updateError}`),
        updateResult !== null && React.createElement("div", {
          style: {
            flexShrink: 0, maxHeight: 160, display: "flex", flexDirection: "column",
            borderBottom: "1px solid var(--dsw-alias-divider-primary, rgba(128,128,128,0.15))",
          },
        },
          React.createElement("div", {
            style: {
              display: "flex", alignItems: "center", gap: 6, padding: "6px 12px 2px",
              fontSize: 11, fontWeight: 600, color: "var(--dsw-alias-label-secondary, #9aa0a8)",
            },
          },
            React.createElement("span", { style: { flex: 1 } }, "Update summary"),
            React.createElement("button", {
              type: "button", onClick: () => setUpdateResult(null),
              title: "Dismiss update summary",
              style: {
                border: "none", background: "transparent", cursor: "pointer", padding: 0,
                color: "var(--dsw-alias-label-tertiary, #8a8f98)", fontSize: 14, lineHeight: 1,
              },
            }, "×")),
          React.createElement("div", {
            style: { overflowY: "auto", minHeight: 0, padding: "2px 12px 8px" },
          },
            updateResult.map((item) => React.createElement("div", {
              key: item.id, style: { display: "flex", flexDirection: "column", gap: 2, padding: "3px 0" },
            },
              React.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
                React.createElement("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-primary, #e8eaf0)" } }, item.name),
                React.createElement("span", { style: { fontSize: 10, padding: "0 5px", borderRadius: 999, border: "1px solid var(--dsw-alias-label-tertiary, #8a8f98)", color: item.status === "updated" ? "var(--dsw-alias-state-success-primary, #2fbf71)" : item.status === "failed" ? "var(--dsw-alias-state-error-primary, #f56c6c)" : "var(--dsw-alias-label-tertiary, #8a8f98)" } }, item.status)),
              (item.changes ?? []).slice(0, 3).map((c, i) => React.createElement("div", { key: i, style: { fontSize: 11, color: "var(--dsw-alias-label-secondary, #9aa0a8)", paddingLeft: 4 } }, c)),
              item.reason !== undefined && React.createElement("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #8a8f98)", paddingLeft: 4 } }, item.reason)))),
        ),
        React.createElement("div", {
          style: { flex: 1, overflowY: "auto", minHeight: 0, paddingBottom: 8 },
        }, rows),
      );
    }

    // ── 回退侧边栏：开关位置 / 布局推进完全参照 dsh-better-sidebar ────────────
    // 开关放右上角（"Session log" 右侧），面板占据右侧，以 #root margin-right
    // 把主内容挤开（而非 transform 缩放）；窄屏则全宽覆盖、不推进。
    const SIDEBAR_CSS = [
      "#root { margin-right: var(--skill-select-sidebar-width, 0px); transition: margin-right var(--ds-transition-duration-slow) var(--ds-ease-in-out); }",
      'body[data-skill-select-sidebar-collapsed] [data-slot="conversation.session.header"] > header { padding-right: 46px; }',
      ".dsh-skill-select-toggle { width: 28px; height: 28px; color: var(--dsw-alias-label-secondary); cursor: pointer; background: 0 0; border: none; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; padding: 0; transition: background var(--ds-transition-duration-slow) var(--ds-ease-in-out), color var(--ds-transition-duration-slow) var(--ds-ease-in-out); }",
      ".dsh-skill-select-toggle:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }",
      "@media (prefers-reduced-motion: reduce) { #root, .dsh-skill-select-toggle { transition: none; } }",
    ].join("\n");

    /** 注入一次侧边栏布局样式（仅回退路径需要）；返回移除函数。测试桩缺 head 时静默跳过。 */
    function ensureSidebarStyle() {
      if (typeof document === "undefined") return () => {};
      try {
        if (document.querySelector('style[data-skill-select-sidebar]') !== null) return () => {};
        const tag = document.createElement("style");
        tag.dataset.skillSelectSidebar = "";
        tag.textContent = SIDEBAR_CSS;
        document.head.appendChild(tag);
        return () => { try { tag.remove(); } catch { /* 忽略卸载期异常 */ } };
      } catch {
        return () => {};
      }
    }

    /** 面板图标：右分栏轮廓（对齐 better-sidebar 的 panel-right 开关）。 */
    function PanelRightIcon({ size = 16 }) {
      return React.createElement("svg", {
        viewBox: "0 0 16 16", width: size, height: size, "aria-hidden": true,
        fill: "none", style: { display: "block" },
      },
        React.createElement("rect", {
          x: 2, y: 2.5, width: 12, height: 11, rx: 2,
          stroke: "currentColor", strokeWidth: 1.2,
        }),
        React.createElement("line", {
          x1: 10, y1: 2.5, x2: 10, y2: 13.5,
          stroke: "currentColor", strokeWidth: 1.2,
        }));
    }

    function SkillsDrawer({ rootCtx }) {
      const sessions = rootCtx.get("sessions");
      const sessionId = React.useSyncExternalStore(
        (fn) => (sessions?.list ? sessions.list.subscribe(fn) : () => {}),
        () => (sessions?.list ? sessions.list.getSnapshot().current : undefined),
      );
      const [open, setOpen] = React.useState(false);
      const [width] = React.useState(400);
      const [narrow, setNarrow] = React.useState(() => typeof window !== "undefined" && window.innerWidth <= 767);
      const panelRef = React.useRef(null);
      const toggleRef = React.useRef(null);
      React.useEffect(() => {
        const onResize = () => setNarrow(window.innerWidth <= 767);
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
      }, []);
      const prevOpenRef = React.useRef(false);
      React.useEffect(() => {
        const reopening = open && !prevOpenRef.current;
        prevOpenRef.current = open;
        if (open && sessionId) {
          // 仅在「重新打开侧边栏」（open false→true）时重置本会话 Skills 勾选；
          // 会话切换（open 保持 true）只刷新列表、不清空勾选。Auto-start 不受影响。
          if (reopening) resetCheckedForSession(rootCtx, sessionId);
          loadSkills(sessionId);
        }
      }, [open, sessionId]);
      // 布局推进：打开时 #root margin-right 把主内容挤开；关闭时清除并给会话头部留出开关位。
      React.useEffect(() => {
        const root = document.documentElement;
        if (open && !narrow) {
          root.style.setProperty("--skill-select-sidebar-width", `${Math.min(width, window.innerWidth)}px`);
          document.body.removeAttribute("data-skill-select-sidebar-collapsed");
        } else {
          root.style.setProperty("--skill-select-sidebar-width", "0px");
          document.body.setAttribute("data-skill-select-sidebar-collapsed", "");
        }
        return () => {
          root.style.removeProperty("--skill-select-sidebar-width");
          document.body.removeAttribute("data-skill-select-sidebar-collapsed");
        };
      }, [open, narrow, width]);
      // 点击侧边栏与开关之外的区域时自动关闭。
      React.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          const target = event.target;
          if (panelRef.current && panelRef.current.contains(target)) return;
          if (toggleRef.current && toggleRef.current.contains(target)) return;
          setOpen(false);
        };
        document.addEventListener("mousedown", onPointerDown);
        return () => document.removeEventListener("mousedown", onPointerDown);
      }, [open]);

      const panelWidth = narrow ? "100vw" : Math.min(width, window.innerWidth);

      return ReactDOM.createPortal(
        React.createElement(React.Fragment, null,
          // 右上角开关（"Session log" 右侧）
          React.createElement("div", {
            style: { position: "fixed", top: 3, right: 10, zIndex: 55, display: "flex", flexDirection: "row", gap: 4 },
          },
            React.createElement("button", {
              type: "button", className: "dsh-skill-select-toggle",
              ref: toggleRef,
              onClick: () => setOpen(!open),
              title: "skill-select",
              "aria-label": "skill-select",
            }, React.createElement(PanelRightIcon, { size: 16 }))),
          // 右侧贴边面板
          React.createElement("div", {
            ref: panelRef,
            style: {
              position: "fixed", top: 0, bottom: 0, right: 0, width: panelWidth,
              zIndex: 50, display: "flex", flexDirection: "column",
              background: "var(--dsw-specific-sidebar-fill, #17191d)",
              borderLeft: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.2))",
              transform: open ? "translateX(0)" : "translateX(102%)",
              visibility: open ? "visible" : "hidden",
              transition: "transform var(--ds-transition-duration-slow) var(--ds-ease-in-out), visibility 0s linear " + (open ? "0s" : "var(--ds-transition-duration-slow)"),
            },
          },
            React.createElement("div", {
              style: {
                height: 36, padding: "0 40px 0 12px", display: "flex", alignItems: "center", gap: 6, flexShrink: 0,
                borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25))",
              },
            },
              React.createElement(SkillIcon, { size: 15 }),
              React.createElement("span", { style: { fontSize: 13, fontWeight: 600 } }, "Skills"),
              React.createElement("div", { style: { flex: 1, minWidth: 0 } }),
              React.createElement(GuardToggle, null)),
            open ? React.createElement("div", {
              style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" },
            }, sessionId
              ? React.createElement(SkillPanel, { rootCtx, sessionId, embedded: false })
              : React.createElement("div", { style: { padding: 16, fontSize: 12, color: "var(--dsw-alias-label-tertiary, #8a8f98)" } }, "No open session.")) : null,
          ),
        ),
        document.body,
      );
    }

    // 常驻挂载：注入布局样式 → 创建容器 → createRoot → render SkillsDrawer，返回 disposer。
    function mountStandalone(ctx) {
      if (typeof document === "undefined") return undefined;
      const removeStyle = ensureSidebarStyle();
      const container = document.createElement("div");
      document.body.appendChild(container);
      let root;
      try {
        root = ReactDOM.createRoot(container);
      } catch (error) {
        try { container.remove(); } catch { /* 忽略清理异常 */ }
        removeStyle();
        return undefined;
      }
      root.render(React.createElement(SkillsDrawer, { rootCtx: ctx }));
      return () => {
        try { root.unmount(); } catch { /* 忽略卸载期异常 */ }
        try { container.remove(); } catch { /* 忽略卸载期异常 */ }
        removeStyle();
      };
    }

    // ── better-sidebar tab 注册 ─────────────────────────────────────────────
    function registerTab(ctx, sidebar) {
      return sidebar.registerTab({
        id: "skill-select",
        title: "Skills",
        icon: (size) => SkillIcon({ size }),
        single: true,
        order: 90,
        component: (props) => {
          const sessionId = props.scope?.sessionId;
          // visible 翻转时刷新（tab 隐藏再显示应拉最新列表）；仅在 visible false→true
          // 时重置本会话勾选（会话切换不清空）。
          const prevVisibleRef = React.useRef(false);
          React.useEffect(() => {
            const reopening = props.visible && !prevVisibleRef.current;
            prevVisibleRef.current = props.visible;
            if (props.visible && sessionId) {
              if (reopening) resetCheckedForSession(ctx, sessionId);
              loadSkills(sessionId);
            }
          }, [props.visible, sessionId]);
          return React.createElement("div", { style: { width: "100%", height: "100%", minHeight: 0 } },
            sessionId
              ? React.createElement(SkillPanel, { rootCtx: ctx, sessionId, embedded: true })
              : React.createElement("div", {
                  style: { padding: 16, fontSize: 12, color: "var(--dsw-alias-label-tertiary, #8a8f98)" },
                }, "No open session."));
        },
      });
    }

    // ── 插件主体 ────────────────────────────────────────────────────────────
    // 已安装 better-sidebar 则注册为其页签（融入侧边栏）；未安装则挂载自绘侧边栏
    // （开关位置 / 布局推进完全参照 better-sidebar）。apply 返回 disposer（HMR 安全）。
    const inject = ["conversation"];

    function apply(ctx) {
      const timers = [];
      let tabDisposer = null;
      let standaloneDisposer = null;
      let registered = false;
      const registerTabIfAvailable = () => {
        const sidebar = ctx.get("betterSidebar");
        if (sidebar !== undefined && sidebar !== null && !registered) {
          registered = true;
          try {
            tabDisposer = registerTab(ctx, sidebar) ?? null;
          } catch (error) {
            console.error("[dsh-skill-select] tab registration failed:", error);
            registered = false;
          }
        }
        return registered;
      };
      registerTabIfAvailable();
      const offService = ctx.on("internal/service", (name) => {
        if (name === "betterSidebar") registerTabIfAvailable();
      });
      let fallback = false;
      const ensureFallback = () => {
        if (registerTabIfAvailable()) return;
        if (fallback) return;
        fallback = true;
        try {
          standaloneDisposer = mountStandalone(ctx) ?? null;
        } catch (error) {
          console.error("[dsh-skill-select] standalone mount failed:", error);
        }
      };
      timers.push(setTimeout(ensureFallback, 3200));
      return () => {
        offService();
        for (const timer of timers) clearTimeout(timer);
        if (tabDisposer !== null) {
          try { tabDisposer(); } catch { /* 忽略卸载期异常 */ }
        }
        if (standaloneDisposer !== null) {
          try { standaloneDisposer(); } catch { /* 忽略卸载期异常 */ }
        }
      };
    }

    exports.apply = apply;
    exports.inject = inject;
    // 测试钩子（浏览器中惰性无害）。
    exports.__test = {
      checked: { getCheckedSnapshot, setChecked, checkedFor, readChecked },
      guard: { getGuardSnapshot, setGuardState, setGuard },
      loadSkills,
      sorting: { sortByName, sortByUsage, groupByRepo },
      mountStandalone,
      composeDraft,
      tokensForChecked,
      stripManagedTokens,
      repoCheckState,
      defaultCheckState,
      repoTokens,
      setDefaultStart,
      setDefaultsBulk,
      resetCheckedForSession,
    };
    return module.exports;
  },
});
