# Antigravity multi-account authentication and proxy routing plan

Status: proposal only. No implementation or live account settings changed.
Target: `dsh-antigravity`; reference: sibling `dsh-codex-connect`.

## 1. Findings from the current implementation

| Area | Current behavior | Consequence |
| --- | --- | --- |
| Credentials | `lib/index.js:2616–2665`: one credential object in `$DSH_HOME/storages/antigravity-oauth.json`; atomic rename, instance-local mutation chain | Cannot retain multiple accounts; separate CLI/Web writers are not coordinated |
| OAuth | `lib/index.js:2386–2553`: separate terminal/Web exchange paths; Web login writes over the current credential | Adding another login replaces the existing account |
| Refresh | `lib/index.js:2756–2781`: read active credential, then modify current store | Switching during refresh/project discovery would be unsafe without account capture |
| Quota/catalog | `lib/index.js:1296–1357`: global cached quota and shared persisted catalog; refresh filters enabled model IDs against the fetched catalog | Old account results could overwrite the new account display and model preferences |
| Web API | `lib/index.js:3203–3275`: status/login/quota/models/logout over HTTP | No account selector; logout deletes the whole credential file; body reader has no size bound |
| Browser UI | `lib/client.js:394–595`: single-account card, interval-based async login polling | Need account controls, nonoverlapping polling, stale-response protection, and explicit clearing of old quota |
| Model/search | `lib/index.js:2827–2902, 3305–3455`: both use the same credential store | Both must follow account selection and proxy policy, including retries |
| Search availability | `lib/index.js:3314–3319`: tests only credential-file existence | A multi-account document with no active account needs a real availability check |
| Packaging | `package.json:37–40`: shipped JavaScript, syntax check and npm packaging only | There is no TypeScript compile/build/lint/test pipeline to invoke today |

### What to reuse from Codex

- `src/store.ts:274–334`: capture account identity per request; refresh only that account, preserve the latest active selection, never recreate a removed account.
- `src/store.ts:355–405`: durable switching and explicit replacement when deleting the active account.
- `src/store.ts:245–260`: protected migration backup and atomic credential writes; use cross-process writer coordination, not only an instance-local promise chain.
- `src/auth-routes.ts:440–486`: validate trusted requests and bound JSON bodies. Do not assume a local endpoint alone prevents cross-site mutations.
- `src/client/account-store.ts`: authoritative status after mutation and cancellation of stale reads.
- `src/settings-contract.ts:25–47`: credential-free HTTP(S) proxy origin validation.
- `src/provider-proxy.ts:282–335`: retain transport ownership for the full operation/stream and probe without account credentials.

Do not copy Codex blindly: its proxy is provider-level, not per-account; its global dispatcher wrapper solves SDK interception that Antigravity's directly owned fetch calls do not require. Its whole-document lock can also hold up unrelated mutations during network refresh. Preserve design invariants, not provider-specific code or identity assumptions. Preserve required license notices if code is reused.

## 2. Proposed user-visible behavior

### Account management

1. Settings → Antigravity always offers **Add account**, including when already signed in.
2. Saved accounts show label/email, **Active** badge, auth health, and proxy mode. Selecting **Use account** changes the shared provider selection for subsequent requests.
3. Selection is global for this DSH credential store, across sessions—not per chat. Show this explicitly.
4. The first successful login becomes active. Later additions keep the current selection unless the user checks **Make active after login**. Reauthentication preserves the account's label and proxy preferences.
5. A stream/request already started stays on its captured account and routing configuration; newly started requests use the new selection. No automatic account rotation, quota failover, or hidden model fallback.
6. Remove an inactive account without affecting the active account. Removing the active account with other accounts present requires an explicit replacement. Removing the last account signs out.
7. Separate **Remove account** from **Sign out all accounts**, with destructive confirmation. Existing `/logout` and CLI `--logout` retain their historical all-credentials meaning, but become clearly labeled.
8. Invalid refresh credentials mark only that account as needing login. Network errors, proxy failures, 429, and 5xx do not delete credentials or select a different account.

### Proxy controls

- Every account has **Use custom proxy**, OFF by default. New login can choose a proxy before exchanging its authorization code, since the account does not exist yet.
- Inputs: protocol (HTTP/HTTPS), host (default suggestion `127.0.0.1`), port (1–65535), routing scope, **Test connection**, and **Save**.
- No implicit port scan, no automatic activation, no automatic VPN/Docker launch.
- OFF means **use existing DSH/network defaults**, not guaranteed direct internet access. DSH may already have an administrator/user-configured global proxy.
- ON is an explicit account-scoped override. If that proxy fails, covered traffic fails closed; never silently retry direct or through DSH's default proxy.
- Expose two scopes to remove ambiguity around “auth routes”:
  - **Authentication only** (initial scope): server-side code exchange, refresh, identity lookup, and login-time project discovery. Model/quota/search calls continue using DSH defaults.
  - **All account traffic**: authentication plus authenticated discovery, catalog, quota, inference, and Antigravity search. Recommend this when the intent is to keep that account's API traffic on one VPN exit.
- A scope exclusion is intentional, not a failure fallback. Display it clearly so auth-only is not mistaken for full VPN coverage.
- Normal browser Google sign-in is NOT routed by a Node HTTP proxy. The user must separately proxy the browser if they require its authorization-page traffic on the same VPN. Loopback callback traffic must remain local.

### Mullvad/Docker deployment assumptions

A VPN tunnel port is not an HTTP proxy port. The container must expose an actual HTTP CONNECT proxy whose outbound traffic goes through the VPN tunnel. HTTP/HTTPS proxy support is the initial implementation; SOCKS5 is deferred unless the chosen container is SOCKS-only, in which case scope and dependency support must be revised before implementation.

Document `127.0.0.1:<published-port>` for host-run DSH. If DSH is containerized, localhost points to that container: use the explicitly configured Docker service/host gateway instead. Publish local proxies to loopback where possible. A plugin-level fail-closed setting cannot prevent a poorly configured proxy container from leaking direct traffic when its VPN dies; container firewall/kill-switch behavior must be tested separately.

## 3. Durable store, identity, migration, and concurrency

### Versioned document

Keep the existing credential path but introduce a validated version-2 document:

```text
version: 2
revision: monotonically increasing mutation revision
activeAccountId: opaque local account ID, or null for an empty store
accounts[]:
  id: opaque locally generated account ID
  providerSubject: Google identity from authenticated userinfo, when available
  label, email, createdAt, updatedAt
  credentialRevision: changes on login or credential refresh
  credentials: { access, refresh, expires, projectId }
  proxy: { enabled: false, url: null, scope: "auth-only", revision: 0 }
```

- Do not use project ID, access token, or an arbitrary decoded JWT as account identity. Obtain the provider subject from an authenticated supported Google userinfo endpoint; verify its response contract during implementation.
- Legacy credentials may have only an email. Import them under a stable local ID. Merge them on later verified reauthentication only under a documented matching rule (e.g. matching verified email); if identity cannot be established, require explicit user confirmation rather than merging unrelated credentials.
- Display only safe account summaries to the browser: opaque local ID, label/email, timestamps, active/auth state, and credential-free proxy configuration. Never access/refresh tokens, provider payloads, PKCE secrets, or credential-bearing URLs.
- Validate schema, duplicate IDs/subjects, active-account existence, maximum accounts (proposed 16), document size, proxy fields, and finite expiry timestamps. Unknown future versions fail clearly rather than being treated as signed out.

### Migration and permissions

- Read legacy format without destructive changes; on first mutation, create a protected, non-overwriting legacy rollback backup, then atomically persist v2. Migration is idempotent and retains the existing login as active with proxy disabled.
- Use unique temporary files and restrictive permissions (0600 files, 0700 newly owned directories); validate file type and reject unsafe symlink/permission situations with actionable errors. Do not chmod the whole shared DSH storage tree.
- Serialize all read-modify-write operations across CLI/Web processes using a supported file-lock primitive, including migration, switch, remove, proxy edits, and refresh commits. Re-read inside the lock. Use bounded lock acquisition and safe stale-lock ownership handling.
- Network work must not hold the global document writer lock. Use per-account refresh singleflight plus a cross-process per-account refresh lock; take the short document lock only to check and commit current state. Define lock ordering to avoid deadlocks.
- Refresh commits verify account ID and credential generation. A stale refresh cannot overwrite a later re-login, change activeAccountId, overwrite proxy edits, or resurrect removed credentials. Never drop a successfully rotated refresh token because an unrelated account changed.
- Backups contain secrets. Remove legacy rollback backups on explicit account removal/logout so deleted accounts cannot reappear through an automatic recovery path. Explain the resulting rollback limitation; never silently import a backup on missing/corrupt v2 data.

### Request capture and cache isolation

Capture `{accountId, credentials, credentialRevision, proxy policy, route revision, account catalog}` at operation entry, before account-dependent asynchronous work. Pass the context through token refresh, project lookup, model resolution, retries, streaming, quota, and search.

Move quota, dynamic catalog, project/model lookup caches, and relevant diagnostics behind account-aware runtime state. Key by account ID, project/model as applicable, credential generation, and proxy revision—not raw token strings. Late results from A can update only A's matching generation; they cannot overwrite B's active display/catalog or recreate deleted state.

Keep explicit model-enabled preferences provider-wide, but store discovered catalogs per account. Do not permanently delete enabled IDs just because one account's catalog omits them. Active account changes emit `llm/adapters-updated` and resolve its catalog/quota without displaying another account's data.

## 4. OAuth, transport, and API implementation

### OAuth lifecycle

Consolidate terminal/Web exchange logic. A login flow owns flow ID, state, PKCE verifier, callback server, timeout/abort controller, target reauthentication ID (if any), captured proxy policy, and activation intent.

- Request Google account selection/consent when adding an account.
- Keep one pending callback flow initially; a conflicting request returns a clear conflict, not another user's pending URL.
- Add cancellation and flow-specific status. Switch, remove, logout, or conflicting reauthentication cancels and awaits pending login quiescence before committing, with defined commit ordering.
- Flow completion upserts credentials rather than replacing the document. Wrong-account reauthentication requires explicit resolution; it cannot overwrite the requested account.
- Preserve callback state validation, PKCE, loopback binding, no-store responses, and no secrets in errors. Bound exchange/refresh/userinfo calls with timeouts and cancellation.
- CLI uses the same store and flow implementation. Add list, select, remove, account-targeted re-login and explicit proxy options without printing tokens. Reject unknown arguments rather than silently starting login.

### Transport seam

Introduce one host-only fetch/transport module, with explicitly classified request kinds. Thread the captured context through all currently direct provider fetches.

- Disabled/excluded override calls ordinary fetch and preserves the harness's installed transport.
- Enabled covered calls use an account-scoped HTTP(S) proxy dispatcher, preferably a compatible explicitly declared Undici dependency. No process.env rewriting or setGlobalDispatcher calls.
- DSH's `packages/util/http-proxy/src/install.ts:62–67, 159–164` currently exposes the process-wide policy, not per-account proxy selection. Its `scripts/verify-no-bare-dispatcher.ts:10–13` recognizes justified per-request transport ownership: document this specific override and test coexistence with the global policy.
- Validate TLS for both HTTPS proxy and destination; never disable certificate verification. Reject proxy URL credentials, paths, queries, fragments, malformed hosts/ports, and unsupported schemes.
- Keep transport leases until bodies/streams finish or are canceled—not just until response headers arrive. Bound pool size; drain old proxy revisions and destroy them after a bounded shutdown deadline. Register cleanup with plugin lifecycle and CLI finalization.
- Preserve existing streaming idle watchdog, caller cancellation, exact-model capacity retries, image/tool handling, and endpoint fallbacks. Every fallback endpoint uses the same captured route.
- Treat search grounding redirect resolution as part of the search operation in all-account mode; prevent credential forwarding to non-provider destinations. Do not proxy unrelated attachment reads or other DSH providers.
- Fixed-target, short, unauthenticated proxy probe; user-initiated only, with no credential mutation. A successful CONNECT/TLS probe establishes reachability, not proof of Mullvad egress or account authorization.

### Web API additions

Keep the existing `/antigravity/api` prefix and safe legacy active-account status fields.

| Operation | Proposed API |
| --- | --- |
| Status | `GET /status` → revision, activeAccountId, safe accounts, active quota/catalog, current flow status |
| Add/re-login | `POST /login` with optional targetAccountId, activation intent, validated proxy policy |
| Cancel login | `POST /login/cancel` with flowId |
| Switch | `POST /accounts/activate` with accountId and expected revision |
| Remove | `POST /accounts/remove` with accountId, optional replacementAccountId, expected revision |
| Proxy setting | `POST /accounts/proxy` with accountId, policy, expected revision |
| Probe | `POST /proxy/test` with validated credential-free proxy origin |
| Quota | `POST /quota` with accountId; response explicitly identifies account and revision |
| Logout all | Existing `POST /logout`, explicitly documented as destructive |

Bound body sizes, reject unknown fields, validate content type, authenticate/authorize through the supported DSH boundary, and add Origin/Host/fetch-metadata checks consistent with the deployment. Check host-webserver guarantees before claiming routes are protected; never trust arbitrary forwarded headers. Return safe 400/403/404/409/413 and classified upstream errors, not raw token endpoint bodies. Revision conflicts require status reload, not optimistic overwrite.

### Browser behavior

Implement account list, explicit single-active selection (radio/button, not independent active toggles), add/re-login flow, removal confirmation/replacement selection, and per-account proxy editor. Keep the existing quota/model view under the active account heading.

Use a single coordinated status state, request sequencing/AbortController, and nonoverlapping polling only while needed. Ignore old account/revision responses, immediately clear mismatched quota, and re-fetch authoritative state after successful or uncertain mutations. Mutation timeout means outcome unconfirmed, not rollback. Ensure polling/listeners are disposed and English/Chinese labels, keyboard navigation, busy states, focus, and inline errors work.

## 5. Suggested file boundaries and implementation order

Keep shipped plain JavaScript for this feature; do not combine it with an unnecessary full TypeScript migration.

1. **Baseline and test seams:** add a deterministic test runner and injectable clock/fetch/store roots; preserve the current resilience test as regression coverage.
2. **Store:** new `lib/account-store.js` plus schema/lock helpers; retain appropriate compatibility exports in `lib/index.js`. Add migration/concurrency tests before routing changes.
3. **Transport:** new `lib/transport.js` and node-free proxy validation; add HTTP CONNECT/TLS fixtures and disabled-default tests.
4. **Auth:** new `lib/auth.js` or equivalent extracted service; consolidate OAuth and account-bound refresh. Update CLI.
5. **Provider integration:** adapt quota, catalog, model streaming, search, and diagnostics to captured contexts; isolate caches and preserve retry semantics.
6. **HTTP API:** extract route handlers if useful; add validation, account operations, cancellation, revisions, and proxy probe.
7. **UI:** update `lib/client.js` using its existing ModuleLoader format; avoid introducing browser imports that require an unconfigured bundler. Add account/proxy interactions and race tests.
8. **Release:** package scripts, declared runtime/dev dependencies and lockfile, English/Chinese docs, migration/rollback instructions, and isolated packed-install verification.

Keep changes scoped to `dsh-antigravity`; no Codex modifications or harness composition changes are expected. Any later shared harness transport API proposal should be a separate change.

## 6. Automated test plan

All routine tests use fake credentials, isolated temporary DSH_HOME/store paths, local mocks, and no real Google traffic. Deny unexpected network requests. Clean up processes, servers, locks, timers, dispatchers, and temporary state.

| Suite | Required cases |
| --- | --- |
| Store/schema | Empty/single/multiple accounts; duplicate identity; missing active ID; invalid schema/size/version; account limit; corrupt JSON; safe permissions and symlink handling |
| Migration | Legacy import; unchanged credentials; active selection/proxy-off preservation; repeated migration; existing mismatched backup; simulated crash before/after atomic rename; explicit rollback and logout backup cleanup |
| Mutations | Add keeps existing selection; optional activate; duplicate verified re-login; rename; select unknown account; remove inactive/active/last; invalid replacement; restart persists state |
| Refresh races | Concurrent requests cause one refresh per account; switch A→B while refreshing A; remove/re-login A during refresh; unrelated account updates; rotated refresh token retained; aborted waiter; invalid_grant vs transient failures |
| Cross-process | Two store instances and two child processes writing different accounts; CLI login vs Web selection; bounded lock timeout; lock-owner death; no lost update or malformed document |
| OAuth | PKCE/state mismatch; provider rejection; timeout/cancel; occupied callback port; malformed token response; wrong-account reauth; failed add preserves accounts; logout/switch during callback commit |
| Proxy validation | OFF default; scheme/host/port rules; IPv6 origin; reject credentials/path/query/fragment; invalid saved policy fails safely |
| Route coverage | Token exchange, refresh, userinfo, project, quota, catalog, inference, retries, search and redirect resolution; correct auth-only/all-account inclusion; unrelated provider never overridden |
| Proxy failures | HTTP CONNECT and HTTPS-proxy TLS; untrusted certificate; 407; connection refusal; timeout; cancellation; midstream disconnect; zero unintended direct-origin requests on covered failure |
| Isolation/lifecycle | Parallel A→proxy1, B→proxy2, defaults→harness route; switching/editing proxy midstream; old lease drains; removal/logout; plugin disposal leaves no live sockets/timers |
| Cache/catalog | A quota returns after B selection; refresh of removed account; independent account catalogs; proxy generation changes; enabled preferences not pruned by another account |
| API/security | Bad origin/host/cross-site; authorized normal GUI; oversized/invalid body; unknown IDs/revision conflict; no tokens in status/errors/logs; fixed probe cannot become arbitrary URL fetch |
| UI | Add while signed in; active selection; removal replacement; proxy default/toggle/scope/probe; uncertain mutation recovery; delayed A status after B; polling cleanup; EN/ZH and keyboard behavior |
| Existing regressions | 503 exact-model retries and abort; 429 semantics; SSE completion/errors; tools/images; search registration/alias behavior; model picker update |

Most important integration scenario: start A on proxy P1, block its refresh or stream, switch to B on P2, send a new request, then release A. Assert A remains on P1, B uses P2, active selection remains B, and A's late refresh/quota never overwrites B. Repeat with removal, logout, failed proxy, and process restart.

## 7. Compile, check, and package gates

### Baseline actually run during planning

In `/home/nightfury/dsh-plugins/dsh-antigravity`:

```sh
node --version                       # v25.8.1 in this environment
npm --version                        # 11.11.0
npm run check                        # PASS: syntax of host, client, CLI
node test-503-resilience.mjs          # PASS: 9 assertions, 0 failures
npm pack --dry-run --ignore-scripts   # PASS: current package manifest, 11 files
git diff --check                     # PASS
```

The npm commands emitted inherited npm/pnpm configuration warnings, not plugin compile errors. No archive was produced by the dry run. These checks do not establish multi-account correctness, browser functionality, TLS/proxy behavior, or clean-install compatibility.

### Proposed scripts to add, then enforce

- `check:syntax`: recursively `node --check` all shipped JS/MJS, not just today's three files.
- `typecheck`: TypeScript `allowJs`, `checkJs`, `noEmit` with JSDoc contracts; separate browser DOM/ModuleLoader and host Node environments. Resolve DSH peers from the selected supported harness version. Record existing debt separately rather than silently disabling checking.
- `lint`: ESLint with Node/browser globals, promises/error-handling rules and React hooks checks where applicable.
- `test:unit`, `test:integration`: Vitest with fake timers, controlled fetch/transport seams and child-process fixtures.
- `test:browser`: Vitest Browser Mode/Playwright Chromium, mounting the actual ModuleLoader client with a fake API; test the packaged plugin in real DSH separately.
- `check`: aggregate syntax, typecheck, lint, unit and integration tests. Keep browser/pack checks explicit CI stages so missing Chromium cannot silently skip them.

After implementing these scripts, the local/CI sequence is:

```sh
npm run check:syntax
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run test:browser
node test-503-resilience.mjs
npm pack --dry-run --ignore-scripts
npm run pack:dist
git diff --check
```

There is no `npm run build` today: `lib/index.js` is already executable ESM and `lib/client.js` is already a ModuleLoader browser script. Packaging is not compilation; syntax checking is not typechecking. Keeping this format avoids a new build stage. If implementation instead introduces TypeScript/bundled browser modules, add and verify an actual build script before claiming build success.

**Dependency isolation:** current `node_modules` is a symlink to `/home/nightfury/.dsh/profiles/node_modules`. Do NOT run dependency installation against that shared live directory. Establish a disposable standalone checkout/install with declared peer fixtures and a reproducible lockfile for dependency changes and clean-install tests.

**Packed-install gate:** install the generated tarball into an isolated DSH test profile/home with fake accounts, confirm host module imports and all newly split files ship, CLI help works without login, settings client loads, adapter and search register, and no workspace-only dependencies are required. Verify no credential files, backups, test outputs, or node_modules enter the archive. Use maintained Node runtimes compatible with both DSH and the selected Undici version; reconcile the plugin's broad Node >=20 declaration with the actual dependency minimum. This checkout's harness currently declares ^22.19.0 or >=24.

## 8. Manual acceptance, live GUI, and rollback

### Manual acceptance (opt-in real accounts/network)

1. Back up live credentials securely, use two authorized test accounts, and verify legacy account A migrates with proxy OFF.
2. Add B, choose active account, restart DSH, confirm persistence. Re-login A without producing an unwanted duplicate.
3. Make a small model request and Antigravity search on each account; verify account-tagged safe diagnostics and matching quota/catalog.
4. Configure an HTTP CONNECT proxy behind the VPN. Test connectivity, select auth-only or all-account scope, and explicitly verify the corresponding outbound routes.
5. Verify the container's VPN egress separately, using an explicit user-approved IP-check request that carries no OAuth credentials. Do not infer VPN identity from a successful proxy health check.
6. Stop the proxy; covered operations must fail without direct fallback. Stop the VPN while leaving the proxy alive; verify the container kill switch blocks egress.
7. Switch accounts while A streams; A finishes on its captured route, B's next request uses B's route. Disable B's custom proxy and verify DSH defaults are restored, not forced-direct routing.
8. Test removal, replacement selection, cancellation, last-account signout, logout-all, refresh failure, and browser reload. Inspect browser console/server logs for errors and leaked secrets.

### Updating the existing GUI

Verify the installed plugin resolves to the intended package, deploy the tested artifact, restart/reload the relevant DSH host, then refresh and verify the existing GUI at `http://127.0.0.1:3080`. Do not start a replacement server. Do not promise HMR without verifying both the active watcher and that this external plugin is included in its build path.

If harness shell/shared client code unexpectedly changes, use the checkout's actual scripts (`pnpm run build:lib:client` and `pnpm run build:web`; host changes may require `pnpm run build:lib:host`) for the affected artifacts, then restart/refresh the existing application. A shell rebuild alone does not install an external plugin update. No harness-wide rebuild is expected for the proposed plugin-only work.

### Rollback and completion criteria

- Never feed a v2 multi-account document to the old single-account implementation. Before rollback, stop writers and explicitly export the selected account into a protected legacy-format file, or restore a deliberately retained matching pre-migration backup. Warn that newer accounts/settings are not represented in legacy format.
- Restore the previous package and validate login/model operation; never overwrite a user's live credential store as an automated test step.
- Complete only when migration, account/route isolation, proxy fail-closed behavior, security tests, type/lint/test gates, packed installation, and real-GUI smoke checks pass or have explicit documented environmental blockers. Report commands and outcomes separately from checks merely planned.
