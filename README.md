# dsh-antigravity

<p align="center">
  <img src="./assets/images/chat-model-picker.png" alt="dsh-antigravity" width="100%" />
</p>

English | [简体中文](./README.zh.md)

Google Antigravity / Cloud Code Assist model provider for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This is a DSH Web plugin. It registers a DSH `LlmAdapter`
under provider route `antigravity`, stores OAuth credentials under DSH home,
talks to the Cloud Code Assist streaming API directly, and provides full bilingual (English & Simplified Chinese) i18n support in the Web settings page.

> Unofficial integration. This project is not affiliated with or endorsed by
> Google. Use it only with accounts and services you are authorized to access.

## Install into DSH Web

### Option 1: Direct from GitHub

```sh
dsh plugin --profile web add github:dat-lequoc/dsh-antigravity
```

### Option 2: From Local Release Tarball

```sh
npm run pack:dist
dsh plugin --profile web add ./dist/dsh-antigravity-0.0.4.tgz
```

The package declares a DSH bundle patch, so installation automatically mounts
the host plugin and browser settings page.

Search providers register through a Cordis context that injects `web`, whether the web service loads before or after this plugin. The model adapter requires only `llm`.

If your DSH version does not support `dsh plugin add`, copy the package into
the Web profile manually:

```sh
cp -R dsh-antigravity "$DSH_HOME/profiles/web/node_modules/"
```

Then add the plugin to the profile `cordis.patch.yml`:

```yaml
- insert:
    - id: llm-antigravity
      name: dsh-antigravity
```

Restart DSH:

```sh
dsh web
```

## Login

Open **Settings > Antigravity** and click **Login**. The settings page starts
Google OAuth and refreshes quota after login completes.

![Antigravity Settings - Not Signed In](./assets/images/settings-not-signed-in.png)

After login, the settings page displays account information, quota grouped by model family, reset times, and model selector options:

- **Gemini Models** — Gemini Flash / Pro variants share one quota pool (green bars).
- **Claude and GPT models** — Claude Opus, Claude Sonnet, and GPT-OSS share a separate 3P quota pool (cyan bars).

Each group shows a **5-hour limit** (smooths short-term demand) and a **weekly limit** (tied to your subscription tier) with a live countdown to reset.

![Antigravity Settings - Signed In with Quota](./assets/images/settings-signed-in.png)

The plugin starts a loopback OAuth callback server at
`http://localhost:51121/oauth-callback`. If the Web service cannot open a
browser, run the terminal helper on the same machine:

```sh
node "$DSH_HOME/profiles/web/node_modules/dsh-antigravity/bin/antigravity-login.mjs"
```

Credentials are stored at:

```text
$DSH_HOME/storages/antigravity-oauth.json
```

Keep that file private. It contains access and refresh tokens.

### Swapping the Antigravity CLI auth

The `agy` CLI keeps its own session at
`~/.gemini/antigravity-cli/antigravity-oauth-token`, separate from this plugin's
store and from the account DSH itself uses.

**From the settings page.** Every account row has **Use in AGY CLI**, which
writes that account's saved credentials to the CLI's token file without making it
the account DSH uses for model calls. The row that currently holds the CLI
session is marked **AGY CLI**, and a note at the top of the card names the address
`agy` is signed in as. The previous session is backed up to
`antigravity-oauth-token.bak-<timestamp>` only when its address is not one of the
saved accounts: a saved account can be written back at any time, whereas an
outside login would otherwise be lost. An expired access token is refreshed
through the account's own route first; if that refresh fails the stored pair is
written anyway, because the CLI holds the same refresh token and can refresh it
itself.

**From a terminal.** To move the CLI onto an account the plugin already holds —
without signing in again — run the helper from this package:

```sh
node bin/antigravity-cli-auth.mjs list              # CLI identity + candidates
node bin/antigravity-cli-auth.mjs use quoccbaoo     # swap, then probe with `agy models`
node bin/antigravity-cli-auth.mjs restore           # undo the last swap
```

`use` matches any unique part of an account's id, email or label, mints a fresh
access token from that account's refresh token (the token endpoint is also what
returns a matching `id_token`), backs the previous CLI token up beside itself, and
writes the new one atomically with mode `600`. The refresh token is reused
unchanged, so the account keeps working in DSH afterwards. Candidates come from
the plugin store by default; pass `--source sub2api` to read sub2api's database
instead, or `--no-probe` to skip the `agy models` check.

Both the plugin and the CLI end up refreshing the same Google account, which is
fine for this client, but if either reports needing sign-in again, run `list` to
see which identity each one holds.

## Models

After login, select the **Antigravity** provider in DSH's model picker. Use the
model selector in **Settings > Antigravity** to enable or disable individual
models (enabled models are prioritized at the top of the list) — the live remaining quota percentage is shown next to each one.

Registered model IDs:

| Model ID | Name | Quota pool |
|---|---|---|
| `gemini-4-argon` | Gemini 4 Argon | Gemini |
| `gemini-3.7-flash` | Gemini 3.7 Flash | Gemini |
| `gemini-3.6-flash` | Gemini 3.6 Flash | Gemini |
| `gemini-3.5-flash` | Gemini 3.5 Flash | Gemini |
| `gemini-3.1-pro` | Gemini 3.1 Pro | Gemini |
| `gemini-3.1-flash-image` | Gemini 3.1 Flash Image | Gemini |
| `gemini-3-flash` | Gemini 3 Flash | Gemini |
| `gemini-2.5-pro` | Gemini 2.5 Pro | Gemini |
| `gemini-2.5-flash` | Gemini 2.5 Flash | Gemini |
| `claude-opus-5.5` | Claude Opus 5.5 | Claude & GPT (3P) |
| `claude-sonnet-5.5` | Claude Sonnet 5.5 | Claude & GPT (3P) |
| `claude-opus-4-6` | Claude Opus 4.6 | Claude & GPT (3P) |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | Claude & GPT (3P) |
| `gpt-oss-120b` | GPT-OSS 120B | Claude & GPT (3P) |

Models in the same quota pool share a weekly limit and a 5-hour limit. Quota is
consumed proportionally to token cost, so heavier models (e.g. Claude Opus)
drain the pool faster than lighter ones.

The plugin resolves these public IDs to runtime model IDs using the live
`fetchAvailableModels` catalog when available, with static routing fallbacks.

`gemini-4-argon` selects its reasoning level through the model picker and is
sent upstream as `gemini-4-argon-low`, `gemini-4-argon-medium` or
`gemini-4-argon-high`. Upstream serves only those pinned tier IDs and never the
bare `gemini-4-argon`, so the single picker entry routes to a tier rather than
sending the base ID.

The service gates model availability on the client identity in `User-Agent`.
Requests identify as `antigravity/cli/<version>`; without that `cli` segment the
Argon tiers are missing from the model catalog and every request for them is
refused, and sending no `User-Agent` at all is refused outright. Set
`ANTIGRAVITY_USER_AGENT` to override the default.

## Accounts per session

The active account is the default for every session. One session can pin its own
account instead, so concurrent sessions spend different accounts.

In the composer tool row a chip shows **Active** (following the profile-wide
account) or the account this session pinned. Clicking it offers "Follow active
account" and every signed-in account; the choice applies to this session only and
takes effect on its next request.

The same choice is available from the chat:

```
/antigravity-account            # list accounts; mark the active one and this session's
/antigravity-account bop        # or #2, an email address, or an account id
/antigravity-account active     # follow the active account again
```

An account whose access token expired is still selectable: its stored refresh
token renews it on the next request, which is why the settings page and the
picker both treat it as ready.

Pins live in `$DSH_HOME/storages/antigravity-sessions.json` (mode `0600`, newest
500 sessions, 90-day retention). Subagent and forked sessions inherit the nearest
pinned ancestor, so a delegated task spends the account its parent chose.

The model picker stays on the active account because `listModels`/`resolveModel`
are provider-wide; the composer's quota meter follows the session instead, so
its bars and token counts describe what this session is spending. The command
reports the account either way.

When the account a request uses reports quota exhaustion, the request is retried
on the next signed-in account (and the one after that, if it too is exhausted),
and the session's pin moves to the account that worked, so the following steps
start there. A pinned session only moves
after its own account is exhausted, and a request that already produced content
is never replayed elsewhere. Disable the behavior with `failoverOnQuota: false`
on the `dsh-antigravity` row of `cordis.patch.yml`.

## Context window

Each model reports the capacity its catalog advertises: 1,048,576 tokens for the
Gemini families, 250,000 or 200,000 for the Claude ones. DSH condenses the
conversation as it approaches that capacity (compaction-basic's `thresholdRatio`,
0.8 by default, after reserving the completion budget and its 65,536-token
headroom). A 1M window therefore lets a session grow to roughly 839k tokens
before it is summarized, and every request in that range is billed against the
account's token quota.

`maxContextWindow` caps what the adapter reports. It only lowers a model's
capacity, never raises it, so the Claude models keep their own smaller windows:

```yaml
- id: dsh-antigravity
  config:
    maxContextWindow: 750000
```

With that cap the harness condenses earlier: 750,000 is reported as the window
and the trigger lands at exactly 600,000 tokens, keeping roughly 110k after
summarization. Lower the value to spend less quota on long sessions; raise it or
remove the field to keep more history:

| Reported window | Condenses at | Kept after |
|---|---|---|
| 1,048,576 (catalog) | 838,860 | ~157k |
| 750,000 | 600,000 | ~110k |
| 600,000 | 468,928 | ~86k |

The cap applies to every model this provider serves and to subagents using it.
Changing it reloads the provider entry through the profile watcher; no process
restart is needed.

## Token usage

The quota panel also reports how many tokens this machine has spent. The service
exposes quota only as remaining fractions (`retrieveUserQuotaSummary`,
`retrieveUserQuota`), so there is no upstream token total to show; the plugin
instead counts the `usageMetadata` that every completed stream returns and
accumulates it per account in `$DSH_HOME/storages/antigravity-usage.json`
(mode `0600`, daily detail trimmed after 60 days).

The figures cover requests made through this plugin only. Traffic from the
Antigravity CLI, the IDE, or another DSH profile is not included, so the panel
labels the block "Tokens used (this device)" rather than presenting it as an
account-wide total. Cached prompt tokens are reported separately and are not
counted twice in the total; reasoning tokens count as output. A stream that
reports no usage metadata is not counted as a request.

## License

MIT
