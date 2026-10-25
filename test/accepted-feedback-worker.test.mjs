import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Chrome/provider replies are explicit protocol fixtures. The browser reader
// suite separately verifies published FIB result icons and authored identity.
const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
const config={serverUrl:'http://127.0.0.1:4318',token:'accepted-feedback-fixture',qualityMode:false,
  verify:false,autoSubmit:true,skipInstruction:true,minConfidence:.85};
const subject={id:'math',name:'Math'};

function harness(t,{initialAccepted=false,retry=false,unansweredNext=false,reusedId=false,stalledNext=false,missingNext=false}={}){
  let listener,clock=0,mode=initialAccepted?'accepted':'first',solveCalls=0,rejected=false;
  const events=[],actions=[],applied=[],requests=[];
  const first={id:'authored-fib',fingerprint:'fib-before-submit',type:'text',text:'Find the value of the variable in the first figure.',options:[]};
  const second={id:reusedId?first.id:'next-authored-fib',fingerprint:'second-prompt-and-figure',type:'text',
    text:'Find the other requested value in the new figure.',options:[]};
  const accepted={...first,id:'cosmetic-result-id',fingerprint:'green-result-icon-added'};
  const snapshot=()=>{
    const base={ok:true,page:{url:'https://moe.alefed.com/#/progress/ncle/class/accepted-feedback/lesson/one'},
      subjects:[subject],lessons:[],navigation:[],loading:false,completed:false,
      fingerprint:mode,transitionFingerprint:mode};
    if(mode==='complete')return {...base,stage:'complete',completed:true};
    if(mode==='accepted')return {...base,stage:'question',question:accepted,feedback:'correct',navigation:missingNext?[]:[{id:'next',kind:'next'}]};
    if(mode==='wrong')return {...base,stage:'question',question:first,feedback:'wrong',navigation:[{id:'retry',kind:'retry'}]};
    return {...base,stage:'question',question:mode==='second'?second:first,
      ...(unansweredNext||mode==='second'?{navigation:[{id:'next',kind:'next'}]}:{})};
  };
  const content=async message=>{
    if(['ALEF_SCAN','ALEF_INSPECT'].includes(message.type))return snapshot();
    if(['ALEF_SELECT_SUBJECT','ALEF_CANCEL','ALEF_BEGIN'].includes(message.type))return {ok:true};
    if(message.type==='ALEF_NAVIGATE'){
      actions.push(message.actionId);
      if(message.actionId==='retry'){
        assert.equal(mode,'wrong','Try Again must open the rejected question before another answer');mode='first';
      }else{
        assert.equal(message.actionId,'next');
        assert.equal(mode,'accepted','An enabled Next must not skip a fresh unanswered question');
        if(!stalledNext)mode='second';
      }
      return {ok:true,clicked:true};
    }
    if(message.type==='ALEF_APPLY'){
      applied.push({mode,questionId:message.questionId,answer:structuredClone(message.answer)});actions.push('apply');
      // Do not turn an already accepted result page into another successful
      // fixture submission: that is the behavior this regression must catch.
      if(mode==='accepted')return {ok:true,applied:false,submitted:false,reason:'The accepted field is already read-only.'};
      assert.ok(['first','second'].includes(mode),'A rejected field requires Try Again first');
      if(mode==='second'||unansweredNext)mode='complete';
      else if(retry&&!rejected){rejected=true;mode='wrong';}
      else mode=reusedId?'second':'accepted';
      return {ok:true,applied:true,submitted:true};
    }
    throw Error('Unexpected content message '+message.type);
  };
  class Clock extends Date {static now(){return clock;}}
  const timeout=(fn,ms)=>setTimeout(()=>{clock+=ms;fn();},1);
  const chrome={runtime:{id:'accepted-feedback-test',getURL:path=>'chrome-extension://accepted-feedback-test/'+path,
      getPlatformInfo:async()=>({}),onMessage:{addListener(fn){listener=fn;}},
      sendMessage:async message=>events.push(structuredClone(message.event))},
    storage:{session:{get:async()=>({}),set:async()=>{}}},
    tabs:{get:async()=>({id:1,url:snapshot().page.url}),sendMessage:async(_id,message)=>structuredClone(await content(message)),onRemoved:{addListener(){}}},
    scripting:{executeScript:async()=>{}},action:{onClicked:{addListener(){}}}};
  vm.runInNewContext(source,{chrome,URL,AbortController,AbortSignal,DOMException,Date:Clock,setTimeout:timeout,clearTimeout,setInterval,clearInterval,
    fetch:async(endpoint,options={})=>{
      if(endpoint.endsWith('/api/health'))return Response.json({ok:true,configured:true,provider:'ollama',modelReady:true,protocolVersion:3});
      solveCalls++;const request=JSON.parse(options.body);requests.push(request);
      return Response.json({answer:{optionIds:[],text:request.question.text===second.text?'19/6':'17/6',
        explanation:'Explicit transport fixture only.',confidence:.99},verified:false,needsReview:false});
    }});
  const send=message=>new Promise(resolve=>listener({tabId:1,...message},
    {id:'accepted-feedback-test',url:'chrome-extension://accepted-feedback-test/dashboard.html'},resolve));
  t.after(()=>send({type:'STOP'}));
  return {events,actions,applied,requests,send,get solveCalls(){return solveCalls;},async start(){
    assert.equal((await send({type:'CONNECT'})).ok,true);
    const start=await send({type:'START',subjectId:'math',config});assert.equal(start.ok,true,JSON.stringify(start));
  }};
}
const terminal=h=>h.events.find(event=>['complete','review','error'].includes(event.kind));
async function finish(h){
  await h.start();const deadline=Date.now()+5000;
  while(!terminal(h)){
    if(Date.now()>deadline)assert.fail(JSON.stringify(h.events));
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  return terminal(h);
}

test('an accepted text result with a cosmetic fingerprint change advances Next without solving the accepted field again',async t=>{
  const h=harness(t),end=await finish(h);
  assert.equal(end.kind,'complete',JSON.stringify({end,actions:h.actions,requests:h.requests}));
  assert.equal(h.solveCalls,2);assert.deepEqual(h.actions,['apply','next','apply']);
  assert.deepEqual(h.applied.map(row=>row.mode),['first','second']);
  assert.equal(h.requests.some(request=>request.question.id==='cosmetic-result-id'),false);
});

test('starting on an explicitly accepted text result uses Next before requesting a new answer',async t=>{
  const h=harness(t,{initialAccepted:true}),end=await finish(h);
  assert.equal(end.kind,'complete',JSON.stringify(end));assert.equal(h.solveCalls,1);
  assert.deepEqual(h.actions,['next','apply']);assert.equal(h.applied[0].mode,'second');
});

test('wrong-answer feedback still requires Try Again before local text retry then accepted Next',async t=>{
  const h=harness(t,{retry:true}),end=await finish(h);
  assert.equal(end.kind,'complete',JSON.stringify(end));assert.equal(h.solveCalls,2);
  assert.deepEqual(h.actions,['apply','retry','apply','next','apply']);
  assert.deepEqual(h.applied.slice(0,2).map(row=>row.answer.text),['17/6','17/6']);
  assert.equal(h.events.filter(event=>event.kind==='submitted'&&event.retryAttempt).length,1);
});

test('an enabled Next beside a fresh unanswered text question never skips solving it',async t=>{
  const h=harness(t,{unansweredNext:true}),end=await finish(h);
  assert.equal(end.kind,'complete',JSON.stringify(end));assert.equal(h.solveCalls,1);
  assert.deepEqual(h.actions,['apply']);assert.equal(h.applied[0].mode,'first');
});

test('a reused authored ID with a new stem and no accepted feedback is solved as a new question',async t=>{
  const h=harness(t,{reusedId:true}),end=await finish(h);
  assert.equal(end.kind,'complete',JSON.stringify(end));assert.equal(h.solveCalls,2);
  assert.deepEqual(h.actions,['apply','apply']);
  assert.equal(h.requests[0].question.id,h.requests[1].question.id);
  assert.notEqual(h.requests[0].question.text,h.requests[1].question.text);
});

test('a stalled accepted Next stops after one click without resolving the accepted question',async t=>{
  const h=harness(t,{stalledNext:true}),end=await finish(h);
  assert.equal(end.kind,'review',JSON.stringify(end));assert.equal(h.solveCalls,1);
  assert.deepEqual(h.actions,['apply','next']);assert.deepEqual(h.applied.map(row=>row.mode),['first']);
});

test('an accepted field without a ready Next stops within the existing wait instead of solving or waiting forever',async t=>{
  const h=harness(t,{initialAccepted:true,missingNext:true}),end=await finish(h);
  assert.equal(end.kind,'review',JSON.stringify(end));assert.equal(h.solveCalls,0);
  assert.deepEqual(h.actions,[]);assert.deepEqual(h.applied,[]);
  assert.match(end.message,/لم يكتمل الانتقال/);
});
