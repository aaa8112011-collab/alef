import test from 'node:test';
import assert from 'node:assert/strict';
import { solveQuestion, validateSolveInput } from '../server/solver.mjs';

const input = {
  subject: 'الرياضيات',
  question: { id: 'q1', text: 'ما ناتج ٢ + ٢؟', type: 'single', options: [{ id: 'a', text: '٤' }, { id: 'b', text: '٥' }] },
  verify: true,
};
const answer = { optionIds: ['a'], text: '٤', explanation: '٢ + ٢ = ٤', confidence: 0.97 };
const providerResponse = value => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { status: 200 });
const config = fetchImpl => ({ provider: 'openai', apiKey: 'test-key-not-real', model: 'test-model', baseUrl: 'https://provider.example/v1', fetchImpl });

test('answers are independently checked without including the first response in the verifier prompt', async () => {
  const requests = [];
  const result = await solveQuestion(input, config(async (url, request) => {
    requests.push({ url, ...request, body: JSON.parse(request.body) });
    return providerResponse({ ...answer, confidence: requests.length === 2 ? 0.91 : 0.97 });
  }));
  assert.equal(requests.length, 2);
  assert.equal(result.verified, true);
  assert.equal(result.needsReview, false);
  assert.equal(result.answer.confidence, 0.91);
  assert.equal(requests[0].url, 'https://provider.example/v1/chat/completions');
  assert.equal(requests[0].headers.Authorization, 'Bearer test-key-not-real');
  assert.equal(requests[1].body.messages.length, 2);
  assert.deepEqual(JSON.parse(requests[1].body.messages[1].content).question, input.question);
  assert.equal(requests[0].redirect, 'error');
});

test('verifier disagreement always requires review', async () => {
  let calls = 0;
  const result = await solveQuestion(input, config(async () => providerResponse(++calls === 1 ? answer : { ...answer, optionIds: ['b'] })));
  assert.equal(result.verified, false);
  assert.equal(result.needsReview, true);
  assert.equal(result.reason, 'verification_disagreement');
});

test('a low-confidence answer cannot be applied and does not spend a second request', async () => {
  let calls = 0;
  const result = await solveQuestion(input, config(async () => { calls++; return providerResponse({ ...answer, confidence: 0.6 }); }));
  assert.equal(calls, 1);
  assert.equal(result.needsReview, true);
  assert.equal(result.reason, 'low_confidence');
});

test('a low-confidence verifier requires review even when selections match', async () => {
  let calls = 0;
  const result = await solveQuestion(input, config(async () => providerResponse({ ...answer, confidence: ++calls === 1 ? 0.98 : 0.5 })));
  assert.equal(result.verified, true);
  assert.equal(result.needsReview, true);
  assert.equal(result.reason, 'low_confidence');
});

test('invented or duplicate option IDs are discarded', async () => {
  for (const optionIds of [['unknown'], ['a', 'a']]) {
    const result = await solveQuestion(input, config(async () => providerResponse({ ...answer, optionIds })));
    assert.equal(result.needsReview, true);
    assert.equal(result.reason, 'invalid_selection');
    assert.deepEqual(result.answer.optionIds, []);
  }
});

test('single-choice cannot select multiple options', async () => {
  const result = await solveQuestion(input, config(async () => providerResponse({ ...answer, optionIds: ['a', 'b'] })));
  assert.equal(result.needsReview, true);
  assert.equal(result.reason, 'invalid_selection');
});

test('multiple-choice agreement is independent of option order', async () => {
  let calls = 0;
  const result = await solveQuestion({ ...input, question: { ...input.question, type: 'multiple' } }, config(async () => providerResponse({ ...answer, optionIds: ++calls === 1 ? ['a', 'b'] : ['b', 'a'] })));
  assert.equal(result.verified, true);
  assert.equal(result.needsReview, false);
});

test('free-text answers are verified conservatively', async () => {
  const question = { id: 'text', text: 'What is the capital of France?', type: 'text', options: [] };
  const result = await solveQuestion({ ...input, question }, config(async () => providerResponse({ ...answer, optionIds: [], text: 'Paris' })));
  assert.equal(result.verified, true);
  assert.equal(result.answer.text, 'Paris');
});

test('verification can be explicitly disabled but is never reported as completed', async () => {
  let calls = 0;
  const result = await solveQuestion({ ...input, verify: false }, config(async () => { calls++; return providerResponse(answer); }));
  assert.equal(calls, 1);
  assert.equal(result.verified, false);
  assert.equal(result.needsReview, false);
});

test('malformed provider output fails instead of inventing an answer', async () => {
  await assert.rejects(solveQuestion(input, config(async () => new Response('{"choices":[]}'))), { code: 'invalid_provider_response' });
  await assert.rejects(solveQuestion(input, config(async () => providerResponse({ ...answer, confidence: 2 }))), { code: 'invalid_provider_response' });
});

test('missing configuration does not contact a provider', async () => {
  await assert.rejects(solveQuestion(input, { ...config(() => assert.fail('should not fetch')), apiKey: '' }), { code: 'not_configured', status: 503 });
});

test('provider authentication errors never relay response body secrets', async () => {
  await assert.rejects(solveQuestion(input, config(async () => new Response('secret-provider-body', { status: 401 }))), error => {
    assert.equal(error.code, 'provider_authentication_failed');
    assert.equal(error.message.includes('secret-provider-body'), false);
    return true;
  });
});

test('provider rate limits retain a useful error code', async () => {
  await assert.rejects(solveQuestion(input, config(async () => new Response('{}', { status: 429 }))), { code: 'provider_rate_limited', status: 429 });
});

test('an aborted client signal reaches the provider request', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(solveQuestion(input, config(async (_url, request) => {
    assert.equal(request.signal.aborted, true);
    throw request.signal.reason;
  }), controller.signal), { code: 'request_aborted' });
});

test('the total request timeout also aborts a stalled response body', async () => {
  // The ref'ed timer keeps this isolated test alive while AbortSignal.timeout uses
  // an unref'ed timer. A real pending HTTP request keeps the application alive.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(solveQuestion(input, {
      ...config(async (_url, request) => new Response(new ReadableStream({
        start(controller) {
          request.signal.addEventListener('abort', () => controller.error(request.signal.reason), { once: true });
        },
      }))),
      requestTimeoutMs: 10,
    }), { code: 'request_aborted', status: 504 });
  } finally { clearTimeout(keepAlive); }
});

test('input validates subject, supported type, option IDs, and boolean verification', () => {
  for (const bad of [null, {}, { ...input, subject: '' }, { ...input, verify: 'yes' },
    { ...input, question: { ...input.question, type: 'image' } },
    { ...input, question: { ...input.question, options: [{ id: 'a', text: 'one' }, { id: 'a', text: 'two' }] } },
    { ...input, question: { ...input.question, options: [] } },
    { ...input, question: { ...input.question, text: 'x'.repeat(18_001) } },
  ]) assert.throws(() => validateSolveInput(bad), { code: 'invalid_request', status: 400 });
});

const localConfig = fetchImpl => ({ provider: 'ollama', apiKey: '', model: 'qwen3:8b', baseUrl: 'http://127.0.0.1:11434', fetchImpl });
const localResponse = value => new Response(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify(value) }, done: true }));

test('local Ollama uses the native non-streaming JSON protocol without an API key', async () => {
  const requests = [];
  const result = await solveQuestion(input, { ...localConfig(async (url, request) => {
    requests.push({ url, ...request, body: JSON.parse(request.body) });
    return localResponse(answer);
  }), apiKey: 'must-not-be-sent-to-local-runtime' });
  assert.equal(result.verified, true);
  assert.equal(result.needsReview, false);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(requests[0].headers.Authorization, undefined);
  assert.equal(requests[0].body.model, 'qwen3:8b');
  assert.equal(requests[0].body.stream, false);
  assert.equal(requests[0].body.format, 'json');
  assert.equal(requests[0].body.think, false);
  assert.deepEqual(requests[0].body.options, { temperature: 0, num_predict: 2048, num_ctx: 8192 });
  assert.equal(requests[1].body.messages.length, 2);
});

test('a stopped local runtime has a precise error and never asks for a paid key', async () => {
  await assert.rejects(solveQuestion(input, localConfig(async () => { throw new Error('connection refused'); })), error => {
    assert.equal(error.code, 'ollama_unreachable');
    assert.equal(error.status, 503);
    assert.match(error.message, /Ollama/);
    assert.doesNotMatch(error.message, /SOLVER_API_KEY/);
    return true;
  });
});

test('missing local models and insufficient memory have separate safe errors', async () => {
  const cases = [
    [404, 'model qwen3:8b not found', 'model_not_found'],
    [500, 'model requires more system memory than is available (secret-detail)', 'ollama_out_of_memory'],
  ];
  for (const [status, error, code] of cases) {
    await assert.rejects(solveQuestion(input, localConfig(async () => new Response(JSON.stringify({ error }), { status }))), result => {
      assert.equal(result.code, code);
      assert.equal(result.message.includes('secret-detail'), false);
      return true;
    });
  }
});

test('local malformed answers and verifier disagreement retain existing review safeguards', async () => {
  let calls = 0;
  const disagreement = await solveQuestion(input, localConfig(async () => localResponse({ ...answer, optionIds: ++calls === 1 ? ['a'] : ['b'] })));
  assert.equal(disagreement.needsReview, true);
  assert.equal(disagreement.reason, 'verification_disagreement');
  await assert.rejects(solveQuestion(input, localConfig(async () => new Response(JSON.stringify({ message: { content: 'not JSON' } })))), { code: 'invalid_provider_response' });
});

const matchingInput={...input,question:{id:'match-q',text:'صل كل عدد باسمه.',type:'matching',options:[],items:[{id:'i1',text:'1'},{id:'i2',text:'2'}],targets:[{id:'t1',text:'واحد'},{id:'t2',text:'اثنان'},{id:'t3',text:'ثلاثة'}]}};
const matchingAnswer={...answer,optionIds:[],text:'1 مع واحد و2 مع اثنان',matches:[{itemId:'i1',targetId:'t1'},{itemId:'i2',targetId:'t2'}]};
test('matching validates a complete mapping and verifies it independent of pair order',async()=>{
  let calls=0;
  const result=await solveQuestion(matchingInput,config(async()=>providerResponse({...matchingAnswer,matches:++calls===1?matchingAnswer.matches:[...matchingAnswer.matches].reverse()})));
  assert.equal(result.verified,true);assert.equal(result.needsReview,false);assert.deepEqual(result.answer.matches,matchingAnswer.matches);
});
test('matching rejects incomplete mappings, unknown IDs, duplicate items, and reused targets',async()=>{
  for(const matches of [[{itemId:'i1',targetId:'t1'}],[{itemId:'i1',targetId:'unknown'},{itemId:'i2',targetId:'t2'}],[{itemId:'i1',targetId:'t1'},{itemId:'i1',targetId:'t2'}],[{itemId:'i1',targetId:'t1'},{itemId:'i2',targetId:'t1'}]]){
    const result=await solveQuestion(matchingInput,config(async()=>providerResponse({...matchingAnswer,matches})));
    assert.equal(result.needsReview,true);assert.equal(result.reason,'invalid_selection');
  }
});
test('matching disagreement and invalid provider mapping do not become verified solutions',async()=>{
  let calls=0;
  const result=await solveQuestion(matchingInput,config(async()=>providerResponse(++calls===1?matchingAnswer:{...matchingAnswer,matches:[{itemId:'i1',targetId:'t2'},{itemId:'i2',targetId:'t1'}]})));
  assert.equal(result.needsReview,true);assert.equal(result.verified,false);
  await assert.rejects(solveQuestion(matchingInput,config(async()=>providerResponse({...matchingAnswer,matches:'invalid'}))),{code:'invalid_provider_response'});
  assert.throws(()=>validateSolveInput({...matchingInput,question:{...matchingInput.question,targets:[{id:'t1',text:'واحد'}]}}),{code:'invalid_request'});
});
