# dsh-antigravity

<p align="center">
  <img src="./assets/images/chat-model-picker.png" alt="dsh-antigravity" width="100%" />
</p>

[English](./README.md) | 简体中文

适用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Google Antigravity / Cloud Code Assist 模型提供商插件。

这是一个 DSH Web 插件。它在 provider 路由 `antigravity` 下注册 DSH `LlmAdapter`，OAuth 凭证存储于 DSH home 目录下，直接与 Cloud Code Assist 流式 API 通信，并且 Web 设置页面完整支持中英文双语国际化（i18n）。

> 非官方集成。本项目与 Google 无关，亦未获得 Google 认可。请仅在您有权访问的账号和服务中使用。

---

## 安装到 DSH Web

### 方式一：直接从 GitHub 安装

```sh
dsh plugin --profile web add github:dat-lequoc/dsh-antigravity
```

### 方式二：通过本地 Release 包安装

```sh
npm run pack:dist
dsh plugin --profile web add ./dist/dsh-antigravity-0.0.4.tgz
```

该 package 声明了 DSH bundle patch，安装后会自动挂载 host 插件与浏览器设置页面。

无论 web 服务在本插件之前还是之后加载，搜索提供者都通过注入 `web` 的 Cordis 上下文注册。模型适配器仅依赖 `llm`。

如果您的 DSH 版本暂不支持 `dsh plugin add`，可手动复制到 Web profile：

```sh
cp -R dsh-antigravity "$DSH_HOME/profiles/web/node_modules/"
```

然后在 profile 的 `cordis.patch.yml` 中添加该插件：

```yaml
- insert:
    - id: llm-antigravity
      name: dsh-antigravity
```

重启 DSH：

```sh
dsh web
```

---

## 登录与授权

打开 **设置（Settings）> Antigravity** 并点击 **登录（Login）**。设置页面将发起 Google OAuth 授权流程，并在登录完成后自动刷新配额（Quota）。

![Antigravity Settings - 未登录](./assets/images/settings-not-signed-in.png)

登录成功后，设置页面将展示账号信息、按模型分组的实时配额进度条、重置倒计时以及模型选择器：

- **Gemini Models** —— Gemini Flash / Pro 变体共享同一个配额池（绿色进度条）。
- **Claude and GPT models** —— Claude Opus、Claude Sonnet 与 GPT-OSS 共享独立的 3P 配额池（青色进度条）。

每个分组均展示 **5 小时限额**（平滑短期突发用量）与 **每周限额**（绑定至订阅级别，如 Google AI Pro），并配有实时重置倒计时。

![Antigravity Settings - 已登录](./assets/images/settings-signed-in.png)

插件会在本地启动一个 loopback OAuth 回调服务（`http://localhost:51121/oauth-callback`）。如果 Web 服务无法自动唤起浏览器，可在同机器终端运行命令行登录助手：

```sh
node "$DSH_HOME/profiles/web/node_modules/dsh-antigravity/bin/antigravity-login.mjs"
```

凭证存储路径：

```text
$DSH_HOME/storages/antigravity-oauth.json
```

> 请妥善保管该文件，其中包含 access token 与 refresh token。

### 切换 Antigravity CLI 授权

`agy` CLI 使用独立的会话文件 `~/.gemini/antigravity-cli/antigravity-oauth-token`，与本插件的账号存储、以及 DSH 当前启用的账号都不相同。

**在设置页操作。** 每个账号行都提供 **用作 AGY CLI**，它只把该账号已保存的凭据写入 CLI 的会话文件，不会改变 DSH 用于模型调用的账号。当前占据 CLI 会话的账号行会标记为 **AGY CLI**，卡片顶部也会显示 `agy` 当前登录的地址。替换前，仅当旧会话的地址不属于任何已保存账号时，才会备份为 `antigravity-oauth-token.bak-<时间戳>`：已保存的账号随时可以重新写入，而外部登录一旦覆盖就找不回来。access token 过期时会先按该账号自身的路由刷新；若刷新失败，仍会写入已保存的凭据，因为 CLI 持有同一个 refresh token，可自行刷新。

**在终端操作。** 如需把 CLI 切到插件已保存的账号，可运行同包内的辅助脚本：

```sh
node bin/antigravity-cli-auth.mjs list              # CLI 身份与候选账号
node bin/antigravity-cli-auth.mjs use quoccbaoo     # 切换后用 `agy models` 验证
node bin/antigravity-cli-auth.mjs restore           # 撤销上一次切换
```

`use` 会按账号 id、邮箱或标签的唯一片段匹配，用该账号的 refresh token 换取新的 access token，把原 CLI token 备份到同目录，并以 `600` 权限原子写入。refresh token 原样复用，因此该账号在 DSH 中仍可继续使用；候选账号默认来自插件存储，可加 `--source sub2api` 改为读取 sub2api 数据库，或加 `--no-probe` 跳过 `agy models` 校验。

---

## 模型列表

登录后，在 DSH 模型选择器中选择 **Antigravity** 提供商。您可以在 **设置 > Antigravity** 的模型选择器中按需勾选或关闭单个模型（已勾选的模型将自动置顶展示），每个模型副标题均会显示其实时可用额度百分比。

支持注册的模型 ID：

| 模型 ID | 名称 | 额度池 |
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

同一额度池内的模型共享 5 小时与每周额度。额度按 Token 成本比例扣除，因此较重的大模型（如 Claude Opus）消耗额度速度会快于轻量模型。

插件会在可用时通过实时的 `fetchAvailableModels` 目录将这些公开 ID 解析为内部运行时模型 ID，并自带静态路由兜底。

`gemini-4-argon` 通过模型选择器指定推理等级，实际向上游发送
`gemini-4-argon-low`、`gemini-4-argon-medium` 或 `gemini-4-argon-high`。上游仅提供这些固定等级 ID，不接受裸 ID
`gemini-4-argon`，因此选择器中的单个条目会按等级路由。

服务端会根据 `User-Agent` 中的客户端标识来决定模型可用性。请求会以
`antigravity/cli/<version>` 标识自身；缺少其中的 `cli` 段时，模型目录不再包含 Argon 各等级且相关请求会被拒绝，完全不发送
`User-Agent` 则会被直接拒绝。可通过 `ANTIGRAVITY_USER_AGENT` 覆盖默认值。

## 按会话选择账号

插件级的「当前账号」是所有会话的默认值。单个会话可以固定使用自己的账号，从而让并行的会话消耗不同账号。

输入框工具行中有一个标签：显示 **跟随当前** 表示使用插件级账号，显示账号名表示本会话固定在该账号。
点击可选择「跟随当前账号」或任一已登录账号；该选择只作用于本会话，并在下一次请求时生效。

同样可以在对话中切换：

```
/antigravity-account            # 列出账号，并标注当前账号与本会话使用的账号
/antigravity-account bop        # 也可用 #2、邮箱或账号 id
/antigravity-account active     # 恢复跟随当前账号
```

访问令牌已过期的账号仍可选择：存储的刷新令牌会在下一次请求时自动续期，设置页与选择器
因此都将该状态视为可用。

固定关系保存在 `$DSH_HOME/storages/antigravity-sessions.json`（权限 `0600`，保留最近
500 个会话、90 天）。子代理与会话分叉会继承最近的已固定祖先会话，因此委派出去的任务
使用其父会话选定的账号。

模型选择器仍以「当前账号」为准，因为 `listModels`/`resolveModel` 是 provider 级别的；
输入框旁的额度条则跟随本会话，显示该会话实际消耗的额度与 Token。会话使用的账号也可用该命令查询。

当某个请求所使用的账号报告额度耗尽时，该请求会在下一个已登录账号上重试（若仍耗尽
则继续尝试下一个），并把会话的固定关系迁移到成功的账号，后续步骤从那里继续。已固定的会话只会在自己的账号
耗尽后才迁移；已经产生内容的请求不会在别的账号上重放。可在 `cordis.patch.yml` 的
`dsh-antigravity` 行设置 `failoverOnQuota: false` 关闭该行为。

## 上下文窗口

每个模型上报其目录声明的容量：Gemini 系列为 1,048,576 Token，Claude 系列为
250,000 或 200,000。DSH 会在对话接近该容量时压缩（compaction-basic 的
`thresholdRatio` 默认 0.8，并先扣除补全预算与 65,536 Token 的 headroom）。因此
1M 窗口会让会话增长到约 839k Token 才被总结，而这一区间内的每次请求都会计入账号的
Token 额度。

`maxContextWindow` 限制适配器上报的容量。它只会下调、不会上调，因此 Claude 模型
保留各自更小的窗口：

```yaml
- id: dsh-antigravity
  config:
    maxContextWindow: 750000
```

设置该值后压缩会更早发生：窗口上报为 750,000，触发点为 600,000 Token，压缩后保留
约 110k。想更省额度就调低，想保留更多历史就调高或删除该字段：

| 上报窗口 | 触发压缩 | 压缩后保留 |
|---|---|---|
| 1,048,576（目录值） | 838,860 | 约 157k |
| 750,000 | 600,000 | 约 110k |
| 600,000 | 468,928 | 约 86k |

该上限适用于本 provider 的全部模型，以及使用它的子代理。修改后由 profile 监听器
重载 provider 条目，无需重启进程。

## Token 用量

额度面板还会显示本机已消耗的 Token 数。服务端仅以剩余比例的形式提供额度
（`retrieveUserQuotaSummary`、`retrieveUserQuota`），并不提供 Token 总量，因此插件改为统计每个已完成请求返回的
`usageMetadata`，按账号累计写入 `$DSH_HOME/storages/antigravity-usage.json`
（权限 `0600`，每日明细保留 60 天）。

该数据仅涵盖经本插件发出的请求，不包含 Antigravity CLI、IDE 或其他 DSH profile
的流量，因此面板将该区块标注为「已用 Token（本机统计）」，而不将其呈现为账号级总量。缓存命中的输入
Token 单独统计、不会在总量中重复计算；推理 Token 计入输出。未上报 usage 元数据的流不会计为一次请求。

---

## 许可证

[MIT](./LICENSE)
