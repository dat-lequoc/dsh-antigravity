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
