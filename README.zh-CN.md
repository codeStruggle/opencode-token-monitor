# OpenCode Token Monitor

> 本文译自英文 [README.md](README.md)（版本 0.1.0）。如有出入，以英文版为准。

[English](README.md) · [Deutsch](README.de.md)

把 [OpenCode](https://opencode.ai) 每一次 LLM step 的 token 用量和费用记录到本地 SQLite 数据库，并通过 `tokenmon` CLI 分析：可按时间段、项目、会话、模型、agent、命令、工具以及父子会话调用链统计，另有上下文构成估算、缓存使用、趋势、对比，以及与 Git/配置的关联分析。

- **精确值与估算值分开。** token 计数来自 OpenCode 自己的统计，可以与 OpenCode 的数据库对账。上下文构成是估算值，会明确标注。
- **费用是 OpenCode 按标价折算的金额（美元），不是 provider 的账单。** 没有已知价格的 step 显示为"不可用"，绝不显示为 $0。
- **只在本地运行。** 没有服务器，不发网络请求，不保存 prompt 或代码内容。

状态：0.1.0，已在 Linux x64 上用 OpenCode 1.18.34 测试。参见[兼容性](docs/COMPATIBILITY.md)和[已知限制](#已知限制)。

## 安装插件

以下方式**二选一**。重复加载会被检测并忽略，但请尽量避免。

**本地 bundle（推荐）：** 把发布文件 `opencode-token-monitor.js` 复制到 OpenCode 的全局插件目录：

```bash
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins"
cp opencode-token-monitor.js "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/"
# 如果已安装 CLI，也可以：
tokenmon install-plugin            # 遇到内容不同的同名文件会拒绝覆盖，除非加 --force（会保留备份）
```

**npm：** 在你自己的 `opencode.json` 里声明确切版本（尚未发布到 npm registry）：

```json
{ "plugin": ["opencode-token-monitor@0.1.0"] }
```

重启 OpenCode 即可，无需其他配置；Token Monitor 不会修改你的 `opencode.json`。

## 安装 CLI

- 发布页的独立二进制（`tokenmon-linux-x64`、`tokenmon-linux-arm64`、`tokenmon-macos-x64`、`tokenmon-macos-arm64`、`tokenmon-windows-x64.exe`），不依赖其他软件。macOS/Windows 二进制未签名，Gatekeeper/SmartScreen 可能要求确认（macOS 上可执行 `xattr -d com.apple.quarantine tokenmon-macos-*`）。
- npm：`npm install -g opencode-token-monitor`，需要 **Node ≥ 22.13**（使用 `node:sqlite`）或 Bun。

## 使用

```bash
tokenmon today                         # 今天按模型汇总（系统时区）
tokenmon week --tz Europe/Berlin       # 自然周，周一开始
tokenmon summary --last 24h --group-by project,agent
tokenmon summary --from 2026-10-01 --to 2026-10-06    # 只写日期的 --to 包含当天全天
tokenmon commands week                 # 每个命令的 direct / descendant / inclusive
tokenmon sessions                      # 根会话及整棵会话树的用量
tokenmon trace ses_xxx                 # 会话树、子会话、工具、命令
tokenmon context --by-source           # 估算的 prompt 构成 vs 精确的 prompt token
tokenmon cache month
tokenmon trend --bucket week
tokenmon compare last-week week        # 或：tokenmon compare --by fingerprint
tokenmon live                          # 今天用量的实时刷新视图
tokenmon import                        # 从 OpenCode 自己的数据库回填/对账
tokenmon doctor                        # 路径、schema、插件加载情况、问题
```

所有命令都支持 `--json`（稳定契约，`schemaVersion` 1.0.0），大多数支持 `--csv`，全部支持 `--redact-paths`。完整参考：[docs/CLI.md](docs/CLI.md)。

## 数据存放位置

优先 `$OPENCODE_TOKEN_MONITOR_DB`，其次 `$XDG_DATA_HOME/opencode-token-monitor/token-monitor.sqlite`，否则 `~/.local/share/opencode-token-monitor/token-monitor.sqlite`（所有系统规则相同，与 OpenCode 自己的数据目录一致）。插件和 CLI 使用同一个路径解析函数；`tokenmon doctor` 会显示实际使用的路径。

每台机器有自己的历史。卸载插件不会删除数据。如需删除历史，需显式执行：`tokenmon data prune --before 2026-01-01`、`tokenmon data vacuum` 或 `tokenmon data purge --yes`。

## 测量内容

| 输出 | 精度 | 来源 |
| --- | --- | --- |
| input / output / reasoning / cache read / cache write token | 精确（以 OpenCode 报告为准） | OpenCode `step-finish` 事件；可与 OpenCode 数据库对账 |
| 费用 | OpenCode 标价，美元 | OpenCode 的模型价格；无已知价格时显示 `n/a` |
| 命令、子会话、工具 | 已观察到的关联为精确值 | OpenCode hook；无法关联的项单独列出 |
| 上下文构成 | 估算（字符数 / 4） | system prompt、AGENTS.md、skills、工具定义、对话、工具结果 |
| Git 分支/commit/是否有未提交修改、配置指纹 | 按根会话记录 | 在项目目录运行 `git`；配置文件的加盐哈希 |

详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。Phase 0 结论见 [docs/API_SPIKE.md](docs/API_SPIKE.md)。

## 隐私

不保存 prompt 文本、代码、工具输入/输出、会话标题或命令参数，只保存计数、大小、id、模型名和路径。分享输出时请使用 `--redact-paths`。

## 已知限制

- OpenCode 不记录会话标题生成的用量；Token Monitor 会报告这类请求的次数，但无法统计其 token。
- `import` 无法从 OpenCode 数据库恢复非 subtask 的普通命令，只有实时运行的插件能看到它们。
- 目前只在 Linux 上用 OpenCode 1.18.34 和一个 OpenAI 兼容 provider 测试过；其他 provider、macOS 和 Windows 尚未验证。

## 许可证

[MIT](LICENSE)。插件 bundle 和 npm CLI 只包含本项目自己的代码。独立二进制额外内嵌了 [Bun](https://bun.sh) 运行时（MIT 许可，其中 JavaScriptCore/WebKit 组件为 LGPL-2），详见 Bun 的许可证。

## 开发

```bash
bun install
bun run check                     # 类型检查 + 单元/集成测试 + 构建
node --test tests/node/cli.test.mjs
OPENCODE_BIN=opencode bun tests/e2e/run-e2e.ts   # 真实 OpenCode + 模拟 provider
bun run build:binaries
```

另见 [AGENTS.md](AGENTS.md)、[docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md)，以及 [integrations/portable-profile](integrations/portable-profile/README.md) 中的 portable profile 集成工具包。
