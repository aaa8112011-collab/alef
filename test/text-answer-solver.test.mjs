import test from 'node:test';
import assert from 'node:assert/strict';
import {solveQuestion} from '../server/solver.mjs';

// Provider replies are deterministic transport/format fixtures. They do not
// evaluate geometry or claim that a real model inferred an authored answer.
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZVhIAAAAASUVORK5CYII=';
const candidate={optionIds:[],text:'17/6',explanation:'جواب مزوّد اختبار لتأكيد نقل القيمة فقط.',confidence:.98};
const reply=value=>Response.json({message:{content:JSON.stringify(value)},done:true});
const content=value=>Response.json({message:{content:value},done:true});
const question=(language='en',vision=false)=>({id:'ordinary-writing-fixture',type:'text',options:[],
  text:language==='ar'?'أوجد قيمة المتغير واكتب الإجابة في الفراغ.':'Find the variable and type the answer in the blank.',
  ...(vision?{requiresVision:true,images:[png]}:{})});
const input=(q=question(),verify=true)=>({subject:'Math',question:q,verify,qualityMode:false,allowUncertain:true});
function fixture(respond,extra={}){
  const requests=[],signals=[];
  const config={provider:'ollama',model:'qwen3:8b',visionModel:'qwen3-vl:8b',baseUrl:'http://127.0.0.1:11434',...extra,
    fetchImpl:async(url,options)=>{
      if(url.endsWith('/api/show'))return Response.json({capabilities:['completion','vision']});
      assert.ok(url.endsWith('/api/chat'),url);
      const body=JSON.parse(options.body);requests.push(body);signals.push(options.signal);
      return respond(body,requests.length,options);
    }};
  return {config,requests,signals};
}
function assertOriginalEvidence(request,q){
  assert.equal(request.messages.length,2,'Every pass gets fresh system and original evidence only');
  const {images,...plain}=q;
  assert.deepEqual(JSON.parse(request.messages[1].content).question,plain);
  assert.deepEqual(request.messages[1].images,images);
  assert.equal(request.messages[0].content.includes(candidate.text),false,'No first-answer hint enters the system prompt');
}

for(const language of ['ar','en'])test(`${language}: an ordinary typed answer uses an exact empty option array and independent text verification`,async()=>{
  const q=question(language),f=fixture(async(_body,n)=>reply({...candidate,confidence:n===1?.98:.93}));
  const result=await solveQuestion(input(q),f.config);
  assert.equal(f.requests.length,2);assert.equal(result.verified,true);assert.equal(result.needsReview,false);
  assert.equal(result.answer.text,candidate.text);assert.equal(result.answer.confidence,.93);
  for(const request of f.requests){
    assertOriginalEvidence(request,q);
    assert.match(request.messages[0].content,/single ordinary text or numeric input/);
    assert.doesNotMatch(request.messages[0].content,/Correct only the response format/);
    assert.deepEqual(request.format.properties.optionIds.enum,[[]]);
    assert.equal(request.format.properties.optionIds.maxItems,0);
    assert.equal(request.format.properties.text.minLength,1);
  }
  assert.match(f.requests[1].messages[0].content,/Solve independently/);
});

for(const language of ['ar','en'])test(`${language}: a malformed visual text response is corrected with unchanged pixels then verified from the original evidence`,async()=>{
  const q=question(language,true),f=fixture(async(_body,n)=>reply(n===1?{...candidate,text:17/6}:{...candidate,confidence:n===2?.96:.91}));
  const result=await solveQuestion(input(q),f.config);
  assert.equal(f.requests.length,3);assert.equal(result.verified,true);assert.equal(result.needsReview,false);
  assert.equal(result.answer.text,candidate.text);assert.equal(result.answer.confidence,.91);
  for(const request of f.requests){assertOriginalEvidence(request,q);assert.equal(request.model,'qwen3-vl:8b');}
  assert.doesNotMatch(f.requests[0].messages[0].content,/Correct only the response format/);
  assert.match(f.requests[1].messages[0].content,/Correct only the response format/);
  assert.match(f.requests[2].messages[0].content,/Solve independently/);
  assert.doesNotMatch(f.requests[2].messages[0].content,/Correct only the response format/);
  assert.ok(f.signals.every(signal=>signal===f.signals[0]),'All three requests share the total solve deadline');
});

for(const [name,bad] of [
  ['blank text',()=>reply({...candidate,text:''})],
  ['whitespace text',()=>reply({...candidate,text:'  \n '})],
  ['numeric JSON text',()=>reply({...candidate,text:17/6})],
  ['answer misplaced in an option ID',()=>reply({...candidate,optionIds:['DO_NOT_COPY_PREVIOUS_ID'],text:''})],
  ['nonempty option IDs beside text',()=>reply({...candidate,optionIds:['DO_NOT_COPY_PREVIOUS_ID']})],
  ['invalid JSON',()=>content('{"text":')],
  ['missing message content',()=>Response.json({message:{}})],
  ['malformed confidence',()=>reply({...candidate,confidence:2})],
])test(`ordinary writing corrects ${name} once without copying the invalid response`,async()=>{
  const f=fixture(async(_body,n)=>n===1?bad():reply(candidate));
  const result=await solveQuestion(input(question(),false),f.config);
  assert.equal(f.requests.length,2);assert.equal(result.answer.text,candidate.text);
  assert.equal(result.needsReview,false);assert.equal(result.verified,false);
  assert.match(f.requests[1].messages[0].content,/Correct only the response format/);
  assert.equal(JSON.stringify(f.requests[1].messages).includes('DO_NOT_COPY_PREVIOUS_ID'),false);
});

for(const [name,bad] of [
  ['empty response',()=>reply({...candidate,text:''})],
  ['malformed JSON',()=>content('not JSON')],
])test(`repeated ${name} stops after one correction with a text-specific reason`,async()=>{
  const f=fixture(async()=>bad()),result=await solveQuestion(input(),f.config);
  assert.equal(f.requests.length,2);assert.equal(result.reason,'invalid_text_answer');
  assert.equal(result.needsReview,true);assert.equal(result.verified,false);
  assert.equal(result.answer.text,'');assert.deepEqual(result.answer.optionIds,[]);assert.equal(result.answer.confidence,0);
});

test('a valid first text answer permits one format correction of its independent verifier',async()=>{
  const f=fixture(async(_body,n)=>reply(n===2?{...candidate,text:''}:{...candidate,confidence:n===3?.9:.98}));
  const result=await solveQuestion(input(),f.config);
  assert.equal(f.requests.length,3);assert.equal(result.verified,true);assert.equal(result.answer.confidence,.9);
  assert.match(f.requests[2].messages[0].content,/Solve independently/);
  assert.match(f.requests[2].messages[0].content,/Correct only the response format/);
  assertOriginalEvidence(f.requests[2],question());
});

test('a correction spent on the first pass cannot be spent again on a malformed verifier',async()=>{
  const f=fixture(async(_body,n)=>reply(n===2?candidate:{...candidate,text:''}));
  const result=await solveQuestion(input(),f.config);
  assert.equal(f.requests.length,3);assert.equal(result.reason,'verification_disagreement');
  assert.equal(result.answer.text,candidate.text);assert.equal(result.answer.confidence,.98);assert.equal(result.verified,false);
  assert.equal(f.requests.filter(request=>/Correct only the response format/.test(request.messages[0].content)).length,1);
});

test('a verifier that remains malformed cannot erase or verify the valid first answer',async()=>{
  const f=fixture(async(_body,n)=>n===1?reply(candidate):content('invalid JSON'));
  const result=await solveQuestion(input(),f.config);
  assert.equal(f.requests.length,3);assert.equal(result.reason,'verification_disagreement');
  assert.equal(result.answer.text,candidate.text);assert.equal(result.verified,false);assert.equal(result.needsReview,true);
});

test('a complete low-confidence text candidate is preserved without a format retry',async()=>{
  const f=fixture(async()=>reply({...candidate,confidence:.4}));
  const result=await solveQuestion(input(),f.config);
  assert.equal(f.requests.length,1);assert.equal(result.reason,'low_confidence');assert.equal(result.answer.text,candidate.text);
  assert.equal(result.answer.confidence,.4);assert.equal(result.verified,false);
});

for(const type of ['single','matching'])test(`${type} questions do not enter the text format-correction path`,async()=>{
  const q=type==='single'?{id:'choice',type,text:'Choose the indicated value.',options:[{id:'original-a',text:'first'},{id:'original-b',text:'second'}]}:
    {id:'matching',type,text:'Match the supplied pairs.',options:[],items:[{id:'i',text:'item'}],targets:[{id:'t',text:'target'}]};
  const f=fixture(async()=>reply({...candidate,optionIds:['invented'],matches:[]}));
  const result=await solveQuestion(input(q),f.config);
  assert.equal(f.requests.length,1);assert.equal(result.reason,'invalid_selection');assert.equal(result.needsReview,true);
});

test('a LaTeX answer retains its exact expression through correction and independent verification',async()=>{
  const q={...question(),answerFormat:'latex'},fraction=String.raw`\frac{19}{7}`;
  const f=fixture(async(_body,n)=>reply({...candidate,text:n===1?'':fraction}));
  const result=await solveQuestion(input(q),f.config);
  assert.equal(f.requests.length,3);assert.equal(result.answer.text,fraction);assert.equal(result.verified,true);
  for(const request of f.requests){
    assert.match(request.messages[0].content,/ONLY the requested mathematical expression/);
    assert.doesNotMatch(request.messages[0].content,/single ordinary text or numeric input/);
    assert.equal(JSON.parse(request.messages[1].content).question.answerFormat,'latex');
  }
});

test('STOP during format correction aborts the solve before verification',async()=>{
  const controller=new AbortController();
  const f=fixture(async(_body,n,options)=>{
    if(n===1)return reply({...candidate,text:''});
    controller.abort();assert.equal(options.signal.aborted,true);throw options.signal.reason;
  });
  await assert.rejects(solveQuestion(input(),f.config,controller.signal),{code:'request_aborted',status:504});
  assert.equal(f.requests.length,2);assert.equal(f.signals[0],f.signals[1]);
});

test('the initial total deadline also aborts a stalled correction response body',async()=>{
  const keepAlive=setTimeout(()=>{},1000);
  const f=fixture(async(_body,n,options)=>{
    if(n===1)return reply({...candidate,text:''});
    return new Response(new ReadableStream({start(stream){
      if(options.signal.aborted)stream.error(options.signal.reason);
      else options.signal.addEventListener('abort',()=>stream.error(options.signal.reason),{once:true});
    }}));
  },{requestTimeoutMs:25});
  try{
    await assert.rejects(solveQuestion(input(),f.config),{code:'request_aborted',status:504});
    assert.equal(f.requests.length,2);assert.equal(f.signals[0],f.signals[1]);
  }finally{clearTimeout(keepAlive);}
});

for(const [name,response,code] of [
  ['provider error',()=>Response.json({error:'fixture provider failure'},{status:500}),'ollama_error'],
  ['truncated output',()=>Response.json({message:{content:JSON.stringify(candidate)},done_reason:'length'}),'incomplete_provider_response'],
])test(`${name} retains its error instead of triggering a text format correction`,async()=>{
  const f=fixture(async()=>response());
  await assert.rejects(solveQuestion(input(),f.config),{code});assert.equal(f.requests.length,1);
});

for(const [name,response] of [
  ['a disconnected HTTP 200 response stream',()=>new Response(new ReadableStream({
    start(stream){stream.error(new Error('fixture transport disconnected'));},
  }))],
  ['an oversized provider envelope',()=>Response.json({message:{content:JSON.stringify({
    ...candidate,explanation:'X'.repeat(100001),
  })}})],
  ['malformed outer provider JSON',()=>new Response('{"message":',{headers:{'Content-Type':'application/json'}})],
])test(`${name} is not treated as a repairable answer format`,async()=>{
  const f=fixture(async()=>response());
  await assert.rejects(solveQuestion(input(),f.config),{code:'invalid_provider_response'});
  assert.equal(f.requests.length,1,'A transport/envelope failure must not spend another inference request');
});

test('missing required image evidence stops before any format repair or inference',async()=>{
  const q={...question(),requiresVision:true},f=fixture(async()=>assert.fail('Incomplete evidence reached the provider'));
  const result=await solveQuestion(input(q),f.config);
  assert.equal(result.reason,'missing_visual_evidence');assert.equal(f.requests.length,0);
});
