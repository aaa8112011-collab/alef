import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Protocol tests use explicit Chrome/provider stubs. Browser interaction suites
// separately validate that dropdowns, writing and held dragging acknowledge.
const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
const config={serverUrl:'http://127.0.0.1:4318',token:'retry-fixture-only',verify:false,qualityMode:false,
  autoSubmit:true,skipInstruction:true,minConfidence:.85};
const subject={id:'math',name:'الرياضيات'};
function harness(t,{type='single',reject=3,hideRejectedQuestion=false,stalledRetry=false,replaceQuestion=false,
  replaceFrame=false,delayRetry=false,lowConfidence=false,wrongInitially=false,missingRetry=false,autoSubmit=true,finishWithNext=false}={}) {
  let listener,clock=0,mode=wrongInitially?'wrong':'question',retryAt=null,frameId=0,calls=0;
  const events=[],applied=[],actions=[];
  const question={id:'retry-q',fingerprint:'stable-retry-question',type,text:'اختر أو أكمل الإجابة الصحيحة للسؤال.',
    options:type==='single'||type==='multiple'?[{id:'first-id',text:'الأولى'},{id:'second-id',text:'الثانية'}]:[],
    ...(type==='matching'?{items:[{id:'blank-one',text:'الأول'},{id:'blank-two',text:'الثاني'}],
      targets:[{id:'word-one',text:'ماء'},{id:'word-two',text:'ماء مالح'}]}:{})};
  const firstAnswer={optionIds:['single','multiple'].includes(type)?['first-id']:[],text:type==='text'?'مثلث':'',
    ...(type==='matching'?{matches:[{itemId:'blank-one',targetId:'word-two'},{itemId:'blank-two',targetId:'word-one'}]}:{}),
    confidence:lowConfidence?.4:.99,explanation:'إجابة اختبار محلي فقط'};
  const snapshot=()=>{
    if(mode==='opening'&&clock-retryAt>=750&&!delayRetry){mode='question';}
    const base={ok:true,page:{url:'https://moe.alefed.com/#/progress/ncle/class/retry-test/lesson/one'},
      subjects:[subject],lessons:[],navigation:[],loading:false,completed:false,fingerprint:mode,
      ...(frameId?{frameContext:{frameId,documentId:'other-doc',topPageKey:'other'}}:{})};
    if(mode==='complete')return {...base,stage:'complete',completed:true};
    if(mode==='final-feedback')return {...base,stage:'instruction',question:null,feedback:'wrong',navigation:[{id:'next',kind:'next'}]};
    if(mode==='opening')return {...base,stage:'question',question:null,feedback:'wrong',navigation:[{id:'retry',kind:'retry'}]};
    return {...base,stage:mode==='wrong'&&hideRejectedQuestion?'instruction':'question',
      question:mode==='wrong'&&hideRejectedQuestion?null:structuredClone(question),
      ...(mode==='wrong'?{feedback:'wrong',navigation:missingRetry?[]:[{id:'retry',kind:'retry'}]}:{})};
  };
  const content=async message=>{
    if(['ALEF_SCAN','ALEF_INSPECT'].includes(message.type))return snapshot();
    if(['ALEF_SELECT_SUBJECT','ALEF_CANCEL','ALEF_BEGIN'].includes(message.type))return {ok:true};
    if(message.type==='ALEF_NAVIGATE'){
      if(message.actionId==='next'){assert.equal(mode,'final-feedback');actions.push('next');mode='complete';return {ok:true,clicked:true};}
      assert.equal(message.actionId,'retry');assert.equal(mode,'wrong');actions.push('retry');
      if(!stalledRetry){mode='opening';retryAt=clock;if(replaceQuestion){question.id='another-q';question.fingerprint='another-q';}if(replaceFrame)frameId=8;}
      return {ok:true,clicked:true};
    }
    if(message.type==='ALEF_APPLY'){
      assert.equal(mode,'question','A retry must reopen the editable question before applying an answer');
      assert.equal(message.questionId,'retry-q');assert.equal(message.questionFingerprint,'stable-retry-question');
      if(applied.length)assert.equal(actions.at(-1),'retry','Every retry submission needs a preceding Try Again');
      actions.push('apply');applied.push(structuredClone(message.answer));
      if(!message.autoSubmit)return {ok:true,applied:true,submitted:false,reason:'Manual submit remains enabled.'};
      mode=applied.length<=reject?'wrong':finishWithNext?'final-feedback':'complete';return {ok:true,applied:true,submitted:true};
    }
    throw Error('Unexpected '+message.type);
  };
  class Clock extends Date {static now(){return clock;}}
  const timeout=(fn,ms)=>setTimeout(()=>{clock+=ms;fn();},1);
  const chrome={
    runtime:{id:'retry-test',getURL:path=>'chrome-extension://retry-test/'+path,getPlatformInfo:async()=>({}),
      onMessage:{addListener(fn){listener=fn;}},sendMessage:async message=>events.push(structuredClone(message.event))},
    storage:{session:{get:async()=>({}),set:async()=>{}}},
    tabs:{get:async()=>({id:1,url:snapshot().page.url}),sendMessage:async(_tab,message)=>structuredClone(await content(message)),onRemoved:{addListener(){}}},
    scripting:{executeScript:async()=>{}},action:{onClicked:{addListener(){}}},
  };
  vm.runInNewContext(source,{chrome,URL,AbortController,AbortSignal,DOMException,Date:Clock,setTimeout:timeout,clearTimeout,setInterval,clearInterval,
    fetch:async endpoint=>{
      if(endpoint.endsWith('/api/health'))return Response.json({ok:true,configured:true,provider:'ollama',modelReady:true,protocolVersion:3});
      calls++;return Response.json({answer:firstAnswer,verified:false,needsReview:lowConfidence});
    }});
  const send=message=>new Promise(resolve=>listener({tabId:1,...message},{id:'retry-test',url:'chrome-extension://retry-test/dashboard.html'},resolve));
  t.after(()=>send({type:'STOP'}));
  return {events,applied,actions,send,get calls(){return calls},start:async()=>{
    assert.equal((await send({type:'CONNECT'})).ok,true);
    const started=await send({type:'START',subjectId:'math',config:{...config,autoSubmit}});assert.equal(started.ok,true,JSON.stringify(started));
  }};
}
async function waitFor(predicate,description) {
  const until=Date.now()+6000;
  while(!predicate()){if(Date.now()>until)assert.fail(typeof description==='function'?description():description);await new Promise(resolve=>setTimeout(resolve,5));}
}
const terminal=h=>h.events.find(event=>['complete','review','error'].includes(event.kind));
async function finish(h){await h.start();await waitFor(()=>terminal(h),()=>JSON.stringify(h.events));return terminal(h);}

for(const type of ['single','multiple'])test(`${type} retries exhaust current choices then cycle after repeated Try Again without another model call`,async t=>{
  const h=harness(t,{type,reject:4});assert.equal((await finish(h)).kind,'complete',JSON.stringify(h.events));
  assert.equal(h.calls,1);assert.deepEqual(h.applied.map(answer=>answer.optionIds),[['first-id'],['second-id'],['first-id'],['second-id'],['first-id']]);
  assert.deepEqual(h.actions,['apply','retry','apply','retry','apply','retry','apply','retry','apply']);
  const attempts=h.events.filter(event=>event.kind==='submitted'&&event.retryAttempt);
  assert.deepEqual(attempts.map(event=>event.retryNumber),[1,2,3,4]);
  assert.ok(attempts.every(event=>event.answer.confidence===undefined&&/محاولة سريعة/.test(event.answer.explanation)));
  assert.equal((await h.send({type:'GET_STATE'})).state.stats.total,1,'Retries do not claim new questions were solved');
});

for(const type of ['text','matching'])test(`${type} retry reuses a valid acknowledged answer without asking the model again`,async t=>{
  const h=harness(t,{type,reject:2});assert.equal((await finish(h)).kind,'complete',JSON.stringify(h.events));assert.equal(h.calls,1);
  assert.equal(h.applied.length,3);assert.equal(h.actions.filter(action=>action==='retry').length,2);
  if(type==='text')assert.deepEqual(h.applied.map(answer=>answer.text),['مثلث','مثلث','مثلث']);
  else assert.deepEqual(h.applied.map(answer=>answer.matches),Array.from({length:3},()=>[{itemId:'blank-one',targetId:'word-two'},{itemId:'blank-two',targetId:'word-one'}]));
});

test('Try Again remains usable when rejected-answer controls are unmounted and no loading player exists',async t=>{
  const h=harness(t,{hideRejectedQuestion:true,reject:2});assert.equal((await finish(h)).kind,'complete',JSON.stringify(h.events));
  assert.equal(h.calls,1);assert.equal(h.applied.length,3);
});

test('twenty repeated retries stop on the current question without another provider request or false completion',async t=>{
  const h=harness(t,{reject:100});const result=await finish(h);assert.equal(result.kind,'review');assert.equal(result.cause,'retry_limit');
  assert.equal(h.calls,1);assert.equal(h.applied.length,21);assert.equal(h.actions.filter(action=>action==='retry').length,20);
  assert.equal(h.events.some(event=>event.kind==='complete'),false);assert.equal((await h.send({type:'GET_STATE'})).state.stats.lessonsCompleted,0);
});

test('a platform-enabled Next after the final rejection advances even while wrong feedback remains visible',async t=>{
  const h=harness(t,{reject:2,finishWithNext:true});assert.equal((await finish(h)).kind,'complete',JSON.stringify(h.events));
  assert.equal(h.calls,1);assert.deepEqual(h.actions,['apply','retry','apply','retry','apply','next']);
});

for(const [name,options,pattern] of [
  ['an unacknowledged retry click',{stalledRetry:true},/لم يستجب/],
  ['a different question after retry',{replaceQuestion:true},/تغير السؤال/],
  ['a different target frame after retry',{replaceFrame:true},/تغير إطار/],
  ['wrong feedback without a visible retry',{missingRetry:true},/لم يظهر زر/],
])test(name+' stops without applying another answer',async t=>{
  const h=harness(t,options);const result=await finish(h);assert.equal(result.kind,'review',JSON.stringify(result));assert.match(result.message,pattern);
  assert.equal(h.calls,1);assert.equal(h.applied.length,1);
});

test('a retry already visible before any submitted answer cannot trigger guessing or another provider call',async t=>{
  const h=harness(t,{wrongInitially:true});const result=await finish(h);assert.equal(result.kind,'review');assert.equal(h.calls,0);assert.equal(h.applied.length,0);assert.equal(h.actions.length,0);
});

test('low confidence on the first answer still stops before any submission or fast attempt',async t=>{
  const h=harness(t,{lowConfidence:true});const result=await finish(h);assert.equal(result.kind,'review');assert.equal(h.calls,1);assert.equal(h.applied.length,0);assert.equal(h.actions.length,0);
});

test('manual submission mode applies the first answer and never clicks a retry or claims submission',async t=>{
  const h=harness(t,{autoSubmit:false});const result=await finish(h);assert.equal(result.kind,'review');assert.equal(h.applied.length,1);assert.equal(h.actions.filter(action=>action==='retry').length,0);
  assert.equal(h.events.some(event=>event.kind==='submitted'),false);assert.equal((await h.send({type:'GET_STATE'})).state.stats.solved,0);
});

test('STOP while Try Again is opening prevents a local attempt and leaves the first submission alone',async t=>{
  const h=harness(t,{delayRetry:true});await h.start();await waitFor(()=>h.actions.includes('retry'),()=>JSON.stringify(h.events));
  assert.equal((await h.send({type:'STOP'})).ok,true);await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(h.calls,1);assert.equal(h.applied.length,1);assert.equal((await h.send({type:'GET_STATE'})).state.running,false);
});
