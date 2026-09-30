'use strict';
// 雷仔 · 自训练后台任务（引擎级 · 独立于任何对话窗口）
//
// 目标：让"深度自训练飞轮(H)"真正自己转起来，且不绑定任何会话/对话框口。
// 实现：本模块在后端进程里用 setInterval 定时调用 selftrain.tick()（纯只读分析），
//       把每一轮自训练洞察落盘到 data/selftrain/ 下（含 digest 摘要 + 完整建议），
//       供后续智能体在任意会话里召回"最近该练什么/该改什么"。
//
// 独立性：①不依赖任何 sessionId（tick() 是纯数据层，不注入任何会话消息）；
//         ②定时器独立运行，与调度器/心跳/对话窗口完全解耦；
//         ③只读 data/ 关键数据 + 只写 data/selftrain/ 自己的产物，不越界。
//
// 设计原则：本任务只"产出洞察"，不直接修改记忆/技能/进化（那需要业务接口 + 安全/缓存护栏），
//           真正的"落地"经由智能体在会话里按建议审视后执行。这保证自训练不破坏稳定前缀与关键数据。
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR, load: loadConfig } = require('./config');
const selftrain = require('./selftrain');

const OUT_DIR = path.join(DATA_DIR, 'selftrain');

function ensure() { fs.mkdirSync(OUT_DIR, { recursive: true }); }

/** 读取最近一轮自训练洞察（跨会话可见，供智能体随时召回"最近该练/该改什么"）。 */
function readLatest() {
  ensure();
  const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort().reverse();
  if (!files.length) return null;
  try { return JSON.parse(fs.readFileSync(path.join(OUT_DIR, files[0]), 'utf8')); } catch { return null; }
}

/** 读取历史自训练日志（按时间正序，供成长复盘）。 */
function readHistory(limit = 30) {
  ensure();
  const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort().slice(-limit);
  const out = [];
  for (const f of files) {
    try { const d = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf8')); out.push({ at: d.at, digest: d.digest }); } catch { }
  }
  return out;
}

/** 执行一轮自训练并把洞察落盘。返回本轮产物。 */
function runOnce() {
  const result = selftrain.tick();
  const at = result.at || new Date().toISOString();
  const fname = path.join(OUT_DIR, at.replace(/[:.]/g, '-') + '.json');
  ensure();
  fs.writeFileSync(fname, JSON.stringify(result, null, 2), 'utf8');
  console.log(`[selftrain] 自训练完成 ${at}：${result.boundary.profile.selfMemories}自认知/${result.boundary.profile.skillPackages}技能/${result.boundary.profile.evoVersions}进化`);
  return result;
}

let timer = null;
let running = false;

/** 启动引擎级自训练后台任务（server 启动时调用一次）。 */
function start() {
  if (timer) return;
  const cfg = loadConfig();
  // 自训练周期（毫秒），默认每 6 小时跑一次；5 分钟以内视为无效值用默认。
  const intervalMs = Math.max(5 * 60 * 1000, Number(cfg.selftrainIntervalMs) || 6 * 3600 * 1000);
  // 首次启动时若尚无任何自训练记录，立即跑一次（让飞轮先转起来）
  if (!readLatest()) {
    try { runOnce(); } catch (e) { console.error('[selftrain] 首轮自训练失败: ' + e.message); }
  }
  timer = setInterval(() => {
    ensure();
    if (running) return;   // 防重入：上一轮还没跑完就跳过本轮
    running = true;
    try { runOnce(); } catch (e) { console.error('[selftrain] 自训练失败: ' + e.message); }
    finally { running = false; }
  }, intervalMs);
  if (timer.unref) timer.unref();
  console.log(`[selftrain] 自训练飞轮已启动（周期 ${Math.round(intervalMs / 3600000)}h，引擎级独立运行）`);
}

/** 停止自训练后台任务（测试/停用时用）。 */
function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, runOnce, readLatest, readHistory, OUT_DIR };
