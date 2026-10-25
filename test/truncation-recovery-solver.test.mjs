import test from 'node:test';
import assert from 'node:assert/strict';
import {solveQuestion} from '../server/solver.mjs';

// Explicit provider fixtures exercise bounded generation recovery, original
// evidence and schema transport. They do not evaluate Arabic/model accuracy.
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZVhIAAAAASUVORK5CYII=';
const partialMarker='DO_NOT_REPLAY_TRUNCATED_BODY';
const matches=[{itemId:'blank-first',targetId:'word-five'},{itemId:'blank-second',targetId:'word-two'}];
const answer={optionIds:[],text:'',matches,explanation:'رد اختبار نقل روابط أصلية فقط.',confidence:.97};
const textAnswer={optionIds:[],text:'17/6',explanation:'رد اختبار نقل قيمة فقط.',confidence:.97};
const reply=value=>Response.json({message:{content:JSON.stringify(value)},done:true,done_reason:'stop'});
const truncated=(value=null)=>Response.json({message:{thinking:partialMarker,
  content:value===null?'{"optionIds":[],"matches":[':JSON.stringify(value)},done:true,done_reason:'length',eval_count:4096});
const question=(language='ar',vision=false)=>({id:'truncation-two-blank-fixture',type:'matching',options:[],
  text:language==='ar'?'اقرأ العبارة وأكمل الفراغين بالكلمتين المناسبتين من القائمة.':'Read the statement and fill both blanks using the supplied words.',
  items:[{id:'blank-first',text:language==='ar'?'الفراغ الأول':'First blank'},{id:'blank-second',text:language==='ar'?'الفراغ الثاني':'Second blank'}],
  targets:Array.from({length:7},(_,i)=>({id:['word-one','word-two','word-three','word-four','word-five','word-six','word-seven'][i],
    text:language==='ar'?'كلمة اختبار '+(i+1):'Fixture word '+(i+1)})),
  ...(vision?{requiresVision:true,images:[png]}:{})});
const input=(q=question(),extra={})=>({subject:'Arabic',question:q,qualityMode:true,verify:true,allowUncertain:true,...extra});
function fixture(respond,extra={}){
  const requests=[],signals=[];
  const config={provider:'ollama',model:'qwen3:8b',visionModel:'qwen3-vl:8b',baseUrl:'http://127.0.0.1:11434',...extra,
    fetchImpl:async(url,options={})=>{
      if(url.endsWith('/api/show'))return Response.json({capabilities:['completion','vision']});
      assert.ok(url.endsWith('/api/chat')||url.endsWith('/chat/completions'),url);
      const body=JSON.parse(options.body);requests.push(body);signals.push(options.signal);
      return respond(body,requests.length,options);
    }};
  return {config,requests,signals};
}
function originalEvidence(request,q){
  assert.equal(request.messages.length,2,'Recovery and verification must remain fresh original-evidence requests');
  const {images,...plain}=q;
  assert.deepEqual(JSON.parse(request.messages[1].content).question,plain);
  assert.deepEqual(request.messages[1].images,images);
  assert.equal(JSON.stringify(request.messages).includes(partialMarker),false,'No truncated content or thinking is a prompt hint');
}
function compact(request){
  assert.equal(request.think,false);
  assert.ok(request.options.num_predict>=4096&&request.options.num_predict<=8192);
  assert.equal(request.format.properties.explanation.maxLength,240);
}

for(const language of ['ar','en'])test(`${language}: a truncated two-blank seven-word answer is regenerated once then checked independently`,async()=>{
  const q=question(language),f=fixture(async(_body,n)=>n===1?truncated():reply({...answer,confidence:n===2?.96:.91}));
  const result=await solveQuestion(input(q),f.config);
  assert.equal(f.requests.length,3);assert.equal(result.verified,true);assert.equal(result.needsReview,false);
  assert.deepEqual(result.answer.matches,matches);assert.equal(result.answer.confidence,.91);
  assert.equal(f.requests[0].think,true);
  compact(f.requests[1]);compact(f.requests[2]);
  for(const request of f.requests){originalEvidence(request,q);assert.deepEqual(request.format.properties.text.enum,['']);}
  assert.match(f.requests[2].messages[0].content,/Solve independently/);
  assert.ok(f.signals.every(signal=>signal===f.signals[0]),'The recovery shares the original solve deadline');
});

test('normal complete matching keeps the original thinking mode and spends no recovery request',async()=>{
  const q=question(),f=fixture(async()=>reply(answer)),result=await solveQuestion(input(q),f.config);
  assert.equal(f.requests.length,2);assert.equal(result.verified,true);
  for(const request of f.requests){
    originalEvidence(request,q);assert.equal(request.think,true);assert.equal(request.options.num_predict,4096);
    assert.deepEqual(request.format.properties.text.enum,['']);
  }
});

test('a verifier can use the single recovery allowance without receiving the first answer',async()=>{
  const q=question(),f=fixture(async(_body,n)=>n===2?truncated():reply({...answer,confidence:n===3?.9:.98}));
  const result=await solveQuestion(input(q),f.config);
  assert.equal(f.requests.length,3);assert.equal(result.verified,true);assert.equal(result.answer.confidence,.9);
  assert.equal(f.requests[0].think,true);assert.equal(f.requests[1].think,true);compact(f.requests[2]);
  originalEvidence(f.requests[2],q);assert.match(f.requests[2].messages[0].content,/Solve independently/);
});

test('parseable but token-truncated JSON is discarded rather than accepted as a complete answer',async()=>{
  const wrong={...answer,matches:[{itemId:'blank-first',targetId:'word-one'},{itemId:'blank-second',targetId:'word-three'}],confidence:1};
  const f=fixture(async(_body,n)=>n===1?truncated(wrong):reply(answer));
  const result=await solveQuestion(input(),f.config);
  assert.equal(f.requests.length,3);assert.deepEqual(result.answer.matches,matches);assert.equal(result.answer.confidence,.97);
});

test('repeated truncation stops after one regeneration even when each response contains parseable JSON',async()=>{
  const f=fixture(async()=>truncated(answer));
  await assert.rejects(solveQuestion(input(),f.config),{code:'incomplete_provider_response'});
  assert.equal(f.requests.length,2);compact(f.requests[1]);
});

test('a recovery spent on the first pass cannot regenerate a truncated verifier again',async()=>{
  const f=fixture(async(_body,n)=>n===2?reply(answer):truncated());
  await assert.rejects(solveQuestion(input(),f.config),{code:'incomplete_provider_response'});
  assert.equal(f.requests.length,3,'There is one additional generation across the whole solve');
});

test('the recovered first answer retains low confidence without an unnecessary verification request',async()=>{
  const f=fixture(async(_body,n)=>n===1?truncated():reply({...answer,confidence:.54}));
  const result=await solveQuestion(input(),f.config);
  assert.equal(f.requests.length,2);assert.equal(result.answer.confidence,.54);assert.equal(result.verified,false);
  assert.equal(result.needsReview,true);assert.equal(result.reason,'low_confidence');assert.deepEqual(result.answer.matches,matches);
});

test('a complete low-confidence mapping is not regenerated merely because confidence is low',async()=>{
  const f=fixture(async()=>reply({...answer,confidence:.54})),result=await solveQuestion(input(),f.config);
  assert.equal(f.requests.length,1);assert.equal(result.reason,'low_confidence');assert.equal(result.answer.confidence,.54);
});

test('a compact verifier disagreement keeps the recovered first answer without falsely verifying it',async()=>{
  const other={...answer,matches:[{itemId:'blank-first',targetId:'word-three'},{itemId:'blank-second',targetId:'word-five'}]};
  const f=fixture(async(_body,n)=>n===1?truncated():reply(n===2?answer:other));
  const result=await solveQuestion(input(),f.config);
  assert.equal(f.requests.length,3);assert.equal(result.reason,'verification_disagreement');
  assert.equal(result.verified,false);assert.equal(result.needsReview,true);assert.deepEqual(result.answer.matches,matches);
});

for(const [name,badMatches] of [
  ['invented ID',[{itemId:'blank-first',targetId:'invented'},{itemId:'blank-second',targetId:'word-two'}]],
  ['duplicate target',[{itemId:'blank-first',targetId:'word-two'},{itemId:'blank-second',targetId:'word-two'}]],
  ['missing blank',[{itemId:'blank-first',targetId:'word-five'}]],
])test(`recovery does not legitimize a mapping with ${name}`,async()=>{
  const f=fixture(async(_body,n)=>n===1?truncated():reply({...answer,matches:badMatches}));
  const result=await solveQuestion(input(),f.config);
  assert.equal(f.requests.length,2);assert.equal(result.reason,'invalid_selection');assert.equal(result.needsReview,true);
  assert.deepEqual(result.answer.matches,[]);
});

test('an invalid complete mapping does not enter the token-truncation retry path',async()=>{
  const f=fixture(async()=>reply({...answer,matches:[{itemId:'blank-first',targetId:'invented'}]}));
  const result=await solveQuestion(input(),f.config);
  assert.equal(f.requests.length,1);assert.equal(result.reason,'invalid_selection');
});

test('vision recovery and verification retain the same original image bytes and model',async()=>{
  const q=question('ar',true),f=fixture(async(_body,n)=>n===1?truncated():reply(answer));
  const result=await solveQuestion(input(q),f.config);
  assert.equal(result.verified,true);assert.equal(f.requests.length,3);
  for(const request of f.requests){originalEvidence(request,q);assert.equal(request.model,'qwen3-vl:8b');assert.equal(request.think,false);}
  compact(f.requests[1]);compact(f.requests[2]);
});

test('a larger original-ID mapping receives a bounded recovery allowance without changing its IDs',async()=>{
  const q={id:'large-mapping-recovery',type:'matching',text:'Match all original entries.',options:[],
    items:Array.from({length:20},(_,i)=>({id:'item-'+i+'-'+'i'.repeat(110),text:'Item '+i})),
    targets:Array.from({length:20},(_,i)=>({id:'target-'+i+'-'+'t'.repeat(108),text:'Target '+i}))};
  const expected=q.items.map((item,i)=>({itemId:item.id,targetId:q.targets[i].id}));
  const f=fixture(async(_body,n)=>n===1?truncated():reply({...answer,matches:expected}));
  const result=await solveQuestion(input(q),f.config);
  assert.equal(result.verified,true);assert.deepEqual(result.answer.matches,expected);assert.equal(f.requests.length,3);
  assert.equal(f.requests[1].options.num_predict,8192);compact(f.requests[1]);
});

test('local fast mode recovers truncation once without pretending an independent verification happened',async()=>{
  const f=fixture(async(_body,n)=>n===1?truncated():reply(answer));
  const result=await solveQuestion(input(question(),{qualityMode:false,verify:false}),f.config);
  assert.equal(f.requests.length,2);assert.equal(result.verified,false);assert.equal(result.needsReview,false);
  assert.equal(f.requests[0].think,false);compact(f.requests[1]);
});

test('an external-provider token limit retains its original error without adding a paid request',async()=>{
  const f=fixture(async()=>Response.json({choices:[{message:{content:JSON.stringify(answer)},finish_reason:'length'}]}),
    {provider:'openai',apiKey:'fixture-not-real',model:'fixture',baseUrl:'https://provider.example/v1'});
  await assert.rejects(solveQuestion(input(),f.config),{code:'incomplete_provider_response'});
  assert.equal(f.requests.length,1);
});

for(const [name,response,code] of [
  ['provider HTTP failure',()=>Response.json({error:'fixture failure'},{status:500}),'ollama_error'],
  ['broken response stream',()=>new Response(new ReadableStream({start(controller){controller.error(Error('fixture connection lost'));}})),'invalid_provider_response'],
  ['malformed outer JSON',()=>new Response('{"message":'),'invalid_provider_response'],
])test(`${name} is not token exhaustion and does not generate a recovery request`,async()=>{
  const f=fixture(async()=>response());
  await assert.rejects(solveQuestion(input(),f.config),{code});assert.equal(f.requests.length,1);
});

test('STOP after a truncated response prevents any regeneration',async()=>{
  const controller=new AbortController(),f=fixture(async()=>{controller.abort();return truncated();});
  await assert.rejects(solveQuestion(input(),f.config,controller.signal),{code:'request_aborted'});
  assert.equal(f.requests.length,1);
});

for(const [name,response] of [['truncated output',()=>truncated()],['a complete candidate',()=>reply(answer)]])
test(`STOP during compact recovery takes precedence over ${name}`,async()=>{
  const controller=new AbortController(),f=fixture(async(_body,n)=>{
    if(n===1)return truncated();
    controller.abort();return response();
  });
  await assert.rejects(solveQuestion(input(),f.config,controller.signal),{code:'request_aborted',status:504});
  assert.equal(f.requests.length,2);assert.equal(f.signals[0],f.signals[1]);
});

test('the original total deadline also aborts a stalled recovery response',async()=>{
  const keepAlive=setTimeout(()=>{},1500);
  const f=fixture(async(_body,n,options)=>n===1?truncated():new Response(new ReadableStream({start(controller){
    if(options.signal.aborted)controller.error(options.signal.reason);
    else options.signal.addEventListener('abort',()=>controller.error(options.signal.reason),{once:true});
  }})),{requestTimeoutMs:100});
  try{
    await assert.rejects(solveQuestion(input(),f.config),{code:'request_aborted',status:504});
    assert.equal(f.requests.length,2);assert.equal(f.signals[0],f.signals[1]);
  }finally{clearTimeout(keepAlive);}
});

test('text-format correction and truncation recovery keep separate once-only allowances',async()=>{
  const q={id:'text-format-and-token-fixture',type:'text',options:[],text:'Write the requested exact value.'};
  const f=fixture(async(_body,n)=>n===1?reply({...textAnswer,text:''}):n===2?truncated():reply(textAnswer));
  const result=await solveQuestion(input(q),f.config);
  assert.equal(f.requests.length,4,'One format correction, one truncation recovery, and one independent verifier are bounded');
  assert.equal(result.verified,true);assert.equal(result.answer.text,textAnswer.text);
  compact(f.requests[2]);compact(f.requests[3]);
  for(const request of f.requests)originalEvidence(request,q);
});
