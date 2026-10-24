import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, contextMessage, fileOf, isOpenEnded, normalizeConfig } from '../lib/index.js';

/* 一个够用的假 ctx：只实现本插件真正碰的三样东西。 */
function makeCtx() {
  const listeners = new Map();
  const provided = {};
  return {
    listeners,
    provided,
    on(event, handler) {
      const list = listeners.get(event) || [];
      list.push(handler);
      listeners.set(event, list);
      return () => {};
    },
    logger: { info() {}, warn() {} },
    provide(name, value) { provided[name] = value; },
    async preStep(agent, messages) {
      for (const handler of listeners.get('agent/pre-step') || []) {
        await handler({ agent, messages }, () => undefined);
      }
    },
    async postExec(agent, name, args, result = { isError: false }) {
      let out;
      for (const handler of listeners.get('tools/post-execute') || []) {
        out = await handler({ agent, name, arguments: args }, result, async () => ({ kind: 'accept' }));
      }
      return out;
    },
  };
}

function userMessage(text, id) {
  return { id: id || 'u-' + text, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } };
}

function nudgeText(result) {
  const contexts = result && result.additionalContexts;
  if (!contexts || contexts.length === 0) return null;
  return contexts[0].content[0].text;
}

const AGENT = { id: 'agent-1' };

test('未启用时不注册监听，调用原样通过', async () => {
  const ctx = makeCtx();
  apply(ctx, {});
  assert.equal(ctx.listeners.size, 0);
});

test('开放式提示 + 第一次落盘 → 注入一条建议', async () => {
  const ctx = makeCtx();
  apply(ctx, { enabled: true });
  await ctx.preStep(AGENT, [userMessage('帮我设计一下这个模块的架构')]);
  const out = await ctx.postExec(AGENT, 'write', { file_path: 'D:/x/a.js' });
  const text = nudgeText(out);
  assert.ok(text, '应当注入上下文');
  assert.match(text, /creativity-nudge/);
  assert.equal(out.additionalContexts[0].role, 'user');
  assert.equal(out.additionalContexts[0].source.kind, 'creativity-nudge');
  assert.ok(out.additionalContexts[0].id);
});

test('非开放式提示 → 不触发', async () => {
  const ctx = makeCtx();
  apply(ctx, { enabled: true });
  await ctx.preStep(AGENT, [userMessage('把 README 里的错字改掉')]);
  const out = await ctx.postExec(AGENT, 'write', { file_path: 'D:/x/readme.md' });
  assert.equal(nudgeText(out), null);
});

test('T1 每个会话只触发一次（后续落盘不再提醒）', async () => {
  const ctx = makeCtx();
  apply(ctx, { enabled: true, cooldownCalls: 0 });
  await ctx.preStep(AGENT, [userMessage('这个方案怎么落地')]);
  const first = await ctx.postExec(AGENT, 'write', { file_path: 'D:/x/a.js' });
  assert.ok(nudgeText(first));
  const second = await ctx.postExec(AGENT, 'write', { file_path: 'D:/x/b.js' });
  assert.equal(nudgeText(second), null);
});

test('预算上限生效：最多 maxPerSession 次', async () => {
  const ctx = makeCtx();
  apply(ctx, { enabled: true, maxPerSession: 1, cooldownCalls: 0, stuckEdits: 2 });
  await ctx.preStep(AGENT, [userMessage('设计一个新方案')]);
  const a = await ctx.postExec(AGENT, 'write', { file_path: 'D:/x/a.js' });
  assert.ok(nudgeText(a));
  const b = await ctx.postExec(AGENT, 'edit', { file_path: 'D:/x/c.js' });
  const c = await ctx.postExec(AGENT, 'edit', { file_path: 'D:/x/c.js' });
  assert.equal(nudgeText(b), null);
  assert.equal(nudgeText(c), null);
});

test('冷却期内的触发被压制', async () => {
  const ctx = makeCtx();
  apply(ctx, { enabled: true, cooldownCalls: 10, stuckEdits: 2 });
  await ctx.preStep(AGENT, [userMessage('设计一个方案')]);
  const first = await ctx.postExec(AGENT, 'write', { file_path: 'D:/x/a.js' });
  assert.ok(nudgeText(first));
  let last = null;
  for (let i = 0; i < 5; i += 1) {
    last = await ctx.postExec(AGENT, 'edit', { file_path: 'D:/x/a.js' });
  }
  assert.equal(nudgeText(last), null);
  assert.equal(ctx.provided.creativityNudge.status().stats.suppressed > 0, true);
});

test('同一个文件改到第 stuckEdits 次 → 触发 T2', async () => {
  const ctx = makeCtx();
  apply(ctx, { enabled: true, stuckEdits: 3, cooldownCalls: 0, maxPerSession: 2 });
  await ctx.preStep(AGENT, [userMessage('改个错字')]);
  const r1 = await ctx.postExec(AGENT, 'edit', { file_path: 'D:/x/a.js' });
  const r2 = await ctx.postExec(AGENT, 'edit', { file_path: 'D:/x/a.js' });
  assert.equal(nudgeText(r1), null);
  assert.equal(nudgeText(r2), null);
  const r3 = await ctx.postExec(AGENT, 'edit', { file_path: 'D:/x/a.js' });
  assert.ok(nudgeText(r3));
});

test('用户发新消息会重置 T2 计数', async () => {
  const ctx = makeCtx();
  apply(ctx, { enabled: true, stuckEdits: 3, cooldownCalls: 0, maxPerSession: 2 });
  await ctx.preStep(AGENT, [userMessage('改个错字', 'u1')]);
  await ctx.postExec(AGENT, 'edit', { file_path: 'D:/x/a.js' });
  await ctx.postExec(AGENT, 'edit', { file_path: 'D:/x/a.js' });
  await ctx.preStep(AGENT, [userMessage('换个别的改法', 'u2')]);
  const r = await ctx.postExec(AGENT, 'edit', { file_path: 'D:/x/a.js' });
  assert.equal(nudgeText(r), null, '新消息之后计数应从 1 重新开始');
});

test('同一 step 重复出现的同一条用户消息不会重置计数', async () => {
  const ctx = makeCtx();
  apply(ctx, { enabled: true, stuckEdits: 3, cooldownCalls: 0, maxPerSession: 2 });
  const message = userMessage('改个错字', 'u1');
  await ctx.preStep(AGENT, [message]);
  await ctx.postExec(AGENT, 'edit', { file_path: 'D:/x/a.js' });
  await ctx.postExec(AGENT, 'edit', { file_path: 'D:/x/a.js' });
  await ctx.preStep(AGENT, [message]); // 同一 step 的下一轮，id 不变
  const r = await ctx.postExec(AGENT, 'edit', { file_path: 'D:/x/a.js' });
  assert.ok(nudgeText(r), '计数不应被清空');
});

test('dryRun 只记录不注入', async () => {
  const ctx = makeCtx();
  apply(ctx, { enabled: true, dryRun: true });
  await ctx.preStep(AGENT, [userMessage('设计一个方案')]);
  const out = await ctx.postExec(AGENT, 'write', { file_path: 'D:/x/a.js' });
  assert.equal(nudgeText(out), null);
  const status = ctx.provided.creativityNudge.status();
  assert.equal(status.stats.dryRuns, 1);
  assert.equal(status.stats.fires, 0);
});

test('下游 block 决策会被保留', async () => {
  const ctx = makeCtx();
  apply(ctx, { enabled: true });
  await ctx.preStep(AGENT, [userMessage('设计一个方案')]);
  const handler = ctx.listeners.get('tools/post-execute')[0];
  const out = await handler(
    { agent: AGENT, name: 'write', arguments: { file_path: 'D:/x/a.js' } },
    { isError: false },
    async () => ({ kind: 'block', feedback: [{ type: 'text', text: 'no' }] }),
  );
  assert.equal(out.kind, 'block');
  assert.ok(out.feedback);
  assert.equal(out.additionalContexts[0].source.kind, 'creativity-nudge');
});

test('连续失败开关关闭时不受影响，打开时按阈值触发', async () => {
  const off = makeCtx();
  apply(off, { enabled: true, stuckFailures: 0 });
  await off.preStep(AGENT, [userMessage('跑一下')]);
  await off.postExec(AGENT, 'pwsh', {}, { isError: true });
  const a = await off.postExec(AGENT, 'pwsh', {}, { isError: true });
  assert.equal(nudgeText(a), null);

  const on = makeCtx();
  apply(on, { enabled: true, stuckFailures: 2, cooldownCalls: 0 });
  await on.preStep(AGENT, [userMessage('跑一下')]);
  await on.postExec(AGENT, 'pwsh', {}, { isError: true });
  const b = await on.postExec(AGENT, 'pwsh', {}, { isError: true });
  assert.ok(nudgeText(b));
});

test('文本工具与路径归一化', () => {
  assert.equal(isOpenEnded('设计一个缓存层', ['设计']), true);
  assert.equal(isOpenEnded('修复空指针', ['设计']), false);
  assert.equal(fileOf({ file_path: 'D:\\x\\A.js' }), 'd:/x/a.js');
  assert.equal(fileOf({}), '');
});

test('非法配置在装载时抛错', () => {
  assert.throws(() => normalizeConfig({ stuckEdits: 1 }), /stuckEdits/);
  assert.throws(() => normalizeConfig({ keywords: [] }), /keywords/);
  assert.throws(() => normalizeConfig({ maxPerSession: -1 }), /maxPerSession/);
});

test('contextMessage 带来源标记与稳定形状', () => {
  const message = contextMessage('hi', 'summary');
  assert.equal(message.role, 'user');
  assert.equal(message.source.form, 'notice');
  assert.equal(message.content[0].text, 'hi');
  assert.notEqual(message.id, contextMessage('hi', 'summary').id);
});
