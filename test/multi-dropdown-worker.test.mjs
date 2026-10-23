import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Protocol coverage with explicit Chrome and provider stubs. Real DOM/menu
// ownership and actual inference schemas are covered in separate suites.
const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
const config={serverUrl:'http://127.0.0.1:4318',token:'multi-dropdown-worker-fixture-only',qualityMode:false,
  verify:false,autoSubmit:true,skipInstruction:true,minConfidence:.85};
const subject={id:'math',name:'الرياضيات'};
const graph='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const fields=[
  {id:'angle',text:'زاوية د [dropdown:angle]',options:[{id:'shared',text:'70°'},{id:'angle-110',text:'110°'}]},
  {id:'relationship',text:'المثلثان [dropdown:relationship]',options:[{id:'shared',text:'متشابهان'},{id:'rel-other',text:'غير متشابهين'}]},
];

function harness(t,{capability=true,reject=0,vision=false,firstSelections,changeAfterRetry=false,holdCapability=false,type='dropdowns'}={}) {
  let listener,mode='question',healthCalls=0,captures=0,releaseHealth;
  const requests=[],applied=[],actions=[],events=[];
  const question={id:'multi-q',fingerprint:'multi-q-original',type,
    text:'اقرأ الرسم ثم أكمل: الزاوية [dropdown:angle] والمثلثان [dropdown:relationship].',
    options:type==='single'?[{id:'shared',text:'70°'},{id:'angle-110',text:'110°'}]:[],
    ...(type==='dropdowns'?{fields:structuredClone(fields)}:{}),...(vision?{requiresVision:true}: {})};
  const answer={optionIds:type==='single'?['shared']:[],text:'',confidence:.99,explanation:'جواب محاكي لاختبار التفاعل فقط.',
    ...(type==='dropdowns'?{selections:firstSelections||[{fieldId:'relationship',optionId:'shared'},{fieldId:'angle',optionId:'shared'}]}:{})};
  const snapshot=()=>({ok:true,page:{url:'https://moe.alefed.com/#/progress/ncle/class/multi-dropdown/lesson/one'},
    subjects:[subject],lessons:[],navigation:mode==='wrong'?[{kind:'retry',id:'retry'}]:[],loading:false,
    completed:mode==='complete',stage:mode==='complete'?'complete':'question',fingerprint:mode,
    ...(mode==='complete'?{}:{question:structuredClone(question)}),...(mode==='wrong'?{feedback:'wrong'}:{})});
  const content=async message=>{
    if(['ALEF_SCAN','ALEF_INSPECT'].includes(message.type))return snapshot();
    if(['ALEF_BEGIN','ALEF_CANCEL','ALEF_SELECT_SUBJECT'].includes(message.type))return {ok:true};
    if(message.type==='ALEF_GET_VISUALS'){
      captures++;assert.equal(message.questionId,'multi-q');assert.equal(message.questionFingerprint,'multi-q-original');
      return {ok:true,questionId:question.id,questionFingerprint:question.fingerprint,images:[{data:graph,alt:'رسم المثلثين'}]};
    }
    if(message.type==='ALEF_NAVIGATE'){
      assert.equal(message.actionId,'retry');assert.equal(mode,'wrong');actions.push('retry');mode='question';
      if(changeAfterRetry){question.fingerprint='multi-q-changed';question.fields[0].options=[{id:'new-angle',text:'80°'}];}
      return {ok:true,clicked:true};
    }
    if(message.type==='ALEF_APPLY'){
      assert.equal(mode,'question');assert.equal(message.questionId,'multi-q');assert.equal(message.questionFingerprint,'multi-q-original');
      if(type==='dropdowns'){
        assert.equal(message.answer.selections.length,fields.length);
        assert.equal(new Set(message.answer.selections.map(row=>row.fieldId)).size,fields.length);
        for(const row of message.answer.selections){const field=fields.find(field=>field.id===row.fieldId);assert.ok(field?.options.some(option=>option.id===row.optionId),'Every choice must belong to its own field');}
      }
      if(applied.length)assert.equal(actions.at(-1),'retry','Try Again must reopen the fields before every attempt');
      actions.push('apply');applied.push(structuredClone(message.answer));mode=applied.length<=reject?'wrong':'complete';
      return {ok:true,applied:true,submitted:true};
    }
    throw Error('Unexpected content request: '+message.type);
  };
  class Clock extends Date {static now(){return clock;}}
  let clock=0;
  const timeout=(fn,ms)=>setTimeout(()=>{clock+=ms;fn();},1);
  const chrome={
    runtime:{id:'multi-worker-test',getURL:path=>'chrome-extension://multi-worker-test/'+path,getPlatformInfo:async()=>({}),
      onMessage:{addListener(fn){listener=fn;}},sendMessage:async message=>events.push(structuredClone(message.event))},
    storage:{session:{get:async()=>({}),set:async()=>{}}},
    tabs:{get:async()=>({id:1,url:snapshot().page.url}),sendMessage:async(_tab,message)=>structuredClone(await content(message)),onRemoved:{addListener(){}}},
    scripting:{executeScript:async()=>{}},action:{onClicked:{addListener(){}}},
  };
  vm.runInNewContext(source,{chrome,URL,AbortController,AbortSignal,DOMException,Date:Clock,setTimeout:timeout,clearTimeout,setInterval,clearInterval,
    fetch:async(endpoint,options={})=>{
      if(endpoint.endsWith('/api/health')){
        healthCalls++;
        const response=()=>Response.json({ok:true,configured:true,provider:'ollama',modelReady:true,protocolVersion:3,visionReady:true,
          ...(capability==='missing'?{}:{capabilities:{multiDropdown:capability}})});
        if(holdCapability&&healthCalls>1)return new Promise(resolve=>{releaseHealth=()=>resolve(response());});
        return response();
      }
      assert.ok(endpoint.endsWith('/api/solve'));requests.push(JSON.parse(options.body));
      return Response.json({answer,verified:false,needsReview:false});
    }});
  const send=message=>new Promise(resolve=>listener({tabId:1,...message},{id:'multi-worker-test',url:'chrome-extension://multi-worker-test/dashboard.html'},resolve));
  t.after(()=>send({type:'STOP'}));
  return {events,requests,applied,actions,send,get captures(){return captures},get healthCalls(){return healthCalls},
    capabilityPending:()=>!!releaseHealth,releaseCapability:()=>releaseHealth?.(),start:async()=>{
      assert.equal((await send({type:'CONNECT'})).ok,true);
      const start=await send({type:'START',subjectId:'math',config});assert.equal(start.ok,true,JSON.stringify(start));
    }};
}
async function waitFor(predicate,description) {
  const until=Date.now()+6000;
  while(!predicate()){if(Date.now()>until)assert.fail(typeof description==='function'?description():description);await new Promise(resolve=>setTimeout(resolve,5));}
}
const terminal=h=>h.events.find(event=>['complete','review','error'].includes(event.kind));
async function finish(h){await h.start();await waitFor(()=>terminal(h),()=>JSON.stringify(h.events));return terminal(h);}

for(const vision of [false,true])test(`multiple dropdowns preserve field-scoped options${vision?' alongside the actual graph payload':''} in the solve request`,async t=>{
  const h=harness(t,{vision});assert.equal((await finish(h)).kind,'complete',JSON.stringify(h.events));
  assert.equal(h.requests.length,1);assert.equal(h.requests[0].question.type,'dropdowns');assert.deepEqual(h.requests[0].question.fields,fields);
  assert.equal(h.applied.length,1);assert.deepEqual(h.applied[0].selections,[{fieldId:'relationship',optionId:'shared'},{fieldId:'angle',optionId:'shared'}]);
  assert.equal(h.captures,vision?1:0);if(vision)assert.deepEqual(h.requests[0].question.images,[graph]);
});

test('repeated multi-dropdown retries traverse complete valid combinations without new solve or graph capture',async t=>{
  const h=harness(t,{reject:4,vision:true});assert.equal((await finish(h)).kind,'complete',JSON.stringify(h.events));
  assert.equal(h.requests.length,1);assert.equal(h.captures,1);
  const ordered=h.applied.map(answer=>fields.map(field=>answer.selections.find(row=>row.fieldId===field.id).optionId));
  assert.deepEqual(ordered,[['shared','shared'],['shared','rel-other'],['angle-110','shared'],['angle-110','rel-other'],['shared','shared']]);
  assert.deepEqual(h.actions,['apply','retry','apply','retry','apply','retry','apply','retry','apply']);
  const retries=h.events.filter(event=>event.kind==='submitted'&&event.retryAttempt);
  assert.deepEqual(retries.map(event=>event.retryNumber),[1,2,3,4]);assert.ok(retries.every(event=>event.answer.confidence===undefined));
  assert.equal((await h.send({type:'GET_STATE'})).state.stats.total,1);
});

for(const capability of ['missing',false])test(`missing multi-dropdown capability (${String(capability)}) stops before inference, graph capture or applying any field`,async t=>{
  const h=harness(t,{capability,vision:true});const result=await finish(h);
  assert.ok(['review','error'].includes(result.kind));assert.match(result.message,/عدة قوائم/);assert.match(result.message,/المشروع كاملًا/);assert.match(result.message,/START-WINDOWS\.cmd/);
  assert.equal(h.requests.length,0);assert.equal(h.applied.length,0);assert.equal(h.captures,0);
});

test('an ordinary single-choice question remains compatible with a protocol3 server without the new capability',async t=>{
  const h=harness(t,{capability:'missing',type:'single'});assert.equal((await finish(h)).kind,'complete',JSON.stringify(h.events));
  assert.equal(h.requests.length,1);assert.equal(h.healthCalls,1);assert.equal(h.applied.length,1);assert.equal(h.requests[0].question.fields,undefined);
});

for(const selections of [
  [{fieldId:'angle',optionId:'rel-other'},{fieldId:'relationship',optionId:'shared'}],
  [{fieldId:'angle',optionId:'shared'},{fieldId:'angle',optionId:'angle-110'}],
  [{fieldId:'angle',optionId:'shared'}],
])test('invalid or incomplete field selection is rejected before applying any dropdown: '+JSON.stringify(selections),async t=>{
  const h=harness(t,{firstSelections:selections});const result=await finish(h);assert.equal(result.kind,'review');assert.equal(result.cause,'invalid_selection');
  assert.equal(h.requests.length,1);assert.equal(h.applied.length,0);assert.equal(h.actions.length,0);
});

test('a changed dropdown question after Try Again cannot receive a cached quick answer',async t=>{
  const h=harness(t,{reject:2,changeAfterRetry:true});const result=await finish(h);assert.equal(result.kind,'review');assert.match(result.message,/تغير السؤال/);
  assert.equal(h.requests.length,1);assert.equal(h.applied.length,1);assert.deepEqual(h.actions,['apply','retry']);
});

test('STOP during the new capability check prevents inference or field application after health finally replies',async t=>{
  const h=harness(t,{holdCapability:true});await h.start();await waitFor(h.capabilityPending,()=>JSON.stringify(h.events));
  assert.equal((await h.send({type:'STOP'})).ok,true);h.releaseCapability();await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(h.requests.length,0);assert.equal(h.applied.length,0);assert.equal((await h.send({type:'GET_STATE'})).state.running,false);
});
