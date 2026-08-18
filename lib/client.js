/**
 * dsh-skill-select — client 半（web ModuleLoader bundle）。
 *
 * 功能：
 *  - 探测可选服务 `betterSidebar`（三保险：ctx.get + internal/service 事件 +
 *    3s 重探测），存在则注册侧边栏页签 `skill-select`；
 *  - 不存在则回退：在内置侧栏 `sidebar.footer.action` 槽注册"技能"按钮，
 *    点击打开浮动面板；
 *  - 页签/面板列出宿主 `/skill-select/api/list` 返回的技能（名称、简介、
 *    来源徽标、勾选框），简介缺失时串行调用 `summarize` 生成回填；
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
      project: "局部",
      user: "全局",
      bundled: "内置",
      other: "其他",
    };
    const SOURCE_COLOR = {
      project: "var(--dsw-alias-state-business-primary, #4c8dff)",
      user: "var(--dsw-alias-state-success-primary, #2fbf71)",
      bundled: "var(--dsw-alias-state-warn-primary, #e6a23c)",
      other: "var(--dsw-alias-label-tertiary, #8a8f98)",
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
          const skills = (value.skills ?? []).filter((s) => s.userInvocable !== false);
          skills.sort((a, b) => a.name.localeCompare(b.name));
          setSkillState({ sessionId, skills, loading: false, error: null });
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
              skills: current.map((s) => (s.name === name ? { ...s, description: value.description } : s)),
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
      for (const skill of missing) summarizeOne(sessionId, skill.name);
    }

    // ── 草稿手势注入 ────────────────────────────────────────────────────────
    function draftGesture(current, gesture, on) {
      const pattern = new RegExp(`(^|\\s)${gesture.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`);
      if (on) {
        if (pattern.test(current)) return current;
        return current ? `${current} ${gesture}` : gesture;
      }
      return current.replace(pattern, (m, lead) => (lead ? "" : "")).replace(/\s{2,}/g, " ").trim();
    }

    function applyChecked(rootCtx, sessionId, name, on) {
      if (!sessionId) return;
      const list = checkedFor(sessionId);
      const next = on
        ? (list.includes(name) ? list : [...list, name])
        : list.filter((n) => n !== name);
      setChecked(sessionId, next);
      try {
        const actx = scopeCtxFor(rootCtx, sessionId);
        const input = rootCtx.conversation.input.for(actx);
        const current = input.state.getSnapshot().draft;
        input.setDraft(draftGesture(current, `/${name}`, on));
      } catch (error) {
        console.error("[dsh-skill-select] draft update failed:", error);
      }
    }

    // ── 图标与小组件 ────────────────────────────────────────────────────────
    function SkillIcon({ size = 14 }) {
      return React.createElement("svg", {
        viewBox: "0 0 24 24", width: size, height: size, "aria-hidden": true,
        style: { display: "block", flexShrink: 0 },
      }, React.createElement("path", {
        d: "M12 2 2 7v10l10 5 10-5V7L12 2zm0 2.2 7.5 3.8L12 11.8 4.5 8 12 4.2zM4 9.8l7 3.5v6.4l-7-3.5V9.8zm16 0v6.4l-7 3.5v-6.4l7-3.5z",
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
      }, SOURCE_LABEL[source] ?? "其他");
    }

    function Checkbox({ checked, onChange, disabled, label }) {
      return React.createElement("label", {
        style: {
          display: "inline-flex", alignItems: "center", gap: 6, cursor: disabled ? "default" : "pointer",
          flexShrink: 0,
        },
        title: label,
      }, React.createElement("input", {
        type: "checkbox", checked, disabled,
        onChange: (event) => onChange(event.target.checked),
        style: { width: 14, height: 14, accentColor: "var(--dsw-alias-state-business-primary, #4c8dff)", cursor: disabled ? "default" : "pointer", margin: 0 },
      }));
    }

    // ── 技能面板（页签与浮动面板共用）────────────────────────────────────────
    function SkillPanel({ rootCtx, sessionId, embedded }) {
      const state = React.useSyncExternalStore(subscribeSkills, getSkillSnapshot);
      const checkedMap = React.useSyncExternalStore(subscribeChecked, getCheckedSnapshot);
      const [query, setQuery] = React.useState("");
      // 经 checkedFor 读取：懒加载 localStorage，刷新/重挂载后勾选态不丢。
      void checkedMap; // 订阅保持勾选变化触发重渲染
      const checked = sessionId ? checkedFor(sessionId) : [];

      React.useEffect(() => {
        if (sessionId && state.sessionId !== sessionId) {
          loadSkills(sessionId);
        }
      }, [sessionId, state.sessionId]);

      const refresh = () => sessionId && loadSkills(sessionId);

      const groupOrder = ["project", "user", "bundled", "other"];
      const groups = groupOrder.map((source) => ({
        source,
        items: state.skills.filter((s) => {
          if (s.source !== source) return false;
          if (!query.trim()) return true;
          const q = query.trim().toLowerCase();
          return s.name.toLowerCase().includes(q)
            || (s.description ?? "").toLowerCase().includes(q);
        }),
      })).filter((g) => g.items.length > 0);

      const rows = [];
      for (const group of groups) {
        rows.push(React.createElement("div", {
          key: `group-${group.source}`,
          style: {
            fontSize: 11, fontWeight: 600, color: "var(--dsw-alias-label-secondary, #6b7078)",
            padding: "10px 12px 4px", display: "flex", alignItems: "center", gap: 6,
          },
        }, React.createElement(Badge, { source: group.source }), `${SOURCE_LABEL[group.source]}技能（${group.items.length}）`));
        for (const skill of group.items) {
          const isChecked = checked.includes(skill.name);
          rows.push(React.createElement("div", {
            key: skill.name,
            style: {
              display: "flex", alignItems: "flex-start", gap: 8, padding: "7px 12px",
              borderBottom: "1px solid var(--dsw-alias-divider-primary, rgba(128,128,128,0.15))",
            },
          }, React.createElement(Checkbox, {
            checked: isChecked,
            disabled: !sessionId,
            label: `启用技能 ${skill.name}`,
            onChange: (on) => applyChecked(rootCtx, sessionId, skill.name, on),
          }), React.createElement("div", { style: { flex: 1, minWidth: 0 } },
            React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
              React.createElement("span", {
                style: {
                  fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)",
                  fontSize: 12.5, color: "var(--dsw-alias-label-primary, #e8eaf0)",
                },
              }, skill.name),
              skill.whenToUse ? React.createElement("span", {
                title: skill.whenToUse,
                style: { fontSize: 10, color: "var(--dsw-alias-label-tertiary, #8a8f98)" },
              }, "↗") : null,
            ),
            React.createElement("div", {
              style: {
                fontSize: 12, lineHeight: "17px", marginTop: 2,
                color: "var(--dsw-alias-label-secondary, #9aa0a8)",
                whiteSpace: "normal", wordBreak: "break-word",
              },
            }, skill.description === null || skill.description === undefined
              ? React.createElement("span", {
                  style: { display: "inline-flex", alignItems: "center", gap: 6 },
                }, "简介生成中…",
                  React.createElement("a", {
                    href: "#", onClick: (event) => {
                      event.preventDefault();
                      if (sessionId) summarizeOne(sessionId, skill.name);
                    },
                    style: { color: "var(--dsw-alias-state-business-primary, #4c8dff)", textDecoration: "none", fontSize: 11 },
                  }, "重试"))
              : skill.description))));
        }
      }

      if (rows.length === 0 && !state.loading) {
        rows.push(React.createElement("div", {
          key: "empty", style: { padding: "16px 12px", fontSize: 12, color: "var(--dsw-alias-label-tertiary, #8a8f98)" },
        }, query.trim() ? "没有匹配的技能" : "未发现技能（请确认已安装并配置技能）。"));
      }

      return React.createElement("div", {
        style: {
          display: "flex", flexDirection: "column", height: "100%", minHeight: 0,
          background: embedded ? "transparent" : "var(--dsw-specific-panel, #17191d)",
          color: "var(--dsw-alias-label-primary, #e8eaf0)",
          fontFamily: "inherit",
        },
      },
        React.createElement("div", {
          style: { display: "flex", gap: 8, padding: "8px 12px", alignItems: "center" },
        },
          React.createElement("input", {
            type: "text", placeholder: "搜索技能…", value: query,
            onChange: (event) => setQuery(event.target.value),
            style: {
              flex: 1, minWidth: 0, fontSize: 12.5, padding: "5px 10px",
              borderRadius: 6, border: "1px solid var(--dsw-alias-divider-primary, rgba(128,128,128,0.25))",
              background: "var(--dsw-specific-input-major, #20242b)",
              color: "var(--dsw-alias-label-primary, #e8eaf0)", outline: "none",
            },
          }),
          React.createElement("button", {
            type: "button", onClick: refresh, disabled: !sessionId || state.loading,
            title: "刷新技能列表",
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
        }, `加载失败：${state.error}`),
        React.createElement("div", {
          style: { flex: 1, overflowY: "auto", minHeight: 0, paddingBottom: 8 },
        }, rows),
      );
    }

    // ── 浮动面板（无 better-sidebar 时的回退）────────────────────────────────
    function FloatPanel({ rootCtx, sessionId, onClose }) {
      return ReactDOM.createPortal(
        React.createElement("div", {
          style: { position: "fixed", inset: 0, zIndex: 9000 },
          onClick: onClose,
        },
          React.createElement("div", {
            style: {
              position: "absolute", right: 88, top: 56, width: 340, maxHeight: "72vh",
              display: "flex", flexDirection: "column", borderRadius: 12,
              border: "1px solid var(--dsw-alias-divider-primary, rgba(128,128,128,0.25))",
              background: "var(--dsw-specific-panel, #17191d)",
              boxShadow: "var(--dsw-shadow-lv2, 0 8px 24px rgba(0,0,0,0.4))",
              overflow: "hidden",
            },
            onClick: (event) => event.stopPropagation(),
          },
            React.createElement("div", {
              style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px 0" },
            },
              React.createElement("span", {
                style: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600 },
              }, React.createElement(SkillIcon, { size: 15 }), "技能选择"),
              React.createElement("button", {
                type: "button", onClick: onClose, "aria-label": "关闭",
                style: {
                  width: 24, height: 24, border: "none", borderRadius: 6, background: "transparent",
                  color: "var(--dsw-alias-label-tertiary, #8a8f98)", cursor: "pointer", fontSize: 14,
                },
              }, "×")),
            React.createElement(SkillPanel, { rootCtx, sessionId, embedded: false }),
          )),
        document.body,
      );
    }

    function FooterButton({ rootCtx, useSessions }) {
      const [open, setOpen] = React.useState(false);
      // SnapshotSelectorHook 的 selector 是必填：选 current 字段（SessionListState.current）。
      const sessionId = useSessions ? useSessions((s) => s.current) : undefined;
      return React.createElement(React.Fragment, null,
        React.createElement("button", {
          type: "button",
          onClick: () => setOpen(true),
          title: "技能选择",
          "aria-label": "技能选择",
          style: {
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 28, height: 28, borderRadius: 6, border: "none", background: "transparent",
            cursor: "pointer", color: "var(--dsw-alias-label-tertiary, #8a8f98)",
          },
        }, React.createElement(SkillIcon, { size: 15 })),
        open && React.createElement(FloatPanel, {
          rootCtx, sessionId, onClose: () => setOpen(false),
        }),
      );
    }

    // ── better-sidebar tab 注册 ─────────────────────────────────────────────
    function registerTab(ctx, sidebar) {
      return sidebar.registerTab({
        id: "skill-select",
        title: "技能",
        single: true,
        order: 90,
        component: (props) => {
          const sessionId = props.scope?.sessionId;
          // visible 翻转时刷新（design 2.2：tab 隐藏再显示应拉最新列表）。
          React.useEffect(() => {
            if (props.visible && sessionId) loadSkills(sessionId);
          }, [props.visible, sessionId]);
          return React.createElement("div", { style: { width: "100%", height: "100%", minHeight: 0 } },
            sessionId
              ? React.createElement(SkillPanel, { rootCtx: ctx, sessionId, embedded: true })
              : React.createElement("div", {
                  style: { padding: 16, fontSize: 12, color: "var(--dsw-alias-label-tertiary, #8a8f98)" },
                }, "当前没有打开的会话。"));
        },
      });
    }

    // ── 插件主体 ────────────────────────────────────────────────────────────
    // 可选服务探测：事件常驻 + 定时兜底，覆盖任意出现时序（含竞态窗）。
    // apply 返回 disposer：清理事件监听、定时器与 tab/footer 注册（HMR 安全）。
    const inject = ["conversation", "slots"];

    function apply(ctx) {
      const timers = [];
      let tabDisposer = null;
      let footerDisposer = null;
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
          footerDisposer = ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
            name: "sidebar.footer.action",
            id: "dsh-skill-select",
            order: 100,
            registrant: "dsh-skill-select",
          }, (props) => React.createElement(FooterButton, {
            rootCtx: ctx,
            useSessions: props.useSessions,
          }))) ?? null;
        } catch (error) {
          console.error("[dsh-skill-select] footer action registration failed:", error);
        }
      };
      timers.push(setTimeout(ensureFallback, 3200));
      return () => {
        offService();
        for (const timer of timers) clearTimeout(timer);
        if (tabDisposer !== null) {
          try { tabDisposer(); } catch { /* 忽略卸载期异常 */ }
        }
        if (footerDisposer !== null) {
          try { footerDisposer(); } catch { /* 忽略卸载期异常 */ }
        }
      };
    }

    exports.apply = apply;
    exports.inject = inject;
    // 测试钩子（浏览器中惰性无害）。
    exports.__test = {
      draftGesture,
      checked: { getCheckedSnapshot, setChecked, checkedFor, readChecked },
      loadSkills,
    };
    return module.exports;
  },
});
