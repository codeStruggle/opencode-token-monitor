# OpenCode Token Monitor — 方案 A 实施计划

版本：1.1  
日期：2026-10-06  
用途：交给 Codex、Claude Code 或 OpenCode，作为实现与验收依据。  
状态：产品边界与集成方案已确定；OpenCode API、插件运行时、宿主存储、SQLite 驱动与打包可行性须在 Phase 0 验证。

> 1.1 相对 1.0 的修改汇总见文末「附录 A：变更记录」。
>
> 本文中标记 **[待验证]** 的内容是基于既有认知的假设，必须在 Phase 0 以官方类型、源码和实际运行结果确认或推翻；推翻时按实际结果调整，并在 `docs/API_SPIKE.md` 记录。

## 1. 给实施代理的工作指令

实现独立项目 `opencode-token-monitor`，并在首个可发布里程碑（M1，见第 15 节）完成后，为现有 `opencode-portable-profile` 添加最小必要集成。Token Monitor 源码由独立仓库唯一维护；Profile 只消费固定版本的 release bundle。

实施前先读取两个实际仓库的 `AGENTS.md`、README、配置、安装脚本和已有测试。本计划基于用户提供的 Portable Profile README；当前尚未检查其完整源码，也未执行真实 OpenCode API spike。截至本版本，`opencode-token-monitor` 仓库为空仓库（无任何 commit）。实际仓库指令与本计划发生冲突时，明确指出冲突再处理，不要静默改变架构。

工作方式：

1. 先检查实际环境，明确假设与不确定性。
2. 按阶段实现；每阶段完成对应验证，记录证据，再推进依赖阶段。
3. 优先完成最小可运行的采集、持久化、查询与 CLI 闭环并尽早发布（M1），使真实数据尽早开始积累；再逐步加入完整分析能力。
4. 不为计划中的未来功能预先构建复杂框架；目录与文件按实际需要创建。
5. 仅修改与当前任务直接相关的代码，保留现有风格和项目级配置机制。
6. 所有源码、标识符、注释、日志、错误信息、测试名、配置键及开发者技术文档使用英文；与用户交流默认使用中文，支持德语和英语。
7. 不把未运行、未观察的测试记为通过；区分已验证、已知不兼容和未验证。
8. 遇到上下文即将不足或阶段性结束，更新英文交接文件，记录完成内容、关键决策、修改文件、实际验证结果、阻塞项和下一步；无法读取精确 token 余量时，不得伪造数值。
9. 某项能力经 Phase 0 证实不可获得时，以「unavailable + 证据」作为该项的合法结论，不得以推测或估算伪装补齐。

阶段状态与证据写入 `docs/IMPLEMENTATION_STATUS.md`，会话交接写入 `.opencode/HANDOFF.md`，以便不同编码工具继续工作。

## 2. 目标与完成范围

Token Monitor 是通用 OpenCode 插件与本地分析工具，用于：

- 保存 usage 与 cost，并标明其来源与精度（宿主记录、provider 报告或不可用）。
- 从 OpenCode 自身持久化数据回填历史，并以其作为 usage 对账基准（可行性经 Phase 0 确认）。
- 分析 project、session、command、agent、tool 与父子 session 调用链。
- 支持自然时间段、滚动时间段和自定义区间查询。
- 将精确 usage 与估算的 context attribution 分开显示。
- 分析 cache、趋势、配置变化和 Git 状态相关性。
- 提供可独立运行的 `tokenmon` CLI、稳定 JSON 输出、CSV 导出和 `doctor` 诊断。
- 通过同一 Analytics API 为将来的 Web UI 保留接口边界。

本计划包含 Phase 0–10 的完整范围，按三个里程碑交付（第 15 节）。里程碑可独立发布，但发布某个里程碑不等于整个计划完成。

本轮不实现 Web server/Web UI，不增加多设备数据同步，不重新设计 Profile，不安装或包装 OpenCode 本体。

## 3. 必须遵守的架构约束

| 约束 | 要求 |
| --- | --- |
| 源码所有权 | 仅 `opencode-token-monitor` 维护 Token Monitor 源码 |
| Profile 集成 | 消费明确版本、校验 checksum 的 release artifact |
| 产物维护 | Profile 内的 bundle 为生成文件，不允许手工修改 |
| 版本 | 不使用 `latest` 自动追踪，不自动升级 Profile 中的插件 |
| OpenCode 本体 | 独立安装、独立升级，Profile 不固定或替换 executable |
| 插件加载 | 使用 OpenCode 原生 global plugin 加载机制 |
| 单实例 | 同一进程内插件被多次加载（global/project/npm）时，只有一个实例注册采集；其余仅记录诊断 |
| 宿主安全 | 插件 hook 绝不向宿主抛出异常，不在热路径上执行阻塞式批量 I/O；采集失败不影响用户会话 |
| 配置 | 不为启用 Token Monitor 修改已有 `opencode.json` / `opencode.jsonc` |
| 配置层级 | 保留 OpenCode 原生 global/project 配置行为，不自建 loader |
| Portable 判断 | 插件不检测自己是否由 Portable Profile 安装 |
| Runtime 数据 | SQLite 始终与两个配置/源码仓库分离 |
| Schema 兼容 | 写入方遇到高于自身认知的 schema version 时停止写入并报告，不降级、不破坏数据；CLI 查询默认只读打开 |
| 环境变量 | 不修改 `XDG_CONFIG_HOME` / `XDG_DATA_HOME`，不引入特殊 portable runtime mode |
| 查询层 | CLI、JSON 和将来的 HTTP 共用 Analytics API |
| 插件职责 | 只采集和写入，不启动 Web server |
| 精度 | EXACT usage 与 ESTIMATED context attribution 不混为同一数据；cost 必带来源标记 |
| 隐私 | 默认不保存 prompt、源码、tool result 全文；内容指纹使用带本机随机 salt 的 HMAC |
| 卸载 | Profile 卸载不删除用户历史数据库 |

不引入 `portable-root/data/`、portable DB、用于 portable detection 的 `OPENCODE_TOKEN_MONITOR_HOME` 或特殊 `OPENCODE_CONFIG_DIR` override。

## 4. 两个仓库的职责

目标仓库：

- `codeStruggle/opencode-token-monitor`：源码、SQLite、分析、CLI、测试、安装支持、构建与 release。
- `codeStruggle/opencode-portable-profile`：携带已验证的固定 bundle、manifest、更新脚本、安装验证和说明。

实施时验证实际路径及权限，不假定远端仓库已存在或当前会话有访问权限。不把创建远端仓库、公开发布或推送代码视为本计划文件本身授予的操作权限。

跨仓库依赖：Phase 0–8 只需 Token Monitor 仓库；凡需 Profile 仓库的验证（真实 Profile commands、安装器行为）放在 Phase 9 / Phase 10，此前用模拟相同调用模式的 fixture 代替。

### 4.1 Token Monitor 建议结构

```text
opencode-token-monitor/
├── package.json
├── tsconfig.json
├── LICENSE
├── README.md            # Authoritative
├── README.zh-CN.md      # Translation, states the English version it is based on
├── README.de.md         # Translation, states the English version it is based on
├── src/
│   ├── plugin/        # Plugin entry, OpenCode adapter, single-instance guard, write queue
│   ├── collector/     # Session, command, tool and context collection
│   ├── importer/      # Backfill / reconciliation from OpenCode's own storage
│   ├── core/          # Normalized events, models and DTOs
│   ├── db/            # Thin Db interface, driver adapters, repository, migration runner
│   ├── analytics/     # Usage, trace, context, cache, trends, compare, git
│   ├── time/          # Range parsing and timezone boundaries
│   ├── runtime/       # Paths and runtime configuration
│   └── cli/           # Commands and renderers
├── migrations/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── fixtures/
│   └── e2e/
├── docs/
├── scripts/
└── dist/              # Build output
```

不建立 monorepo，不预先创建 `packages/core`、`packages/plugin`、`packages/cli`、`packages/web`。以上是职责划分，实施时合并不必要的小文件，避免为每个名词创建空模块。migration SQL 只维护一份权威来源。`importer/` 仅在 Phase 0 确认宿主存储可读后创建。

### 4.2 Profile 必要新增项

```text
profile/plugins/opencode-token-monitor.js
integrations/token-monitor/manifest.json
integrations/token-monitor/README.md
scripts/update-token-monitor.sh
scripts/update-token-monitor.ps1
```

仅对 `verify.sh`、`verify.ps1`、现有 installer/uninstaller 和 README 系列做必要修改；如果现有安装器已经正确管理 `plugins/`，不重复增加安装逻辑。

## 5. 安装与集成方案

### 5.1 固定单文件 bundle

目标产物：`dist/opencode-token-monitor.js`。

Profile 在 Git 中携带该 bundle，使 clone 后安装不需要联网下载 Token Monitor，checkout 历史 commit 可恢复对应配置和插件版本。Profile 中的 bundle 是 release artifact，不是第二套源码。

生成文件头至少包含：

```text
GENERATED FILE
Source: codeStruggle/opencode-token-monitor
Version: <release-version>
DO NOT EDIT
```

「self-contained」指第三方运行依赖尽量被打包；它不表示文件不依赖宿主运行时。插件 bundle 只需包含采集与写入路径，不打包 CLI 与分析代码。

OpenCode 插件运行于 Bun 运行时，可直接使用内建 `bun:sqlite` 而无需原生依赖 **[待验证]**。若成立，插件 bundle 使用 `bun:sqlite` 且不包含任何原生模块；若不成立，先给出证据和最小替代方案，再调整交付方式。

### 5.2 普通用户安装

支持两条路径，具体入口需经 Phase 0 验证：

1. npm plugin：用户在自己的配置中显式声明固定版本 `opencode-token-monitor@<version>`。
2. local bundle：通过 `tokenmon install-plugin` 或明确的手工步骤，安装同一个 release bundle 到标准 global plugins directory。

`install-plugin` 若发现目标目录为 symlink/Junction，必须保留其语义。已有同名插件或不同版本不能被无提示覆盖；安装行为应可检查、可回退。

重复加载防护：

- 插件入口使用进程级单例守卫（例如 `globalThis[Symbol.for("opencode-token-monitor")]`），记录已加载实例的版本与来源路径。
- 第二个实例不注册采集 hook，只记录一条诊断（含两者版本与路径）。
- 两个实例版本不同时，保留先加载者，诊断中明确提示版本冲突。
- 数据库唯一键去重是兜底，不是主要防线。
- `tokenmon doctor` 报告最近一次观察到的加载来源与重复加载情况。

普通用户显式选择 npm 安装可以修改自己的配置；Profile 的默认集成始终使用本地 bundle，不借此改动已有配置。

### 5.3 保持 Profile 现有路径

用户附带 README 定义：

| 平台 | 全局配置位置 |
| --- | --- |
| Linux / macOS | `${XDG_CONFIG_HOME:-$HOME/.config}/opencode` |
| Windows，设置 XDG_CONFIG_HOME | `$env:XDG_CONFIG_HOME\opencode` |
| Windows，未设置 XDG_CONFIG_HOME | `$HOME\.config\opencode` |

安装器管理 `AGENTS.md`、`agents/`、`skills/`、`commands/`、`tools/`、`plugins/`；已有路径替换前备份。Windows 目录使用 Junction，单独文件优先 symlink，受策略限制时回退为复制。

仅当 `opencode.json` 与 `opencode.jsonc` 都不存在时，现有安装器才提供最小配置。Token Monitor 不改变该规则。

### 5.4 项目级行为

继续允许 project 的 `AGENTS.md`、`opencode.json` 和 `.opencode/{agents,skills,commands,tools,plugins}` 按原生规则工作。同名 command 的项目覆盖与插件加载顺序须分别实测，不能假定所有配置类型都采用同一种覆盖方式。

插件不硬编码 Profile 名称或 `/security-review` 等命令，只记录实际观察到的 command、agent、skill 和来源路径。

## 6. Runtime 数据与卸载

### 6.1 数据库位置

默认数据目录与 OpenCode 自身数据目录约定保持一致，使用户在熟悉的位置找到数据，并使路径解析在各平台使用同一规则。OpenCode 在所有平台都使用 XDG 风格目录 **[待验证]**；若成立，默认：

| 平台 | 默认数据库 |
| --- | --- |
| 所有平台 | `${XDG_DATA_HOME:-$HOME/.local/share}/opencode-token-monitor/token-monitor.sqlite` |

若 Phase 0 证实 OpenCode 在 macOS/Windows 使用平台原生目录，则改为与 OpenCode 一致的平台目录（如 macOS `~/Library/Application Support/`、Windows `%LOCALAPPDATA%`），并在 `docs/API_SPIKE.md` 记录依据。无论哪种选择，发布后不得静默改变默认路径；如需迁移，提供显式迁移命令并保留旧文件。

显式 override：`OPENCODE_TOKEN_MONITOR_DB`。插件和 CLI 必须共用同一个路径解析函数，`tokenmon doctor` 报告实际使用的路径与其决定原因（override / XDG / 默认）。遵循现有环境变量，不主动修改它们。

不同设备默认各有自己的历史。多设备 export/import、merge、remote backend 属于未来范围。

### 6.2 保留、维护与卸载

- 首次运行前没有 SQLite 是正常状态；Profile 安装验证不能要求数据库已经存在。
- 卸载只移除自身管理的插件与配置并按原有规则恢复备份，不删除 SQLite、WAL 或历史。
- 数据维护命令均需用户显式执行，不由卸载或升级流程隐式调用：
  - `tokenmon data prune --before <date>`：删除早于指定时间的明细（保留规则在文档中明确）。
  - `tokenmon data vacuum`：回收空间。
  - `tokenmon data purge`：删除全部数据，需交互确认或 `--yes`。
- 文档给出每千次 LLM step 的大致数据库体积，供用户评估保留策略（数值来自实测）。

## 7. Phase 0：真实 API 与运行时验证

在确定数据库驱动、插件入口、采集策略和最终数据模型前，验证当前 OpenCode 官方文档、类型定义、源码和真实运行行为。记录测试使用的 OpenCode 版本、操作系统、运行时和命令。

### 7.1 插件与运行时

- 本地 `.js/.ts` global plugin 是否自动加载，采用什么 export/module 格式？
- npm plugin 的入口与 local bundle 是否使用相同 adapter？
- 插件宿主是否为 Bun？`bun:sqlite` 是否可用？同步写入对宿主事件循环的实际影响（测量单次与批量事务耗时）。
- global、project、npm 插件同时存在时，原生加载/执行规则是什么？同一插件是否会在同一进程中被加载多次？
- CLI 的 npm 运行时要求：Node 版本下 `node:sqlite` 是否可用（需 Node ≥ 22.13 **[待验证]**）；standalone binary（`bun build --compile`）能否在无 Bun CLI 的机器运行，体积多大？

### 7.2 Usage 与 cost 语义

- 哪个事件或 hook 可作为可靠的 LLM request/step 完成来源？候选：`message.updated`（assistant message 完成）与 `message.part.updated` 中的 `step-finish` part **[待验证]**。
- usage 字段（input/output/reasoning/cache read/cache write）含义是什么？reasoning 与 cache 是否已包含在 input/output 中？是否存在字段缺失或重复包含？
- **cost 的来源**：是 provider 报告的计费值，还是 OpenCode 依据 models.dev 等价格表计算的值 **[待验证]**？订阅类 provider（例如 Claude Pro/Max、GitHub Copilot）与自定义 provider 下 cost 的取值是什么（0、null 或其他）？
- streaming 过程中同一 message/part 被更新多少次？何时 usage 成为最终值？retry、abort、restart、重复事件如何表现？
- 能否稳定获得 message、step/part、session、parent session、provider、model、agent 的标识？哪个标识可作为去重键？

### 7.3 宿主存储（回填与对账）

- OpenCode 自身在何处、以何种格式（JSON 文件或数据库）持久化 session、message 及其 tokens/cost **[待验证]**？格式是否随版本变化？
- 是否存在官方的统计输出（例如 `opencode stats`）**[待验证]**，其口径是什么？
- 从宿主存储读取是否只需读权限、是否会与运行中的 OpenCode 冲突？

### 7.4 Command、tool、context

- command 调用、tool 开始/结束、child session 创建及其因果关系如何获取？
- 可观察哪些 context 内容与来源（例如 `chat.params`、system prompt transform 类 hook **[待验证]**）？哪些只能估算，哪些无法获得？

### 7.5 产出

- `docs/API_SPIKE.md`：事实、限制、版本与选型依据。
- **采集策略决策记录**：在以下方案中择一并给出证据：
  - (a) 仅插件采集；
  - (b) 仅读取宿主存储；
  - (c) 混合：usage 以宿主存储为准或交叉验证，插件负责 command/tool 因果、context 证据、Git 与 fingerprint 等宿主不保存的信息。
  
  在宿主存储可稳定读取的前提下，优先评估 (c)。
- **SQLite 驱动决策**：插件端驱动、CLI 端驱动（Bun 编译 binary 与 npm CLI 分别说明）。
- 经过脱敏的真实 event fixtures 与宿主存储样本，注明来源；synthetic fixture 明确标识。
- 最小 plugin load、SQLite 写入、CLI 读取及 bundle smoke test。
- 已验证的数据字段映射与 capability 表（每项为 available / partial / unavailable，附证据）。

关卡：未通过真实加载和数据库写入验证前，不宣称单文件发布方案已可行；缺失能力不得靠推测补成 EXACT。

## 8. 数据模型、持久化与精度

### 8.1 OpenCode Adapter

OpenCode-specific 字段只在 adapter（插件 adapter 与 importer）中解析，输出内部 normalized events。Analytics 不直接引用宿主原始结构。未知字段和版本变化不应破坏用户的 OpenCode 会话；无法解析的事件计入诊断计数而不是抛出异常。

初始 usage event 可参考以下字段，最终依据 Phase 0 调整：

```ts
type CostSource = "host_computed" | "provider_reported" | "unavailable"
type UsageOrigin = "plugin" | "import"

type ModelUsageEvent = {
  dedupKey: string            // Derived from verified host identifiers
  sessionId: string
  messageId?: string
  stepId: string
  timestamp: number           // UTC epoch milliseconds
  provider: string
  model: string
  agent?: string
  inputTokens: number | null
  outputTokens: number | null
  reasoningTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  cost: number | null
  costCurrency: string | null
  costSource: CostSource
  final: boolean              // false while streaming; only final rows count toward totals
  origin: UsageOrigin
  pluginVersion: string
  hostVersion: string | null
}
```

规则：

- 缺失值与真实零值分开。不要假设五种 token 字段可以简单相加；先确定 reasoning/cache 是否已经包含在其他字段内。保留原始 usage 语义与来源，再定义展示/聚合规则。
- cost 必须带来源标记。由宿主按价格表计算的值在文档和 CLI 中称为「按标价折算（list-price estimate）」，不得称为「实际费用」或「账单」。
- 订阅类 provider 下 cost 为 0 时，若 Phase 0 证实该 0 并非真实计费值，存为 `null` + `costSource = "unavailable"`，不当作真实零；判断规则在 adapter 中集中维护并有测试。
- 同一 dedupKey 的插件记录与导入记录合并为一行；以哪个来源为准由 Phase 0 的采集策略决定，并在行上保留两者是否一致的标记，用于对账。

### 8.2 SQLite 实体

完整范围需要考虑：`projects`、`sessions`、`messages`、`command_runs`、`tool_runs`、`llm_steps`、`context_sources`、`git_snapshots`、`diagnostics` 和 schema version。

以实际已验证标识建立关系，支持 parent/child session、message/step、command/tool 因果关联。不必一次创建所有未来表，但 early schema 必须避免阻断后续 trace 与 context 扩展。

### 8.3 写入路径

- 插件 hook 只做轻量解析并放入内存队列；在 step/message 完成或短定时器触发时，以单个事务批量 upsert。
- streaming 中间更新按 dedupKey upsert 覆盖，只有 `final = true` 的记录计入统计。
- 所有 hook 包裹 try/catch；异常写入诊断表或日志，不向宿主传播。
- OpenCode 进程正常退出时尽力 flush 队列；异常退出导致的未完成 step 不伪造成成功或零消耗，可由 importer 在下次回填时补齐。

### 8.4 Migration 与并发

- migration 具有版本和事务边界，使用 `BEGIN IMMEDIATE` 获取写锁后再检查 `user_version`，保证多个实例同时启动时只有一个执行迁移，失败不留下半完成结构。
- 写入方读取到的 schema version 高于自身支持版本时：停止写入，记录诊断，不尝试降级；`tokenmon doctor` 明确提示需要升级的组件。
- 实测多 OpenCode 实例写入与 CLI 同时读取；据结果配置 WAL 与 busy timeout。CLI 查询命令以只读方式打开数据库，仅 `import`、`data *` 等维护命令以读写方式打开。
- restart 后历史保留并继续使用同一数据库。

### 8.5 隐私

- 默认不保存完整 prompt、源码或 tool result；分析所需元数据、长度与估算值按最小需求保存。
- 内容指纹（用于去重或 fingerprint）使用 HMAC，key 为首次运行时生成并保存在本机数据目录的随机 salt，避免短文本被字典还原。
- project 绝对路径属于敏感信息：CSV/JSON 导出提供 `--redact-paths` 选项。
- telemetry 失败不破坏用户任务；错误可诊断，不静默宣称采集成功。

## 9. Command、Tool、Agent 与调用链归因

目标：root/child session 的使用量能够关联到实际触发的 command/agent，并可追踪工具调用。

Profile 中的真实命令及其调用模式：

| Command | README 中的默认执行方式 | 调用模式 |
| --- | --- | --- |
| `/review` | `code-reviewer` child session | child |
| `/security-review` | `security-auditor` child session | child |
| `/verify` | `build` child session | child |
| `/handoff` | 当前 `build` session | same-session |
| `/project-docs` | 当前 `build` session | same-session |

Phase 4 使用模拟 child、same-session、nested child 及并发调用模式的 fixture 完成验收，不依赖 Profile 仓库；真实 Profile commands 的端到端验证放在 Phase 10。

例如 `/security-review`：root 22K，child 91K，则 inclusive 为 113K。该数字仅示意；验收使用实际采集值。

- exclusive：当前对象直接拥有的 usage。
- inclusive：当前对象及**可明确关联**的后代的 usage；无法关联的部分单独列为 unattributed 行，不并入任何 inclusive。
- 总 usage 以去重后的 final LLM steps 为基础；不能把 inclusive 父行和 child 行再次相加。
- tool 自身的执行元数据不等于 provider 计费 token；工具结果导致的后续输入是另一层归因。
- 并发 commands、多个 child、retry 和中止必须有测试；不能仅凭时间重叠断言因果关系。
- 无法可靠关联时显示 unknown/unattributed，不强行挂到最近 command。

验收：session 总量与去重 step 总量一致；command 的 direct/descendant 归因可解释，存在未知项时明确列出。

## 10. 时间查询与 Analytics API

支持：`today`、`yesterday`、`week`、`last-week`、`month`、`last-month`；`--last 1h/24h/7d/30d`；`--from` 与 `--to`。

已确定的语义（属于 CLI 与 JSON 契约）：

- 数据库时间统一使用 UTC epoch 毫秒。
- 内部查询一律采用半开区间 `[start, end)`。
- 自然日/周/月按所选 timezone 计算；默认系统本地 timezone，支持 `--tz <IANA>` 显式选择。
- 一周起点为周一（ISO 8601）。
- `--from`：date-only 表示该日 00:00（所选 timezone）；带时间则为该时刻。
- `--to`：date-only 表示**包含该日全天**，内部解析为次日 00:00 作为排他上界；带时间则为排他上界本身。
- 无 timezone 的日期时间输入按所选 timezone 解释；带偏移或 `Z` 的输入按其自身偏移解释。
- CLI 文本输出与 JSON 均回显实际解析后的区间（start、end、timezone），消除歧义。
- 滚动区间（`--last`）按绝对时长计算；自然日按日历边界计算，不用固定 24 小时替代 DST 日边界。
- 必测 Europe/Berlin 夏令时开始/结束、周界、月末、跨年、范围内无数据及起止边界事件。

查询层顺序：SQLite → Repository → Analytics/Query Service → DTO → CLI/JSON/未来 HTTP。

例如 `queryUsage({ range, timezone, groupBy, filters })`；CLI 不自行写 SQL。至少支持已采集的 project/session/provider/model/command/agent 维度，tool/context 维度使用其各自明确的度量语义。

稳定 DTO：`UsageSummary`、`UsageBreakdown`、`SessionTrace`、`ContextAnalysis`、`CacheAnalysis`、`TrendSeries`、`ComparisonResult`。按实现进度定义，不预先写空 API 框架。

`--json` 为可机器消费的契约，包含 `schemaVersion`、resolved range、timezone、totals、groups，以及精度/缺失/cost 来源信息。不加入纯终端展示标题或 ANSI 控制字符。单位、null 语义、排序规则须明确。

JSON 契约版本策略：`schemaVersion` 采用 semver。新增字段为 minor；删除字段、改名或改变既有字段语义为 major，并在 CHANGELOG 中记录。消费者应忽略未知字段。

## 11. Context 与 Cache 分析

精确 usage 与 estimated attribution 分开存储、计算和呈现。

Context 可按可观察证据区分 system、AGENTS.md、skills、conversation、tool results、user 与 unknown。每个估算结果注明方法、来源可见性和适用范围。

- 不宣称能精确拆分 provider 的 inputTokens。
- 不把原始文本 tokenizer 估算直接当作 provider 计费值。
- 如果估算需归一化到实际 input，明确标注为分配结果，并保留原始估算。
- coverage 明确定义分母和公式；coverage 不等于估算准确率。
- unknown 残差和重复来源有明确处理，不能产生负数或虚假覆盖率。
- cache read/write 采用已验证的 provider 语义；ratio 定义有固定分母。
- 未知 cache 指标显示不可用，而不是 0% 或虚构「节省费用」。

计划中示例实际 input 47,820 与各来源估算仅用于说明界面，不能作为真实测试证据。所有展示示例必须满足其声明的公式。

可行性说明：Context 归因是本计划中可行性风险最高的部分。若 Phase 0 证实某些来源（例如 system prompt 内容）对插件不可见，Phase 5 以「该来源 unavailable + 证据」为合法交付，只对可观察来源提供估算；cache 分析不受此影响，照常交付。

## 12. History、Compare、Git 与配置 Fingerprint

- 提供历史趋势、区间比较和可解释的差异结果。
- Git 信息来自被 OpenCode 操作的 project：commit、branch、dirty 状态；不把 Profile 仓库 commit 当作项目 commit。
- 非 Git project 正常工作，Git metadata 为 unavailable。
- 记录 pluginVersion 与 OpenCode 版本，以便识别采集器与宿主版本差异。
- configFingerprint 可基于实际观察到的 AGENTS、agents、skills、commands 配置来源计算 HMAC，不保存全文。
- fingerprint 使用稳定排序和明确的来源范围；全局/项目覆盖、symlink/Junction 和缺失项有一致处理。
- 若只能观察部分配置，标记范围，不能宣称 fingerprint 代表全部生效配置。
- 配置 A/B 的 token 差异是关联证据，不自动证明配置导致差异；比较同时展示任务数量、模型和样本规模等必要上下文。

## 13. CLI 与跨平台交付

### 13.1 命令范围

计划 CLI 范围：usage summary、today/yesterday/week/month、inspect/trace、context、cache、trend、compare、live、import、doctor、data（prune/vacuum/purge）、JSON 和 CSV。具体子命令命名在 Phase 0 后统一，避免重复入口。

- CLI 必须可在 OpenCode 未运行时查询历史。
- `live` 只读取数据库（定时轮询，刷新间隔可配置），不要求插件启动 server。
- `import` 从 OpenCode 宿主存储回填历史；幂等，重复执行不重复计数；输出新增、已存在、与插件记录不一致的条数。
- `doctor` 输出：实际 DB 路径及决定原因、schema 版本与各组件支持版本、最近一次写入时间、插件加载来源与重复加载诊断、最近错误摘要。

### 13.2 运行时与产物

CLI 以 standalone binary 为主要分发形式（Bun 编译，内含 `bun:sqlite`）**[待验证]**；npm CLI 为次要形式，其运行时要求在 Phase 0 后确定并在 `package.json` `engines` 与 README 中明确，二选一：

- Node ≥ 22.13（使用 `node:sqlite`）**[待验证]**；或
- 需要 Bun。

不能假设 OpenCode 内部使用 Bun，就代表用户 PATH 中有 `bun`；需要 Bun 时不能描述为仅需 Node/npm。

SQLite 访问通过一个很薄的 `Db` 接口（`exec` / `prepare` / `transaction`）隔离驱动差异，每个驱动一个实现；Repository 与 Analytics 只依赖该接口。不为未使用的驱动编写实现。

目标 standalone assets：

```text
tokenmon-linux-x64
tokenmon-linux-arm64
tokenmon-macos-x64
tokenmon-macos-arm64
tokenmon-windows-x64.exe
```

- standalone 产物必须在不安装 Bun CLI 的环境做 smoke test。跨编译成功不等于目标平台已运行验证。
- 记录各产物体积。
- macOS 未签名/未公证的二进制会被 Gatekeeper 拦截，Windows 未签名二进制可能触发 SmartScreen：首版若不签名，在 README「已知限制」中写明并给出放行步骤；签名/公证作为后续增强，取决于实际可用的证书与发布权限。

Profile 默认只带 plugin，不安装 CLI，不修改 PATH，不隐式写 `/usr/local/bin` 或 `~/.local/bin`。可选 `--with-tokenmon-cli` 留作以后需求，首版不实现。

## 14. Release、Manifest 与 Profile 更新

### 14.1 Token Monitor Release

同一源码构建 npm package、单文件 plugin bundle 和 CLI binaries。CI 执行类型/静态检查、相关单元测试、SQLite integration、OpenCode fixtures、打包与 checksum。

M1（v0.1）最小 release 只需：

```text
opencode-token-monitor-<version>.tgz
opencode-token-monitor.js
checksums.txt
```

M3（v1.0）完整 release：

```text
opencode-token-monitor-<version>.tgz
opencode-token-monitor.js
tokenmon-linux-x64
tokenmon-linux-arm64
tokenmon-macos-x64
tokenmon-macos-arm64
tokenmon-windows-x64.exe
checksums.txt
```

建立 compatibility matrix，记录 Token Monitor/OpenCode 版本、平台、测试范围和证据。使用 tested / known incompatible / unknown，不凭空声明全面兼容。

LICENSE 依据实际项目授权选择并检查依赖分发许可，不在本计划中假定授权类型。release/npm publish 使用仓库实际的发布权限与流程。可选增强：为 release 产物生成 GitHub artifact attestation，用于验证产物来源。

### 14.2 Profile Manifest

示例形状，所有占位符必须在集成时替换为真实值：

```json
{
  "name": "opencode-token-monitor",
  "version": "<exact-release-version>",
  "source": "https://github.com/codeStruggle/opencode-token-monitor",
  "artifact": "profile/plugins/opencode-token-monitor.js",
  "sha256": "<actual-artifact-sha256>",
  "dbSchemaVersion": "<schema-version-written-by-this-release>",
  "testedWith": {
    "opencode": ["<actually-tested-version>"]
  }
}
```

### 14.3 更新脚本

`scripts/update-token-monitor.sh <version>` 与 PowerShell 等价脚本：

1. 要求明确版本，拒绝隐式 latest。
2. 从对应 release 下载 bundle 与 checksum 至临时位置。
3. 校验版本、文件与 SHA256；缺失或不匹配立即停止，保留原 bundle/manifest。
4. 更新 bundle 与 manifest，运行相关 verify；失败时恢复原有集成状态。
5. 显示变更（含 schema 版本变化）和验证结果，不自动 commit/push。

SHA256 检查只表示文件与选定 checksum 一致，不应宣称它本身验证发布者身份。降级到写入更低 schema 版本的插件时，脚本提示：已被新版本迁移的数据库将使旧插件停止写入（见第 8.4 节）。

### 14.4 Profile Verify

在现有检查之外验证 plugin 文件、固定版本、manifest 和实际 SHA256；保留 symlink/Junction 行为。数据库尚未创建或 CLI 未安装不视为 Profile 安装失败。

## 15. 里程碑、分阶段实施与验收

### 15.1 里程碑

| 里程碑 | 包含阶段 | 目的 |
| --- | --- | --- |
| M1 — v0.1「采集先行」 | Phase 0、1、2、3、8a、9 | 尽早发布可用的精确 usage 采集、回填与基本查询，并接入 Profile，开始积累真实数据 |
| M2 — v0.2+「完整分析」 | Phase 4、5、6、7 | 调用链、context/cache、history/compare/Git、完整 CLI；可按阶段逐次发布 minor 版本 |
| M3 — v1.0「全平台交付」 | Phase 8b、10 | 全平台 standalone binaries、兼容矩阵与最终端到端验收 |

M2 各阶段如需 schema 变更，必须通过 migration 兼容 M1 已积累的数据。

### 15.2 阶段

| 阶段 | 实现内容 | 验证与交付关卡 |
| --- | --- | --- |
| Phase 0 — API Spike | 真实事件、宿主存储、plugin/runtime、SQLite 驱动、bundle/CLI 可行性、采集策略决策 | API_SPIKE、采集策略与驱动决策记录、真实脱敏 fixtures、加载/写入/读取 smoke test |
| Phase 1 — Core + SQLite | normalized events、Db 接口、schema、migration、dedup、repository、单例守卫、写入队列 | 重复/更新事件不重复计数；并发 migration、schema 版本过高停止写入、restart integration tests；hook 异常不外泄 |
| Phase 2 — Exact Usage | provider/model/timestamp/token/cost/costSource/session 采集；`import` 回填 | 以宿主存储（或经 Phase 0 确认的官方统计）为基准的可重复对账测试；字段语义、null、单位、cost 来源明确；订阅模式 cost 处理有测试 |
| Phase 3 — Time Analytics | 自然段、滚动段、自定义范围、group/filter、DTO；最小 CLI（summary、JSON、doctor） | DST/周/月/年边界、`--from/--to` 语义与 `[start,end)` 测试；回显解析后的区间 |
| Phase 8a — Minimal Release | npm package、plugin bundle、checksums、release workflow | 干净环境安装 npm 与 bundle；bundle 在真实 OpenCode 中加载并写入 |
| Phase 9 — Profile Integration | bundle/manifest/update scripts/verify/docs | 不改已有配置；checksum 失败不破坏旧安装；link/Junction 保持；无数据库时 verify 通过 |
| Phase 4 — Command/Tool/Agent | parent-child trace、exclusive/inclusive、因果关联 | child/same-session/nested/并发/中止/重试 fixture；无 double count；unattributed 单独列出 |
| Phase 5 — Context + Cache | 来源估算、coverage、cache 指标 | EXACT/ESTIMATED 分离；unknown 与分母语义测试；不可观察来源以 unavailable + 证据交付 |
| Phase 6 — History/Compare/Git | trends、compare、project Git、configFingerprint | 已知差异 fixture、非 Git、配置哈希稳定性；差异可解释 |
| Phase 7 — 完整 CLI | inspect/context/cache/trend/compare/live/CSV/data 维护命令 | OpenCode 不运行也能查历史；JSON 契约（semver）与 CSV 输出测试；`--redact-paths` |
| Phase 8b — Full Release | 全平台 standalone binaries、兼容矩阵、已知限制 | 目标平台实机 smoke test（无 Bun CLI）；记录体积；未验证平台明确标记 |
| Phase 10 — Final E2E | 正常 prompt、真实 Profile commands、subagent、tool、多模型、restart | 完整调用链、持久化、统计对账与最终验收报告 |

Phase 7 是完整 CLI 阶段；最小读取与查询 CLI 在 Phase 3 完成，Phase 0–3 就要能验证「采集 → SQLite → analytics → CLI」闭环。

## 16. 最终测试 Matrix

| 场景 | 必须检查 |
| --- | --- |
| 普通 OpenCode + npm | 正确加载与采集，文档入口可用 |
| 普通 OpenCode + local bundle | 同一逻辑，第三方依赖无漏包 |
| 插件重复加载（global + project / npm + bundle） | 只有一个实例采集；诊断给出两者版本与路径；无重复计数 |
| Profile Linux/macOS | 标准目录、链接、安装/重装/卸载 |
| Profile Windows | Junction、文件 symlink/copy fallback |
| 已有 opencode.json/jsonc | 安装前后内容和相关配置保持原样 |
| 项目级配置 | agents/skills/commands/tools/plugins 原生行为保持 |
| OpenCode 升级 | Profile 不绑定 executable；兼容记录真实 |
| root/child/nested child | 正确因果归因，exclusive/inclusive 不重复累加 |
| 重复/更新/retry/abort | 幂等，缺失信息不伪造成零或成功；streaming 中间值不计入统计 |
| 多实例写入 + CLI 读取 | 数据一致，不破坏宿主会话 |
| 多实例同时首次启动 | migration 只执行一次，无半完成结构 |
| schema 版本错位 | 旧版本写入方停止写入并报告；数据未被破坏 |
| 宿主热路径性能 | 采集开启前后单次 step 的额外延迟在文档声明的范围内（数值来自实测） |
| SQLite restart | 历史保留并继续使用同一数据库 |
| `import` 回填与对账 | 幂等；与插件记录一致或明确列出差异 |
| 订阅类 provider | cost 不被当作真实零；显示 unavailable 或按标价折算并标注 |
| Profile uninstall/reinstall | 数据库保留，旧历史可继续查询 |
| 新机器无 SQLite/CLI | Profile verify 不误报失败 |
| explicit DB override | 插件与 CLI 使用同一个 override 路径；doctor 报告原因 |
| Europe/Berlin DST | 自然日边界与滚动时间按声明语义工作 |
| `--from` / `--to` date-only | 包含语义与回显区间一致 |
| Context/cache 数据缺失 | 清楚显示 estimated/unknown/unavailable |
| 隐私 | 数据库中无 prompt/源码全文；指纹为 HMAC；`--redact-paths` 生效 |
| updater checksum 错误 | 旧 bundle 与 manifest 保持一致且未被破坏 |
| CLI 无 OpenCode/Bun CLI | standalone 可运行；npm 路径明确其依赖 |
| macOS/Windows 未签名二进制 | 已知限制与放行步骤与实际行为一致 |

## 17. 完成定义与交接要求

### 17.1 里程碑完成

每个里程碑完成时：所含阶段的关卡全部满足；release 产物与 checksum 可重复构建；README（英文为权威版本）、已知限制、兼容矩阵与实施状态反映该里程碑的实际结果。里程碑完成不得表述为整个计划完成。

### 17.2 整个计划完成

只有以下条件均满足，才能宣布完整计划完成：

- 独立 Token Monitor 源码、采集/数据库/分析/CLI 闭环和完整功能实现。
- 实测 usage 来源，并与宿主存储（或已确认的官方统计）对账；完整 trace 不丢失已知 child usage，也不重复统计。
- cost 来源与语义有文档，未把按标价折算的值称为实际费用。
- 时间、context、cache、trend/compare/Git 语义有文档和针对性验证；不可获得的能力以 unavailable + 证据记录。
- npm、单文件 bundle、目标 CLI binaries 和 checksum 有可重复构建流程；未验证平台明确标记。
- Profile 只增加固定 release 消费，不产生源码分叉，不更改现有配置/层级规则。
- 安装、更新、卸载与重装测试覆盖历史数据保留及链接语义。
- 英文 README 为权威版本；中/德 README 标注其所依据的英文版本，CI 检查版本标记与英文版一致。兼容矩阵、已知限制和实施状态与实际结果一致。
- 最终报告列出修改文件、实际运行的验证、结果、未完成项和风险，不把占位符或 synthetic fixture 当作真实证据。

若受 API 能力、平台环境或权限阻塞，交付已完成部分和可复现的阻塞证据；不能以虚构实现填补缺口，也不能把完整范围擅自缩小为只做 token summary。

## 18. 可直接使用的启动提示词

将本文件交给编码代理，并给出两个仓库的实际路径后，可以使用：

```text
Read docs/opencode-token-monitor-plan-A.md (v1.1) and the repository
instructions first. Implement Plan A in the actual repositories, starting
with Phase 0 and milestone M1.

In Phase 0, verify the current OpenCode API, plugin runtime (Bun and
bun:sqlite), usage and cost semantics (including where cost comes from and
how subscription providers report it), OpenCode's own persisted storage,
and SQLite driver options for both the plugin and the CLI. Record a
collection-strategy decision (plugin / host storage / hybrid) and a driver
decision with evidence before choosing implementation details. Treat every
item marked [待验证] as an assumption until verified.

Keep Token Monitor as the sole source repository. The portable profile only
consumes a pinned generated release bundle. Preserve existing opencode.json/
opencode.jsonc, native project/global behavior and installer link semantics.
Keep runtime SQLite outside both repositories. Never delete user history as
part of profile uninstall. Do not add a web server or portable runtime mode.

The plugin must never throw into or block the host, must guard against being
loaded twice, and must stop writing if the database schema is newer than it
understands. Deliver a working collection -> SQLite -> analytics -> CLI path
and a minimal release in M1, then complete M2 and M3 with evidence. Keep
exact usage separate from estimated attribution and label the cost source.
Use English for code and technical repository docs. Update implementation
status and the handoff file as work progresses. Report actual checks,
missing capabilities and blockers honestly.
```

## 19. 依据与待验证来源

- 用户提供的 `README(1).md`：Portable Profile 的安装路径、配置边界、commands、语言策略与卸载规则已核对。
- 当前对话中的方案 A：独立源码仓库 + single-file release bundle + Profile 固定版本消费。
- 方案 A v1.0 的评审意见（见附录 A）。
- OpenCode 官方插件文档：<https://opencode.ai/docs/plugins/>。
- OpenCode 官方仓库：<https://github.com/anomalyco/opencode>。
- Bun SQLite 文档：<https://bun.sh/docs/api/sqlite>。
- Node.js `node:sqlite` 文档：<https://nodejs.org/api/sqlite.html>。

后四项是 Phase 0 需要重新检查的技术来源，本次保存计划没有执行实时 API 验证。实现时以实际版本的官方类型、源码和运行证据为准。

## 附录 A：变更记录（v1.0 → v1.1）

| # | 变更 | 涉及章节 |
| --- | --- | --- |
| 1 | cost 增加 `costSource`/`costCurrency`；宿主按价格表计算的值称为「按标价折算」；订阅模式下的 0 不当作真实零 | 3、7.2、8.1、16、17 |
| 2 | Phase 2 对账明确以 OpenCode 宿主存储或已确认的官方统计为基准，并写成可重复测试 | 7.3、15、17 |
| 3 | 新增宿主存储回填（`tokenmon import`）与采集策略决策（plugin / 宿主存储 / 混合） | 2、4.1、7.3、7.5、13.1 |
| 4 | 插件端 `bun:sqlite` 与 CLI 端驱动分开决策；引入薄 `Db` 接口；CLI 以 standalone binary 为主，npm CLI 明确 runtime | 5.1、7.1、13.2 |
| 5 | 并发 migration（`BEGIN IMMEDIATE` + `user_version`）；schema 版本过高时停止写入；CLI 只读打开 | 3、8.4、14.3、16 |
| 6 | 插件进程级单例守卫与重复加载诊断 | 3、5.2、16 |
| 7 | 写入队列批量事务、streaming upsert、`final` 标记、hook 异常隔离 | 3、8.3、16 |
| 8 | 拆分三个里程碑；最小 release（8a）与 Profile 集成（9）提前到 M1 | 1、2、14.1、15、17 |
| 9 | Phase 5 允许以「unavailable + 证据」交付不可观察的 context 来源 | 1、11、15 |
| 10 | Phase 4 改用调用模式 fixture，真实 Profile commands 移到 Phase 10；明确跨仓库依赖 | 4、9、15 |
| 11 | 新增 `doctor` 与 `data prune/vacuum/purge`、数据库体积说明 | 2、6.2、13.1 |
| 12 | JSON 契约 `schemaVersion` 采用 semver 策略 | 10 |
| 13 | 记录二进制体积；写明 macOS/Windows 未签名限制；可选 artifact attestation | 13.2、14.1 |
| 14 | 内容指纹改用带本机 salt 的 HMAC；导出提供 `--redact-paths` | 3、8.5、12、16 |
| 15 | 默认数据库目录改为与 OpenCode 自身约定一致（XDG 风格，待验证），并禁止发布后静默改变 | 6.1 |
| 16 | 周起点固定为周一；`--to` date-only 包含当日全天；回显解析后的区间 | 10、16 |
| 17 | inclusive 只含可明确关联的后代，unattributed 单独列行 | 9 |
| 18 | 英文 README 为权威版本，翻译版标注依据版本并由 CI 检查 | 4.1、17 |
| 19 | manifest 增加 `dbSchemaVersion`；更新脚本提示降级风险 | 14.2、14.3 |
