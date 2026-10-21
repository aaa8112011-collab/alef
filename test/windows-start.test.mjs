import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWindowsAssistant } from '../scripts/windows-start.mjs';

const testToken = 'local-pairing-token-for-tests-only-123456';

function launcherHarness(settings = {}) {
  const calls = [];
  const fetchCalls = [];
  const logs = [];
  const servers = [];
  let running = settings.running !== false;
  const env = Object.freeze({ LOCALAPPDATA: 'C:\\Users\\Student\\AppData\\Local', ...settings.env });
  const model = env.SOLVER_LOCAL_MODEL || (env.SOLVER_PROVIDER === 'ollama' ? env.SOLVER_MODEL : '') || 'qwen3:8b';
  const visionModel = env.SOLVER_LOCAL_VISION_MODEL || (env.SOLVER_PROVIDER === 'ollama' ? env.SOLVER_VISION_MODEL : '') || 'qwen3-vl:8b';
  const installed = new Set([
    ...(settings.installed !== false ? [model] : []),
    ...(settings.visionInstalled !== false ? [visionModel] : []),
  ]);
  const spawnImpl = (command, args, options) => {
    const call = { command, args, options, input: undefined, kills: 0 };
    calls.push(call);
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = input => { call.input = input; };
    child.kill = () => { call.kills += 1; child.emit('exit', 0); return true; };
    queueMicrotask(() => {
      if (args[0] === 'serve') { running = true; return; }
      if (args[0] === '--version' && (settings.runtimeMissing || (settings.fallbackOnly && command === 'ollama'))) {
        child.emit('error', Object.assign(new Error('Missing executable'), { code: 'ENOENT' }));
      } else if (args[0] === 'pull') {
        if (settings.pullFails || settings.pullFailsModel === args[1]) child.emit('close', 1);
        else { if (!settings.badVerification) installed.add(args[1]); child.emit('close', 0); }
      } else if (command === 'clip.exe' && settings.clipFails) {
        child.emit('error', Object.assign(new Error('Clipboard unavailable'), { code: 'ENOENT' }));
      } else child.emit('close', 0);
    });
    return child;
  };
  const fetchImpl = async (url, options) => {
    fetchCalls.push({ url, options });
    if (url.endsWith('/api/tags')) {
      if (!running) throw new Error('Not running');
      return Response.json({ models: [...installed].map(name => ({ name })) });
    }
    if (url.endsWith('/api/health')) return Response.json({
      ok: true, provider: 'ollama', model, visionModel, configured: !settings.badHealth, modelReady: !settings.badHealth,
      visionReady: !settings.badVisionHealth,
    });
    throw new Error('Unexpected URL');
  };
  const serverFactory = config => {
    const server = new EventEmitter();
    server.config = config;
    server.closes = 0;
    server.listen = (port, host, callback) => {
      server.bound = { port, host };
      queueMicrotask(() => settings.portBusy
        ? server.emit('error', Object.assign(new Error('Busy'), { code: 'EADDRINUSE' }))
        : callback());
    };
    server.close = callback => { server.closes += 1; queueMicrotask(callback); };
    server.closeAllConnections = () => {};
    servers.push(server);
    return server;
  };
  return {
    calls, fetchCalls, logs, servers, env,
    options: { env, platform: 'win32', nodeVersion: '24.19.0', spawnImpl, fetchImpl, serverFactory,
      tokenLoader: async () => ({ token: testToken, path: null }),
      log: message => logs.push(message), sleep: async () => {} },
  };
}

test('Windows launcher rejects unsupported Node and non-Windows before starting processes', async () => {
  const harness = launcherHarness();
  await assert.rejects(startWindowsAssistant({ ...harness.options, nodeVersion: '20.19.0' }), /Node.js 22/);
  await assert.rejects(startWindowsAssistant({ ...harness.options, platform: 'linux' }), /ويندوز/);
  assert.equal(harness.calls.length, 0);
});

test('missing Ollama checks PATH and the supported Windows user installation then explains installation', async () => {
  const harness = launcherHarness({ runtimeMissing: true });
  await assert.rejects(startWindowsAssistant(harness.options), /https:\/\/ollama.com\/download\/windows/);
  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls[0].command, 'ollama');
  assert.equal(harness.calls[1].command, 'C:\\Users\\Student\\AppData\\Local\\Programs\\Ollama\\ollama.exe');
  assert.equal(harness.servers.length, 0);
});

test('installed text and vision models start without any API key and copy token through stdin without logging it', async t => {
  const harness = launcherHarness({ fallbackOnly: true });
  const app = await startWindowsAssistant(harness.options);
  t.after(() => app.close());
  assert.equal(app.model, 'qwen3:8b');
  assert.equal(app.visionModel, 'qwen3-vl:8b');
  assert.equal(harness.servers[0].config.visionModel, 'qwen3-vl:8b');
  assert.equal(harness.servers[0].config.provider, 'ollama');
  assert.equal(harness.servers[0].config.apiKey, '');
  assert.deepEqual(harness.servers[0].bound, { port: 4318, host: '127.0.0.1' });
  assert.equal(harness.calls.some(call => ['serve', 'pull'].includes(call.args[0])), false);
  const clipboard = harness.calls.find(call => call.command === 'clip.exe');
  assert.equal(clipboard.input, testToken);
  assert.deepEqual(clipboard.args, []);
  assert.equal(harness.logs.some(message => message.includes(testToken)), false);
  assert.equal(harness.calls.every(call => call.options.shell === false), true);
  assert.equal(harness.fetchCalls.every(call => call.options.redirect === 'error'), true);
  assert.deepEqual(harness.calls.find(call => call.command === 'explorer.exe').args, ['http://127.0.0.1:4318/']);
});

test('launcher starts only its own Ollama service, pulls the selected model, verifies it and stops only owned runtime', async () => {
  const harness = launcherHarness({ running: false, installed: false, env: { SOLVER_LOCAL_MODEL: 'qwen3:14b' } });
  const app = await startWindowsAssistant(harness.options);
  const serve = harness.calls.find(call => call.args[0] === 'serve');
  const pull = harness.calls.find(call => call.args[0] === 'pull');
  assert.ok(serve);
  assert.deepEqual(pull.args, ['pull', 'qwen3:14b']);
  assert.equal(serve.options.env.OLLAMA_HOST, 'http://127.0.0.1:11434');
  assert.equal(app.model, 'qwen3:14b');
  assert.match(harness.logs.find(message => message.includes('تنزيله')), /غيغابايت/);
  await app.close();
  await app.close();
  assert.equal(serve.kills, 1);
  assert.equal(harness.servers[0].closes, 1);
});

test('an existing text model only downloads the missing visual model and preserves the configured D model directory', async t => {
  const harness = launcherHarness({ visionInstalled: false, env: { OLLAMA_MODELS: 'D:\\ollama\\models' } });
  const app = await startWindowsAssistant(harness.options);
  t.after(() => app.close());
  const pulls = harness.calls.filter(call => call.args[0] === 'pull');
  assert.deepEqual(pulls.map(call => call.args), [['pull', 'qwen3-vl:8b']]);
  assert.equal(pulls[0].options.env.OLLAMA_MODELS, 'D:\\ollama\\models');
  assert.equal(harness.env.OLLAMA_MODELS, 'D:\\ollama\\models');
  assert.ok(harness.logs.some(message => message.includes('العربية والإنجليزية') && message.includes('مرة واحدة')));
  assert.equal(harness.servers[0].config.model, 'qwen3:8b');
  assert.equal(harness.servers[0].config.visionModel, 'qwen3-vl:8b');
});

test('first setup downloads and verifies both models in order before opening the local assistant', async t => {
  const harness = launcherHarness({ installed: false, visionInstalled: false });
  const app = await startWindowsAssistant(harness.options);
  t.after(() => app.close());
  assert.deepEqual(harness.calls.filter(call => call.args[0] === 'pull').map(call => call.args), [
    ['pull', 'qwen3:8b'], ['pull', 'qwen3-vl:8b'],
  ]);
  assert.equal(harness.fetchCalls.filter(call => call.url.endsWith('/api/tags')).length, 3);
  assert.ok(harness.calls.findIndex(call => call.command === 'clip.exe') > harness.calls.findIndex(call => call.args[1] === 'qwen3-vl:8b'));
  assert.equal(harness.servers.length, 1);
});

test('a failed visual download leaves the existing text model alone and never starts or claims full readiness', async () => {
  const harness = launcherHarness({ visionInstalled: false, pullFailsModel: 'qwen3-vl:8b' });
  await assert.rejects(startWindowsAssistant(harness.options), /لم يكتمل تنزيل النموذج qwen3-vl:8b/);
  assert.equal(harness.servers.length, 0);
  assert.deepEqual(harness.calls.filter(call => call.args[0] === 'pull').map(call => call.args), [['pull', 'qwen3-vl:8b']]);
  assert.equal(harness.calls.some(call => call.command === 'clip.exe'), false);
  assert.equal(harness.logs.some(message => message.startsWith('الخادم جاهز')), false);
});

test('visual model readiness must confirm capability rather than mere presence in the model list', async () => {
  const harness = launcherHarness({ badVisionHealth: true });
  await assert.rejects(startWindowsAssistant(harness.options), /جاهزية النموذج المرئي/);
  assert.equal(harness.servers[0].closes, 1);
  assert.equal(harness.calls.some(call => call.command === 'clip.exe'), false);
  assert.equal(harness.logs.some(message => message.startsWith('الخادم جاهز')), false);
});

test('explicit local visual-model override is passed to the service and unsafe names fail before process launch', async t => {
  const harness = launcherHarness({ visionInstalled: false, env: { SOLVER_LOCAL_VISION_MODEL: 'qwen2.5vl:7b' } });
  const app = await startWindowsAssistant(harness.options);
  t.after(() => app.close());
  assert.equal(app.visionModel, 'qwen2.5vl:7b');
  assert.equal(harness.servers[0].config.visionModel, 'qwen2.5vl:7b');
  assert.deepEqual(harness.calls.find(call => call.args[0] === 'pull').args, ['pull', 'qwen2.5vl:7b']);
  const invalid = launcherHarness({ env: { SOLVER_LOCAL_VISION_MODEL: 'qwen3-vl:8b & calc.exe' } });
  await assert.rejects(startWindowsAssistant(invalid.options), /اسم النموذج المحلي غير صالح/);
  assert.equal(invalid.calls.length, 0);
});

test('a single model configured for both tasks is downloaded once and must still pass visual capability health', async t => {
  const harness = launcherHarness({ installed: false, visionInstalled: false, env: { SOLVER_LOCAL_MODEL: 'qwen3-vl:8b' } });
  const app = await startWindowsAssistant(harness.options);
  t.after(() => app.close());
  assert.equal(app.model, app.visionModel);
  assert.deepEqual(harness.calls.filter(call => call.args[0] === 'pull').map(call => call.args), [['pull', 'qwen3-vl:8b']]);
});

test('a failed model download never starts the assistant or claims readiness', async () => {
  const harness = launcherHarness({ installed: false, pullFails: true });
  await assert.rejects(startWindowsAssistant(harness.options), /لم يكتمل تنزيل/);
  assert.equal(harness.servers.length, 0);
  assert.equal(harness.logs.some(message => message.startsWith('الخادم جاهز')), false);
  assert.equal(harness.calls.some(call => call.command === 'clip.exe'), false);
});

test('a successful pull exit status is insufficient if the model is still absent', async () => {
  const harness = launcherHarness({ installed: false, badVerification: true });
  await assert.rejects(startWindowsAssistant(harness.options), /النموذج لم يظهر/);
  assert.equal(harness.servers.length, 0);
});

test('old paid API settings are ignored for the free launcher and .env is unchanged', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'alef-windows-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, '.env');
  const original = 'SOLVER_PROVIDER=openai\nSOLVER_MODEL=gpt-4.1-mini\n';
  await writeFile(path, original);
  const harness = launcherHarness({ env: {
    SOLVER_PROVIDER: 'openai', SOLVER_MODEL: 'gpt-4.1-mini',
    SOLVER_BASE_URL: 'https://api.openai.com/v1', SOLVER_CONFIG_DIR: directory,
  } });
  const app = await startWindowsAssistant(harness.options);
  t.after(() => app.close());
  assert.equal(app.model, 'qwen3:8b');
  assert.equal(harness.servers[0].config.baseUrl, 'http://127.0.0.1:11434');
  assert.equal(await readFile(path, 'utf8'), original);
  assert.equal(harness.env.SOLVER_PROVIDER, 'openai');
});

test('external Ollama URLs are rejected before launching commands or connecting', async () => {
  const harness = launcherHarness({ env: { SOLVER_LOCAL_BASE_URL: 'http://example.com:11434' } });
  await assert.rejects(startWindowsAssistant(harness.options), /محليًا/);
  assert.equal(harness.calls.length, 0);
});

test('launcher honors bounded local inference timeout and rejects invalid values before startup', async t => {
  const valid = launcherHarness({ env: { SOLVER_TIMEOUT_MS: '600000' } });
  const app = await startWindowsAssistant(valid.options);
  t.after(() => app.close());
  assert.equal(valid.servers[0].config.requestTimeoutMs, 600000);
  for (const value of ['0', '999', '600001', 'not-a-number']) {
    const invalid = launcherHarness({ env: { SOLVER_TIMEOUT_MS: value } });
    await assert.rejects(startWindowsAssistant(invalid.options), /SOLVER_TIMEOUT_MS/);
    assert.equal(invalid.calls.length, 0);
  }
});

test('busy port is reported without killing an existing unrelated service', async () => {
  const harness = launcherHarness({ portBusy: true });
  await assert.rejects(startWindowsAssistant(harness.options), /المنفذ مستخدم/);
  assert.equal(harness.calls.every(call => call.kills === 0), true);
});

test('failed final model health check closes the new server and reports no readiness', async () => {
  const harness = launcherHarness({ badHealth: true });
  await assert.rejects(startWindowsAssistant(harness.options), /اختبار جاهزية النموذج لم ينجح/);
  assert.equal(harness.servers[0].closes, 1);
  assert.equal(harness.logs.some(message => message.startsWith('الخادم جاهز')), false);
});

test('clipboard failure preserves the running service and explains the token command', async t => {
  const harness = launcherHarness({ clipFails: true });
  const app = await startWindowsAssistant(harness.options);
  t.after(() => app.close());
  assert.ok(harness.logs.some(message => message.includes('npm run token')));
  assert.equal(harness.servers[0].closes, 0);
  assert.equal(harness.logs.some(message => message.includes(testToken)), false);
});

test('double-click batch uses a quoted working directory and Node script without shell-expanded settings', async () => {
  const source = await readFile(new URL('../START-WINDOWS.cmd', import.meta.url), 'utf8');
  assert.match(source, /cd \/d "%~dp0"/i);
  assert.match(source, /node "%~dp0scripts\\windows-start\.mjs"/i);
  assert.match(source, /chcp 65001 >nul/i);
  assert.doesNotMatch(source, /ExecutionPolicy|powershell|SOLVER_API_KEY|curl|--env-file-if-exists/i);
});
