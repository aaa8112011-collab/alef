import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Worker protocol tests with explicit Chrome/fetch stubs. The browser and server
// suites separately cover DOM extraction and the actual local HTTP endpoint.
const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
const catalogURL='https://moe.alefed.com/#/classes/preflight-class?tab=assigned';
const lessonURL='https://moe.alefed.com/#/progress/ncle/class/preflight-class/lesson/one/material/first';
const subject={id:'math',name:'الرياضيات'};
const ready={ok:true,configured:true,provider:'ollama',modelReady:true,model:'qwen3:8b',protocolVersion:3,visionReady:true};
const config={serverUrl:'http://127.0.0.1:4318',token:'preflight-fixture-local-only',qualityMode:false,verify:false,autoSubmit:true,skipInstruction:true,minConfidence:.85};

function setup(t,{health=async()=>Response.json(ready),resume=false,holdFinalTab=false}={}) {
  let listener,removed,releaseFinalTab,heldFinalTab=false;
  const lesson={id:'one',name:'درس محفوظ',kind:'core-lesson',status:'review',reason:'طلب إذن المحتوى',reviewCause:'frame_permission_required'};
  const priorEvent={kind:'review',message:'سبب التوقف السابق',timestamp:10,sequence:3,running:false,status:'review'};
  const seed={running:false,status:'review',page:{url:catalogURL,title:'الرياضيات'},subjects:[subject],subjectId:'math',
    queue:[lesson,{id:'two',name:'الدرس التالي',status:'pending',kind:'core-lesson'}],currentLesson:lesson,catalogURL,catalogClass:'https://moe.alefed.com/classes/preflight-class',
    blockedFrames:resume?[{origin:'https://content.alefed.com'}]:[],
    ...(resume?{frameBlockedPage:lessonURL}:{}),
    stats:{solved:0,review:1,total:0,lessonsCompleted:0,lessonsTotal:2,lessonsReview:1},events:[priorEvent],lastEvent:priorEvent,eventSequence:3};
  const storage={'alef:run:1':structuredClone(seed)},messages=[],events=[],requests=[];
  let currentURL=resume?lessonURL:catalogURL;
  const snapshot=()=>({ok:true,page:{url:currentURL,title:'الرياضيات'},subjects:[subject],stage:'lessons',completed:false,question:null,lessons:[],navigation:[],fingerprint:'empty-catalog',
    catalog:{type:'core-coursework',tab:'assigned',filter:'all',loading:false,empty:true}});
  const chrome={
    runtime:{id:'preflight-test',getURL:path=>'chrome-extension://preflight-test/'+path,getPlatformInfo:async()=>({}),onMessage:{addListener(fn){listener=fn}},sendMessage:async message=>events.push(structuredClone(message))},
    storage:{session:{get:async key=>({[key]:structuredClone(storage[key])}),set:async items=>Object.assign(storage,structuredClone(items)),remove:async key=>{delete storage[key]}}},
    permissions:{contains:async()=>true},
    tabs:{get:async()=>{
      if(holdFinalTab&&requests.length&&!heldFinalTab){
        heldFinalTab=true;await new Promise(resolve=>{releaseFinalTab=resolve;});
      }
      return {id:1,url:currentURL};
    },sendMessage:async(_id,message)=>{
      messages.push(structuredClone(message));
      if(message.type==='ALEF_SELECT_SUBJECT')return {ok:true,selected:true};
      if(['ALEF_SCAN','ALEF_INSPECT'].includes(message.type))return snapshot();
      if(message.type==='ALEF_CANCEL')return {ok:true};
      throw Error('Unexpected content mutation: '+message.type);
    },onRemoved:{addListener(fn){removed=fn}},create:async()=>{}},
    scripting:{executeScript:async()=>{throw Error('Preflight must not inject into the page');}},
    action:{onClicked:{addListener(){}}},
  };
  vm.runInNewContext(source,{chrome,URL,AbortController,AbortSignal,DOMException,setTimeout,clearTimeout,setInterval,clearInterval,
    fetch:async(url,options={})=>{
      requests.push({url,options});
      assert.equal(url,config.serverUrl+'/api/health','Preflight must query only the checked local health endpoint');
      assert.equal(options.method||'GET','GET');
      assert.equal(options.headers?.Authorization,undefined,'Public health does not receive the pairing token');
      assert.equal(options.body,undefined);
      assert.equal(options.redirect,'error','Health must not follow a local-to-external redirect');
      return health(options);
    }},{filename:'preflight-worker.js'});
  const send=message=>new Promise((resolve,reject)=>{
    if(!listener({tabId:1,...message},{id:'preflight-test',url:'chrome-extension://preflight-test/dashboard.html'},result=>resolve(structuredClone(result))))reject(Error('Worker rejected '+message.type));
  });
  t.after(()=>send({type:'STOP'}));
  return {requests,messages,events,send,remove:()=>removed?.(1),changeURL:value=>{currentURL=value},
    finalTabPending:()=>!!releaseFinalTab,releaseFinalTab:()=>releaseFinalTab?.(),
    state:async()=>(await send({type:'GET_STATE'})).state,
    start:()=>send({type:resume?'RESUME_FRAMES':'START',subjectId:'math',config})};
}

async function rejectedWithoutPageChange(h,pattern) {
  const before=await h.state();
  const result=await h.start();
  assert.equal(result.ok,false,JSON.stringify(result));assert.match(result.error,pattern);
  assert.deepEqual(await h.state(),before,'A rejected preflight must preserve queue, history, counters and the selected lesson');
  assert.deepEqual(h.messages,[],'No subject selection, lesson opening, answer or injection is permitted before service readiness');
  assert.deepEqual(h.events,[],'A failed preflight must not emit a running session');
  assert.equal(h.requests.length,1);
  return result;
}

for(const [name,error] of [
  ['an unreachable local server',new TypeError('Failed to fetch')],
  ['a local health timeout',new DOMException('Deadline elapsed','TimeoutError')],
])test(name+' is rejected before course navigation and explains the Windows launcher',async t=>{
  const h=setup(t,{health:async()=>{throw error}});
  await rejectedWithoutPageChange(h,/START-WINDOWS\.cmd/);
});

for(const [name,response] of [
  ['an HTTP failure',()=>new Response('service unavailable',{status:503})],
  ['non-JSON data',()=>new Response('<html>another app</html>',{status:200})],
  ['another service',()=>Response.json({status:'ok'})],
])test('preflight rejects '+name+' without clearing the saved lesson',async t=>{
  const h=setup(t,{health:async()=>response()});
  await rejectedWithoutPageChange(h,/[\u0600-\u06ff]/);
});

for(const [name,body] of [
  ['missing model',{...ready,configured:false,modelReady:false,message:'النموذج غير مثبت. شغّل ollama pull qwen3:8b ثم أعد الفحص.'}],
  ['stopped Ollama',{...ready,configured:false,modelReady:false,issue:'ollama_unreachable',message:'افتح Ollama على جهاز Windows ثم أعد فحص الاتصال.'}],
  ['a model that is not ready',{...ready,modelReady:false,message:'النموذج غير جاهز بعد.'}],
])test('preflight reports '+name+' before entering the course',async t=>{
  const h=setup(t,{health:async()=>Response.json(body)});
  await rejectedWithoutPageChange(h,new RegExp(body.message.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});

test('permission resume preserves the current lesson and remaining queue when the local server is offline',async t=>{
  const h=setup(t,{resume:true,health:async()=>{throw new TypeError('Failed to fetch')}});
  await rejectedWithoutPageChange(h,/START-WINDOWS\.cmd/);
  const state=await h.state();assert.equal(state.currentLesson.id,'one');assert.equal(state.queue[1].status,'pending');
  assert.deepEqual(state.blockedFrames,[{origin:'https://content.alefed.com'}]);
});

test('a healthy local service is checked before selecting the subject and can complete an empty catalog',async t=>{
  const h=setup(t);const result=await h.start();assert.equal(result.ok,true,JSON.stringify(result));
  const until=Date.now()+2000;
  while(!h.events.some(row=>row.event?.kind==='complete')){if(Date.now()>until)assert.fail(JSON.stringify(h.events));await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(h.requests.length,1);assert.equal(h.messages.filter(message=>message.type==='ALEF_SELECT_SUBJECT').length,1);
  assert.equal((await h.state()).status,'complete');
});

for(const resume of [false,true])test(`a protocol 2 backend cannot ${resume?'resume':'start'} the new solver contract before a full project update`,async t=>{
  const h=setup(t,{resume,health:async()=>Response.json({...ready,protocolVersion:2})});
  const result=await rejectedWithoutPageChange(h,/START-WINDOWS\.cmd/);
  assert.match(result.error,/المشروع|الخادم|قديمة|تحديث/,'The refusal must explain a server/project upgrade rather than an API key');
});

test('an invalid external service address is rejected before any health request',async t=>{
  const h=setup(t);const before=await h.state();
  const result=await h.send({type:'START',subjectId:'math',config:{...config,serverUrl:'https://external.example/'}});
  assert.equal(result.ok,false);assert.equal(h.requests.length,0);assert.deepEqual(h.messages,[]);assert.deepEqual(await h.state(),before);
});

async function waitUntil(predicate,description) {
  const until=Date.now()+2000;
  while(!predicate()){if(Date.now()>until)assert.fail(description);await new Promise(resolve=>setTimeout(resolve,5));}
}

test('only one START can reserve a tab while its health request is pending',async t=>{
  let release;
  const h=setup(t,{health:()=>new Promise(resolve=>{release=()=>resolve(Response.json(ready));})});
  const first=h.start();await waitUntil(()=>!!release,'The first local health request must start');
  const second=await h.start();assert.equal(second.ok,false);assert.match(second.error,/فحص|يعمل/);
  assert.equal(h.requests.length,1,'Double click cannot launch another preflight or run');assert.deepEqual(h.messages,[]);
  release();assert.equal((await first).ok,true);
  await waitUntil(()=>h.events.some(row=>row.event?.kind==='complete'),'The first run should finish');
  assert.equal(h.messages.filter(message=>message.type==='ALEF_SELECT_SUBJECT').length,1);
});

test('STOP aborts a pending health request and a late healthy response cannot start the course',async t=>{
  let release;
  const h=setup(t,{health:()=>new Promise(resolve=>{release=()=>resolve(Response.json(ready));})});
  const pending=h.start();await waitUntil(()=>!!release,'The health request must start');
  const stopped=await h.send({type:'STOP'});assert.equal(stopped.ok,true);
  assert.equal(h.requests[0].options.signal.aborted,true);
  release();const result=await pending;assert.equal(result.ok,false);
  assert.equal(h.messages.some(message=>message.type!=='ALEF_CANCEL'),false);
  assert.equal(h.events.some(row=>['status','queue','lesson','question'].includes(row.event?.kind)),false);
  const state=await h.state();assert.equal(state.running,false);assert.equal(state.status,'stopped');
  assert.equal(state.queue[0].status,'review');assert.equal(state.queue[1].status,'pending');
});

for(const [name,destination] of [
  ['leaving Alef','https://unrelated.example/'],
  ['changing to another Alef lesson',lessonURL.replace('/lesson/one/','/lesson/two/')],
])test(name+' during the health request prevents selection on the replacement page',async t=>{
  let release;
  const h=setup(t,{health:()=>new Promise(resolve=>{release=()=>resolve(Response.json(ready));})});
  const before=await h.state();const pending=h.start();await waitUntil(()=>!!release,'The health request must start');
  h.changeURL(destination);release();const result=await pending;
  assert.equal(result.ok,false);assert.deepEqual(h.messages,[]);assert.deepEqual(h.events,[]);assert.deepEqual(await h.state(),before);
});

for(const resume of [false,true])test(`STOP during the final tab lookup preserves the saved ${resume?'resume':'start'} state after a healthy preflight`,async t=>{
  const h=setup(t,{resume,holdFinalTab:true});const before=await h.state();
  const pending=h.start();await waitUntil(h.finalTabPending,'The post-health tab validation must be held');
  assert.equal(h.requests.length,1);assert.deepEqual(h.messages,[]);
  assert.equal((await h.send({type:'STOP'})).ok,true);
  h.releaseFinalTab();const result=await pending;assert.equal(result.ok,false,JSON.stringify(result));
  const after=await h.state();
  assert.equal(after.running,false);assert.equal(after.status,'stopped');
  assert.deepEqual(after.queue,before.queue,'STOP must not lose or reset the current and later lessons');
  assert.deepEqual(after.currentLesson,before.currentLesson);
  assert.deepEqual(after.stats,before.stats,'A stopped preflight cannot clear or roll back review counters');
  assert.deepEqual(after.blockedFrames,before.blockedFrames);
  assert.equal(after.frameBlockedPage,before.frameBlockedPage);
  assert.deepEqual(h.events.map(row=>row.event.kind),['stopped'],'No new run status can follow the STOP event');
  assert.ok(h.messages.every(message=>message.type==='ALEF_CANCEL'),'No subject selection or lesson mutation can occur after STOP');
});
