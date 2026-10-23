import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Explicit Chrome/provider protocol stubs. Real DOM/library suites separately
// test choosing, writing, dragging and the page's acknowledgement of submission.
const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
const url='https://moe.alefed.com/#/progress/ncle/class/uncertain-fixture/lesson/one';
const config={serverUrl:'http://127.0.0.1:4318',token:'uncertain-protocol-fixture-only',
  qualityMode:false,verify:true,autoSubmit:true,skipInstruction:true,minConfidence:.85};

function harness(t,{type='single',allowUncertain=true,omitUncertain=false,reason='low_confidence',confidence=.35,
  needsReview=true,uncertainCapability=true,mutateAnswer,changedQuestion=false,failedApply=false,autoSubmit=true,deferSolve=false}={}){
  let listener,clock=0,mode='question',releaseSolve;
  const events=[],applied=[],requests=[];
  const question={id:'uncertain-question',fingerprint:'uncertain-question-original',type,
    text:'Choose or enter the requested answer to the complete fixture question.',options:
      ['single','multiple'].includes(type)?[{id:'original-a',text:'first'},{id:'original-b',text:'second'}]:[],
    ...(type==='matching'?{items:[{id:'blank-a',text:'first blank'},{id:'blank-b',text:'second blank'}],
      targets:[{id:'word-a',text:'first word'},{id:'word-b',text:'second word'}]}:{}),
    ...(type==='dropdowns'?{fields:[{id:'field-a',text:'first blank',options:[{id:'same-id',text:'first'},{id:'other',text:'second'}]},
      {id:'field-b',text:'second blank',options:[{id:'same-id',text:'first'},{id:'other',text:'second'}]}]}:{})};
  const answer={optionIds:['single','multiple'].includes(type)?['original-a']:[],text:type==='text'?'unverified fixture text':'',
    confidence,explanation:'Best available unverified fixture answer.',
    ...(type==='matching'?{matches:[{itemId:'blank-a',targetId:'word-b'},{itemId:'blank-b',targetId:'word-a'}]}:{}),
    ...(type==='dropdowns'?{selections:[{fieldId:'field-a',optionId:'same-id'},{fieldId:'field-b',optionId:'same-id'}]}:{})};
  mutateAnswer?.(answer);
  const snapshot=()=>({ok:true,page:{url},subjects:[{id:'math',name:'Math'}],lessons:[],navigation:[],loading:false,
    stage:mode==='complete'?'complete':'question',completed:mode==='complete',fingerprint:mode,
    question:mode==='complete'?null:structuredClone(question)});
  const content=async message=>{
    if(['ALEF_SCAN','ALEF_INSPECT'].includes(message.type))return snapshot();
    if(['ALEF_BEGIN','ALEF_SELECT_SUBJECT','ALEF_CANCEL'].includes(message.type))return {ok:true};
    if(message.type==='ALEF_APPLY'){
      assert.equal(message.questionId,'uncertain-question');assert.equal(message.questionFingerprint,'uncertain-question-original');
      applied.push(structuredClone(message.answer));
      if(failedApply)return {ok:false,error:'The fixture did not acknowledge the selected answer.'};
      if(!message.autoSubmit)return {ok:true,applied:true,submitted:false,reason:'Manual submission remains selected.'};
      mode='complete';return {ok:true,applied:true,submitted:true};
    }
    throw Error('Unexpected '+message.type);
  };
  class Clock extends Date {static now(){return clock;}}
  const chrome={runtime:{id:'uncertain-test',getURL:path=>'chrome-extension://uncertain-test/'+path,getPlatformInfo:async()=>({}),
    onMessage:{addListener(fn){listener=fn;}},sendMessage:async({event})=>events.push(structuredClone(event))},
    storage:{session:{get:async()=>({}),set:async()=>{}}},
    tabs:{get:async()=>({id:1,url}),sendMessage:async(_tab,message)=>structuredClone(await content(message)),onRemoved:{addListener(){}}},
    scripting:{executeScript:async()=>{}},action:{onClicked:{addListener(){}}}};
  vm.runInNewContext(source,{chrome,URL,AbortController,AbortSignal,DOMException,Date:Clock,
    setTimeout:(fn,ms)=>setTimeout(()=>{clock+=ms;fn();},1),clearTimeout,setInterval,clearInterval,
    fetch:async(endpoint,options={})=>{
      if(endpoint.endsWith('/api/health'))return Response.json({ok:true,configured:true,provider:'ollama',modelReady:true,
        protocolVersion:3,visionReady:true,capabilities:{multiDropdown:true,mathField:true,...(uncertainCapability===undefined?{}:{uncertainAnswers:uncertainCapability})}});
      assert.ok(endpoint.endsWith('/api/solve'));requests.push(JSON.parse(options.body));
      if(deferSolve)await new Promise(resolve=>{releaseSolve=resolve;});
      if(changedQuestion){question.id='changed-question';question.fingerprint='changed-question-original';}
      return Response.json({answer,verified:false,needsReview,reason});
    }});
  const send=message=>new Promise(resolve=>{
    const accepted=listener({tabId:1,...message},{id:'uncertain-test',url:'chrome-extension://uncertain-test/dashboard.html'},resolve);
    if(!accepted)resolve({ok:false,error:'Worker refused request'});
  });
  t.after(()=>{releaseSolve?.();return send({type:'STOP'});});
  return {events,applied,requests,answer,send,release:()=>releaseSolve?.(),
    async start(overrides={}){
      assert.equal((await send({type:'CONNECT'})).ok,true);
      const options={...config,...(omitUncertain?{}:{allowUncertain}),autoSubmit,...overrides};
      return send({type:'START',subjectId:'math',config:options});
    }};
}
async function waitFor(predicate,details){
  const deadline=Date.now()+6000;
  while(!predicate()){if(Date.now()>deadline)assert.fail(details());await new Promise(resolve=>setTimeout(resolve,5));}
}
const terminal=h=>h.events.find(event=>['complete','review','error','stopped'].includes(event.kind));
async function finish(h){const started=await h.start();assert.equal(started.ok,true,JSON.stringify(started));
  await waitFor(()=>terminal(h),()=>JSON.stringify(h.events));return terminal(h);}

for(const type of ['single','multiple','text','matching','dropdowns'])test(`${type}: explicitly enabled uncertain answering submits one complete original candidate without inflating confidence`,async t=>{
  const h=harness(t,{type});assert.equal((await finish(h)).kind,'complete',JSON.stringify(h.events));
  assert.equal(h.requests.length,1);assert.equal(h.requests[0].allowUncertain,true);
  assert.deepEqual(h.applied,[h.answer]);
  const answer=h.events.find(event=>event.kind==='answer'),submitted=h.events.find(event=>event.kind==='submitted');
  for(const event of [answer,submitted]){
    assert.equal(event.uncertainAnswer,true);assert.equal(event.uncertaintyReason,'low_confidence');
    assert.equal(event.answer.confidence,.35);assert.notEqual(event.verified,true);assert.notEqual(event.retryAttempt,true);
  }
  assert.equal((await h.send({type:'GET_STATE'})).state.stats.solved,1);
});

test('an independent-verification disagreement may submit the original candidate only when explicitly enabled',async t=>{
  const h=harness(t,{reason:'verification_disagreement',confidence:.97});
  assert.equal((await finish(h)).kind,'complete',JSON.stringify(h.events));assert.deepEqual(h.applied,[h.answer]);
  assert.equal(h.events.find(event=>event.kind==='submitted').uncertaintyReason,'verification_disagreement');
  assert.equal(h.applied[0].confidence,.97);
});

test('a zero-confidence candidate remains explicitly unverified rather than receiving a fabricated confidence boost',async t=>{
  const h=harness(t,{confidence:0});assert.equal((await finish(h)).kind,'complete');
  assert.equal(h.applied[0].confidence,0);assert.equal(h.events.find(event=>event.kind==='submitted').verified,false);
});

test('strict mode still reviews a disagreement even when the candidate confidence is high',async t=>{
  const h=harness(t,{allowUncertain:false,reason:'verification_disagreement',confidence:.97});
  assert.equal((await finish(h)).kind,'review');assert.equal(h.applied.length,0);
});

for(const flag of [false,undefined])test(`strict worker configuration (${String(flag)}) still reviews an uncertain first answer`,async t=>{
  const h=harness(t,{allowUncertain:flag,omitUncertain:flag===undefined});assert.equal((await finish(h)).kind,'review');
  assert.equal(h.applied.length,0);assert.equal(h.events.some(event=>event.kind==='submitted'),false);
});

for(const reason of ['missing_visual_evidence','missing_question_text','invalid_selection','visual_evidence_unreadable'])test(`uncertain answering does not override ${reason}`,async t=>{
  const h=harness(t,{reason});assert.equal((await finish(h)).kind,'review',JSON.stringify(h.events));assert.equal(h.applied.length,0);
});

test('an unexplained review is not interpreted as authorization to submit an uncertain answer',async t=>{
  const h=harness(t,{reason:null});assert.equal((await finish(h)).kind,'review');assert.equal(h.applied.length,0);
});

test('a low candidate still follows the uncertainty preference when an older response omitted the review flag',async t=>{
  const h=harness(t,{reason:null,needsReview:false});assert.equal((await finish(h)).kind,'complete');
  assert.equal(h.applied.length,1);assert.equal(h.events.find(event=>event.kind==='submitted').uncertaintyReason,'low_confidence');
});

test('an older server without the uncertainty capability cannot silently ignore the preference',async t=>{
  const h=harness(t,{uncertainCapability:false});const end=await finish(h);
  assert.equal(end.kind,'review',JSON.stringify(end));assert.equal(end.blocking,true);assert.match(end.message,/حدّث المشروع كاملًا/);
  assert.equal(h.requests.length,0);assert.equal(h.applied.length,0);
});

for(const [name,type,mutateAnswer] of [
  ['empty choice abstention','single',answer=>{answer.optionIds=[];}],
  ['unknown original choice ID','single',answer=>{answer.optionIds=['invented-id'];}],
  ['multiple IDs for a single choice','single',answer=>{answer.optionIds=['original-a','original-b'];}],
  ['empty text answer','text',answer=>{answer.text=' ';}],
  ['incomplete matching','matching',answer=>{answer.matches.pop();}],
  ['reused matching target','matching',answer=>{answer.matches[1].targetId=answer.matches[0].targetId;}],
  ['incomplete dropdown mapping','dropdowns',answer=>{answer.selections.pop();}],
  ['wrong dropdown field','dropdowns',answer=>{answer.selections[1].fieldId='unknown-field';}],
  ['out-of-range confidence','single',answer=>{answer.confidence=1.1;}],
])test(`uncertain answering cannot invent or apply ${name}`,async t=>{
  const h=harness(t,{type,mutateAnswer}),end=await finish(h);assert.equal(end.kind,'review',JSON.stringify(h.events));
  assert.equal(end.cause,'invalid_selection','An unusable candidate is not mislabeled as a confidence-only stop');
  assert.equal(h.applied.length,0);assert.equal(h.events.some(event=>event.kind==='submitted'),false);
});

test('changing the question during uncertain inference prevents applying the previous candidate',async t=>{
  const h=harness(t,{changedQuestion:true});const end=await finish(h);
  assert.notEqual(end.kind,'complete');assert.equal(h.applied.length,0);assert.equal(h.events.some(event=>event.kind==='submitted'),false);
});

test('a failed page acknowledgement never claims the uncertain answer was submitted',async t=>{
  const h=harness(t,{failedApply:true});assert.notEqual((await finish(h)).kind,'complete');
  assert.equal(h.applied.length,1);assert.equal(h.events.some(event=>event.kind==='submitted'),false);
  assert.equal((await h.send({type:'GET_STATE'})).state.stats.solved,0);
});

test('manual submission mode remains manual for an uncertain answer',async t=>{
  const h=harness(t,{autoSubmit:false});assert.equal((await finish(h)).kind,'review');
  assert.equal(h.applied.length,1);assert.equal(h.events.some(event=>event.kind==='submitted'),false);
});

test('STOP during uncertain inference prevents applying its late candidate',async t=>{
  const h=harness(t,{deferSolve:true});assert.equal((await h.start()).ok,true);
  await waitFor(()=>h.requests.length===1,()=>JSON.stringify(h.events));
  assert.equal((await h.send({type:'STOP'})).ok,true);h.release();
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(h.applied.length,0);assert.equal(h.events.some(event=>event.kind==='submitted'),false);
});

test('the uncertainty preference must be an explicit boolean',async t=>{
  const h=harness(t);const started=await h.start({allowUncertain:'yes'});
  assert.equal(started.ok,false);assert.equal(h.requests.length,0);assert.equal(h.applied.length,0);
});
