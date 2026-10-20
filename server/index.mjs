import http from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile, link, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { solveQuestion, SolverError, readProviderJson } from './solver.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localHost = /^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/;
const allowedOrigin = origin => /^chrome-extension:\/\/[a-p]{32}$/.test(origin)
  || /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/.test(origin);

function authorized(header, token) {
  if (!token || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    let rejected = false;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > 100_000) {
        if (!rejected) reject(new SolverError('request_too_large', 'حجم السؤال أكبر من المسموح.', 413));
        rejected = true;
      } else if (!rejected) chunks.push(chunk);
    });
    request.on('end', () => {
      if (rejected) return;
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new SolverError('invalid_json', 'يجب إرسال بيانات JSON صالحة.', 400)); }
    });
    request.on('error', () => reject(new SolverError('request_aborted', 'أُلغي الطلب.', 400)));
  });
}

function getConfig(options) {
  const provider = options.provider ?? process.env.SOLVER_PROVIDER ?? 'ollama';
  if (!['ollama', 'openai'].includes(provider)) throw new Error('SOLVER_PROVIDER must be ollama or openai.');
  const isLocal = provider === 'ollama';
  const config = {
    provider,
    apiKey: options.apiKey ?? process.env.SOLVER_API_KEY ?? '',
    model: options.model ?? process.env.SOLVER_MODEL ?? (isLocal ? 'qwen3:8b' : 'gpt-4.1-mini'),
    baseUrl: options.baseUrl ?? process.env.SOLVER_BASE_URL ?? (isLocal ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1'),
    pairingToken: options.pairingToken ?? process.env.SOLVER_PAIRING_TOKEN ?? '',
    fetchImpl: options.fetchImpl ?? fetch,
    requestTimeoutMs: Number(options.requestTimeoutMs ?? process.env.SOLVER_TIMEOUT_MS ?? (isLocal ? 240_000 : 60_000)),
    healthTimeoutMs: options.healthTimeoutMs ?? 2000,
    downloadPath: options.downloadPath ?? resolve(projectRoot, 'dist/alef-assistant.zip'),
  };
  if (typeof config.model !== 'string' || !config.model.trim() || config.model.length > 200 || /[\r\n]/.test(config.model)) throw new Error('SOLVER_MODEL must be a nonempty model name.');
  if (!Number.isInteger(config.requestTimeoutMs) || config.requestTimeoutMs < 1000 || config.requestTimeoutMs > 600_000) throw new Error('SOLVER_TIMEOUT_MS must be between 1000 and 600000.');
  let endpoint;
  try { endpoint = new URL(config.baseUrl); } catch { throw new Error('SOLVER_BASE_URL must be a valid URL.'); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('SOLVER_BASE_URL cannot contain credentials, query, or fragment. HTTPS is required for OpenAI.');
  if (isLocal && (endpoint.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(endpoint.hostname))) {
    throw new Error('Ollama SOLVER_BASE_URL must be a local HTTP URL on localhost or 127.0.0.1.');
  }
  if (!isLocal && endpoint.protocol !== 'https:') {
    throw new Error('OpenAI SOLVER_BASE_URL must use HTTPS.');
  }
  return config;
}

const canonicalModel = name => name.split('/').at(-1).includes(':') ? name : `${name}:latest`;
async function getHealth(config) {
  const base = { ok: true, configured: false, provider: config.provider, model: config.model, modelReady: false };
  if (config.provider === 'openai') return { ...base, configured: Boolean(config.apiKey), ...(!config.apiKey ? { issue: 'not_configured', message: 'الوضع المدفوع يحتاج مفتاح خدمة؛ يمكنك استخدام وضع Ollama المحلي المجاني بدلًا منه.' } : {}) };
  const signal = AbortSignal.timeout(config.healthTimeoutMs);
  let response;
  try {
    response = await config.fetchImpl(`${config.baseUrl.replace(/\/+$/, '')}/api/tags`, { signal, redirect: 'error' });
  } catch {
    return { ...base, issue: 'ollama_unreachable', message: 'افتح Ollama على جهاز Windows ثم أعد فحص الاتصال.' };
  }
  try {
    if (!response.ok) { response.body?.cancel().catch(() => {}); throw new Error('runtime response'); }
    const body = await readProviderJson(response, signal);
    if (!Array.isArray(body.models)) throw new Error('invalid model list');
    const modelReady = body.models.some(model => [model?.name, model?.model].some(name => typeof name === 'string' && canonicalModel(name) === canonicalModel(config.model)));
    return modelReady ? { ...base, configured: true, modelReady: true }
      : { ...base, issue: 'model_not_found', message: `النموذج غير مثبت. شغّل ollama pull ${config.model} ثم أعد الفحص.` };
  } catch {
    return { ...base, issue: 'invalid_provider_response', message: 'تعذّر قراءة قائمة نماذج Ollama. تحقّق من تشغيله وتحديثه.' };
  }
}

const setupPage = `<!doctype html>
<html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>مُعين ألف — الإعداد المحلي</title>
<style>body{font-family:system-ui,sans-serif;background:#f5f8fc;color:#17243a;max-width:760px;padding:48px 24px;margin:auto;line-height:1.9}main{background:white;padding:32px;border:1px solid #dce4ee;border-radius:20px}a{color:#136dca}code{direction:ltr;display:inline-block;background:#edf3fa;padding:0 6px;border-radius:4px}h1{margin:0}</style>
<main><h1>مُعين ألف</h1><p>الخادم المحلي يعمل. الحل الافتراضي مجاني على جهازك عبر Ollama، دون مفتاح API أو اشتراك مدفوع. هذه أداة مستقلة وليست منتجًا رسميًا من منصة ألف.</p>
<ol><li>ثبّت Ollama لنظام Windows من موقعه الرسمي وافتحه.</li><li>افتح PowerShell وشغّل <code>ollama pull qwen3:8b</code> مرة واحدة لتنزيل النموذج. تنزيل النموذج يحتاج اتصالًا بالإنترنت ومساحة تخزين؛ سرعة الحل تعتمد على جهازك. النموذج مناسب لجهازك ذي ذاكرة 32GB؛ يمكنك اختيار <code>qwen3:4b</code> الأخف إذا احتجت.</li><li>حمّل <a href="/downloads/alef-assistant.zip">ملف الإضافة</a> وفك ضغطه، أو استخدم مجلد <code>extension</code> مباشرة.</li><li>افتح صفحة إضافات Chrome، فعّل وضع المطور، ثم اختر «تحميل إضافة غير مضغوطة».</li><li>سجّل الدخول إلى <code>https://moe.alefed.com/</code> في متصفحك، ثم افتح الإضافة واربط علامة التبويب.</li><li>شغّل <code>npm run token</code> محليًا وانسخ رمز الاقتران إلى إعدادات الإضافة. هذا الرمز يحمي الاتصال بين الإضافة والخادم المحلي؛ ليس مفتاح API مدفوعًا. الملف موجود في <code>.alef-assistant/pairing-token</code> داخل مجلد المستخدم، أو المسار الذي حددته في <code>SOLVER_CONFIG_DIR</code>.</li><li>افحص الاتصال في الإضافة. ظهور النموذج في فحص الحالة يؤكد تثبيته، أما أول سؤال فيختبر الاستدلال الفعلي.</li></ol>
<p>في وضع Ollama المحلي تبقى الأسئلة على جهازك. تقدير الثقة والتحقق المزدوج لا يضمنان صحة كل إجابة، والموقع الحقيقي يحتاج اختبارًا وضبطًا قبل الاعتماد على الإرسال التلقائي.</p>
<details><summary>الوضع الخارجي اختياري وقد يكون مدفوعًا</summary><p>لمن يريد استخدام مزود خارجي فقط: اضبط <code>SOLVER_PROVIDER=openai</code> ومفتاح <code>SOLVER_API_KEY</code>. عندها تُرسل الأسئلة إلى المزود الخارجي. اترك الوضع الافتراضي <code>ollama</code> للعمل المحلي دون مفتاح.</p></details>
<p><a href="/api/health">حالة الخدمة والنموذج المحلي</a></p></main></html>`;

export function createAppServer(options = {}) {
  const config = getConfig(options);
  const server = http.createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (!localHost.test(request.headers.host ?? '')) return json(response, 403, { error: { code: 'invalid_host', message: 'عنوان الخادم غير مسموح.' } });
    if (origin && !allowedOrigin(origin)) return json(response, 403, { error: { code: 'origin_forbidden', message: 'مصدر الطلب غير مسموح.' } });
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '600' });
      return response.end();
    }
    let path;
    try { path = new URL(request.url, 'http://127.0.0.1').pathname; }
    catch { return json(response, 400, { error: { code: 'invalid_url', message: 'عنوان الطلب غير صالح.' } }); }
    if (request.method === 'GET' && path === '/api/health') return json(response, 200, await getHealth(config));
    if (request.method === 'GET' && path === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' });
      return response.end(setupPage);
    }
    if (request.method === 'GET' && path === '/downloads/alef-assistant.zip') {
      try {
        const archive = await readFile(config.downloadPath);
        response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="alef-assistant.zip"', 'X-Content-Type-Options': 'nosniff' });
        return response.end(archive);
      } catch { return json(response, 404, { error: { code: 'archive_not_built', message: 'ملف الإضافة لم يُجهّز بعد. استخدم مجلد extension أو شغّل أمر التحزيم.' } }); }
    }
    if (request.method !== 'POST' || path !== '/api/solve') return json(response, 404, { error: { code: 'not_found', message: 'المسار غير موجود.' } });
    if (!authorized(request.headers.authorization, config.pairingToken)) return json(response, 401, { error: { code: 'unauthorized', message: 'رمز الاقتران غير صحيح.' } });
    if ((request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') return json(response, 415, { error: { code: 'unsupported_media_type', message: 'استخدم Content-Type: application/json.' } });
    const controller = new AbortController();
    response.on('close', () => { if (!response.writableEnded) controller.abort(); });
    try {
      const input = await readJson(request);
      const result = await solveQuestion(input, config, controller.signal);
      if (!response.destroyed) json(response, 200, result);
    } catch (error) {
      if (response.destroyed) return;
      if (error instanceof SolverError) return json(response, error.status, { error: { code: error.code, message: error.message } });
      json(response, 500, { error: { code: 'internal_error', message: 'حدث خطأ داخلي في الخادم.' } });
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 20_000;
  return server;
}

export async function loadPairingToken(configDir = process.env.SOLVER_CONFIG_DIR ?? resolve(homedir(), '.alef-assistant')) {
  const validateToken = token => {
    if (!/^[A-Za-z0-9._~+/=-]{32,256}$/.test(token)) {
      throw new Error('Pairing token must contain 32–256 ASCII token characters without spaces. Inspect the local token file or SOLVER_PAIRING_TOKEN; its value was not changed.');
    }
    return token;
  };
  if (process.env.SOLVER_PAIRING_TOKEN) return { token: validateToken(process.env.SOLVER_PAIRING_TOKEN.trim()), path: null };
  const path = resolve(configDir, 'pairing-token');
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  try {
    const token = validateToken((await readFile(path, 'utf8')).trim());
    return { token, path };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const token = randomBytes(32).toString('hex');
    const temporaryPath = resolve(configDir, `.pairing-token-${randomBytes(12).toString('hex')}.tmp`);
    // Publish a fully written file atomically. Two simultaneous starts must never
    // read an empty file created by the other's pending writeFile operation.
    await writeFile(temporaryPath, `${token}\n`, { mode: 0o600, flag: 'wx' });
    try {
      await link(temporaryPath, path);
    } catch (linkError) {
      if (linkError.code !== 'EEXIST') throw linkError;
      return loadPairingToken(configDir);
    } finally {
      await unlink(temporaryPath);
    }
    return { token, path };
  }
}

async function main() {
  const { token, path } = await loadPairingToken();
  const port = Number(process.env.SOLVER_PORT ?? 4318);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SOLVER_PORT must be between 1 and 65535.');
  const server = createAppServer({ pairingToken: token });
  server.on('error', error => { console.error(`Local server failed: ${error.code ?? 'unknown_error'}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => {
    console.log(`مُعين ألف: http://127.0.0.1:${port}`);
    console.log(path ? `رمز الاقتران محفوظ محليًا في: ${path}` : 'يستخدم الخادم رمز الاقتران من SOLVER_PAIRING_TOKEN.');
    if ((process.env.SOLVER_PROVIDER ?? 'ollama') === 'ollama') console.log('الحل مجاني ومحلي عبر Ollama. افتح Ollama وثبّت النموذج المحدد قبل البدء؛ لا تحتاج مفتاح API.');
    else if (!process.env.SOLVER_API_KEY) console.log('الوضع المدفوع غير مفعّل: اضبط SOLVER_API_KEY أو اختر SOLVER_PROVIDER=ollama للحل المحلي المجاني.');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeAllConnections(); });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
