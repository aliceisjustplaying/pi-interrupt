import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import install from '../index.ts';

// No live model requests, real credentials, user settings or global extensions.
async function fixture() {
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
  await session.bindExtensions({ mode: 'tui', onError: error => errors.push(error), uiContext: {
    setStatus() {}, notify() {}, getEditorText: () => editor, setEditorText: value => { editor = value; },
  } });
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
    signal: () => signal, editor: () => editor };
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
      else await f.session.prompt('interrupt message', { streamingBehavior: 'steer' });
      assert.equal(f.signal().aborted, true);
      await first;
      await f.finished;
      await f.session.waitForIdle();
      const texts = f.session.messages.filter(m => m.role === 'user').map(m => m.content.filter(c => c.type === 'text').map(c => c.text).join(''));
      assert.deepEqual(texts, ['original message', 'interrupt message', 'queued message']);
      assert.deepEqual(f.errors, []);
      if (mode === 'shortcut') assert.equal(f.editor(), '');
    } finally {
      await f.session.abort();
      f.session.dispose();
    }
  });
}
