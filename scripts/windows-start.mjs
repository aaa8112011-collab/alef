import { spawn } from 'node:child_process';
import { win32, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { createAppServer, loadPairingToken } from '../server/index.mjs';

function runCommand(spawnImpl, command, args, { input, visible = false, env } = {}) {
  return new Promise((resolveCommand, reject) => {
    const child = spawnImpl(command, args, {
      shell: false,
      windowsHide: !visible,
      stdio: input === undefined ? (visible ? 'inherit' : 'ignore') : ['pipe', 'ignore', 'ignore'],
      ...(env ? { env } : {}),
    });
    child.once('error', reject);
    child.once('close', code => code === 0
      ? resolveCommand()
      : reject(Object.assign(new Error('Command failed'), { code: 'COMMAND_FAILED' })));
    if (input !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

function localSettings(env) {
  // Local-prefixed values override old API-provider settings without editing .env.
  const model = env.SOLVER_LOCAL_MODEL || (env.SOLVER_PROVIDER === 'ollama' ? env.SOLVER_MODEL : '') || 'qwen3:8b';
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9._-]+)?$/.test(model) || model.length > 180) {
    throw new Error('اسم النموذج المحلي غير صالح. استخدم مثلًا qwen3:8b.');
  }
  let base;
  try {
    base = new URL(env.SOLVER_LOCAL_BASE_URL || (env.SOLVER_PROVIDER === 'ollama' ? env.SOLVER_BASE_URL : '') || 'http://127.0.0.1:11434');
  } catch { throw new Error('عنوان Ollama المحلي غير صالح.'); }
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname)
    || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('عنوان Ollama يجب أن يكون محليًا مثل http://127.0.0.1:11434.');
  }
  const port = Number(env.SOLVER_PORT || 4318);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('منفذ الخادم غير صالح.');
  const requestTimeoutMs = Number(env.SOLVER_TIMEOUT_MS || 240000);
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 600000) {
    throw new Error('SOLVER_TIMEOUT_MS يجب أن يكون عددًا صحيحًا بين 1000 و600000.');
  }
  return { model, baseUrl: base.origin, port, requestTimeoutMs };
}

async function installedModels(fetchImpl, baseUrl) {
  try {
    const response = await fetchImpl(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (!response.ok) return null;
    const result = await response.json();
    return Array.isArray(result.models) ? result.models : null;
  } catch { return null; }
}

const hasModel = (models, name) => models.some(model =>
  [model.name, model.model].includes(name) || (!name.includes(':') && [model.name, model.model].includes(`${name}:latest`)));

/** Windows orchestration only. Dependencies are injected in tests; no model output is mocked in production. */
export async function startWindowsAssistant(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const spawnImpl = options.spawnImpl ?? spawn;
  const fetchImpl = options.fetchImpl ?? fetch;
  const serverFactory = options.serverFactory ?? createAppServer;
  const tokenLoader = options.tokenLoader ?? loadPairingToken;
  const log = options.log ?? console.log;
  const sleep = options.sleep ?? (ms => new Promise(done => setTimeout(done, ms)));
  if (Number(nodeVersion.split('.')[0]) < 22) throw new Error('ثبّت Node.js 22 أو أحدث من https://nodejs.org/ ثم أعد التشغيل.');
  if (platform !== 'win32') throw new Error('هذا المشغّل مخصص لويندوز. استخدم npm start على الأنظمة الأخرى.');
  const config = localSettings(env);
  const runtimeEnv = { ...env, OLLAMA_HOST: config.baseUrl };
  const candidates = ['ollama'];
  if (env.LOCALAPPDATA) candidates.push(win32.join(env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'));
  let executable;
  for (const candidate of candidates) {
    try {
      await runCommand(spawnImpl, candidate, ['--version'], { env: runtimeEnv });
      executable = candidate;
      break;
    } catch { /* Try the supported per-user Windows installation next. */ }
  }
  if (!executable) throw new Error('لم أجد Ollama. ثبّته من https://ollama.com/download/windows ثم افتح START-WINDOWS.cmd مجددًا.');

  let ownedRuntime;
  let server;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (server) {
      await new Promise(done => {
        server.close(done);
        server.closeAllConnections?.();
      });
    }
    if (ownedRuntime) ownedRuntime.kill();
  };
  try {
    let models = await installedModels(fetchImpl, config.baseUrl);
    if (!models) {
      log('تشغيل خدمة Ollama المحلية…');
      ownedRuntime = spawnImpl(executable, ['serve'], {
        shell: false, windowsHide: true, stdio: 'inherit', env: runtimeEnv,
      });
      let runtimeFailed = false;
      ownedRuntime.once('error', () => { runtimeFailed = true; });
      ownedRuntime.once('exit', () => { runtimeFailed = true; });
      for (let attempt = 0; attempt < 40; attempt += 1) {
        models = await installedModels(fetchImpl, config.baseUrl);
        if (models) break;
        if (runtimeFailed) throw new Error('تعذّر تشغيل Ollama. افتح تطبيق Ollama ثم أعد تشغيل البرنامج.');
        await sleep(500);
      }
      if (!models) throw new Error('لم تستجب خدمة Ollama المحلية. افتح Ollama ثم أعد المحاولة.');
    }
    if (!hasModel(models, config.model)) {
      log(`النموذج ${config.model} غير مثبت. يبدأ تنزيله الآن؛ قد يحتاج عدة غيغابايت من الإنترنت والمساحة (نحو 5 غيغابايت للنموذج الافتراضي).`);
      try {
        await runCommand(spawnImpl, executable, ['pull', config.model], { visible: true, env: runtimeEnv });
      } catch {
        throw new Error('لم يكتمل تنزيل النموذج. تحقق من اتصال الإنترنت والمساحة ثم أعد فتح البرنامج لاستكمال التنزيل.');
      }
      models = await installedModels(fetchImpl, config.baseUrl);
      if (!models || !hasModel(models, config.model)) throw new Error('انتهى أمر التنزيل لكن النموذج لم يظهر في Ollama؛ لم يبدأ خادم الحل.');
    }
    const { token } = await tokenLoader(env.SOLVER_CONFIG_DIR);
    server = serverFactory({ provider: 'ollama', model: config.model, baseUrl: config.baseUrl,
      apiKey: '', pairingToken: token, requestTimeoutMs: config.requestTimeoutMs });
    await new Promise((listen, reject) => {
      const onError = error => reject(error.code === 'EADDRINUSE'
        ? new Error('المنفذ مستخدم. أغلق نافذة البرنامج القديمة، أو غيّر SOLVER_PORT، ثم أعد التشغيل.')
        : new Error('تعذّر تشغيل الخادم المحلي.'));
      server.once('error', onError);
      server.listen(config.port, '127.0.0.1', () => {
        server.removeListener('error', onError);
        listen();
      });
    });
    server.on('error', () => log('حدث خطأ في الخادم المحلي. أعد تشغيل البرنامج.'));
    const address = `http://127.0.0.1:${config.port}`;
    let health;
    try {
      const response = await fetchImpl(`${address}/api/health`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      health = response.ok ? await response.json() : null;
    } catch { /* A failed readiness request must not produce a success message. */ }
    if (!health?.ok || health.provider !== 'ollama' || health.model !== config.model || health.modelReady !== true || health.configured !== true) {
      throw new Error('بدأ الخادم لكن اختبار جاهزية النموذج لم ينجح. تحقق من خدمة Ollama ثم أعد التشغيل.');
    }
    log(`الخادم جاهز بالنموذج المحلي ${config.model}. لا يحتاج مفتاح API مدفوعًا. اترك هذه النافذة مفتوحة.`);
    try {
      await runCommand(spawnImpl, 'clip.exe', [], { input: token });
      log('نُسخ رمز الاقتران المحلي إلى الحافظة. الصقه في إعدادات الإضافة فقط.');
    } catch { log('تعذّر نسخ رمز الاقتران. استخدم npm run token محليًا ثم انسخه إلى الإضافة.'); }
    try { await runCommand(spawnImpl, 'explorer.exe', [`${address}/`]); }
    catch { log(`افتح صفحة الإعداد المحلية في متصفحك: ${address}/`); }
    return { server, model: config.model, address, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function main() {
  // Built-in .env loading also supports Node 22 versions before --env-file-if-exists.
  try { loadEnvFile(resolve(process.cwd(), '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('تعذّر قراءة .env؛ لم تتغير إعداداتك.'); }
  const app = await startWindowsAssistant();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close(); });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
