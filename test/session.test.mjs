import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import install from '../index.ts';

// No live model requests, real credentials, user settings or global extensions.
// options.tuiAbort binds the same abort handler Pi's terminal UI uses, which
// drains the queues and restores them into the editor before cancelling.
async function fixture(options = {}) {
  const root = process.env.TMPDIR || join(import.meta.dirname, '..', '.test-artifacts');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'pi-interrupt-test-'));
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: join(dir, 'models.json'), allowModelNetwork: false,
  });
  await modelRuntime.setRuntimeApiKey('anthropic', 'local-test-only');
  const shortcuts = new Map(), errors = [];
  let ctx, editor = 'interrupt message';
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [pi => {
      install({ ...pi, registerShortcut(key, value) { shortcuts.set(key, value); pi.registerShortcut(key, value); } });
      pi.on('session_start', (_event, context) => { ctx = context; });
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const model = modelRuntime.getModel('anthropic', 'claude-sonnet-4-5');
  assert.ok(model);
  const { session } = await createAgentSession({
    cwd: dir, agentDir: dir, modelRuntime, model, resourceLoader: loader,
    settingsManager, sessionManager: SessionManager.inMemory(dir), noTools: 'all',
  });
  const bindings = { mode: 'tui', onError: error => errors.push(error), uiContext: {
    setStatus() {}, notify() {}, getEditorText: () => editor, setEditorText: value => { editor = value; },
  } };
  if (options.tuiAbort) {
    bindings.abortHandler = () => {
      const { steering, followUp } = session.clearQueue();
      const queued = [...steering, ...followUp];
      if (queued.length) editor = [...queued, editor].filter(t => t.trim()).join("\n\n");
      void session.abort();
    };
  }
  await session.bindExtensions(bindings);
  const started = Promise.withResolvers();
  let calls = 0, signal;
  session.agent.streamFunction = (_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    const message = {
      role: 'assistant', content: [{ type: 'text', text: 'done' }], api: model.api,
      provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    if (++calls === 1) {
      signal = options.signal;
      const finish = () => stream.push({ type: 'error', reason: 'aborted', error: { ...message, stopReason: 'aborted' } });
      signal.addEventListener('abort', finish, { once: true });
      started.resolve();
    } else {
      queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message }));
    }
    return stream;
  };
  const finished = Promise.withResolvers();
  session.subscribe(event => {
    if (event.type === 'agent_settled' && calls > 1) finished.resolve();
  });
  return { session, errors, started: started.promise, finished: finished.promise,
    interrupt: () => shortcuts.get('ctrl+enter').handler(ctx),
    submit: (text, opts) => { editor = ""; return session.prompt(text, opts); },
    setEditor: text => { editor = text; },
    signal: () => signal, editor: () => editor };
}

function userTexts(f) {
  return f.session.messages.filter(m => m.role === 'user').map(m => m.content.filter(c => c.type === 'text').map(c => c.text).join(''));
}

for (const [mode, queue] of [['shortcut', 'followUp'], ['enter-mode', 'followUp'], ['shortcut', 'steer']]) {
  test(`${mode}: actual Pi abort/settle/resubmit preserves queued ${queue}`, { timeout: 15000 }, async () => {
    const f = await fixture();
    try {
      if (mode === 'enter-mode') await f.session.prompt('/interrupt-mode on');
      const first = f.session.prompt('original message');
      await f.started;
      await f.session.prompt('queued message', { streamingBehavior: queue });
      assert.equal(f.signal().aborted, false);
      if (mode === 'shortcut') await f.interrupt();
      else await f.submit('interrupt message', { streamingBehavior: 'steer' });
      assert.equal(f.signal().aborted, true);
      await first;
      await f.finished;
      await f.session.waitForIdle();
      const texts = userTexts(f);
      assert.deepEqual(texts, ['original message', 'interrupt message', 'queued message']);
      assert.deepEqual(f.errors, []);
      if (mode === 'shortcut') assert.equal(f.editor(), '');
    } finally {
      await f.session.abort();
      f.session.dispose();
    }
  });
}

for (const queue of ['steer', 'followUp']) {
  test(`shortcut with TUI abort restore sends queued ${queue} ahead of the draft`, { timeout: 15000 }, async () => {
    const f = await fixture({ tuiAbort: true });
    try {
      const first = f.session.prompt('original message');
      await f.started;
      await f.session.prompt('queued message', { streamingBehavior: queue });
      await f.interrupt();
      assert.equal(f.signal().aborted, true);
      await first;
      await f.finished;
      await f.session.waitForIdle();
      const texts = userTexts(f);
      assert.deepEqual(texts, ['original message', 'queued message\n\ninterrupt message']);
      assert.deepEqual(f.errors, []);
      assert.equal(f.editor(), '');
    } finally {
      await f.session.abort();
      f.session.dispose();
    }
  });
}

test('shortcut with TUI abort restore sends queued messages alone when the editor is empty', { timeout: 15000 }, async () => {
  const f = await fixture({ tuiAbort: true });
  try {
    const first = f.session.prompt('original message');
    await f.started;
    await f.session.prompt('queued message', { streamingBehavior: 'steer' });
    f.setEditor('');
    await f.interrupt();
    assert.equal(f.signal().aborted, true);
    await first;
    await f.finished;
    await f.session.waitForIdle();
    assert.deepEqual(userTexts(f), ['original message', 'queued message']);
    assert.deepEqual(f.errors, []);
    assert.equal(f.editor(), '');
  } finally {
    await f.session.abort();
    f.session.dispose();
  }
});

test('enter-mode with TUI abort restore sends queued entries ahead of the submission', { timeout: 15000 }, async () => {
  const f = await fixture({ tuiAbort: true });
  try {
    await f.session.prompt('/interrupt-mode on');
    const first = f.session.prompt('original message');
    await f.started;
    await f.submit('queued message', { streamingBehavior: 'steer' });
    await f.submit('interrupt message', { streamingBehavior: 'steer' });
    assert.equal(f.signal().aborted, true);
    await first;
    await f.finished;
    await f.session.waitForIdle();
    assert.deepEqual(userTexts(f), ['original message', 'queued message\n\ninterrupt message']);
    assert.deepEqual(f.errors, []);
    assert.equal(f.editor(), '');
  } finally {
    await f.session.abort();
    f.session.dispose();
  }
});
