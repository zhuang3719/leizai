# 雷仔（Leizai）

> 一个**独立运行、可自我进化**的个人 AI 智能体。灵感源自 Prime Agent 的 *propose-not-apply* 进化机制：
> 把提示词当作可迭代的数据，而不是固定死的咒语。

雷仔运行在你自己的机器上，基于大模型构建，具备工具、记忆、技能、子智能体、Python REPL 内核、
智能体间通信、心跳 / 定时与自治目标能力。它不是某个云平台的产品，而是你的本地伙伴。

## 特性

- **自主与可解释**：每个动作可解释、可回滚；进化提案默认留档、可撤销。
- **记忆与技能**：长期记忆 + 可执行技能包（`data/skills/<name>/main.py`）。
- **子智能体 / 雷影体系**：派生子智能体（领域分身）并行处理专精任务，通过共享信箱通信。
- **多模型供应商**：`src/providers.js` 统一适配，配置即切换。
- **本地优先**：数据默认落在本机 `data/`、`workspace/`；不依赖外部云存储。

## 目录结构

```
src/            引擎核心（26 个 .js 模块 + plugins/）
webui/          前端界面（Vue ESM，免构建直接运行）
boot_splash/    启动动画素材
build-client/   桌面外壳构建素材（不含二进制）
docs/           设计文档
scripts/        构建与冒烟测试脚本
```

## 快速开始

前置：**Node.js >= 18**。

```bash
npm install          # 安装依赖（如无 package-lock 可跳过）
npm start            # 启动引擎（默认 http://127.0.0.1:3458）
# 首次运行会以 src/config.js 的内置默认值启动；如需自定义，创建未跟踪的 config.json
```

> ⚠️ 请勿把真实密钥写入 `config.json` 并提交——本仓 `.gitignore` 已屏蔽 `config*.json` / `.env` 等。

## 开发

```bash
npm test             # 集成测试（scripts/integration-test.mjs）
npm run smoke        # 冒烟测试（scripts/api-smoke.mjs）
```

## 许可证

本项目以 **Apache License 2.0** 发布，详见 [LICENSE](./LICENSE)。

## 贡献

欢迎提交 Issue / PR，见 [CONTRIBUTING.md](./CONTRIBUTING.md)。
