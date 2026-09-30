# ⚡ 雷仔 LEIZAI — 自我进化型智能体

雷仔是一个**独立运行在你电脑上**的自我进化型智能体，基于 DeepSeek 大模型构建。
灵感来自开源项目 [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent)（Prime Intellect 的 RLM harness：一个"把自身提示词当数据、自我改进"的智能体运行时），并按你的要求做到了：

1. **全部能力同构复刻**（进化、记忆、技能、子智能体、长时自治目标、断线续跑、守护式运行）；
2. **真正的智能体补齐**：**持久 Python REPL 内核（RLM）**、**agent 间直接通信**、**心跳/定时调度**、**可执行技能包**；
3. **权限给到最大**：fullAccess 模式——文件工具不限目录、命令黑名单关闭、SSRF 防护关闭，子智能体拥有全工具（读写文件 / 跑命令 / 进化 / 派孙级）；
4. **DeepSeek 专项调优**：稳定前缀设计 → 实测**缓存命中率 95%+**，平均首 token 延迟约 1s 级。

界面为**扁平化纯黑 · 简约炫酷 · 动态元素拉满**的雷系闪电风格。**网页版已弃用**，唯一界面是原生 Windows 桌面客户端。

---

## 快速开始

**双击桌面的「雷仔」图标** → 弹出**雷仔自己的桌面程序窗口**（`LeiZai.exe`）。

**这是 100% 原生 Windows 程序**（.NET WinForms + GDI 自绘）：没有任何浏览器内核、没有 WebView2、没有 HTML/网页成分——所有界面都是系统原生控件：自绘无边框深色标题栏、原生文本框/滚动列表、GDI 粒子闪电动画、环形仪表。

- 程序启动时自动检测后端：未运行 → 静默拉起（隐藏窗口）；已在运行 → 直接复用；
- 点窗口 ✕ 关闭 = 退出程序并停止后端（数据全部落盘，随时重开）；
- 日志写入 `logs\leizai.log`（后端）+ `logs\desktop.log`（客户端，崩溃/切换/异常可查）；
- 单实例保护：重复双击只会在任务栏找到已有窗口；
- 快捷键：`Ctrl+1~4` 快速切换 对话/进化/记忆/任务 页；`Enter` 发送、`Shift+Enter` 换行、`Ctrl+V` 粘贴剪贴板图片（或点输入区 📷 按钮，自动压缩并切换 vision 模型）、`Esc` 关闭弹窗。
- 命令：**`/dev <目标>`（一句话开自治目标，自动多轮推进）** **`/handoff`（总结进度并写交接文档，好开新会话）** **`/auto`（确认自动模式，默认已开）** `/refine`（反思进化）`/new`（新会话）`/clear`（清屏）`/help`（帮助）**`/heartbeat <间隔秒> <消息>`（心跳自动继续）** **`/schedule <HH:MM> <消息>`（每天定时）**

> 前置：Node.js ≥ 18（客户端会用 `node` 拉起本地后端）；**可选 Python ≥ 3.8**（用于持久 Python REPL 内核 python_repl / run_skill，未安装时这两项自动不可用并提示）。
> 密钥：默认写在 `config.json` 的 `apiKey` 字段（已预填；也可以改用环境变量 `LEIZAI_DEEPSEEK_API_KEY`，环境变量优先且不落盘）。

### 独立性说明
雷仔是与本机其他软件**完全独立**的个体：不依赖任何平台或后台服务，唯一的对外连接是 DeepSeek API；启停它不影响任何其他程序，其他程序的变动也不影响它。全部数据在 `data/` 与 `config.json`，整个目录拷走即可迁移。

### 开机自启（可选）
运行 `安装开机自启.cmd`，雷仔开机后静默运行；`卸载开机自启.cmd` 可移除。

---

## 与 Prime Agent 的能力对照

| Prime Agent 能力 | 雷仔实现 | 位置 |
|---|---|---|
| 自我改进 RLM harness（propose-not-apply） | 进化引擎：提案 → 版本快照 → 批准生效 → 可回滚，全部留档 | `src/evolution.js` |
| 持久化运行时 / 守护进程（断点不丢） | 会话/任务/提案/调度全部落盘；服务器重启自动恢复活跃任务与调度 | `src/goals.js` `src/scheduler.js` `src/server.js` |
| 记忆 / Prompts / Skills 文件系统持久化 | `data/memory/` `data/prompts/` `data/skills/` | `src/memory.js` `src/prompt.js` |
| 子智能体（agent protocol） | `spawn_subagent`（sync / background）+ `fetch_subagent`，**全工具权限**，结果落盘 | `src/subagent.js` |
| 长时程自治任务（autonomous goals） | 多轮推进 + 每轮进展评估 + 轮次上限 + 断线续跑 | `src/goals.js` |
| 反思沉淀（refine） | 任务后自动反思：沉淀记忆 / 新技能 / 进化提案；`/refine` 强制触发 | `src/runtime.js` |
| **持久 Python REPL（RLM 内核）** | `python_repl` 工具：每会话常驻 Python 进程，变量/导入/状态跨调用保留 | `src/repl.js` `src/repl_host.py` |
| **agent 间直接通信** | 信箱机制：`agent_send` / `agent_inbox` / `agent_list`；子智能体每轮自动收取消息 | `src/subagent.js` |
| **心跳 / 定时（heartbeat / schedule）** | `/heartbeat`、`/schedule`、`schedule_heartbeat` / `schedule_at` / `schedule_stop` 工具，持久化 + 断线续跑 | `src/scheduler.js` |
| **可执行技能包（skills as packages）** | `data/skills/<名>/SKILL.md + main.py`，`run_skill` 在 REPL 内执行；`save_skill` 带 code 即创建包 | `src/skills.js` |
| 子智能体全权限（读写/命令/进化） | ✅ 与主智能体同权；只读限制已取消 | `src/subagent.js` |
| 界面 | 原生桌面客户端（WinForms+GDI 自绘）；网页版已弃用 | `app/` |

已进一步补齐：**多模型 Provider 抽象**（`provider` + `thinkingFormat`，OpenAI 兼容/本地模型可接入）、**无头 JSONL RPC 接口**（`src/cli.js --rpc`）、**进化质量门禁**（`evolutionGate` 确定性命令，未通过不落盘）、**细粒度权限**（`allowedPaths/protectedPaths/protectedCommands`）、**记忆相关度排序**、**插件/自定义工具**（`src/plugins/*.js` → `reloadPlugins()` 热加载）、**补充态 harness**（`data/prompts/harness.md` + `immutableGenome`，可让基础 genome 保持不变）、**Python 内核跨重启快照/恢复**（`data/kernels/`）、**Agent 级评测摘要**（`scripts/eval-recap.mjs`）、**MCP 客户端**（`config.mcpServers` → `mcp_list_tools` / `mcp_call` 工具，可用 `scripts/mock-mcp.mjs` 自测）、**守护进程 attach/detach**（`daemonMode=true` 时后端独立运行、关闭窗口后后台继续，设置页可「关闭后台」）。

仍有差异（有意取舍）：无完整 TUI；无 OS 级进程沙箱。但 RLM 内核、agent 通信、心跳/定时、可执行技能、全权限、多模型、无头接口、质量门禁、插件扩展、补充态 harness、内核快照、MCP、守护进程这几块已补齐。
## 守护进程（attach / detach）
- 设置勾选「守护进程模式」，或 `config.json` 设 `daemonMode: true`；
- 开启后：关闭窗口=**detach**，后端（node）继续独立运行，自治目标/心跳/定时不中断；再次启动客户端自动 **attach** 复用；
- 设置页出现「关闭后台」按钮（`POST /api/shutdown`）可停止后台服务；`data/daemon.pid` 记录后台 PID，后台状态见 `GET /api/daemon`。
## MCP（Model Context Protocol）
- `config.json` 的 `mcpServers` 配置 stdio 服务器：`[{ "name": "xxx", "command": "npx", "args": ["-y","@modelcontextprotocol/server-filesystem","."] }]`；
- 模型即可调用 `mcp_list_tools` / `mcp_call` 使用外部 MCP 工具；可用 `node scripts/mock-mcp.mjs` 作本地自测。

---

## DeepSeek 提速与缓存命中设计（实测）

### 实测结果
- 第二轮对话起：**缓存命中率 95%+**（`prompt_cache_hit_tokens / (hit+miss)`）
- 稳定前缀下重复调用：首 token 延迟随命中下降（如 1855ms → 944ms）
- 界面上有实时缓存命中率环形仪表 + 每次回复的命中统计

### 四层设计
1. **system 提示词永久静态**：基因组（`data/prompts/system.md`）+ 技能目录 + 固定尾注拼接后从不变化（只有进化/新技能才会改变一次，之后新前缀继续命中）。
2. **工具 schema 顺序冻结**：`src/tools.js` 的注册表顺序即 API 请求顺序，写入规则"只追加、不重排"，保证前缀稳定（新工具一律追加在末尾）。
3. **动态内容一律后置**：时间、轮次、目标进度等动态信息全部放进最新的 user 消息，绝不插入 system 或历史中间。
4. **历史压缩形成新稳定前缀**：超预算时才压缩最旧回合，压缩前先生成**滚动摘要**注入（不再直接丢弃而"失忆"），压缩后即成为新的稳定前缀，后续回合继续命中；压缩极少发生（上下文预算默认 48 万 tokens，中文感知估算）。

其他提速：流式输出（SSE）、**思考强度默认 low**（设置里可切 off/low/high/max）、`stream_options.include_usage` 遥测、429/5xx 退避重试、连接复用（Node 自带 keep-alive）、思考过程实时可见但不占回复延迟展示。

---

## 进化机制（核心）

雷仔的"基因组" = `data/prompts/system.md`。它**从不直接修改自己**，而是：

```
任务完成 → 反思 → 提出提案(propose) → 自动批准(applied, 可配置) → 版本归档
        → 之后所有请求使用新基因组（前缀变化一次）→ 不满意可一键回滚
```

- 提案含：目标、标题、理由（必须带证据）、精确 patch 或全文。
- 批准前自动把旧内容快照到 `data/evolution/versions/`；回滚会校验当前内容哈希，防止误回滚。
- 进化纪律写在基因组里：**同一类错误出现两次以上 / 规则导致目标冲突 / 明显更优做法**才值得提案；"克制本身就是纪律"。
- 界面「进化」页：查看提案、差异对比、批准/否决/回滚、动作日志时间线。

### 进化的"自动 vs 手动"（配置即开关）
| 配置 | 默认 | 含义 |
|---|---|---|
| `reflectionEnabled` | `true` | 反射**总开关**；`false` 时连 `/refine` 也不触发反射 |
| `reflectionAuto` | `true` | 是否**自动反射**；`true`=重要任务后自动沉淀，`false`=仅 `/refine` 手动触发 |
| `evolutionAutoApply` | `true` | 反射提出的进化提案是否**自动生效**；`false`=进入「进化」页人工批准/否决 |

- **自动反射的触发条件**：一回合工具调用 **≥2 次**（或用户 `/refine`），且同一会话 **3 分钟内**只跑一次（节流），异步不阻塞回复。
- **自动进化**：反射提出提案后，`evolutionAutoApply=true` → 自动 approve + 版本归档（可回滚）；`evolutionGate` 配置了门禁命令时须先通过才生效（默认空=不拦截）。
- 手动路径始终可用：`/refine` 强制反射；`propose_evolution` / 记忆页 / 进化页人工操作。

---

### 人性化入门（说人话即可）
做开发时不用记流程，雷仔默认已开启**自动编排**：大任务自动拆解（子智能体）、长目标用 `create_goal` 注册成自治任务、把进度与决策持续记入工作区进度文件、把可复用流程沉淀成技能。
- `说一句 "/dev 帮我重构订单模块"` → 自动开一个自治目标，多轮自主推进，你只看「任务」页结果；
- `说一句 "这个任务很大，你自己拆子任务并行做，最后汇总"` → 雷仔自动派子智能体分管；
- `说一句 "/handoff"` → 自动把当前进度总结并写入交接文档，好开新会话接着干；
- **一个窗口可以一直用**：上下文变长时，旧回合会被**全量归档到本会话后台**（`data/archives/`，静默保存），只把滚动摘要留在上下文里——**既不占上下文、又不丢细节**；雷仔需要旧细节时会用 `recall_context` **立刻调回**，无需新开窗口；
- **何时交接？不用你操心**：发生上下文压缩时雷仔会在回复末尾**主动提醒**；但你现在也可选择**不交接、继续用**（旧细节仍在归档里随取随用）；
- 一切其它需求直接中文描述即可，无需 `/new`、`/refine` 等命令驱动。

### 一个对话 = 一个项目（独立文件夹 + 上下文归档）
- **每个对话有自己的独立项目文件夹**：`工作目录/projects/<会话id>/`，内含 `_progress.md`（进度/决定/笔记账本）。删除会话即删除该文件夹。
- **规则双保险**：确立规则/关键决定时，雷仔会**同时** `save_memory`（记忆）+ `log_progress`（进度文件）——**记忆与进度各留一笔，永不随归档淘汰**。
- **上下文归档是雷仔自己处理**：旧回合在上下文变长时会**全量静默归档**到本会话后台（`data/archives/`），只把滚动摘要留在活跃上下文——不占上下文、不丢细节、需要时用 `recall_context` **自动调回**；
- **归档容量上限自动淘汰（安全）**：超过 `archiveMaxEntries`（默认 100000）时自动淘汰**最旧"流水"**——**规则早已在记忆/进度文件**，淘汰永不打乱项目；
- 归档发生时雷仔会在回复里**轻提到一下**（无需你操作）；
- **查看/清理归档**：右键会话 → 「查看归档」/「清空归档」（确认后一键清空）；
- **删除 = 进回收站（可恢复）**：删除会话会**移入回收站**（30 天后自动清除、期间可恢复，右键「恢复」）；「彻底删除」才连同归档/项目文件夹永久清除；均有**二次确认**避免误删；
- 记忆/技能/进化完全不受影响（全局、独立，雷仔自行决策该记什么、该进化什么）。

## 功能清单（界面）

- **对话**：流式回复、思考过程折叠展示、工具调用卡片、每轮缓存/费用/延迟/上下文占用统计；**支持图片上传**（📷 按钮或 Ctrl+V 粘贴，自动压缩；后端自动切换 vision 模型看图），发送后**用户气泡内回显缩略图**；快捷命令 `/refine`、`/new`、`/clear`、`/help`、**`/heartbeat`、`/schedule`**。
- **智能输入区**：`/` 触发**命令自动补全弹窗**（↑↓ 选择、Tab/Enter 采纳、Esc 关闭；支持按前缀过滤 `/refine /heartbeat /schedule /help /new /clear`）；**图片附件预览块**（缩略图 + ✕ 移除）；**对话 / 自治目标** 分段切换（滑动高亮）；空输入占位符、输入焦点青色脉动光效、字符计数、发送按钮按内容状态亮/暗；发送后自动清空输入与附件。
- **动态效果**：页签下划线**滑动动画**（`Ctrl+1~4` 或点击切换时平滑过渡）、AI 气泡**流式脉动光边**（输出中）、右侧面板闪电粒子条、环形仪表、窗口顶部微光。
- **自治目标**：切到「自治目标」模式后下达目标，多轮推进、每轮自动评估、断线续跑；任务页可停止。
- **Python REPL 内核（RLM）**：`python_repl` 在会话的常驻 Python 解释器中执行代码，变量/导入/状态跨调用保留；适合计算、数据处理、自动化，是"把上下文当变量"的本地实现。
- **agent 间直接通信**：`agent_list` / `agent_send` / `agent_inbox`；主智能体与子智能体、子智能体之间可直接传话；子智能体每轮自动收取信箱消息。
- **心跳 / 定时**：`/heartbeat 3600 检查并继续` 注册周期心跳；`/schedule 09:00 做每日盘点` 每天定时；调度在任务页可见、可停止，服务器重启自动恢复。
- **可执行技能包**：`data/skills/<名>/SKILL.md + main.py`；`run_skill` 在 REPL 内执行 `main(args)->str`；沉淀技能时贴 code 即可生成包。
- **进化**：提案管理 + 差异对比 + 回滚 + 日志时间线。
- **记忆/技能**：浏览、检索、编辑、删除；技能目录自动进入系统提示词。
- **实时面板**：缓存命中率仪表、token 用量、TTFB、估算费用、活动流。
- **设置**：模型 / 思考强度 / API Key / 工作目录 / 价格 / 端口 / 进化策略 / **provider（多模型）** / **thinkingFormat** / **fullAccess（最大权限开关）** / **allowedPaths / protectedPaths / protectedCommands（细粒度权限）** / **evolutionGate（进化质量门禁）** / **pythonPath**。
- **无头接口**：`node src/cli.js --rpc` 提供行分隔 JSON 命令/响应（ping / sessions / chat / goal / agents / schedules / config / memory），可被脚本、CI、第三方 UI 驱动；`node src/cli.js chat --session <id> --message "..."` 为一次性命令。

### 命令执行器说明
`run_command` 使用 **PowerShell 执行器**（中文与 UTF-8 全通、支持 `dir/cd/echo/type/copy/&&` 等常见 cmd 惯用法自动转换）；**fullAccess 模式下不拦截任何命令**（黑名单可通过 `fullAccess=false` 恢复）；超时自动终止。

### 搜索
`web_search` 自动多源兜底：**Bing → DuckDuckGo**（任一可用即返回，结果标注来源）；`web_fetch` 在 fullAccess 模式下**允许访问内网地址**（sandbox 模式下保持 SSRF 防护）。

---

## 安全边界（已放宽为最大权限，请知悉）

> 你要求"给到最大"：雷仔现在是 **fullAccess 模式（默认开启）**——文件工具可读写本机**任意路径**、`run_command` **不拦截**危险命令、`web_fetch` **不防**内网地址、子智能体**全工具**。**它运行在你的用户权限下，每一个动作都会真实影响你的电脑。**
>
> 这是一把双刃剑：雷仔自律（基因组里有完整行为纪律与"先读后写/失败透明"刚性规则），但**最终责任在用户**。请把 `data/` 与 `config.json` 视为敏感数据，勿提交公开仓库；建议定期查看工具调用卡片确认它在做什么。
>
> **首次运行会弹一次主题化确认框**（`fullAccess=true` 且未确认过时）：点「保持最大权限」→ 写 `data/fullaccess-ack.flag` 记录；点「关闭最大权限」→ 自动改为受限沙箱。

- 想收紧？设置或 `config.json` 把 `fullAccess` 改为 `false`，即恢复：文件工具仅限工作目录、危险命令黑名单、SSRF 防护（子智能体保持全工具）。
- 所有数据（会话/记忆/提案/任务/调度/子智能体）都在本机 `data/` 目录，**唯一的外部连接是 DeepSeek API 本身**。

---

## 目录结构

```
雷仔/
├─ LeiZai.exe           原生桌面客户端（双击即开，自绘窗口）
├─ 启动雷仔.cmd         控制台模式入口（可选）
├─ config.json          配置（密钥/模型/端口/工作目录/价格/进化策略/fullAccess/pythonPath）
├─ app/                 客户端源码（C# / WinForms / GDI 自绘，纯 ASCII+\u 转义源）
│  ├─ Program.cs        入口：单实例 + 自检 + 崩溃日志
│  ├─ MainForm.cs       主窗口（绝对定位布局：标题栏/页签/会话栏/实时面板/设置，含调度创建）
│  ├─ ChatView.cs       聊天视图（消息流 + SSE 流式渲染 + 输入条，含 /heartbeat /schedule 命令）
│  ├─ SideViews.cs      进化 / 记忆 / 任务 视图 + 深色弹窗（任务页含调度列表）
│  ├─ Controls.cs       自绘控件（粒子层/环形仪表/气泡/工具卡/扁平按钮）
│  ├─ Theme.cs          深色闪电主题
│  ├─ ApiClient.cs      本地 API/SSE 客户端
│  └─ Models.cs         数据模型 + JSON 助手
├─ src/                 本地后端（Node.js）
│  ├─ server.js        HTTP + SSE（网页版已弃用）
│  ├─ runtime.js       会话/回合引擎/反思
│  ├─ deepseek.js      DeepSeek 客户端（流式+遥测+重试）
│  ├─ prompt.js        稳定前缀系统提示词构建
│  ├─ tools.js         工具注册表（顺序冻结；fullAccess 边界；REPL/技能/agent/调度工具）
│  ├─ repl.js          Python 持久 REPL 管理器（RLM 内核）
│  ├─ repl_host.py     Python REPL 宿主（每会话常驻解释器）
│  ├─ skills.js        可执行技能包（SKILL.md + main.py）
│  ├─ scheduler.js     心跳/定时调度器（持久化 + 断线续跑）
│  ├─ memory.js        记忆/技能库（含技能包）
│  ├─ evolution.js     进化引擎（propose/approve/reject/rollback）
│  ├─ subagent.js      子智能体（全工具 + 信箱通信）
│  ├─ goals.js         自治目标 + 断线续跑
│  └─ config.js        配置加载保存
├─ data/               全部持久化数据（会话/记忆/技能/进化/任务/调度/子智能体）
├─ logs/               运行日志（leizai.log / desktop.log）
└─ scripts/            冒烟 / 集成 / 全面测试 / 图标与构建脚本
```

### 重新构建客户端
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\build-client.ps1
```

---

## 测试与验证

```bash
node scripts/unit-test.mjs        # 单元测试（无网络/无服务器）：Provider 解析、配置默认、细粒度权限、记忆排序、门禁逻辑
node scripts/fix-regression-test.mjs # 缺陷修复回归测试（离线）：CLI --session/--rpc、上下文摘要压缩、token 估算、子智能体描述、技能去重、溢出检测
node scripts/evolution-gate-test.mjs # 进化质量门禁端到端（失败拦截/通过应用/回滚）
node scripts/api-smoke.mjs        # DeepSeek 连通性 + 缓存命中验证
node scripts/integration-test.mjs # 服务器运行中：全链路回归
node scripts/test-all.mjs         # 服务器运行中：全面测试（单元+集成+端到端）
node scripts/edge-test.mjs        # 服务器运行中：边界/异常测试（参数校验/未知资源/配置防护）
node scripts/vision-test.mjs      # 服务器运行中：图片→vision 模型识别测试（自动还原模型配置）
node scripts/restart-test.mjs     # 服务器运行中：杀掉服务器再重启，验证目标/调度断线续跑
node scripts/eval-recap.mjs       # 服务器运行中：Agent 级评测摘要（成本/缓存/任务成功率/子智能体/调度）
```

覆盖：fullAccess 越界放行 / 沙箱模式拦截、Python REPL 持久状态、可执行技能包 run_skill、agent 信箱通信、心跳/定时调度、进化闭环、记忆、稳定前缀、对话缓存命中、工具回路、子智能体（全工具）、停止中断、自治目标、网页版弃用（410）、坏请求 4xx、配置类型校验、图片视觉识别、重启恢复。完整结论见 `TEST-REPORT.md`。

## 常见问题

- **没看到缓存命中**？前 1-2 次调用必然 miss（首次建立缓存）；连续对话/任务内自然命中。
- **python_repl 不可用**？本机未安装 Python（或 `pythonPath` 配置错）；装 Python ≥3.8 后重启即可。
- **改了端口没生效**？改完需重启（界面会提示）。
- **fullAccess 太危险**？设置 → `fullAccess = false` 恢复沙箱（文件工具限工作目录、命令黑名单、SSRF 防护）。
- **进化太激进/太保守**？设置里：`提案自动批准生效` 开关；或在「进化」页否决/回滚每条提案。
