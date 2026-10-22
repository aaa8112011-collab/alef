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
const visualPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZVhIAAAAASUVORK5CYII=';

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
  assert.equal(requests[0].body.format.type, 'object');
  assert.deepEqual(requests[0].body.format.properties.optionIds.items.enum, ['a','b']);
  assert.equal(requests[0].body.format.properties.optionIds.minItems, 0);
  assert.equal(requests[0].body.format.properties.optionIds.maxItems, 1);
  assert.deepEqual(requests[1].body.format, requests[0].body.format);
  assert.equal(requests[0].body.think, false);
  assert.equal(requests[0].body.keep_alive, '15m');
  assert.deepEqual(requests[0].body.options, { temperature: 0, num_predict: 512, num_ctx: 8192 });
  assert.equal(requests[1].body.messages.length, 2);
});

test('local single-pass solving sends one compact request and never claims independent verification', async () => {
  const requests = [];
  const result = await solveQuestion({ ...input, verify: false }, localConfig(async (_url, request) => {
    requests.push(JSON.parse(request.body));
    return localResponse({ ...answer, text: '' });
  }));
  assert.equal(requests.length, 1);
  assert.equal(result.verified, false);
  assert.equal(result.needsReview, false);
  assert.deepEqual(result.answer.optionIds, ['a']);
  assert.equal(requests[0].think, false);
  assert.equal(requests[0].keep_alive, '15m');
  assert.match(requests[0].messages[0].content, /one short Arabic sentence/);
  assert.match(requests[0].messages[0].content, /keep text empty/);
});

test('local text answers retain their full response allowance and required content', async () => {
  let requestBody;
  const text = 'إجابة نصية كاملة '.repeat(100);
  const result = await solveQuestion({ ...input, verify: false, question: {
    id: 'essay', text: 'اكتب إجابة كاملة عن الموضوع.', type: 'text', options: [],
  } }, localConfig(async (_url, request) => {
    requestBody = JSON.parse(request.body);
    return localResponse({ ...answer, optionIds: [], text });
  }));
  assert.equal(requestBody.options.num_predict, 2048);
  assert.equal(result.answer.text, text.trim());
  assert.match(requestBody.messages[0].content, /complete requested answer in text/);
});

test('local output budget expands for a complete 20-pair mapping with long original IDs', async () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ id: `item-${i}-` + 'i'.repeat(118), text: `عنصر ${i}` }));
  const targets = Array.from({ length: 20 }, (_, i) => ({ id: `target-${i}-` + 't'.repeat(117), text: `هدف ${i}` }));
  const matches = items.map((item, index) => ({ itemId: item.id, targetId: targets[index].id }));
  let requestBody;
  const result = await solveQuestion({ ...input, verify: false, question: {
    id: 'large-mapping', text: 'صل كل عنصر بهدفه.', type: 'matching', options: [], items, targets,
  } }, localConfig(async (_url, request) => {
    requestBody = JSON.parse(request.body);
    return localResponse({ ...answer, optionIds: [], text: '', matches });
  }));
  assert.ok(requestBody.options.num_predict > 2048);
  assert.ok(requestBody.options.num_predict <= 8192);
  assert.ok(requestBody.options.num_predict >= Buffer.byteLength(JSON.stringify(matches)));
  assert.deepEqual(result.answer.matches, matches);
  assert.equal(result.needsReview, false);
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

test('missing required visual evidence blocks Arabic and English questions without any model request', async () => {
  for (const text of ['ما معامل التمدد في الرسم؟', 'What is the scale factor shown in the diagram?']) {
    let calls = 0;
    const result = await solveQuestion({...input,verify:false,qualityMode:true,question:{...input.question,text,requiresVision:true}},localConfig(async()=>{calls++;assert.fail('Missing diagrams must never be guessed.');}));
    assert.equal(calls,0);assert.equal(result.needsReview,true);assert.equal(result.reason,'missing_visual_evidence');
    assert.equal(result.verified,false);assert.deepEqual(result.answer.optionIds,[]);
  }
});

test('visual input rejects external URLs, malformed base64, oversized images and oversized pixel dimensions', () => {
  const hugeDimensions = Buffer.from(visualPng,'base64');hugeDimensions.writeUInt32BE(999999,16);
  for (const images of [['https://example.com/image.png'],['data:image/png;base64,'+visualPng],['%%%%'],['YWJjZA=='],Array(4).fill(visualPng),['A'.repeat(1_400_000)],[hugeDimensions.toString('base64')]]) {
    assert.throws(()=>validateSolveInput({...input,question:{...input.question,images}}),{code:'invalid_request'});
  }
  assert.throws(()=>validateSolveInput({...input,qualityMode:'yes'}),{code:'invalid_request'});
  assert.throws(()=>validateSolveInput({...input,question:{...input.question,requiresVision:'yes'}}),{code:'invalid_request'});
});

test('Arabic and English diagrams route to a verified vision-capable model with independent image evidence', async () => {
  for (const text of ['الشكل صورة تمدد مركزه الأصل. ما معامل التمدد؟','The image is a dilation centered at the origin. What is the scale factor?']) {
    const requests=[];
    const result=await solveQuestion({...input,verify:false,qualityMode:true,question:{...input.question,text,requiresVision:true,images:[visualPng]}},
      {...localConfig(async(url,request)=>{
        const body=JSON.parse(request.body);requests.push({url,body,headers:request.headers});
        if(url.endsWith('/api/show'))return Response.json({capabilities:['completion','vision']});
        return localResponse(answer);
      }),visionModel:'qwen3-vl:8b'});
    assert.equal(result.verified,true);assert.equal(result.needsReview,false);
    assert.equal(requests.length,3);
    assert.deepEqual(requests[0].body,{model:'qwen3-vl:8b'});
    const chats=requests.slice(1);
    for(const {body,headers} of chats){
      assert.equal(body.model,'qwen3-vl:8b');assert.equal(body.think,false);assert.ok(body.options.num_predict>=2048);
      assert.deepEqual(body.messages[1].images,[visualPng]);assert.equal(headers.Authorization,undefined);
      assert.equal(JSON.parse(body.messages[1].content).question.text,text);
      assert.equal(body.messages[1].content.includes(visualPng),false,'Image bytes must not be represented as pretend readable text.');
      assert.deepEqual(body.format.properties.optionIds.items.enum,input.question.options.map(option=>option.id));
    }
    assert.deepEqual(chats[1].body.format,chats[0].body.format,'Both independent vision passes use the same original-ID constraint.');
    assert.equal(chats[1].body.messages.length,2,'Verification must inspect original images without the first answer.');
  }
});

test('an installed text-only model cannot receive image questions as a silent fallback', async () => {
  const calls=[];
  await assert.rejects(solveQuestion({...input,question:{...input.question,requiresVision:true,images:[visualPng]}},localConfig(async(url)=>{
    calls.push(url);return Response.json({capabilities:['completion']});
  })),{code:'vision_not_supported',status:503});
  assert.equal(calls.length,1);assert.match(calls[0],/\/api\/show$/);
});

test('a missing vision model has a dedicated actionable error without paid-key guidance', async () => {
  await assert.rejects(solveQuestion({...input,question:{...input.question,images:[visualPng]}},localConfig(async()=>new Response('{}',{status:404}))),error=>{
    assert.equal(error.code,'vision_model_not_found');assert.match(error.message,/ollama pull qwen3-vl:8b/);assert.doesNotMatch(error.message,/API_KEY/);return true;
  });
});

test('quality mode enables supported text reasoning and forces an independent check despite a saved fast setting', async () => {
  const requests=[];
  const result=await solveQuestion({subject:'English',verify:false,qualityMode:true,question:{id:'reasoning',text:'Choose the synonym of rapid.',type:'single',options:[{id:'a',text:'fast'},{id:'b',text:'slow'}]}},
    localConfig(async(_url,request)=>{requests.push(JSON.parse(request.body));return localResponse(answer);}));
  assert.equal(requests.length,2);assert.equal(result.verified,true);
  assert.ok(requests.every(request=>request.think===true&&request.options.num_predict>=4096));
  assert.match(requests[0].messages[0].content,/Arabic or English/);
});

test('OpenAI visual routing uses actual image content parts rather than base64 inside the prompt', async () => {
  let requestBody;
  const result=await solveQuestion({...input,verify:false,question:{...input.question,images:[visualPng]}},config(async(_url,request)=>{
    requestBody=JSON.parse(request.body);return providerResponse(answer);
  }));
  assert.equal(result.needsReview,false);
  const content=requestBody.messages[1].content;
  assert.equal(content[0].type,'text');assert.equal(JSON.parse(content[0].text).question.images,undefined);
  assert.deepEqual(content[1],{type:'image_url',image_url:{url:'data:image/png;base64,'+visualPng,detail:'high'}});
});

test('a token-truncated result is never accepted even if its partial JSON happens to parse', async () => {
  await assert.rejects(solveQuestion({...input,verify:false},localConfig(async()=>Response.json({message:{content:JSON.stringify(answer)},done_reason:'length'}))),{code:'incomplete_provider_response'});
});

test('quality mode uses exact bilingual arithmetic without a model and labels its verification method', async () => {
  for (const text of ['ما ناتج ٢ + ٢؟','What is 2 + 2?']) {
    const result=await solveQuestion({...input,qualityMode:true,verify:false,question:{...input.question,text}},localConfig(async()=>assert.fail('Exact supported arithmetic must not depend on model guesses.')));
    assert.equal(result.verified,true);assert.equal(result.needsReview,false);assert.equal(result.verificationMethod,'exact_math');
    assert.deepEqual(result.answer.optionIds,['a']);assert.equal(result.answer.confidence,1);
  }
});

test('narrow Arabic and English diagram references reject absent pixels even when an old extractor omitted requiresVision', async () => {
  for(const text of ["Figure D'E'F'G' is a dilation of figure DEFG centered at the origin. What is the scale factor?",'ما معامل التمدد في الرسم المقابل؟','Find the distance shown in the graph.']) {
    const result=await solveQuestion({...input,verify:false,question:{...input.question,text}},localConfig(async()=>assert.fail('Do not infer unseen diagram coordinates.')));
    assert.equal(result.needsReview,true);assert.equal(result.reason,'missing_visual_evidence');
  }
});

test('text-only dilation problems with complete corresponding coordinates are not blocked by the diagram backstop', async () => {
  for(const text of ["Figure A' is a dilation of A; A=(2,4) and A'=(3,6). Find its scale factor.",'في الرسم تمدد يحول النقطة (٢،٤) إلى النقطة (٣،٦). ما معامل التمدد؟']) {
    let calls=0;
    const result=await solveQuestion({...input,verify:false,question:{...input.question,text}},localConfig(async()=>{calls++;return localResponse(answer);}));
    assert.equal(calls,1);assert.equal(result.needsReview,false);
  }
});

test('local choice schemas permit original IDs and abstention without forcing a choice or copying option labels',async()=>{
  const question={id:'original-ids',text:'Select the scale factor.',type:'single',options:[
    {id:'answer-550e8400-e29b-41d4-a716-446655440000',text:'1.5'},
    {id:'answer-550e8400-e29b-41d4-a716-446655440001',text:'2'},
  ]};
  const requests=[];
  const result=await solveQuestion({...input,question,verify:false},localConfig(async(_url,request)=>{
    requests.push(JSON.parse(request.body));
    return localResponse({...answer,optionIds:[question.options[0].id],text:''});
  }));
  assert.equal(requests.length,1,'The schema must not add a model request or a repair loop.');
  const schema=requests[0].format;
  assert.equal(schema.type,'object');assert.equal(schema.additionalProperties,false);
  assert.deepEqual(new Set(schema.required),new Set(['optionIds','text','explanation','confidence']));
  assert.deepEqual(schema.properties.optionIds.items.enum,question.options.map(option=>option.id));
  assert.equal(schema.properties.optionIds.minItems,0,'Empty-array abstention must remain decodable.');
  assert.equal(schema.properties.optionIds.maxItems,1);
  assert.equal(schema.properties.confidence.minimum,0,'The decoder must not force a high confidence.');
  assert.equal(schema.properties.confidence.maximum,1);
  assert.deepEqual(result.answer.optionIds,[question.options[0].id]);
  assert.equal(result.needsReview,false);
});

test('local responses that ignore the original-ID schema are never remapped from labels, positions or duplicate IDs',async()=>{
  const question={id:'no-id-guessing',text:'Select the scale factor.',type:'single',options:[
    {id:'original-first',text:'1.5'},{id:'original-second',text:'2'},
  ]};
  for(const optionIds of [[],['1.5'],['0'],['A'],['unknown'],['original-first','original-first'],['original-first','original-second']]) {
    let calls=0;
    const result=await solveQuestion({...input,question,verify:true},localConfig(async()=>{
      calls++;return localResponse({...answer,optionIds,text:'1.5',confidence:.99});
    }));
    assert.equal(calls,1,'An invalid response must stop without verification or an unbounded repair request.');
    assert.equal(result.reason,'invalid_selection',JSON.stringify(optionIds));
    assert.equal(result.needsReview,true);assert.equal(result.verified,false);
    assert.deepEqual(result.answer.optionIds,[]);
  }
});

test('local multiple-choice schemas retain the exact selection set and runtime uniqueness checks',async()=>{
  const question={id:'multiple-contract',text:'Select all prime numbers.',type:'multiple',options:[
    {id:'prime-two',text:'2'},{id:'prime-three',text:'3'},{id:'composite-four',text:'4'},
  ]};
  const requests=[];
  const result=await solveQuestion({...input,question},localConfig(async(_url,request)=>{
    requests.push(JSON.parse(request.body));
    return localResponse({...answer,optionIds:requests.length===1?['prime-two','prime-three']:['prime-three','prime-two']});
  }));
  assert.equal(result.verified,true);
  for(const request of requests) {
    assert.deepEqual(request.format.properties.optionIds.items.enum,question.options.map(option=>option.id));
    assert.equal(request.format.properties.optionIds.minItems,0);
    assert.equal(request.format.properties.optionIds.maxItems,3);
  }
  const duplicate=await solveQuestion({...input,question},localConfig(async()=>localResponse({...answer,optionIds:['prime-two','prime-two']})));
  assert.equal(duplicate.reason,'invalid_selection');assert.equal(duplicate.needsReview,true);
});

test('local text and matching schemas use empty option arrays and keep matching identities constrained without forcing completion',async()=>{
  let textRequest;
  const text=await solveQuestion({...input,verify:false,question:{id:'schema-text',text:'Name a color.',type:'text',options:[]}},localConfig(async(_url,request)=>{
    textRequest=JSON.parse(request.body);return localResponse({...answer,optionIds:[],text:'أزرق'});
  }));
  assert.equal(text.answer.text,'أزرق');
  assert.equal(textRequest.format.properties.optionIds.maxItems,0);
  assert.equal(textRequest.format.properties.optionIds.items.enum,undefined,'An empty JSON Schema enum would be invalid.');
  assert.equal(textRequest.format.properties.text.const,undefined);
  let matchingRequest;
  const matching=await solveQuestion({...matchingInput,verify:false},localConfig(async(_url,request)=>{
    matchingRequest=JSON.parse(request.body);return localResponse(matchingAnswer);
  }));
  assert.equal(matching.needsReview,false);
  const schema=matchingRequest.format;
  assert.equal(schema.properties.optionIds.maxItems,0);
  assert.equal(schema.properties.optionIds.items.enum,undefined);
  assert.equal(schema.properties.matches.minItems,0);
  assert.equal(schema.properties.matches.maxItems,matchingInput.question.items.length);
  assert.deepEqual(schema.properties.matches.items.properties.itemId.enum,matchingInput.question.items.map(item=>item.id));
  assert.deepEqual(schema.properties.matches.items.properties.targetId.enum,matchingInput.question.targets.map(target=>target.id));
  for(const matches of [[],[{itemId:'i1',targetId:'t1'}],[{itemId:'i1',targetId:'t1'},{itemId:'i2',targetId:'t1'}]]) {
    const incomplete=await solveQuestion({...matchingInput,verify:false},localConfig(async()=>localResponse({...matchingAnswer,matches})));
    assert.equal(incomplete.reason,'invalid_selection');assert.equal(incomplete.needsReview,true);
  }
});


test('low-confidence empty choice selections preserve abstention without claiming invalid IDs or sending a second solution',async()=>{
  for(const type of ['single','multiple']) {
    let calls=0;
    const result=await solveQuestion({...input,question:{...input.question,type}},localConfig(async()=>{
      calls++;return localResponse({...answer,optionIds:[],text:'',explanation:'لم تتضح بيانات الرسم بما يكفي للاختيار.',confidence:.4});
    }));
    assert.equal(calls,1);assert.equal(result.needsReview,true);assert.equal(result.verified,false);
    assert.equal(result.reason,'low_confidence');assert.deepEqual(result.answer.optionIds,[]);
    assert.match(result.answer.explanation,/لم تتضح/);
  }
  const invalid=await solveQuestion(input,localConfig(async()=>localResponse({...answer,optionIds:['not-an-original-ID'],confidence:.4})));
  assert.equal(invalid.reason,'invalid_selection','Low confidence cannot authorize foreign IDs.');
  let calls=0;
  const verifier=await solveQuestion(input,localConfig(async()=>localResponse(++calls===1?answer:{...answer,optionIds:[],confidence:.4})));
  assert.equal(calls,2);assert.equal(verifier.needsReview,true);assert.equal(verifier.verified,false);
  assert.equal(verifier.reason,'verification_disagreement');
});
