import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import { createAppServer, loadPairingToken } from '../server/index.mjs';

const token = 'local-test-pairing-token-not-real';
const input = { subject: 'الرياضيات', question: { id: 'q1', text: '2 + 2?', type: 'single', options: [{ id: 'a', text: '4' }, { id: 'b', text: '5' }] }, verify: false };
const answer = { optionIds: ['a'], text: '4', explanation: '2 + 2 = 4', confidence: 0.99 };
async function withServer(t, options = {}) {
  const server = createAppServer({ provider: 'openai', apiKey: '', pairingToken: token, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const post = (url, body, headers = {}) => fetch(`${url}/api/solve`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });

test('health reports missing credentials without exposing any secret or token', async t => {
  const url = await withServer(t);
  const response = await fetch(`${url}/api/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.configured, false);
  assert.equal(body.provider, 'openai');
  assert.equal(body.model, 'gpt-4.1-mini');
  assert.equal(body.modelReady, false);
  assert.equal(JSON.stringify(body).includes(token), false);
});

test('solve requires the local pairing token', async t => {
  const url = await withServer(t);
  for (const authorization of ['', 'Bearer bad-token']) {
    const response = await post(url, input, { Authorization: authorization });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'unauthorized');
  }
});

test('configured missing API key is a real 503, never a fake answer', async t => {
  const url = await withServer(t);
  const response = await post(url, input);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'not_configured');
});

test('paired solve request returns the provider answer', async t => {
  let calls = 0;
  const url = await withServer(t, { apiKey: 'test-key-not-real', fetchImpl: async () => {
    calls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
  } });
  const response = await post(url, input);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { answer, verified: false, needsReview: false });
  assert.equal(calls, 1);
});

test('extension origin is permitted and arbitrary website origin is blocked', async t => {
  const url = await withServer(t);
  const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  const response = await fetch(`${url}/api/health`, { headers: { Origin: origin } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  const denied = await post(url, input, { Origin: 'https://evil.example' });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
});

test('CORS preflight permits authorization only for accepted origins', async t => {
  const url = await withServer(t);
  const response = await fetch(`${url}/api/solve`, { method: 'OPTIONS', headers: { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' } });
  assert.equal(response.status, 204);
  assert.match(response.headers.get('access-control-allow-headers'), /Authorization/);
});

test('a foreign Host header is refused to prevent DNS rebinding', async t => {
  const url = await withServer(t);
  // Native fetch normalizes Host; use http.request to exercise the actual wire header.
  const status = await new Promise((resolve, reject) => {
    http.get(`${url}/api/health`, { headers: { Host: 'attacker.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 403);
});

test('oversized and malformed requests fail before provider access', async t => {
  const url = await withServer(t);
  let response = await post(url, { ...input, subject: 'x'.repeat(4_300_001) });
  assert.equal(response.status, 413);
  response = await fetch(`${url}/api/solve`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{broken' });
  assert.equal(response.status, 400);
  response = await post(url, input, { 'Content-Type': 'text/plain' });
  assert.equal(response.status, 415);
});

test('provider URLs require TLS and cannot embed credentials', () => {
  for (const baseUrl of ['http://example.com/v1', 'https://user:password@example.com', 'https://example.com?key=secret']) {
    assert.throws(() => createAppServer({ provider: 'openai', baseUrl }), /HTTPS/);
  }
});

test('setup page is available and missing archive has an explicit error', async t => {
  const url = await withServer(t, { downloadPath: '/definitely/not/a/real/archive.zip' });
  const page = await fetch(url);
  assert.match(await page.text(), /مُعين ألف/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const download = await fetch(`${url}/downloads/alef-assistant.zip`);
  assert.equal(download.status, 404);
});

test('pairing token persists across restarts and file is private', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'alef-token-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await loadPairingToken(dir);
  const second = await loadPairingToken(dir);
  assert.equal(first.token, second.token);
  assert.match(first.token, /^[a-f0-9]{64}$/);
  assert.equal((await stat(first.path)).mode & 0o777, 0o600);
  assert.equal((await readFile(first.path, 'utf8')).trim(), first.token);
});

test('invalid existing pairing token is preserved and reported, not overwritten', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'alef-token-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'pairing-token'), 'invalid');
  await assert.rejects(loadPairingToken(dir), /32–256 ASCII token characters/);
  assert.equal(await readFile(join(dir, 'pairing-token'), 'utf8'), 'invalid');
});

test('concurrent first-time token creation returns one stable token', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'alef-token-race-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const results = await Promise.all(Array.from({ length: 12 }, () => loadPairingToken(dir)));
  assert.equal(new Set(results.map(result => result.token)).size, 1);
  assert.equal((await readFile(results[0].path, 'utf8')).trim(), results[0].token);
});

test('line breaks inside an existing token are rejected without changing the file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'alef-token-format-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const content = `${'a'.repeat(32)}\n${'b'.repeat(32)}\n`;
  await writeFile(join(dir, 'pairing-token'), content);
  await assert.rejects(loadPairingToken(dir), /without spaces/);
  assert.equal(await readFile(join(dir, 'pairing-token'), 'utf8'), content);
});

async function withLocalRuntime(t, handler) {
  const runtime = http.createServer(handler);
  runtime.listen(0, '127.0.0.1');
  await once(runtime, 'listening');
  t.after(() => new Promise(resolve => { runtime.close(resolve); runtime.closeAllConnections(); }));
  return `http://127.0.0.1:${runtime.address().port}`;
}

test('local Ollama HTTP integration checks the installed model and solves without any API key', async t => {
  const received = [];
  const baseUrl = await withLocalRuntime(t, async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    assert.equal(request.headers.authorization, undefined);
    if (request.url === '/api/tags') return response.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }));
    assert.equal(request.url, '/api/chat');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.end(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify(answer) }, done: true }));
  });
  const url = await withServer(t, { provider: 'ollama', apiKey: '', model: 'qwen3:8b', baseUrl });
  const health = await (await fetch(`${url}/api/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.protocolVersion, 2);
  assert.equal(health.configured, true);
  assert.equal(health.provider, 'ollama');
  assert.equal(health.model, 'qwen3:8b');
  assert.equal(health.modelReady, true);
  assert.equal(health.visionModel, 'qwen3-vl:8b');
  assert.equal(health.visionReady, false);
  assert.equal(health.visionIssue, 'vision_model_not_found');
  const solved = await post(url, { ...input, verify: true });
  assert.equal(solved.status, 200);
  assert.deepEqual(await solved.json(), { answer, verified: true, needsReview: false });
  assert.equal(received.length, 2);
  assert.equal(received[0].stream, false);
  assert.equal(received[0].format, 'json');
  assert.equal(received[0].think, false);
});

test('local health does not call a different installed model ready', async t => {
  const baseUrl = await withLocalRuntime(t, (_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ models: [{ name: 'qwen3:4b' }] }));
  });
  const url = await withServer(t, { provider: 'ollama', model: 'qwen3:8b', baseUrl });
  const health = await (await fetch(`${url}/api/health`)).json();
  assert.equal(health.configured, false);
  assert.equal(health.modelReady, false);
  assert.equal(health.issue, 'model_not_found');
  assert.match(health.message, /ollama pull qwen3:8b/);
});

test('local health distinguishes a stopped runtime and a missing model from a missing API key', async t => {
  const url = await withServer(t, { provider: 'ollama', fetchImpl: async () => { throw new Error('refused'); } });
  const health = await (await fetch(`${url}/api/health`)).json();
  assert.equal(health.configured, false);
  assert.equal(health.provider, 'ollama');
  assert.equal(health.issue, 'ollama_unreachable');
  const solve = await post(url, input);
  assert.equal(solve.status, 503);
  assert.equal((await solve.json()).error.code, 'ollama_unreachable');
});

test('Ollama endpoints must stay on local HTTP and cannot hide credentials or queries', () => {
  for (const baseUrl of ['https://127.0.0.1:11434', 'http://192.168.1.2:11434', 'http://example.com:11434', 'http://localhost:11434?key=secret', 'http://user:secret@localhost:11434', 'http://localhost:11434#fragment']) {
    assert.throws(() => createAppServer({ provider: 'ollama', baseUrl }), /SOLVER_BASE_URL/);
  }
});

test('solver provider and total timeout configuration have bounded supported values', () => {
  assert.throws(() => createAppServer({ provider: 'unknown' }), /SOLVER_PROVIDER/);
  for (const requestTimeoutMs of [0, 999, 600001, NaN]) {
    assert.throws(() => createAppServer({ provider: 'ollama', requestTimeoutMs }), /SOLVER_TIMEOUT_MS/);
  }
});

test('local health uses a bounded timeout when the runtime stalls', async t => {
  const url = await withServer(t, { provider: 'ollama', healthTimeoutMs: 10, fetchImpl: (_url, request) => new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
  }) });
  const health = await (await fetch(`${url}/api/health`)).json();
  assert.equal(health.issue, 'ollama_unreachable');
  assert.equal(health.configured, false);
});

const diagramPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZVhIAAAAASUVORK5CYII=';

test('health verifies actual vision capability and the native HTTP route receives image bytes for both languages', async t => {
  const received=[];
  const baseUrl=await withLocalRuntime(t,async(request,response)=>{
    response.setHeader('Content-Type','application/json');
    assert.equal(request.headers.authorization,undefined);
    if(request.url==='/api/tags')return response.end(JSON.stringify({models:[{name:'qwen3:8b'},{name:'qwen3-vl:8b'}]}));
    const chunks=[];for await(const chunk of request)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    received.push({path:request.url,body});
    if(request.url==='/api/show')return response.end(JSON.stringify({capabilities:['completion','vision']}));
    assert.equal(request.url,'/api/chat');
    response.end(JSON.stringify({message:{content:JSON.stringify(answer)},done:true}));
  });
  const url=await withServer(t,{provider:'ollama',model:'qwen3:8b',visionModel:'qwen3-vl:8b',baseUrl});
  const health=await(await fetch(url+'/api/health')).json();
  assert.equal(health.protocolVersion,2);assert.equal(health.visionInstalled,true);assert.equal(health.visionReady,true);
  for(const text of ['اقرأ الرسم وحدد معامل التمدد.','Read the diagram and find the dilation scale factor.']){
    const response=await post(url,{...input,qualityMode:true,question:{...input.question,text,requiresVision:true,images:[diagramPng]}});
    assert.equal(response.status,200);
    const result=await response.json();assert.equal(result.verified,true);assert.equal(result.needsReview,false);
  }
  const chats=received.filter(item=>item.path==='/api/chat');assert.equal(chats.length,4);
  assert.ok(chats.every(({body})=>body.model==='qwen3-vl:8b'&&body.messages[1].images[0]===diagramPng));
  assert.equal(received.filter(item=>item.path==='/api/show').length,1,'A verified configured model capability is reused between related solves.');
});

test('installed vision-model names are insufficient when the runtime reports a text-only model',async t=>{
  const baseUrl=await withLocalRuntime(t,async(request,response)=>{
    response.setHeader('Content-Type','application/json');
    response.end(JSON.stringify(request.url==='/api/tags'?{models:[{name:'qwen3:8b'},{name:'qwen3-vl:8b'}]}:{capabilities:['completion']}));
  });
  const url=await withServer(t,{provider:'ollama',model:'qwen3:8b',baseUrl});
  const health=await(await fetch(url+'/api/health')).json();
  assert.equal(health.modelReady,true);assert.equal(health.configured,true);
  assert.equal(health.visionInstalled,true);assert.equal(health.visionReady,false);
  assert.equal(health.visionIssue,'vision_not_supported');
  const response=await post(url,{...input,question:{...input.question,requiresVision:true,images:[diagramPng]}});
  assert.equal(response.status,503);assert.equal((await response.json()).error.code,'vision_not_supported');
});

test('required diagrams missing from the request produce a review result without contacting a provider',async t=>{
  let called=false;
  const url=await withServer(t,{provider:'ollama',fetchImpl:async()=>{called=true;assert.fail('No image evidence.');}});
  const response=await post(url,{...input,question:{...input.question,requiresVision:true}});
  assert.equal(response.status,200);const body=await response.json();
  assert.equal(body.needsReview,true);assert.equal(body.reason,'missing_visual_evidence');assert.equal(called,false);
});

test('the bounded HTTP body accepts real image payload sizes above the old text-only limit',async t=>{
  const largePng=Buffer.concat([Buffer.from(diagramPng,'base64'),Buffer.alloc(110_000)]).toString('base64');
  let receivedImage;
  const url=await withServer(t,{provider:'ollama',fetchImpl:async(path,request)=>{
    if(path.endsWith('/api/show'))return Response.json({capabilities:['vision']});
    receivedImage=JSON.parse(request.body).messages[1].images[0];
    return Response.json({message:{content:JSON.stringify(answer)},done:true});
  }});
  const response=await post(url,{...input,question:{...input.question,images:[largePng]}});
  assert.equal(response.status,200);assert.equal(receivedImage,largePng);
});
