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
      quotaUnavailable: "此账号暂无 quota 数据。",
      quotaStale: "刷新失败，以下是上次成功获取的 quota。",
      remainingLabel: "{percent}% 剩余",
      fetchingQuota: "正在获取 quota...",
      quota: "额度",
      resetPrefix: "将在 {time} 后刷新",
      resetUnavailable: "刷新时间不可用",
      resetNowLabel: "现在刷新",
      notApplicable: "不适用",
      notEnforced: "当前未生效",
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
      quotaUnavailable: "Quota unavailable for this account.",
      quotaStale: "Refresh failed; showing the last successful quota.",
      remainingLabel: "{percent}% remaining",
      fetchingQuota: "Fetching quota data...",
      quota: "Quota",
      resetPrefix: "Refreshes in {time}",
      resetUnavailable: "Refresh time unavailable",
      resetNowLabel: "Refreshes now",
      notApplicable: "N/A",
      notEnforced: "Not currently enforced",
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
      accounts: "Accounts", manage: "Manage", addAccount: "Add account", active: "Active", useAccount: "Use account",
      globalSelection: "Selection is shared across DSH sessions. New requests use this account; requests already running keep their account and route.",
      reauth: "Reauthenticate", remove: "Remove account", logoutAll: "Sign out all accounts",
      confirmLogout: "Sign out ALL saved Antigravity accounts? This removes all saved credentials and migration backups.",
      confirmRemove: "Remove {account}? Saved credentials and migration backups will be deleted.",
      replacement: "Replacement active account (required)", chooseReplacement: "Choose an account", removeLast: "Removing the last account signs out.",
      makeActive: "Make active after login", firstActive: "The first account becomes active automatically.",
      proxy: "Proxy", customProxy: "Use custom proxy", proxyOff: "Default route", proxyEnabled: "Proxy enabled",
      browserProxy: "Google sign-in in your browser is NOT proxied by this setting. Configure the browser separately; the callback stays local.",
      authOnly: "Authentication only", allAccount: "All account traffic", scope: "Routing scope",
      scopeNote: "Authentication only covers server-side login/refresh/identity/project discovery. Model, quota and search use DSH defaults. All account traffic is recommended for one VPN exit. Covered proxy failures never fall back to defaults.",
      protocol: "Protocol", host: "Host", port: "Port", testProxy: "Test connection", probeOK: "Proxy reachable. This does not verify VPN egress or account authorization.",
      probeFailed: "Proxy is not reachable.", proxyInvalid: "Enter an HTTP(S) host and port (1–65535), without credentials, paths, query or fragment.",
      save: "Save", cancel: "Cancel", cancelLogin: "Cancel login", openLogin: "Open Google sign-in", copyLogin: "Copy URL", copiedLogin: "Copied", loginPending: "Waiting for Google sign-in…",
      uncertain: "Request failed or timed out; outcome may be unconfirmed. Reloading authoritative state. Do not assume it was rolled back.",
      requestFailed: "Request failed. Refresh status and try again.", refreshState: "Refresh status", ready: "Ready", needsSignIn: "Needs sign-in", expired: "Needs sign-in",
      loginComplete: "Login complete.", loginCancelled: "Login cancelled.", loginError: "Login failed or expired. Try again.",
    });
    Object.assign(zh, {
      accounts: "账号", manage: "管理", addAccount: "添加账号", active: "当前启用", useAccount: "使用此账号",
      globalSelection: "账号选择由所有 DSH 会话共享。新请求使用所选账号；进行中的请求保留原账号和路由。",
      reauth: "重新认证", remove: "移除账号", logoutAll: "退出所有账号",
      confirmLogout: "确定退出所有已保存的 Antigravity 账号？将删除所有凭据和迁移备份。",
      confirmRemove: "确定移除 {account}？将删除其凭据和迁移备份。",
      replacement: "替代的启用账号（必选）", chooseReplacement: "请选择账号", removeLast: "移除最后一个账号后将退出登录。",
      makeActive: "登录后设为启用账号", firstActive: "第一个账号将自动启用。",
      proxy: "代理", customProxy: "使用自定义代理", proxyOff: "默认路由", proxyEnabled: "代理已启用",
      browserProxy: "此设置不会代理浏览器中的 Google 登录页面。请单独配置浏览器代理；回调必须保持本地连接。",
      authOnly: "仅认证", allAccount: "所有账号流量", scope: "路由范围",
      scopeNote: "仅认证涵盖服务端登录、刷新、身份查询和登录时项目发现；模型、额度和搜索使用 DSH 默认设置。若需统一 VPN 出口，建议选择所有账号流量。代理失败时，覆盖的请求不会回退到默认路由。",
      protocol: "协议", host: "主机", port: "端口", testProxy: "测试连接", probeOK: "代理可达。这不代表已验证 VPN 出口或账号授权。",
      probeFailed: "代理不可达。", proxyInvalid: "请输入 HTTP(S) 主机和端口（1–65535），不得包含凭据、路径、查询或片段。",
      save: "保存", cancel: "取消", cancelLogin: "取消登录", openLogin: "打开 Google 登录", copyLogin: "复制链接", copiedLogin: "已复制", loginPending: "等待 Google 登录…",
      uncertain: "请求失败或超时，结果可能尚未确认。正在重新获取权威状态，请勿认为操作已回滚。",
      requestFailed: "请求失败，请刷新状态后重试。", refreshState: "刷新状态", ready: "正常", needsSignIn: "需要登录", expired: "需要登录",
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
      try {
        const spans = document.querySelectorAll("span");
        for (const span of spans) {
          if (!span.textContent || span.textContent.trim() !== "Antigravity") continue;
          const btn = span.closest("button");
          const svg = btn && btn.querySelector("svg");
          if (!svg) continue;
          svg.setAttribute("viewBox", "0 0 110 113");
          svg.setAttribute("width", "16");
          svg.setAttribute("height", "16");
          svg.setAttribute("fill", "none");
          const path = svg.querySelector("path");
          if (!path || path.getAttribute("d") !== ANTIGRAVITY_SVG_PATH) {
            // The settings shell may replace this button during navigation. Reapply
            // only when the path is actually different to avoid mutation loops.
            svg.innerHTML = `<path d="${ANTIGRAVITY_SVG_PATH}" fill="currentColor"/>`;
          }
        }
      } catch (_) {
        // Navigation can transiently detach the settings tree; retry below.
      }
    }

    function initNavObserver() {
      patchNavIcon();
      const root = document.documentElement || document.body;
      if (!root) return () => {};
      const observer = new MutationObserver(() => patchNavIcon());
      observer.observe(root, { childList: true, subtree: true });
      // Some shell navigations replace the observer's observed root. The bounded
      // retry keeps the tab icon present without touching session state or polling APIs.
      const timer = window.setInterval(patchNavIcon, 1000);
      return () => { observer.disconnect(); window.clearInterval(timer); };
    }

    function installStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
.dsha-wrap{box-sizing:border-box;width:100%;max-width:820px;padding:4px 0 28px;color:#111827}
.dsha-page-head{display:flex;align-items:center;gap:10px}
.dsha-brand-icon{color:#111827;flex-shrink:0}
.dsha-page-title{margin:0;color:#111827;font-size:20px;font-weight:700;line-height:28px}
.dsha-page-desc{margin:7px 0 20px;color:#6b7280;font-size:13px;line-height:20px}
.dsha-card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:18px;box-shadow:0 2px 8px rgba(17,24,39,.035)}
.dsha-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
.dsha-title{display:flex;align-items:center;gap:9px;font-size:15px;font-weight:750;color:#111827}
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
.dsha-quota-title{margin:20px 0 8px;color:#111827;font-size:14px;font-weight:750}
.dsha-quota-group{margin-top:10px;padding:14px 16px;background:#fbfcfe;border:1px solid #e6ebf1;border-radius:11px}
.dsha-group-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.dsha-group-title{font-size:13px;font-weight:700;color:#111827;text-transform:uppercase;letter-spacing:.03em}
.dsha-group-desc{font-size:12px;color:#8b93a1}
.dsha-row{padding:10px 0;border-top:1px solid #e9eef4}
.dsha-row:first-of-type{border-top:0;padding-top:0}
.dsha-rowtop{display:flex;align-items:baseline;justify-content:space-between;gap:12px;color:#4b5563;font-weight:600;font-size:13px}
.dsha-percent{font-size:13px;font-weight:750;color:#059669}
.dsha-rowbottom{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-top:6px;color:#8b93a1;font-size:12px;line-height:17px}
.dsha-remaining{font-weight:650;color:#4b5563}.dsha-reset{white-space:nowrap;text-align:right}
.dsha-row-off .dsha-remaining{font-weight:600;color:#8b93a1}
.dsha-percent-off{color:#9aa3b0;font-weight:650}
.dsha-rowdesc{margin-top:5px;color:#9aa3b0;font-size:12px;line-height:17px}
.dsha-percent-cyan{color:#0284c7}
.dsha-bar{height:7px;margin-top:7px;border-radius:999px;background:#e9eef4;overflow:hidden}
.dsha-fill{height:100%;border-radius:999px;background:#10b981}
.dsha-fill-cyan{background:#06b6d4}
.dsha-empty{border:1px dashed #d8dee8;border-radius:10px;padding:14px;color:#747f90;background:#fafbfc;font-size:13px;line-height:20px}
.dsha-error{margin-top:12px;color:#991b1b;background:#fff5f5;border:1px solid #fecaca;border-radius:10px;padding:10px 12px;font-size:13px;white-space:pre-wrap}
.dsha-note{margin-top:12px;color:#8b93a1;font-size:12px;line-height:18px}
.dsha-login-url{display:block;flex:1 1 100%;min-width:0;max-height:96px;overflow:auto;overflow-wrap:anywhere;word-break:break-word;padding:8px 0;color:#747f90;font-size:12px;line-height:18px}
.dsha-input{box-sizing:border-box;flex:1 1 100%;min-width:0;width:100%;border:1px solid #d7dce3;border-radius:10px;padding:8px 10px;color:#111827;background:#fff;font-size:13px;line-height:18px}
.dsha-account-card{display:flex;flex-direction:column}
.dsha-account-card>.dsha-head,.dsha-account-card>.dsha-note,.dsha-account-card>.dsha-account{order:0}
.dsha-account-card>.dsha-account-list{order:1;display:flex;flex-direction:column;gap:8px}
.dsha-account-card>.dsha-account-list>.dsha-account-row{margin:0}
.dsha-account-card>.dsha-login-flow{order:1}
.dsha-account-quota{margin-top:14px;padding-top:12px;border-top:1px solid #e6ebf1}.dsha-account-quota .dsha-quota-title{margin:0 0 8px}.dsha-account-quota .dsha-quota-group{margin-top:8px}.dsha-account-selected{display:inline-flex;align-items:center;border-radius:999px;padding:6px 10px;background:#eef2f1;color:#087f5b;font-size:12px;font-weight:750}.dsha-manage{position:relative}.dsha-manage>summary{list-style:none}.dsha-manage>summary::-webkit-details-marker{display:none}.dsha-manage[open]>summary{background:#f3f4f6}.dsha-manage-menu{position:absolute;z-index:5;left:0;right:auto;top:calc(100% + 5px);display:flex;gap:6px;padding:7px;background:#fff;border:1px solid #d7dce3;border-radius:10px;box-shadow:0 8px 24px rgba(17,24,39,.12);white-space:nowrap;max-width:calc(100vw - 32px);overflow-x:auto}.dsha-manage-menu .dsha-btn{padding:6px 9px;font-size:12px}@media (max-width:640px){.dsha-manage-menu{left:auto;right:0;white-space:normal;flex-wrap:wrap}.dsha-manage-menu .dsha-btn{flex:1 1 auto}}
.dsha-account-card>.dsha-error{order:4}
.dsha-account-list .dsha-head{margin-bottom:7px}
.dsha-account-list .dsha-actions{justify-content:flex-start;margin-top:8px}
.dsha-account-list .dsha-note{margin-top:5px}
.dsha-account-row{display:grid;grid-template-columns:minmax(0,1fr);gap:9px;padding:12px 14px;border:1px solid #e7ebf1;border-radius:11px;background:#fff;min-width:0}.dsha-account-main{min-width:0}.dsha-account-name{display:flex;align-items:center;gap:8px;min-width:0;font-size:14px;font-weight:750;color:#111827}.dsha-account-name:first-letter{font-weight:800}.dsha-account-email,.dsha-account-route,.dsha-account-health{display:inline-block;margin:4px 12px 0 0;color:#8b93a1;font-size:12px;line-height:17px;overflow-wrap:anywhere}.dsha-account-health.ready{color:#059669}.dsha-account-health.needs{color:#b45309}.dsha-account-route.enabled{color:#2563eb}.dsha-account-route.off{color:#8b93a1}.dsha-account-actions{display:flex;align-items:center;justify-content:flex-start;gap:6px;flex-wrap:wrap}.dsha-account-actions .dsha-btn{padding:6px 10px;font-size:12px}.dsha-btn-danger{color:#b42318}@media (max-width:640px){.dsha-account-actions .dsha-btn{flex:1 1 auto}}
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
      const numeric = typeof resetTime === "number" ? resetTime : (/^\d+$/.test(String(resetTime)) ? Number(resetTime) : NaN);
      const timestamp = Number.isFinite(numeric) ? (numeric < 1e12 ? numeric * 1000 : numeric) : Date.parse(String(resetTime));
      if (!Number.isFinite(timestamp)) return resetTime;
      const delta = timestamp - Date.now();
      if (delta <= 0) return t ? t("resetNow") : "now";
      const totalMinutes = Math.max(1, Math.ceil(delta / 60000));
      const days = Math.floor(totalMinutes / (60 * 24));
      const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
      const minutes = totalMinutes % 60;
      if (days > 0) return t ? t("timeDayHour", { days, hours }) : `${days}d ${hours}h`;
      if (hours > 0) return t ? t("timeHourMin", { hours, minutes }) : `${hours}h ${minutes}m`;
      return t ? t("timeMin", { minutes }) : `${minutes}m`;
    }

    function resetText(row, t) {
      if (row && row.resetTime) {
        const time = formatReset(row.resetTime, t);
        const now = t ? t("resetNow") : "now";
        return time === now ? (t ? t("resetNowLabel") : "Refreshes now") : (t ? t("resetPrefix", { time }) : `Refreshes in ${time}`);
      }
      if (row && row.resetLabel) return t ? t("resetPrefix", { time: row.resetLabel }) : `Refreshes in ${row.resetLabel}`;
      return t ? t("resetUnavailable") : "Refresh time unavailable";
    }

    function percentOf(row) {
      if (typeof row.remainingFraction === "number" && Number.isFinite(row.remainingFraction)) return Math.round(row.remainingFraction * 10000) / 100;
      if (typeof row.remainingPercent === "number" && Number.isFinite(row.remainingPercent)) return row.remainingPercent;
      return undefined;
    }

    function percentText(percent) {
      if (typeof percent !== "number" || !Number.isFinite(percent)) return "?";
      return Number.isInteger(percent) ? String(percent) : percent.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
    }

    function QuotaRow({ row, accent, t }) {
      const disabled = Boolean(row && row.disabled === true);
      const percent = percentOf(row);
      const knownPercent = typeof percent === "number" && Number.isFinite(percent);
      const width = knownPercent ? Math.max(0, Math.min(100, percent)) : 0;
      const wholePercent = knownPercent ? Math.floor(percent) : "?";
      const preciseLabel = disabled
        ? (t ? t("notApplicable") : "N/A")
        : knownPercent ? `${percentText(percent)}%` : "—";
      return React.createElement("div", { className: `dsha-row${disabled ? " dsha-row-off" : ""}` },
        React.createElement("div", { className: "dsha-rowtop" },
          React.createElement("div", null, row.label || row.displayName || row.id || (t ? t("quota") : "Quota")),
          React.createElement("span", { className: `dsha-percent${disabled ? " dsha-percent-off" : accent === "cyan" ? " dsha-percent-cyan" : ""}` }, preciseLabel),
        ),
        disabled ? null : React.createElement("div", { className: "dsha-bar", "aria-label": preciseLabel },
          React.createElement("div", {
            className: `dsha-fill${accent === "cyan" ? " dsha-fill-cyan" : ""}`,
            style: { width: `${width}%` },
          }),
        ),
        React.createElement("div", { className: "dsha-rowbottom" },
          React.createElement("span", { className: "dsha-remaining" }, disabled
            ? (t ? t("notEnforced") : "Not currently enforced")
            : (t ? t("remainingLabel", { percent: wholePercent }) : `${wholePercent}% remaining`)),
          disabled ? null : React.createElement("span", { className: "dsha-reset" }, resetText(row, t)),
        ),
        // Google explains a non-enforced window in the bucket description.
        disabled && row.description ? React.createElement("div", { className: "dsha-rowdesc" }, row.description) : null,
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

    function quotaGroupsOf(quota) {
      if (!quota) return [];
      if (Array.isArray(quota.groups) && quota.groups.length > 0) {
        return quota.groups.filter((group) => Array.isArray(group && group.buckets) && group.buckets.length > 0);
      }
      if (Array.isArray(quota.bucketRows) && quota.bucketRows.length > 0) {
        const map = new Map();
        for (const bucket of quota.bucketRows) {
          const name = bucket.group || "Quota";
          if (!map.has(name)) map.set(name, []);
          map.get(name).push(bucket);
        }
        return [...map.entries()].map(([displayName, buckets]) => ({ displayName, buckets }));
      }
      return [];
    }

    function quotaRowsOf(quota, groups) {
      if (groups.length > 0 || !quota || !Array.isArray(quota.modelRows)) return [];
      return quota.modelRows.filter((row) => typeof row.remainingFraction === "number");
    }

    function QuotaPanel({ quota, state, busy, t }) {
      const groups = quotaGroupsOf(quota);
      const rows = quotaRowsOf(quota, groups);
      const loading = state === "loading" || busy;
      if (!quota && loading) return React.createElement("div", { className: "dsha-empty dsha-quota-empty" }, t("fetchingQuota"));
      if (!quota && state === "error") return React.createElement("div", { className: "dsha-empty dsha-quota-empty dsha-quota-error" }, t("quotaUnavailable"));
      if (!quota) return React.createElement("div", { className: "dsha-empty dsha-quota-empty" }, t("noQuotaDesc"));
      return React.createElement(React.Fragment, null,
        loading && React.createElement("div", { className: "dsha-note", role: "status" }, t("fetchingQuota")),
        state === "error" && React.createElement("div", { className: "dsha-error", role: "status" }, t("quotaStale")),
        groups.length === 0 && rows.length === 0 ? React.createElement("div", { className: "dsha-empty dsha-quota-empty" }, t("noQuotaDesc")) : React.createElement("div", { className: "dsha-quota-title" }, t("quota")),
        groups.map((group, index) => {
          const isCyan = /claude|gpt|3p|openai|anthropic/i.test(`${group.displayName || ""} ${group.description || ""}`);
          return React.createElement(QuotaGroup, { key: group.displayName || index, group, accent: isCyan ? "cyan" : "green", t });
        }),
        groups.length === 0 && rows.map((row, index) => {
          const isCyan = /claude|gpt|3p|openai|anthropic/i.test(`${row.id || ""} ${row.label || ""}`);
          return React.createElement(QuotaRow, { key: row.id || row.label || index, row, accent: isCyan ? "cyan" : "green", t });
        }),
        React.createElement("div", { className: "dsha-note dsha-quota-updated" }, t("updatedAt", { time: new Date(quota.fetchedAt).toLocaleString() })),
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
      const panelRef = useRef(null);
      const [quotaByAccount, setQuotaByAccount] = useState({});
      const [quotaStateByAccount, setQuotaStateByAccount] = useState({});
      const quotaByAccountRef = useRef(quotaByAccount);
      quotaByAccountRef.current = quotaByAccount;
      const commitQuota = useCallback((accountId, value) => {
        const fetchedAt = value?.fetchedAt;
        if (!accountId || typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt) || fetchedAt <= 0) return false;
        const previous = quotaByAccountRef.current[accountId];
        if (Number.isFinite(previous?.fetchedAt) && previous.fetchedAt >= fetchedAt) return false;
        const next = { ...quotaByAccountRef.current, [accountId]: value };
        quotaByAccountRef.current = next;
        setQuotaByAccount(next);
        return true;
      }, []);
      const [modelConfig, setModelConfig] = useState(undefined);
      const [busy, setBusy] = useState(false);
      const [modelBusy, setModelBusy] = useState(false);
      const [error, setError] = useState("");
      const [editor, setEditor] = useState(null);
      const [loginLink, setLoginLink] = useState(null);
      const [loginCopied, setLoginCopied] = useState(false);
      const [callbackUrl, setCallbackUrl] = useState("");
      const live = useRef(false);
      const stateRef = useRef({});
      const reads = useRef(new Set());
      const statusSeq = useRef(0);
      const quotaGeneration = useRef(0);
      const quotaRequestSeq = useRef(new Map());
      const quotaBatchInFlight = useRef(false);
      const quotaBatchPromise = useRef(null);
      const queuedQuotaBatch = useRef(false);
      const queuedQuotaStatus = useRef(false);
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
        statusSeq.current++; quotaGeneration.current++; quotaRequestSeq.current.clear(); modelSeq.current++;
        for (const controller of reads.current) controller.abort();
      }, []);
      const applyStatus = useCallback((value) => {
        if (!live.current || !value || (Number.isFinite(stateRef.current.revision) && value.revision < stateRef.current.revision)) return false;
        const activeChanged = stateRef.current.activeAccountId !== value.activeAccountId;
        const previousAccounts = Array.isArray(stateRef.current.accounts) ? stateRef.current.accounts : [];
        const nextAccounts = Array.isArray(value.accounts) ? value.accounts : [];
        const previousIds = new Set(previousAccounts.map((account) => account.id));
        const nextIds = new Set(nextAccounts.map((account) => account.id));
        const accountsChanged = previousIds.size !== nextIds.size || [...previousIds].some((id) => !nextIds.has(id));
        const revisionChanged = stateRef.current.revision !== value.revision;
        if (activeChanged || accountsChanged || revisionChanged) {
          quotaGeneration.current++;
          quotaRequestSeq.current.clear();
          modelSeq.current++;
          setModelConfig(undefined);
        }
        stateRef.current = value;
        setStatus({ ...value, loading: false });
        if (value.quota && value.quota.accountId) {
          const accountId = value.quota.accountId;
          const accountIsActive = accountId === value.activeAccountId && Array.isArray(value.accounts) && value.accounts.some((account) => account.id === accountId);
          const fetchedAt = value.quota.fetchedAt;
          if (accountIsActive && typeof fetchedAt === "number" && Number.isFinite(fetchedAt) && fetchedAt > 0 && commitQuota(accountId, value.quota)) {
            setQuotaStateByAccount((current) => ({ ...current, [accountId]: "loaded" }));
          }
        }

        // Model quota arrives from account-scoped /quota requests; /status may carry an older cache snapshot.
        if (!value.login || ["complete", "error", "cancelled", "canceled", "expired", "idle"].includes(value.login.status)) setLoginLink(null);
        return true;
      }, [commitQuota]);
      const refreshStatus = useCallback(async () => {
        const seq = ++statusSeq.current;
        const accountId = stateRef.current.activeAccountId;
        const value = await request("/status");
        if (!live.current || seq !== statusSeq.current || accountId !== stateRef.current.activeAccountId) return null;
        return applyStatus(value) ? value : null;
      }, [request, applyStatus]);
      const refreshQuota = useCallback(async (requestedAccountId) => {
        if (mutationLock.current) return;
        const accountId = requestedAccountId || stateRef.current.activeAccountId;
        if (!accountId) return;
        const generation = quotaGeneration.current;
        const seq = (quotaRequestSeq.current.get(accountId) || 0) + 1;
        quotaRequestSeq.current.set(accountId, seq);
        setQuotaStateByAccount((current) => ({ ...current, [accountId]: "loading" }));
        try {
          const value = await request("/quota", { method: "POST", body: JSON.stringify({ accountId }) });
          const accountStillExists = Array.isArray(stateRef.current.accounts) && stateRef.current.accounts.some((account) => account.id === accountId);
          if (value?.accountId !== accountId) throw new Error("Quota response account mismatch");
          if (typeof value.fetchedAt !== "number" || !Number.isFinite(value.fetchedAt) || value.fetchedAt <= 0) throw new Error("Quota response timestamp invalid");
          if (live.current && quotaGeneration.current === generation && quotaRequestSeq.current.get(accountId) === seq && accountStillExists) {
            const accepted = commitQuota(accountId, value);
            if (accepted || Number.isFinite(quotaByAccountRef.current[accountId]?.fetchedAt)) {
              setQuotaStateByAccount((current) => ({ ...current, [accountId]: "loaded" }));
              if (accepted && accountId === stateRef.current.activeAccountId && value.models) setModelConfig(value.models);
            }
          }
        } catch (_) {
          if (live.current && quotaGeneration.current === generation && quotaRequestSeq.current.get(accountId) === seq) setQuotaStateByAccount((current) => ({ ...current, [accountId]: "error" }));
        }
      }, [request, commitQuota]);
      const runQuotaBatch = useCallback((loadStatus) => {
        if (mutationLock.current) return Promise.resolve(false);
        if (quotaBatchInFlight.current) {
          queuedQuotaBatch.current = true;
          queuedQuotaStatus.current = queuedQuotaStatus.current || loadStatus === true;
          return quotaBatchPromise.current || Promise.resolve(false);
        }
        quotaBatchInFlight.current = true;
        const operation = (async () => {
          let nextLoadStatus = loadStatus === true;
          let completed = false;
          try {
            while (true) {
              queuedQuotaBatch.current = false;
              queuedQuotaStatus.current = false;
              const value = nextLoadStatus ? await refreshStatus() : null;
              const accounts = Array.isArray(value?.accounts) ? value.accounts : (stateRef.current.accounts || []);
              await Promise.all(accounts.map((account) => refreshQuota(account.id)));
              completed = true;
              if (!queuedQuotaBatch.current || !live.current || mutationLock.current) break;
              nextLoadStatus = queuedQuotaStatus.current;
            }
            return completed;
          } finally {
            const retry = queuedQuotaBatch.current && live.current && !mutationLock.current;
            const retryStatus = queuedQuotaStatus.current;
            queuedQuotaBatch.current = false;
            queuedQuotaStatus.current = false;
            quotaBatchInFlight.current = false;
            quotaBatchPromise.current = null;
            if (retry) {
              void runQuotaBatch(retryStatus).catch(() => {
                if (live.current) setError(trRef.current("requestFailed"));
              });
            }
          }
        })();
        quotaBatchPromise.current = operation;
        return operation;
      }, [refreshStatus, refreshQuota]);
      const refreshAll = useCallback(async () => {
        if (mutationLock.current) return;
        setBusy(true); setError("");
        try { await runQuotaBatch(true); }
        catch (_) { if (live.current) setError(trRef.current("requestFailed")); }
        finally {
          if (live.current) setBusy(false);
        }
      }, [runQuotaBatch]);
      useEffect(() => {
        live.current = true;
        void refreshStatus().catch(() => {
          if (live.current) { setStatus({ loading: false }); setError(trRef.current("requestFailed")); }
        });
        return () => { live.current = false; invalidateReads(); };
      }, [refreshStatus, invalidateReads]);
      const accountIds = useMemo(() => (status.accounts || []).map((account) => account.id).join("|"), [status.accounts]);
      useEffect(() => {
        const accounts = status.accounts || [];
        if (accounts.length > 0) void runQuotaBatch(false);
      }, [accountIds, status.revision, refreshQuota, runQuotaBatch]);
      // Settings can remain mounted while hidden. Refresh on re-entry as well
      // as periodically while visible; never overlap automatic batches.
      useEffect(() => {
        let disposed = false;
        let inFlight = false;
        let wasVisible = false;
        let lastRefresh = 0;
        const tick = async () => {
          const panel = panelRef.current;
          const visible = document.visibilityState !== "hidden" && !!panel && panel.getClientRects().length > 0 && getComputedStyle(panel).visibility !== "hidden";
          const entered = visible && !wasVisible;
          wasVisible = visible;
          if (!visible || inFlight || mutationLock.current || (!entered && Date.now() - lastRefresh < 60000)) return;
          inFlight = true;
          try {
            const completed = await runQuotaBatch(true);
            if (!disposed && completed) { lastRefresh = Date.now(); setError(""); }
          } catch (_) {
            if (!disposed && live.current) setError(trRef.current("requestFailed"));
          } finally { inFlight = false; }
        };
        const timer = window.setInterval(tick, 1000);
        window.addEventListener("focus", tick);
        document.addEventListener("visibilitychange", tick);
        return () => {
          disposed = true;
          window.clearInterval(timer);
          window.removeEventListener("focus", tick);
          document.removeEventListener("visibilitychange", tick);
        };
      }, [runQuotaBatch]);
      const flow = status.login;
      const flowPending = !!(flow && flow.flowId && !["idle", "complete", "error", "cancelled", "canceled", "expired"].includes(flow.status));
      useEffect(() => {
        const closeMenus = (event) => {
          for (const menu of document.querySelectorAll(".dsha-manage[open]")) {
            if (!menu.contains(event.target)) menu.open = false;
          }
        };
        document.addEventListener("click", closeMenus);
        return () => document.removeEventListener("click", closeMenus);
      }, []);
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
        invalidateReads(); setBusy(true); setError(""); quotaByAccountRef.current = {}; setQuotaByAccount({}); setQuotaStateByAccount({});
        let succeeded = false;
        try {
          const value = await request(path, { method: "POST", body: JSON.stringify(payload || {}) });
          if (!live.current) return;
          if (path === "/login") {
            setLoginLink(value.authUrl ? { url: value.authUrl, flowId: value.flowId } : null);
            applyStatus({ ...stateRef.current, login: { status: value.status || "pending", flowId: value.flowId } });
            setLoginCopied(false);
          } else applyStatus(value);
          succeeded = true;
        } catch (_) { if (live.current) setError(trRef.current("uncertain")); }
        finally {
          if (live.current) {
            try { await refreshStatus(); } catch (_) { if (live.current) setError(trRef.current("uncertain")); }
          }
          mutationLock.current = false;
          if (live.current) { setBusy(false); void refreshAll(); }
        }
        return succeeded;
      }, [request, invalidateReads, applyStatus, refreshStatus, refreshAll]);
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
          const value = await request("/models", { method: "POST", body: JSON.stringify({ enabledModelIds, accountId }) });
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

      const sortedAccounts = useMemo(() => {
        const accounts = Array.isArray(status.accounts) ? [...status.accounts] : [];
        return accounts.sort((a, b) => {
          const aActive = a.id === status.activeAccountId;
          const bActive = b.id === status.activeAccountId;
          if (aActive !== bActive) return aActive ? -1 : 1;
          return String(a.email || a.label || a.id).localeCompare(String(b.email || b.label || b.id));
        });
      }, [status.accounts, status.activeAccountId]);

      const modelOptions = useMemo(() => {
        const options = modelConfig && Array.isArray(modelConfig.options) ? modelConfig.options : [];
        return [...options].sort(compareAntigravityModelOptions);
      }, [modelConfig]);
      const email = status.email || (status.loading ? tr("loading") : tr("notSignedIn"));

      return React.createElement("div", { className: "dsha-wrap", ref: panelRef },
        React.createElement("div", { className: "dsha-page-head" },
          React.createElement(AntigravityIcon, { size: 24, className: "dsha-brand-icon" }),
          React.createElement("h2", { className: "dsha-page-title" }, "Antigravity"),
        ),
        React.createElement("p", { className: "dsha-page-desc" }, tr("pageDesc")),
        React.createElement("section", { className: "dsha-card dsha-account-card" },
          React.createElement("div", { className: "dsha-head" },
            React.createElement("div", { className: "dsha-title" },
              React.createElement(AntigravityIcon, { size: 18, className: "dsha-brand-icon" }),
              React.createElement("span", null, tr("accounts")),
            ),
            React.createElement("div", { className: "dsha-actions" },
              React.createElement("button", { className: "dsha-btn dsha-btn-primary", disabled: status.loading || busy || modelBusy || flowPending, onClick: (event) => openEditor("add", null, event) }, tr("addAccount")),
              status.authenticated && React.createElement("button", { className: "dsha-btn dsha-btn-primary", disabled: busy || modelBusy, onClick: () => { void refreshAll().catch(() => { if (live.current) setError(tr("requestFailed")); }); } }, busy ? tr("refreshing") : tr("refresh")),
              !status.authenticated && React.createElement("button", { className: "dsha-btn", disabled: busy || modelBusy, onClick: () => { void refreshStatus().catch(() => { if (live.current) setError(tr("requestFailed")); }); } }, tr("refreshState")),
              (status.accounts || []).length > 0 && React.createElement("button", { className: "dsha-btn", disabled: busy || modelBusy, onClick: logout }, tr("logoutAll")),
            ),
          ),
          React.createElement("p", { className: "dsha-note" }, tr("globalSelection")),
          React.createElement("div", { className: "dsha-account-list", role: "group", "aria-label": tr("accounts") }, sortedAccounts.map((account) => {
            const active = account.id === status.activeAccountId;
            const proxy = account.proxy || {};
            // Access-token expiry alone does not require sign-in: the host refreshes it on demand.
            const accountReady = ["ready", "refresh-required"].includes(account.authState);
            return React.createElement("div", { key: account.id, className: "dsha-account-row" },
              React.createElement("div", { className: "dsha-account-main" },
                React.createElement("div", { className: "dsha-account-name" }, account.label || account.email || account.id,
                  active ? React.createElement("span", { className: "dsha-badge" }, tr("active")) : null),
                account.label && account.email && account.label !== account.email ? React.createElement("div", { className: "dsha-account-email" }, account.email) : null,
                React.createElement("span", { className: `dsha-account-health ${accountReady ? "ready" : "needs"}` }, accountReady ? tr("ready") : tr("needsSignIn")),
                React.createElement("span", { className: `dsha-account-route ${proxy.enabled ? "enabled" : "off"}` }, proxy.enabled ? tr("proxyEnabled") : tr("proxyOff")),
              ),
              React.createElement("div", { className: "dsha-account-actions" },
                !active && React.createElement("button", { className: "dsha-btn dsha-btn-primary", disabled: busy || modelBusy, onClick: () => { closeEditor(); void mutate("/accounts/activate", { accountId: account.id, expectedRevision: stateRef.current.revision }); } }, tr("useAccount")),
                active && React.createElement("span", { className: "dsha-account-selected" }, tr("active")),
                React.createElement("details", { className: "dsha-manage" },
                  React.createElement("summary", { className: "dsha-btn" }, tr("manage")),
                  React.createElement("div", { className: "dsha-manage-menu" },
                    React.createElement("button", { className: "dsha-btn", disabled: busy || modelBusy || flowPending, onClick: (event) => { event.currentTarget.closest("details").open = false; closeEditor(); void startLogin({ accountId: account.id }); } }, tr("reauth")),
                    React.createElement("button", { className: "dsha-btn", disabled: busy || modelBusy, onClick: (event) => { event.currentTarget.closest("details").open = false; openEditor("proxy", account, event); } }, tr("proxy")),
                    React.createElement("button", { className: "dsha-btn dsha-btn-danger", disabled: busy || modelBusy, onClick: (event) => { event.currentTarget.closest("details").open = false; openEditor("remove", { ...account, active }, event); } }, tr("remove")),
                  ),
                ),
              ),
              React.createElement("div", { className: "dsha-account-quota" },
                React.createElement(QuotaPanel, { quota: quotaByAccount[account.id], state: quotaStateByAccount[account.id], busy, t: tr }),
              ),
            );
          })),
          editor ? React.createElement(AccountEditor, { key: `${editor.kind}:${editor.account ? editor.account.id : "new"}`, editor, accounts: status.accounts || [], busy: busy || modelBusy, tr, onSubmit: submitEditor, onClose: closeEditor, request }) : null,
          flowPending ? React.createElement("div", { className: "dsha-empty dsha-login-flow", role: "status" }, tr("loginPending"),
            loginLink && loginLink.flowId === flow.flowId ? React.createElement(React.Fragment, null,
              React.createElement("div", { className: "dsha-login-url", title: loginLink.url }, loginLink.url),
              React.createElement("button", { className: "dsha-btn", onClick: () => { void navigator.clipboard?.writeText(loginLink.url).then(() => setLoginCopied(true)); } }, loginCopied ? tr("copiedLogin") : tr("copyLogin")),
              React.createElement("a", { href: loginLink.url, target: "_blank", rel: "noopener noreferrer", className: "dsha-btn" }, tr("openLogin"))
            ) : null,
            React.createElement("button", { className: "dsha-btn", disabled: busy || modelBusy, onClick: () => { void mutate("/login/cancel", { flowId: flow.flowId }); } }, tr("cancelLogin")),
            React.createElement("input", { className: "dsha-input", placeholder: "Paste callback URL from your browser", value: callbackUrl, onChange: (e) => setCallbackUrl(e.target.value) }),
            React.createElement("button", { className: "dsha-btn", disabled: busy || !callbackUrl.trim(), onClick: () => { void mutate("/login/callback", { flowId: flow.flowId, callbackUrl: callbackUrl.trim() }); setCallbackUrl(""); } }, "Submit callback URL"),
            React.createElement("p", { className: "dsha-note" }, tr("browserProxy"))) : null,
          flow && ["error", "expired", "complete", "cancelled", "canceled"].includes(flow.status) ? React.createElement("p", { role: "status", className: "dsha-note" }, tr(flow.status === "complete" ? "loginComplete" : ["cancelled", "canceled"].includes(flow.status) ? "loginCancelled" : "loginError")) : null,
          !status.authenticated && React.createElement("div", { className: "dsha-account" },
            React.createElement("div", { className: "dsha-email" },
              React.createElement("span", { className: "dsha-email-mark", "aria-hidden": "true" }),
              React.createElement("span", { className: "dsha-email-text" }, email),
            ),
          ),
          !status.authenticated && React.createElement("div", { className: "dsha-empty" }, tr("notSignedInDesc")),
          error && React.createElement("div", { className: "dsha-error" }, error),
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
