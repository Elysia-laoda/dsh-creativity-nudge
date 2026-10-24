/**
 * dsh-creativity-nudge — 建议型「创造力触发器」。
 *
 * 它只做一件事：在**模型已经锁定路线**的那一刻，注入一句话把它拉回发散状态。
 * 不否决调用、不改写结果、不评价内容好坏 —— 只是往 tools/post-execute 的
 * additionalContexts 里塞一条带来源标记的上下文，模型当普通消息读。
 *
 * 设计取舍（详见 README）：
 *   - **只判断时机，不判断内容。** 判"这个任务要不要创意"要么多烧一次模型调用、
 *     要么正则误伤；而"第一次落盘 / 同一个文件改到第 N 次"是确定性的结构事实。
 *   - **硬预算。** 每会话最多 2 次、冷却 8 次工具调用、用户新消息重置 T2 计数。
 *     高频的元建议会退化成格式噪音，模型与人都会免疫。
 *   - **默认关闭。** 装上不生效，enabled: true 才注册监听。
 *   - **零依赖。** 不 import 任何 @deepseek-ai 包：档案里装的插件只保证能解析
 *     node 内建模块，靠住的越少越不会因为宿主升级而炸。
 *
 * @module dsh-creativity-nudge
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

/** 插件身份（cordis.patch.yml 的行名）。 */
export const name = 'creativity-nudge';

/** 不声明必需服务：拿不到 agent 就什么都不做，绝不影响宿主启动。 */
export const inject = [];

const DEFAULTS = {
  enabled: false,
  maxPerSession: 2,
  cooldownCalls: 8,
  stuckEdits: 5,
  stuckFailures: 0,
  mutatingTools: ['write', 'edit'],
  keywords: [
    '设计', '方案', '架构', '命名', '取名', '创意', '构思', '思路',
    '规划', '选型', '原型', '取舍', '重构', '从零',
    '怎么做', '如何做', '怎么写', '怎么实现', '如何实现',
    '太普通', '换个思路', '有没有别的',
  ],
  auditFile: '',
  dryRun: false,
};

/**
 * T1 文案：第一次落盘之后的提醒。
 * 措辞轮换是有意的 —— 同一句话在上下文里出现第三次就会被当样板忽略。
 */
const T1_VARIANTS = [
  '[creativity-nudge] 你已经开始动文件，而目前只有一个方案。\n\n'
    + '如果这是开放式任务（设计 / 方案 / 命名 / 架构），在做下一处改动之前先停下：'
    + '给出两个"机制不同"的候选，各写一句它牺牲了什么，再选。\n\n'
    + '已经有充分理由锁定唯一方案的话，忽略本条继续。',

  '[creativity-nudge] 第一处文件改动已经落下了，路线也基本定了。\n\n'
    + '检查一下：这个方案是不是"最容易想到的那个"？如果是，'
    + '在它之外再写一个机制不同的做法（不是换参数），并说清两者各自放弃了什么。\n\n'
    + '不适用就继续，不用回应本条。',
];

/** T2 文案：同一个文件被改了 N 次。 */
const T2_VARIANTS = [
  '[creativity-nudge] 同一个文件已经改了 {n} 次，看起来每次都在原思路上微调。\n\n'
    + '不要再改同一处：要么换一个机制（换数据结构、换入口、拆开重做），'
    + '要么先写一个能稳定复现问题的最小例子。',

  '[creativity-nudge] {n} 次编辑都落在同一个文件上，进展却不明显。\n\n'
    + '先停手：现在的方向如果是对的，为什么需要改 {n} 次？'
    + '换一个假设，或者退回到上一个能工作的状态。',
];

/** T3 文案：连续失败（默认关闭，见 README）。 */
const STUCK_VARIANTS = [
  '[creativity-nudge] 连续 {n} 次工具调用失败，说明当前的**假设**不成立，而不是参数没调对。\n\n'
    + '先回退到上一个能工作的状态，再换机制；不要在同一个思路上继续试参数。',
];

/* ────────────────────────── 纯函数（供测试直接引用） ────────────────────────── */

/** 把一条 message 的文本内容拼出来。 */
export function textOf(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/** 取最近一条用户消息（我们自己的注入带 creativity-nudge 来源，不会被误认）。 */
export function lastUserMessage(messages) {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message && message.source && message.source.kind === 'user') return message;
  }
  return undefined;
}

/** 用户这句话是不是开放式请求（关键词是唯一的启发式开关，也是本插件最容易误判的地方）。 */
export function isOpenEnded(text, keywords) {
  const value = String(text || '');
  if (value.length === 0) return false;
  return keywords.some((keyword) => keyword.length > 0 && value.includes(keyword));
}

/** 稳定哈希，用来给同一 agent 的不同次提醒挑不同措辞。 */
export function hashString(value) {
  let hash = 0;
  const text = String(value);
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** 按种子从候选里挑一条。 */
export function pickVariant(list, seed) {
  if (!Array.isArray(list) || list.length === 0) return '';
  return list[hashString(seed) % list.length];
}

/** 工具入参里的目标文件路径（归一化：Windows 反斜杠转正斜杠、小写）。 */
export function fileOf(args) {
  if (!args || typeof args !== 'object') return '';
  const direct = args.file_path || args.filePath || args.path || args.file;
  if (typeof direct !== 'string' || direct.length === 0) return '';
  const normalized = direct.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * 构造一条注入上下文。
 *
 * 形状与宿主 createUserMessage 对齐（role/user + 稳定 id + 带来源），
 * 但**不 import** 那个包 —— 来源标记 kind 是关键：无标记的上下文会在派生历史里
 * 渲染成用户提示词。
 */
export function contextMessage(text, summary) {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'creativity-nudge',
      form: 'notice',
      summary: String(summary || '').slice(0, 120),
    },
    id: randomUUID(),
  };
}

/** 新 agent 的初始状态。 */
export function createState(seed) {
  return {
    seed: seed || randomUUID(),
    lastUserText: '',
    lastUserMessageId: null,
    calls: 0,
    nudges: 0,
    lastNudgeCall: -Infinity,
    commitments: 0,
    firstCommitSeen: false,
    fileEdits: new Map(),
    failures: 0,
  };
}

/** 配置校验：宁可启动时报错，也不要静默改行为。 */
export function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const config = { ...DEFAULTS, ...input };
  const positive = (key, min) => {
    const value = config[key];
    if (!Number.isInteger(value) || value < min) {
      throw new Error('creativity-nudge: ' + key + ' 必须是 >= ' + min + ' 的整数，收到 ' + JSON.stringify(value));
    }
  };
  positive('maxPerSession', 0);
  positive('cooldownCalls', 0);
  positive('stuckEdits', 2);
  positive('stuckFailures', 0);
  if (!Array.isArray(config.mutatingTools) || config.mutatingTools.length === 0) {
    throw new Error('creativity-nudge: mutatingTools 必须是非空数组');
  }
  if (!Array.isArray(config.keywords) || config.keywords.length === 0) {
    throw new Error('creativity-nudge: keywords 必须是非空数组');
  }
  if (typeof config.auditFile !== 'string') throw new Error('creativity-nudge: auditFile 必须是字符串');
  config.enabled = config.enabled === true;
  config.dryRun = config.dryRun === true;
  config.mutatingTools = config.mutatingTools.map(String);
  config.keywords = config.keywords.map(String).filter((keyword) => keyword.length > 0);
  return config;
}

/* ────────────────────────── 插件主体 ────────────────────────── */

/**
 * 安装监听。
 * @param ctx cordis 上下文（监听器随它一起销毁）
 * @param rawConfig cordis.patch.yml 里 config 段的内容
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  const states = new WeakMap();
  const stats = {
    fires: 0,
    dryRuns: 0,
    suppressed: 0,
    lastAt: null,
    lastReason: null,
    lastTool: null,
  };

  const warn = (where, error) => {
    try { ctx.logger?.warn?.('creativity-nudge: ' + where + ' failed: ' + String(error)); } catch { /* logger 不可用也不能抛 */ }
  };

  function stateOf(agent) {
    let state = states.get(agent);
    if (state === undefined) {
      state = createState();
      states.set(agent, state);
    }
    return state;
  }

  function audit(record) {
    if (config.auditFile.length === 0) return;
    try {
      const dir = dirname(config.auditFile);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(config.auditFile, JSON.stringify(record) + '\n', 'utf8');
    } catch (error) {
      warn('audit', error);
    }
  }

  function canFire(state) {
    if (state.nudges >= config.maxPerSession) return false;
    if (state.calls - state.lastNudgeCall < config.cooldownCalls) return false;
    return true;
  }

  /**
   * 观察一次已完成的调用，决定要不要提醒。
   * @returns 需要注入的 message，或 null
   */
  function consider(agent, exec, result) {
    if (!config.enabled && !config.dryRun) return null;
    if (!agent) return null;
    const state = stateOf(agent);
    const toolName = String((exec && exec.name) || '');
    state.calls += 1;

    if (result && result.isError === true) state.failures += 1;
    else state.failures = 0;
    const failedRun = state.failures;

    let reason = null;
    let detail = '';

    if (config.mutatingTools.includes(toolName)) {
      const file = fileOf(exec && exec.arguments);
      state.commitments += 1;

      if (!state.firstCommitSeen) {
        state.firstCommitSeen = true;
        if (isOpenEnded(state.lastUserText, config.keywords)) {
          reason = 'first-commit';
          detail = file;
        }
      }

      if (reason === null && file.length > 0) {
        const next = (state.fileEdits.get(file) || 0) + 1;
        state.fileEdits.set(file, next);
        if (next >= config.stuckEdits) {
          reason = 'stuck-edits';
          detail = file;
          state.fileEdits.set(file, 0);
        }
      }
    }

    if (reason === null && config.stuckFailures > 0 && failedRun >= config.stuckFailures) {
      reason = 'stuck-failures';
      detail = String(failedRun);
      state.failures = 0;
    }

    if (reason === null) return null;

    if (!canFire(state)) {
      stats.suppressed += 1;
      audit({
        at: new Date().toISOString(),
        event: 'suppressed',
        reason,
        detail,
        tool: toolName,
        nudges: state.nudges,
        calls: state.calls,
      });
      return null;
    }

    const seed = state.seed + ':' + state.nudges;
    let template = '';
    if (reason === 'first-commit') template = pickVariant(T1_VARIANTS, seed);
    else if (reason === 'stuck-edits') template = pickVariant(T2_VARIANTS, seed);
    else template = pickVariant(STUCK_VARIANTS, seed);

    const text = template.split('{n}').join(detail);
    const summary = reason === 'first-commit'
      ? 'first commit · ' + (detail.length > 0 ? detail : '?')
      : reason === 'stuck-edits'
        ? 'same file x' + config.stuckEdits
        : 'failures x' + detail;

    state.nudges += 1;
    state.lastNudgeCall = state.calls;
    stats.lastAt = new Date().toISOString();
    stats.lastReason = reason;
    stats.lastTool = toolName;

    audit({
      at: stats.lastAt,
      event: config.dryRun ? 'would-fire' : 'fire',
      reason,
      detail,
      tool: toolName,
      nudges: state.nudges,
      calls: state.calls,
      chars: text.length,
    });

    if (config.dryRun) {
      stats.dryRuns += 1;
      return null;
    }
    stats.fires += 1;
    return contextMessage(text, summary);
  }

  const active = config.enabled || config.dryRun;

  /** 用户真的发新消息时才重置 —— 同一条用户消息会在每一 step 重复出现。 */
  if (active) {
    ctx.on('agent/pre-step', ({ agent, messages }, next) => {
      try {
        if (agent) {
          const message = lastUserMessage(messages);
          if (message) {
            const state = stateOf(agent);
            const id = message.id ?? null;
            if (id !== null && id !== state.lastUserMessageId) {
              state.lastUserMessageId = id;
              state.lastUserText = textOf(message);
              state.fileEdits.clear();
              state.failures = 0;
            } else if (id === null) {
              state.lastUserText = textOf(message);
            }
          }
        }
      } catch (error) {
        warn('pre-step', error);
      }
      return next();
    });

    ctx.on('tools/post-execute', async (exec, result, next) => {
      let message = null;
      try {
        message = consider(exec && exec.agent, exec, result);
      } catch (error) {
        warn('post-execute', error);
      }
      const downstream = await next();
      if (!message) return downstream;
      const existing = (downstream && downstream.additionalContexts) || [];
      if (downstream && downstream.kind === 'block') {
        return { kind: 'block', feedback: downstream.feedback, additionalContexts: [message, ...existing] };
      }
      return { ...(downstream || {}), additionalContexts: [message, ...existing] };
    });
  }

  const service = {
    status: () => ({
      enabled: config.enabled,
      dryRun: config.dryRun,
      maxPerSession: config.maxPerSession,
      cooldownCalls: config.cooldownCalls,
      stuckEdits: config.stuckEdits,
      stuckFailures: config.stuckFailures,
      mutatingTools: [...config.mutatingTools],
      keywordCount: config.keywords.length,
      auditFile: config.auditFile,
      stats: { ...stats },
    }),
    /** 纯判定：一句话会不会被当成开放式请求。 */
    isOpenEnded: (text) => isOpenEnded(text, config.keywords),
    config: () => ({ ...config }),
  };

  try { ctx.provide('creativityNudge', service); } catch (error) { warn('provide', error); }

  if (active) {
    try {
      ctx.logger?.info?.('creativity-nudge: 已接管 tools/post-execute（enabled='
        + config.enabled + ', dryRun=' + config.dryRun
        + ', maxPerSession=' + config.maxPerSession
        + ', cooldownCalls=' + config.cooldownCalls + '）');
    } catch { /* ignore */ }
  }
}

/** 便于测试与排查。 */
export const META = { DEFAULTS, T1_VARIANTS, T2_VARIANTS, STUCK_VARIANTS };
