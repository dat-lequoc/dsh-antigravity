window.__ModuleLoader__.load({
  id: "dsh-antigravity",
  factory(require) {
    const React = require("react");
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const STYLE_ID = "dsh-antigravity-settings-style";
    const API = "/antigravity/api";
    const NS = "dsh-antigravity";
    const ANTIGRAVITY_SVG_PATH =
      "M89.6992 93.695C94.3659 97.195 101.366 94.8617 94.9492 88.445C75.6992 69.7783 79.7825 18.445 55.8659 18.445C31.9492 18.445 36.0325 69.7783 16.7825 88.445C9.78251 95.445 17.3658 97.195 22.0325 93.695C40.1159 81.445 38.9492 59.8617 55.8659 59.8617C72.7825 59.8617 71.6159 81.445 89.6992 93.695Z";

    const zh = {
      pageDesc: "登录 Google Antigravity / Cloud Code Assist，并查看当前账号的共享额度。",
      currentAccount: "当前账号",
      login: "登录",
      loggingIn: "登录中...",
      refresh: "刷新",
      refreshing: "刷新中...",
      logout: "退出",
      loading: "Loading...",
      notSignedIn: "未登录",
      notSignedInDesc: "点击右上角登录后，会在浏览器中完成 Google OAuth，登录成功后这里会显示 quota。",
      noQuotaDesc: "暂无 quota 数据，点击刷新。",
      fetchingQuota: "正在获取 quota...",
      quota: "额度",
      resetPrefix: "重置: {time}",
      resetUnavailable: "重置: n/a",
      resetNow: "现在",
      timeDayHour: "{days}天 {hours}时",
      timeHourMin: "{hours}h {minutes}m",
      timeMin: "{minutes}m",
      updatedAt: "更新时间：{time}",
      modelSelector: "模型选择器",
      modelSelectorDesc: "勾选后会出现在 DSH 的 Antigravity 模型列表中。",
      selectAll: "全选",
      unselectAll: "全不选",
      loadingModels: "正在加载模型配置...",
      modelSelectorNote: "勾选即自动保存。重新打开模型选择器即可看到最新列表；运行中的旧会话不受影响。",
      quotaLabel: "额度: {percent}%",
      loginFailed: "登录失败",
    };

    const en = {
      pageDesc: "Sign in to Google Antigravity / Cloud Code Assist and view shared quotas.",
      currentAccount: "Current Account",
      login: "Sign in",
      loggingIn: "Signing in...",
      refresh: "Refresh",
      refreshing: "Refreshing...",
      logout: "Sign out",
      loading: "Loading...",
      notSignedIn: "Not signed in",
      notSignedInDesc: "Click Sign in to complete Google OAuth in your browser. Quotas will appear here after login.",
      noQuotaDesc: "No quota data yet. Click Refresh.",
      fetchingQuota: "Fetching quota data...",
      quota: "Quota",
      resetPrefix: "Reset: {time}",
      resetUnavailable: "Reset: n/a",
      resetNow: "now",
      timeDayHour: "{days}d {hours}h",
      timeHourMin: "{hours}h {minutes}m",
      timeMin: "{minutes}m",
      updatedAt: "Updated at: {time}",
      modelSelector: "Model Selector",
      modelSelectorDesc: "Checked models will appear in DSH's Antigravity model list.",
      selectAll: "Select all",
      unselectAll: "Deselect all",
      loadingModels: "Loading model configuration...",
      modelSelectorNote: "Changes are saved automatically. Reopen the model picker to see the updated list; running sessions are unaffected.",
      quotaLabel: "Quota: {percent}%",
      loginFailed: "Login failed",
    };

    Object.assign(en, {
      accounts: "Accounts", addAccount: "Add account", active: "Active", useAccount: "Use account",
      globalSelection: "Selection is shared across DSH sessions. New requests use this account; requests already running keep their account and route.",
      reauth: "Reauthenticate", remove: "Remove account", logoutAll: "Sign out all accounts",
      confirmLogout: "Sign out ALL saved Antigravity accounts? This removes all saved credentials and migration backups.",
      confirmRemove: "Remove {account}? Saved credentials and migration backups will be deleted.",
      replacement: "Replacement active account (required)", chooseReplacement: "Choose an account", removeLast: "Removing the last account signs out.",
      makeActive: "Make active after login", firstActive: "The first account becomes active automatically.",
      proxy: "Proxy", customProxy: "Use custom proxy", proxyOff: "OFF — use existing DSH/network defaults (not necessarily direct).",
      browserProxy: "Google sign-in in your browser is NOT proxied by this setting. Configure the browser separately; the callback stays local.",
      authOnly: "Authentication only", allAccount: "All account traffic", scope: "Routing scope",
      scopeNote: "Authentication only covers server-side login/refresh/identity/project discovery. Model, quota and search use DSH defaults. All account traffic is recommended for one VPN exit. Covered proxy failures never fall back to defaults.",
      protocol: "Protocol", host: "Host", port: "Port", testProxy: "Test connection", probeOK: "Proxy reachable. This does not verify VPN egress or account authorization.",
      probeFailed: "Proxy is not reachable.", proxyInvalid: "Enter an HTTP(S) host and port (1–65535), without credentials, paths, query or fragment.",
      save: "Save", cancel: "Cancel", cancelLogin: "Cancel login", openLogin: "Open Google sign-in", loginPending: "Waiting for Google sign-in…",
      uncertain: "Request failed or timed out; outcome may be unconfirmed. Reloading authoritative state. Do not assume it was rolled back.",
      requestFailed: "Request failed. Refresh status and try again.", refreshState: "Refresh status", expiresAt: "Token expires: {time}", expired: "Token expired; refresh or reauthenticate if needed.",
      loginComplete: "Login complete.", loginCancelled: "Login cancelled.", loginError: "Login failed or expired. Try again.",
    });
    Object.assign(zh, {
      accounts: "账号", addAccount: "添加账号", active: "当前启用", useAccount: "使用此账号",
      globalSelection: "账号选择由所有 DSH 会话共享。新请求使用所选账号；进行中的请求保留原账号和路由。",
      reauth: "重新认证", remove: "移除账号", logoutAll: "退出所有账号",
      confirmLogout: "确定退出所有已保存的 Antigravity 账号？将删除所有凭据和迁移备份。",
      confirmRemove: "确定移除 {account}？将删除其凭据和迁移备份。",
      replacement: "替代的启用账号（必选）", chooseReplacement: "请选择账号", removeLast: "移除最后一个账号后将退出登录。",
      makeActive: "登录后设为启用账号", firstActive: "第一个账号将自动启用。",
      proxy: "代理", customProxy: "使用自定义代理", proxyOff: "关闭 — 使用现有 DSH/网络默认设置（不保证直连）。",
      browserProxy: "此设置不会代理浏览器中的 Google 登录页面。请单独配置浏览器代理；回调必须保持本地连接。",
      authOnly: "仅认证", allAccount: "所有账号流量", scope: "路由范围",
      scopeNote: "仅认证涵盖服务端登录、刷新、身份查询和登录时项目发现；模型、额度和搜索使用 DSH 默认设置。若需统一 VPN 出口，建议选择所有账号流量。代理失败时，覆盖的请求不会回退到默认路由。",
      protocol: "协议", host: "主机", port: "端口", testProxy: "测试连接", probeOK: "代理可达。这不代表已验证 VPN 出口或账号授权。",
      probeFailed: "代理不可达。", proxyInvalid: "请输入 HTTP(S) 主机和端口（1–65535），不得包含凭据、路径、查询或片段。",
      save: "保存", cancel: "取消", cancelLogin: "取消登录", openLogin: "打开 Google 登录", loginPending: "等待 Google 登录…",
      uncertain: "请求失败或超时，结果可能尚未确认。正在重新获取权威状态，请勿认为操作已回滚。",
      requestFailed: "请求失败，请刷新状态后重试。", refreshState: "刷新状态", expiresAt: "令牌到期：{time}", expired: "令牌已到期；请刷新，必要时重新认证。",
      loginComplete: "登录完成。", loginCancelled: "登录已取消。", loginError: "登录失败或已过期，请重试。",
    });

    function createTranslator(ctx) {
      const boundT = (ctx && ctx.locale && typeof ctx.locale.bind === "function")
        ? ctx.locale.bind(NS)
        : null;

      return function t(key, params) {
        if (boundT) {
          try {
            const res = boundT(key, params);
            if (res && res !== key && res !== `${NS}.${key}`) return res;
          } catch (_) {}
        }
        const active = (ctx && ctx.locale && typeof ctx.locale.getLocale === "function")
          ? ctx.locale.getLocale()?.active
          : null;
        const isZh = active ? active.startsWith("zh") : (typeof navigator !== "undefined" && navigator.language && navigator.language.startsWith("zh"));
        const dict = isZh ? zh : en;
        let text = dict[key] || en[key] || zh[key] || key;
        if (params && typeof params === "object") {
          for (const [k, v] of Object.entries(params)) {
            text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
          }
        }
        return text;
      };
    }

    function patchNavIcon() {
      const spans = document.querySelectorAll("span");
      for (const span of spans) {
        if (span.textContent && span.textContent.trim() === "Antigravity") {
          const btn = span.closest("button");
          if (btn) {
            const svg = btn.querySelector("svg");
            if (svg) {
              svg.setAttribute("viewBox", "0 0 110 113");
              svg.setAttribute("width", "16");
              svg.setAttribute("height", "16");
              svg.setAttribute("fill", "none");
              const path = svg.querySelector("path");
              if (!path || path.getAttribute("d") !== ANTIGRAVITY_SVG_PATH) {
                svg.innerHTML = `<path d="${ANTIGRAVITY_SVG_PATH}" fill="currentColor"/>`;
              }
            }
          }
        }
      }
    }

    function initNavObserver() {
      patchNavIcon();
      const observer = new MutationObserver(patchNavIcon);
      observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
      return () => observer.disconnect();
    }

    function installStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
.dsha-wrap{box-sizing:border-box;width:100%;max-width:760px;padding:0 0 24px;color:#111827}
.dsha-page-head{display:flex;align-items:center;gap:10px}
.dsha-brand-icon{color:#111827;flex-shrink:0}
.dsha-page-title{margin:0;color:#111827;font-size:20px;font-weight:700;line-height:28px}
.dsha-page-desc{margin:8px 0 18px;color:#8b93a1;font-size:13px;line-height:20px}
.dsha-card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:16px;box-shadow:none}
.dsha-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
.dsha-title{display:flex;align-items:center;gap:9px;font-size:15px;font-weight:700;color:#111827}
.dsha-ok{width:18px;height:18px;border-radius:999px;border:2px solid #10b981;position:relative;flex:0 0 auto}
.dsha-ok:after{content:"";position:absolute;left:4px;top:2px;width:6px;height:9px;border:solid #10b981;border-width:0 2px 2px 0;transform:rotate(45deg)}
.dsha-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.dsha-btn{border:1px solid #d7dce3;background:#fff;color:#111827;border-radius:10px;padding:7px 12px;font-size:13px;line-height:18px;cursor:pointer}
.dsha-btn:hover{background:#f7f8fa}
.dsha-btn:disabled{cursor:not-allowed;opacity:.55}
.dsha-btn-primary{border-color:#111827;background:#111827;color:white}
.dsha-btn-primary:hover{background:#272d38}
.dsha-account{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;padding:12px;border:1px solid #eef1f5;border-radius:10px;background:#fafbfc;color:#4b5563}
.dsha-email{display:flex;align-items:center;gap:9px;font-size:14px;font-weight:650;min-width:0}
.dsha-email-mark{width:16px;height:12px;border:1.8px solid #7f8a9a;border-radius:3px;position:relative;flex:0 0 auto}
.dsha-email-mark:before{content:"";position:absolute;left:1px;right:1px;top:1px;height:7px;border-bottom:1.8px solid #7f8a9a;transform:skewY(-28deg)}
.dsha-email-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsha-badge{display:inline-flex;align-items:center;gap:6px;border-radius:999px;background:#eef2ff;color:#3f46d8;border:1px solid #dfe5ff;padding:4px 9px;font-size:12px;font-weight:800;letter-spacing:.02em}
.dsha-diamond{width:8px;height:8px;border-radius:2px;background:#4f5bf6;transform:rotate(45deg)}
.dsha-quota-title{margin:16px 0 6px;color:#111827;font-size:14px;font-weight:700}
.dsha-quota-group{margin-top:10px;padding:12px 14px;background:#fafbfc;border:1px solid #eef1f5;border-radius:10px}
.dsha-group-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.dsha-group-title{font-size:13px;font-weight:700;color:#111827}
.dsha-group-desc{font-size:12px;color:#8b93a1}
.dsha-row{padding:8px 0;border-top:1px solid #edf1f5}
.dsha-row:first-of-type{border-top:0;padding-top:0}
.dsha-rowtop{display:flex;align-items:baseline;justify-content:space-between;gap:12px;color:#4b5563;font-weight:600;font-size:13px}
.dsha-metrics{display:flex;align-items:baseline;gap:10px;white-space:nowrap;color:#8b93a1;font-size:12px}
.dsha-percent{font-size:13px;font-weight:750;color:#059669}
.dsha-percent-cyan{color:#0284c7}
.dsha-bar{height:6px;margin-top:6px;border-radius:999px;background:#edf1f5;overflow:hidden}
.dsha-fill{height:100%;border-radius:999px;background:#10b981}
.dsha-fill-cyan{background:#06b6d4}
.dsha-empty{border:1px dashed #d8dee8;border-radius:10px;padding:14px;color:#747f90;background:#fafbfc;font-size:13px;line-height:20px}
.dsha-error{margin-top:12px;color:#991b1b;background:#fff5f5;border:1px solid #fecaca;border-radius:10px;padding:10px 12px;font-size:13px;white-space:pre-wrap}
.dsha-note{margin-top:12px;color:#8b93a1;font-size:12px;line-height:18px}
.dsha-model-card{margin-top:14px}
.dsha-model-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px}
.dsha-model-title{font-size:14px;font-weight:700;color:#111827}
.dsha-model-desc{margin-top:3px;color:#8b93a1;font-size:12px;line-height:18px}
.dsha-mini-actions{display:flex;gap:8px;white-space:nowrap}
.dsha-mini-btn{border:0;background:transparent;color:#4f5bf6;font-size:12px;line-height:18px;cursor:pointer;padding:0}
.dsha-mini-btn:hover{text-decoration:underline}
.dsha-model-list{border:1px solid #eef1f5;border-radius:10px;overflow:hidden}
.dsha-model-row{display:flex;align-items:flex-start;gap:10px;padding:11px 14px;background:#fff;border-top:1px solid #eef1f5;cursor:pointer}
.dsha-model-row:hover{background:#fafbfc}
.dsha-model-row:first-child{border-top:0}
.dsha-check{margin-top:1px;width:16px;height:16px;accent-color:#111827;flex:0 0 auto}
.dsha-model-text{min-width:0;flex:1 1 auto}
.dsha-model-name{display:block;font-size:13px;font-weight:650;color:#111827;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsha-model-sub{display:block;margin-top:3px;color:#9aa3b0;font-size:12px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
`;
      document.head.append(style);
    }

    async function api(path, options) {
      const controller = new AbortController();
      const signal = options && options.signal;
      const abort = () => controller.abort();
      if (signal) {
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }
      const timeout = window.setTimeout(abort, 30000);
      try {
        const response = await fetch(`${API}${path}`, {
          ...options, signal: controller.signal, cache: "no-store",
          headers: { "content-type": "application/json", ...(options && options.headers || {}) },
        });
        const body = await response.json();
        if (!response.ok || body.ok === false) throw new Error(`HTTP ${response.status}`);
        return body.ok === true ? body.value : body;
      } finally {
        window.clearTimeout(timeout);
        if (signal) signal.removeEventListener("abort", abort);
      }
    }

    function AntigravityIcon({ size = 20, className = "" }) {
      return React.createElement(
        "svg",
        {
          viewBox: "0 0 110 113",
          width: size,
          height: size,
          fill: "none",
          className,
          style: { flexShrink: 0, display: "inline-block", verticalAlign: "middle" },
          xmlns: "http://www.w3.org/2000/svg",
          "aria-hidden": "true",
        },
        React.createElement("path", {
          d: "M89.6992 93.695C94.3659 97.195 101.366 94.8617 94.9492 88.445C75.6992 69.7783 79.7825 18.445 55.8659 18.445C31.9492 18.445 36.0325 69.7783 16.7825 88.445C9.78251 95.445 17.3658 97.195 22.0325 93.695C40.1159 81.445 38.9492 59.8617 55.8659 59.8617C72.7825 59.8617 71.6159 81.445 89.6992 93.695Z",
          fill: "currentColor",
        }),
      );
    }

    function extractModelVersion(model) {
      const name = String(model && model.name ? model.name : "");
      const id = String(model && model.id ? model.id : "");
      const idMatch = id.match(/(?:gemini|claude|gpt)[-_ ]*v?(\d+(?:\.\d+)*)/i)
        || id.match(/\b(\d+(?:\.\d+)+)\b/);
      if (idMatch) return idMatch[1].split(".").map((num) => parseInt(num, 10) || 0);

      const nameMatch = name.match(/(?:gemini|claude|gpt)[-_ ]*v?(\d+(?:\.\d+)*)/i)
        || name.match(/\b(\d+(?:\.\d+)+)\b/);
      if (nameMatch) return nameMatch[1].split(".").map((num) => parseInt(num, 10) || 0);

      return [0];
    }

    function compareVersionsDesc(v1, v2) {
      const len = Math.max(v1.length, v2.length);
      for (let i = 0; i < len; i++) {
        const num1 = v1[i] !== undefined ? v1[i] : 0;
        const num2 = v2[i] !== undefined ? v2[i] : 0;
        if (num1 !== num2) return num2 - num1;
      }
      return 0;
    }

    function getFamilyOrder(model) {
      const text = `${model && model.id ? model.id : ""} ${model && model.name ? model.name : ""}`.toLowerCase();
      if (text.includes("gemini")) return 1;
      if (text.includes("claude")) return 2;
      if (text.includes("gpt")) return 3;
      return 4;
    }

    function getVariantScore(model) {
      const text = `${model && model.name ? model.name : ""} ${model && model.id ? model.id : ""}`.toLowerCase();
      if (text.includes("ultra")) return 1;
      if (text.includes("pro") && !text.includes("lite")) return 2;
      if (text.includes("flash") && !text.includes("lite") && !text.includes("thinking") && !text.includes("image")) return 3;
      if (text.includes("flash") && text.includes("thinking") && !text.includes("lite")) return 4;
      if (text.includes("image")) return 5;
      if (text.includes("lite") && !text.includes("thinking")) return 6;
      if (text.includes("lite") && text.includes("thinking")) return 7;
      return 10;
    }

    function compareAntigravityModels(a, b) {
      const famA = getFamilyOrder(a);
      const famB = getFamilyOrder(b);
      if (famA !== famB) return famA - famB;

      const verA = extractModelVersion(a);
      const verB = extractModelVersion(b);
      const verComp = compareVersionsDesc(verA, verB);
      if (verComp !== 0) return verComp;

      const variantA = getVariantScore(a);
      const variantB = getVariantScore(b);
      if (variantA !== variantB) return variantA - variantB;

      return (a.name || a.id || "").localeCompare(b.name || b.id || "") || (a.id || "").localeCompare(b.id || "");
    }

    function compareAntigravityModelOptions(a, b) {
      const aEnabled = Boolean(a && a.enabled);
      const bEnabled = Boolean(b && b.enabled);
      if (aEnabled !== bEnabled) return aEnabled ? -1 : 1;
      return compareAntigravityModels(a, b);
    }

    function formatReset(resetTime, t) {
      if (!resetTime) return "n/a";
      const timestamp = Date.parse(resetTime);
      if (!Number.isFinite(timestamp)) return resetTime;
      const delta = timestamp - Date.now();
      if (delta <= 0) return t ? t("resetNow") : "now";
      const totalMinutes = Math.round(delta / 60000);
      const days = Math.floor(totalMinutes / (60 * 24));
      const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
      const minutes = totalMinutes % 60;
      if (days > 0) return t ? t("timeDayHour", { days, hours }) : `${days}d ${hours}h`;
      if (hours > 0) return t ? t("timeHourMin", { hours, minutes }) : `${hours}h ${minutes}m`;
      return t ? t("timeMin", { minutes }) : `${minutes}m`;
    }

    function resetText(row, t) {
      if (row && row.resetLabel) return t ? t("resetPrefix", { time: row.resetLabel }) : `Reset: ${row.resetLabel}`;
      if (row && row.resetTime) return t ? t("resetPrefix", { time: formatReset(row.resetTime, t) }) : `Reset: ${formatReset(row.resetTime, t)}`;
      return t ? t("resetUnavailable") : "Reset: n/a";
    }

    function percentOf(row) {
      if (typeof row.remainingPercent === "number") return row.remainingPercent;
      if (typeof row.remainingFraction === "number") return Math.round(row.remainingFraction * 1000) / 10;
      return 0;
    }

    function QuotaRow({ row, accent, t }) {
      const percent = percentOf(row);
      const width = Math.max(0, Math.min(100, percent));
      return React.createElement("div", { className: "dsha-row" },
        React.createElement("div", { className: "dsha-rowtop" },
          React.createElement("div", null, row.label || row.displayName || row.id || (t ? t("quota") : "Quota")),
          React.createElement("div", { className: "dsha-metrics" },
            React.createElement("span", null, resetText(row, t)),
            React.createElement("span", { className: `dsha-percent${accent === "cyan" ? " dsha-percent-cyan" : ""}` }, `${percent}%`),
          ),
        ),
        React.createElement("div", { className: "dsha-bar" },
          React.createElement("div", {
            className: `dsha-fill${accent === "cyan" ? " dsha-fill-cyan" : ""}`,
            style: { width: `${width}%` },
          }),
        ),
      );
    }

    function QuotaGroup({ group, accent, t }) {
      const buckets = Array.isArray(group && group.buckets) ? group.buckets : [];
      return React.createElement("div", { className: "dsha-quota-group" },
        React.createElement("div", { className: "dsha-group-head" },
          React.createElement("span", { className: "dsha-group-title" }, group.displayName || (t ? t("quota") : "Quota group")),
          group.description && React.createElement("span", { className: "dsha-group-desc" }, group.description),
        ),
        buckets.map((bucket, index) => React.createElement(QuotaRow, {
          key: bucket.id || bucket.bucketId || bucket.label || bucket.displayName || index,
          row: bucket,
          accent,
          t,
        })),
      );
    }

    function modelMeta(option, t) {
      const parts = [];
      if (Array.isArray(option.inputModalities) && option.inputModalities.includes("image")) parts.push("image");
      if (Array.isArray(option.reasoningEfforts) && option.reasoningEfforts.length) {
        parts.push(`thinking: ${option.reasoningEfforts.join("/")}`);
      }
      if (typeof option.remainingPercent === "number") {
        parts.push(t ? t("quotaLabel", { percent: option.remainingPercent }) : `Quota: ${option.remainingPercent}%`);
      }
      return parts.join(" · ");
    }

    function ModelOptionRow({ option, disabled, onToggle, t }) {
      return React.createElement("label", { className: "dsha-model-row" },
        React.createElement("input", {
          className: "dsha-check",
          type: "checkbox",
          checked: !!option.enabled,
          disabled,
          onChange: (event) => onToggle(option.id, event.target.checked),
        }),
        React.createElement("span", { className: "dsha-model-text" },
          React.createElement("span", { className: "dsha-model-name" }, option.name || option.id),
          React.createElement("span", { className: "dsha-model-sub" }, modelMeta(option, t) || option.id),
        ),
      );
    }

    function AccountEditor({ editor, accounts, busy, tr, onSubmit, onClose, request }) {
      const saved = editor.account && editor.account.proxy;
      let parsed;
      try { parsed = saved && saved.url ? new URL(saved.url) : null; } catch (_) {}
      const [enabled, setEnabled] = useState(!!(saved && saved.enabled));
      const [protocol, setProtocol] = useState(parsed ? parsed.protocol.slice(0, -1) : "http");
      const [host, setHost] = useState(parsed ? parsed.hostname : "127.0.0.1");
      const [port, setPort] = useState(parsed ? parsed.port || (parsed.protocol === "https:" ? "443" : "80") : "");
      const [scope, setScope] = useState(saved && saved.scope || "auth-only");
      const [activate, setActivate] = useState(false);
      const [replacement, setReplacement] = useState("");
      const [message, setMessage] = useState("");
      const [probing, setProbing] = useState(false);
      const probeRef = useRef(0);
      const probeAbort = useRef(null);
      const focusRef = useRef(null);
      useEffect(() => {
        focusRef.current && focusRef.current.focus();
        return () => { probeRef.current++; if (probeAbort.current) probeAbort.current.abort(); };
      }, []);
      useEffect(() => { probeRef.current++; if (probeAbort.current) probeAbort.current.abort(); setProbing(false); setMessage(""); }, [enabled, protocol, host, port, scope]);
      function policy() {
        if (!enabled) return { enabled: false, url: null, scope };
        if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !host || /[\s/@?#]/.test(host)) throw new Error("proxy");
        const url = new URL(`${protocol}://${host}:${port}`);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("proxy");
        return { enabled: true, url: url.origin, scope };
      }
      async function probe() {
        let proxy;
        try { proxy = policy(); } catch (_) { setMessage(tr("proxyInvalid")); return; }
        const seq = ++probeRef.current;
        const controller = new AbortController(); probeAbort.current = controller;
        setProbing(true); setMessage("");
        try {
          const result = await request("/proxy/test", { method: "POST", body: JSON.stringify({ url: proxy.url }), signal: controller.signal });
          if (seq === probeRef.current) setMessage(tr(result.reachable ? "probeOK" : "probeFailed"));
        } catch (_) { if (seq === probeRef.current) setMessage(tr("probeFailed")); }
        finally { if (seq === probeRef.current) setProbing(false); }
      }
      const h = React.createElement;
      const removing = editor.kind === "remove";
      const needsReplacement = removing && editor.account.active && accounts.length > 1;
      return h("form", { className: "dsha-quota-group", "aria-label": tr(removing ? "remove" : editor.kind === "add" ? "addAccount" : "proxy"), onSubmit: (event) => {
        event.preventDefault();
        try { onSubmit(removing ? { replacementAccountId: replacement || undefined } : { proxy: policy(), activate }); }
        catch (_) { setMessage(tr("proxyInvalid")); }
      } },
        h("h3", { tabIndex: -1, ref: focusRef }, tr(removing ? "remove" : editor.kind === "add" ? "addAccount" : "proxy"), editor.account ? ` — ${editor.account.label || editor.account.email}` : ""),
        removing ? h("div", null,
          h("p", null, tr("confirmRemove", { account: editor.account.label || editor.account.email })),
          needsReplacement ? h("label", null, tr("replacement"), h("select", { required: true, value: replacement, disabled: busy, onChange: (e) => setReplacement(e.target.value) },
            h("option", { value: "" }, tr("chooseReplacement")), accounts.filter((a) => a.id !== editor.account.id).map((a) => h("option", { key: a.id, value: a.id }, a.label || a.email)))) : accounts.length === 1 ? h("p", null, tr("removeLast")) : null,
        ) : h("fieldset", { disabled: busy, style: { border: 0, padding: 0, minWidth: 0 } },
          h("label", null, h("input", { type: "checkbox", checked: enabled, onChange: (e) => setEnabled(e.target.checked) }), " ", tr("customProxy")),
          h("p", { className: "dsha-note" }, tr("proxyOff")),
          enabled ? h("div", { className: "dsha-actions", style: { justifyContent: "flex-start" } },
            h("label", null, tr("protocol"), " ", h("select", { value: protocol, onChange: (e) => setProtocol(e.target.value) }, h("option", { value: "http" }, "HTTP"), h("option", { value: "https" }, "HTTPS"))),
            h("label", null, tr("host"), " ", h("input", { value: host, onChange: (e) => setHost(e.target.value), autoComplete: "off", spellCheck: false, style: { maxWidth: "180px" } })),
            h("label", null, tr("port"), " ", h("input", { value: port, inputMode: "numeric", onChange: (e) => setPort(e.target.value), style: { width: "75px" } })),
            h("label", null, tr("scope"), " ", h("select", { value: scope, onChange: (e) => setScope(e.target.value) }, h("option", { value: "auth-only" }, tr("authOnly")), h("option", { value: "all-account" }, tr("allAccount")))),
            h("button", { type: "button", className: "dsha-btn", disabled: probing, onClick: probe }, tr("testProxy")),
          ) : null,
          h("p", { className: "dsha-note" }, tr("scopeNote")), h("p", { className: "dsha-note" }, tr("browserProxy")),
          editor.kind === "add" ? h("div", null, h("label", null, h("input", { type: "checkbox", checked: activate, onChange: (e) => setActivate(e.target.checked) }), " ", tr("makeActive")), h("p", { className: "dsha-note" }, tr("firstActive"))) : null,
        ),
        message ? h("p", { role: "status" }, message) : null,
        h("div", { className: "dsha-actions" }, h("button", { type: "button", className: "dsha-btn", disabled: busy, onClick: onClose }, tr("cancel")), h("button", { type: "submit", className: "dsha-btn dsha-btn-primary", disabled: busy || (needsReplacement && !replacement) }, tr(removing ? "remove" : editor.kind === "add" ? "login" : "save"))),
      );
    }

    function AntigravitySettings({ ctx }) {
      const [, setLocaleRev] = useState(0);
      useEffect(() => {
        if (!ctx || !ctx.locale || typeof ctx.locale.subscribe !== "function") return;
        return ctx.locale.subscribe(() => {
          setLocaleRev((r) => r + 1);
        });
      }, [ctx]);

      const tr = useMemo(() => createTranslator(ctx), [ctx]);

      const [status, setStatus] = useState({ loading: true });
      const [quota, setQuota] = useState(undefined);
      const [modelConfig, setModelConfig] = useState(undefined);
      const [busy, setBusy] = useState(false);
      const [modelBusy, setModelBusy] = useState(false);
      const [error, setError] = useState("");
      const [editor, setEditor] = useState(null);
      const [loginLink, setLoginLink] = useState(null);
      const live = useRef(false);
      const stateRef = useRef({});
      const reads = useRef(new Set());
      const statusSeq = useRef(0);
      const quotaSeq = useRef(0);
      const modelSeq = useRef(0);
      const mutationLock = useRef(false);
      const pollInFlight = useRef(false);
      const opener = useRef(null);
      const trRef = useRef(tr); trRef.current = tr;
      const request = useCallback(async (path, options) => {
        const controller = new AbortController();
        reads.current.add(controller);
        const outer = options && options.signal;
        const abort = () => controller.abort();
        if (outer) { if (outer.aborted) abort(); else outer.addEventListener("abort", abort, { once: true }); }
        try { return await api(path, { ...options, signal: controller.signal }); }
        finally { reads.current.delete(controller); if (outer) outer.removeEventListener("abort", abort); }
      }, []);
      const invalidateReads = useCallback(() => {
        statusSeq.current++; quotaSeq.current++; modelSeq.current++;
        for (const controller of reads.current) controller.abort();
      }, []);
      const applyStatus = useCallback((value) => {
        if (!live.current || !value || (Number.isFinite(stateRef.current.revision) && value.revision < stateRef.current.revision)) return;
        const changed = stateRef.current.activeAccountId !== value.activeAccountId || stateRef.current.revision !== value.revision;
        if (changed) { quotaSeq.current++; modelSeq.current++; setQuota(undefined); setModelConfig(undefined); }
        stateRef.current = value;
        setStatus({ ...value, loading: false });
        if (value.quota && value.quota.accountId === value.activeAccountId) setQuota(value.quota);
        else if (!value.activeAccountId) setQuota(undefined);
        if (value.models) setModelConfig(value.models);
        if (!value.login || ["complete", "error", "cancelled", "canceled", "expired", "idle"].includes(value.login.status)) setLoginLink(null);
      }, []);
      const refreshStatus = useCallback(async () => {
        const seq = ++statusSeq.current;
        const accountId = stateRef.current.activeAccountId;
        const value = await request("/status");
        if (!live.current || seq !== statusSeq.current || accountId !== stateRef.current.activeAccountId) return null;
        applyStatus(value); return value;
      }, [request, applyStatus]);
      const refreshQuota = useCallback(async (preserveError = false) => {
        if (mutationLock.current) return;
        const accountId = stateRef.current.activeAccountId;
        if (!accountId) return;
        const seq = ++quotaSeq.current;
        const revision = stateRef.current.revision;
        setBusy(true); setError("");
        try {
          const value = await request("/quota", { method: "POST", body: JSON.stringify({ accountId }) });
          if (live.current && seq === quotaSeq.current && accountId === stateRef.current.activeAccountId && revision === stateRef.current.revision && value.accountId === accountId) {
            setQuota(value); if (value.models) setModelConfig(value.models);
          }
        } catch (_) { if (live.current && seq === quotaSeq.current) setError(trRef.current("requestFailed")); }
        finally { if (live.current && !mutationLock.current) setBusy(false); }
      }, [request]);
      useEffect(() => {
        live.current = true;
        void refreshStatus().catch(() => {
          if (live.current) { setStatus({ loading: false }); setError(trRef.current("requestFailed")); }
        });
        return () => { live.current = false; invalidateReads(); };
      }, [refreshStatus, invalidateReads]);
      useEffect(() => {
        if (status.activeAccountId) void refreshQuota();
      }, [status.activeAccountId, status.revision, refreshQuota]);
      const flow = status.login;
      const flowPending = !!(flow && flow.flowId && !["idle", "complete", "error", "cancelled", "canceled", "expired"].includes(flow.status));
      useEffect(() => {
        if (!flowPending || busy) return;
        let disposed = false;
        let timer;
        const poll = async () => {
          if (!pollInFlight.current) {
            pollInFlight.current = true;
            try { await refreshStatus(); }
            catch (_) { if (!disposed && live.current) setError(trRef.current("requestFailed")); }
            finally { pollInFlight.current = false; }
          }
          if (!disposed) timer = window.setTimeout(poll, 2000);
        };
        timer = window.setTimeout(poll, 2000);
        return () => { disposed = true; window.clearTimeout(timer); };
      }, [flowPending, flow && flow.flowId, busy, refreshStatus]);
      function closeEditor() {
        setEditor(null);
        if (opener.current && opener.current.isConnected) opener.current.focus();
      }
      function openEditor(kind, account, event) {
        opener.current = event.currentTarget;
        setEditor({ kind, account, revision: stateRef.current.revision });
      }
      const mutate = useCallback(async (path, payload) => {
        if (mutationLock.current) return;
        mutationLock.current = true;
        invalidateReads(); setBusy(true); setError(""); setQuota(undefined);
        let succeeded = false;
        try {
          const value = await request(path, { method: "POST", body: JSON.stringify(payload || {}) });
          if (!live.current) return;
          if (path === "/login") {
            setLoginLink(value.authUrl ? { url: value.authUrl, flowId: value.flowId } : null);
            applyStatus({ ...stateRef.current, login: { status: value.status || "pending", flowId: value.flowId } });
            if (value.authUrl) window.open(value.authUrl, "_blank", "noopener,noreferrer");
          } else applyStatus(value);
          succeeded = true;
        } catch (_) { if (live.current) setError(trRef.current("uncertain")); }
        finally {
          if (live.current) {
            try { await refreshStatus(); } catch (_) { if (live.current) setError(trRef.current("uncertain")); }
          }
          mutationLock.current = false;
          if (live.current) { setBusy(false); if (succeeded) void refreshQuota(); }
        }
        return succeeded;
      }, [request, invalidateReads, applyStatus, refreshStatus, refreshQuota]);
      function startLogin(payload) { return mutate("/login", payload); }
      function logout() {
        if (window.confirm(tr("confirmLogout"))) void mutate("/logout", {});
      }
      async function submitEditor(value) {
        const account = editor.account;
        const expectedRevision = editor.revision;
        const ok = editor.kind === "add" ? await startLogin(value)
          : editor.kind === "proxy" ? await mutate("/accounts/proxy", { accountId: account.id, proxy: value.proxy, expectedRevision })
          : await mutate("/accounts/remove", { accountId: account.id, ...value, expectedRevision });
        if (ok && live.current) closeEditor();
      }

      const saveModels = useCallback(async (enabledModelIds) => {
        if (mutationLock.current) return;
        mutationLock.current = true;
        const seq = ++modelSeq.current;
        const accountId = stateRef.current.activeAccountId;
        setModelBusy(true); setError("");
        try {
          const value = await request("/models", { method: "POST", body: JSON.stringify({ enabledModelIds }) });
          if (live.current && seq === modelSeq.current && accountId === stateRef.current.activeAccountId) setModelConfig(value);
        } catch (_) {
          if (live.current) {
            setError(trRef.current("uncertain"));
            try { await refreshStatus(); } catch (_) {}
          }
        } finally {
          mutationLock.current = false;
          if (live.current) setModelBusy(false);
        }
      }, [request, refreshStatus]);

      const toggleModel = useCallback((modelId, enabled) => {
        const current = new Set(modelConfig && Array.isArray(modelConfig.enabledModelIds) ? modelConfig.enabledModelIds : []);
        if (enabled) current.add(modelId);
        else current.delete(modelId);
        void saveModels([...current]);
      }, [modelConfig, saveModels]);

      const setAllModels = useCallback((enabled) => {
        const ids = enabled && modelConfig && Array.isArray(modelConfig.options)
          ? modelConfig.options.map((option) => option.id)
          : [];
        void saveModels(ids);
      }, [modelConfig, saveModels]);

      const quotaGroups = useMemo(() => {
        if (!quota) return [];
        if (Array.isArray(quota.groups) && quota.groups.length > 0) {
          return quota.groups;
        }
        if (Array.isArray(quota.bucketRows) && quota.bucketRows.length > 0) {
          const map = new Map();
          for (const b of quota.bucketRows) {
            const grp = b.group || "Quota";
            if (!map.has(grp)) map.set(grp, []);
            map.get(grp).push(b);
          }
          return [...map.entries()].map(([displayName, buckets]) => ({ displayName, buckets }));
        }
        return [];
      }, [quota]);

      const fallbackModelRows = useMemo(() => {
        if (quotaGroups.length > 0) return [];
        if (!quota || !Array.isArray(quota.modelRows)) return [];
        return quota.modelRows.filter((row) => typeof row.remainingFraction === "number");
      }, [quota, quotaGroups]);

      const modelOptions = useMemo(() => {
        const options = modelConfig && Array.isArray(modelConfig.options) ? modelConfig.options : [];
        return [...options].sort(compareAntigravityModelOptions);
      }, [modelConfig]);
      const plan = quota && quota.planLabel ? quota.planLabel : "";
      const isPro = /pro|paid|plus/i.test(plan);
      const email = status.email || (status.loading ? tr("loading") : tr("notSignedIn"));

      return React.createElement("div", { className: "dsha-wrap" },
        React.createElement("div", { className: "dsha-page-head" },
          React.createElement(AntigravityIcon, { size: 24, className: "dsha-brand-icon" }),
          React.createElement("h2", { className: "dsha-page-title" }, "Antigravity"),
        ),
        React.createElement("p", { className: "dsha-page-desc" }, tr("pageDesc")),
        React.createElement("section", { className: "dsha-card" },
          React.createElement("div", { className: "dsha-head" },
            React.createElement("div", { className: "dsha-title" },
              React.createElement(AntigravityIcon, { size: 18, className: "dsha-brand-icon" }),
              React.createElement("span", null, tr("currentAccount")),
            ),
            React.createElement("div", { className: "dsha-actions" },
              React.createElement("button", { className: "dsha-btn dsha-btn-primary", disabled: status.loading || busy || modelBusy || flowPending, onClick: (event) => openEditor("add", null, event) }, tr("addAccount")),
              React.createElement("button", { className: "dsha-btn", disabled: busy || modelBusy, onClick: () => { void refreshStatus().catch(() => { if (live.current) setError(tr("requestFailed")); }); } }, tr("refreshState")),
              status.authenticated && React.createElement("button", { className: "dsha-btn dsha-btn-primary", disabled: busy || modelBusy, onClick: refreshQuota }, busy ? tr("refreshing") : tr("refresh")),
              (status.accounts || []).length > 0 && React.createElement("button", { className: "dsha-btn", disabled: busy || modelBusy, onClick: logout }, tr("logoutAll")),
            ),
          ),
          React.createElement("p", { className: "dsha-note" }, tr("globalSelection")),
          React.createElement("div", { role: "group", "aria-label": tr("accounts") }, (status.accounts || []).map((account) => {
            const active = account.id === status.activeAccountId;
            const proxy = account.proxy || {};
            return React.createElement("div", { key: account.id, className: "dsha-quota-group" },
              React.createElement("div", { className: "dsha-head" },
                React.createElement("div", { className: "dsha-email" }, account.label || account.email || account.id,
                  active ? React.createElement("span", { className: "dsha-badge" }, tr("active")) : null),
                React.createElement("button", { className: "dsha-btn", disabled: active || busy || modelBusy, "aria-pressed": active, onClick: () => { closeEditor(); void mutate("/accounts/activate", { accountId: account.id, expectedRevision: stateRef.current.revision }); } }, tr("useAccount"))),
              account.label && account.email ? React.createElement("div", { className: "dsha-note" }, account.email) : null,
              React.createElement("p", { className: "dsha-note" }, Number.isFinite(account.expires) ? (account.expires <= Date.now() ? tr("expired") : tr("expiresAt", { time: new Date(account.expires).toLocaleString() })) : tr("reauth")),
              React.createElement("p", { className: "dsha-note" }, proxy.enabled ? `${tr("proxy")}: ${proxy.url || ""} · ${tr(proxy.scope === "all-account" ? "allAccount" : "authOnly")}` : tr("proxyOff")),
              React.createElement("div", { className: "dsha-actions" },
                React.createElement("button", { className: "dsha-btn", disabled: busy || modelBusy || flowPending, onClick: () => { closeEditor(); void startLogin({ accountId: account.id }); } }, tr("reauth")),
                React.createElement("button", { className: "dsha-btn", disabled: busy || modelBusy, onClick: (event) => openEditor("proxy", account, event) }, tr("proxy")),
                React.createElement("button", { className: "dsha-btn", disabled: busy || modelBusy, onClick: (event) => openEditor("remove", { ...account, active }, event) }, tr("remove"))),
            );
          })),
          editor ? React.createElement(AccountEditor, { key: `${editor.kind}:${editor.account ? editor.account.id : "new"}`, editor, accounts: status.accounts || [], busy: busy || modelBusy, tr, onSubmit: submitEditor, onClose: closeEditor, request }) : null,
          flowPending ? React.createElement("div", { className: "dsha-empty", role: "status" }, tr("loginPending"),
            loginLink && loginLink.flowId === flow.flowId ? React.createElement("a", { href: loginLink.url, target: "_blank", rel: "noopener noreferrer", className: "dsha-btn" }, tr("openLogin")) : null,
            React.createElement("button", { className: "dsha-btn", disabled: busy || modelBusy, onClick: () => { void mutate("/login/cancel", { flowId: flow.flowId }); } }, tr("cancelLogin")),
            React.createElement("p", { className: "dsha-note" }, tr("browserProxy"))) : null,
          flow && ["error", "expired", "complete", "cancelled", "canceled"].includes(flow.status) ? React.createElement("p", { role: "status", className: "dsha-note" }, tr(flow.status === "complete" ? "loginComplete" : ["cancelled", "canceled"].includes(flow.status) ? "loginCancelled" : "loginError")) : null,
          React.createElement("div", { className: "dsha-account" },
            React.createElement("div", { className: "dsha-email" },
              React.createElement("span", { className: "dsha-email-mark", "aria-hidden": "true" }),
              React.createElement("span", { className: "dsha-email-text" }, email),
            ),
            isPro && React.createElement("span", { className: "dsha-badge" },
              React.createElement("span", { className: "dsha-diamond", "aria-hidden": "true" }),
              "PRO",
            ),
          ),
          !status.authenticated && React.createElement("div", { className: "dsha-empty" }, tr("notSignedInDesc")),
          status.authenticated && !quota && React.createElement("div", { className: "dsha-empty" }, busy ? tr("fetchingQuota") : tr("noQuotaDesc")),
          status.authenticated && (quotaGroups.length > 0 || fallbackModelRows.length > 0) && React.createElement("div", { className: "dsha-quota-title" }, tr("quota")),
          status.authenticated && quotaGroups.map((group, index) => {
            const isCyan = /claude|gpt|3p|openai|anthropic/i.test(`${group.displayName || ""} ${group.description || ""}`);
            return React.createElement(QuotaGroup, {
              key: group.displayName || index,
              group,
              accent: isCyan ? "cyan" : "green",
              t: tr,
            });
          }),
          status.authenticated && quotaGroups.length === 0 && fallbackModelRows.map((row, index) => {
            const isCyan = /claude|gpt|3p|openai|anthropic/i.test(`${row.id || ""} ${row.label || ""}`);
            return React.createElement(QuotaRow, {
              key: row.id || row.label || index,
              row,
              accent: isCyan ? "cyan" : "green",
              t: tr,
            });
          }),
          error && React.createElement("div", { className: "dsha-error" }, error),
          quota && React.createElement("div", { className: "dsha-note" },
            tr("updatedAt", { time: new Date(quota.fetchedAt).toLocaleString() }),
          ),
        ),
        status.authenticated && React.createElement("section", { className: "dsha-card dsha-model-card" },
          React.createElement("div", { className: "dsha-model-head" },
            React.createElement("div", null,
              React.createElement("div", { className: "dsha-model-title" }, tr("modelSelector")),
              React.createElement("div", { className: "dsha-model-desc" }, tr("modelSelectorDesc")),
            ),
            React.createElement("div", { className: "dsha-mini-actions" },
              React.createElement("button", { className: "dsha-mini-btn", disabled: modelBusy, onClick: () => setAllModels(true) }, tr("selectAll")),
              React.createElement("button", { className: "dsha-mini-btn", disabled: modelBusy, onClick: () => setAllModels(false) }, tr("unselectAll")),
            ),
          ),
          modelOptions.length === 0
            ? React.createElement("div", { className: "dsha-empty" }, tr("loadingModels"))
            : React.createElement("div", { className: "dsha-model-list" },
                modelOptions.map((option) => React.createElement(ModelOptionRow, {
                  key: option.id,
                  option,
                  disabled: modelBusy,
                  onToggle: toggleModel,
                  t: tr,
                })),
              ),
          React.createElement("div", { className: "dsha-note" }, tr("modelSelectorNote")),
        ),
      );
    }

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        installStyle();
        ctx.effect(() => initNavObserver());
        if (ctx.locale && typeof ctx.locale.register === "function") {
          ctx.locale.register(NS, { zh, en });
        }
        ctx.slots.inject("settings.section", () => ctx.slots.register({
          name: "settings.section",
          id: "antigravity",
          order: 12,
          label: () => "Antigravity",
        }, (props) => React.createElement(AntigravitySettings, { ...props, ctx })));
      },
    };
  },
});
