import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const workerSource=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
const subject={id:'math',name:'الرياضيات'};
const catalogURL='https://moe.alefed.com/#/classes/readiness-class?tab=assigned';
const config={serverUrl:'http://127.0.0.1:4318',token:'readiness-test-only',verify:false,qualityMode:false,autoSubmit:true,skipInstruction:true,minConfidence:.85};

function harness(t,{loadingReads=3,forever=false,permissionAfter=0,readyQuestionWithProgress=false,frameResult=false,
  unmarked=false,locked=false,unsupportedQuestion=false,lateLoadingAtMs=null,readyAfterMs=null,
  lateDiagnostic=null,diagnosticAtMs=0,permissionAtMs=null,singleLesson=false}={}) {
  const events=[],storage={},opened=[],sent=[],navigation=[];
  let handler,mode='catalog',current=null,reads=0,clock=0,lessonStarted=0;
  let url=catalogURL;
  class Clock extends Date {static now(){return clock;}}
  const timeout=(fn,ms)=>setTimeout(()=>{clock+=ms;fn();},1);
  const page=()=>({url,title:'اختبار جاهزية الدرس'});
  const question=()=>({id:'question-'+current,fingerprint:'question-'+current,text:'ما ناتج 1 + 1؟',type:'single',options:[{id:'a',text:'1'},{id:'b',text:'2'}]});
  const snapshot=()=>{
    if(mode==='catalog')return {ok:true,page:page(),stage:'lessons',completed:false,fingerprint:'catalog',catalog:{type:'core-coursework',tab:'assigned',filter:'all',loading:false},subjects:[subject],navigation:[],lessons:(singleLesson?['one']:['one','two']).map(id=>({id,name:'درس '+id,kind:'core-lesson',completed:false,locked:false}))};
    if(mode==='loading'){
      reads++;
      const elapsed=clock-lessonStarted;
      if(permissionAfter&&reads>=permissionAfter||permissionAtMs!==null&&elapsed>=permissionAtMs)return {ok:true,page:page(),stage:'instruction',permissionRequired:true,loading:true,fingerprint:'permission',question:null,lessons:[],navigation:[],diagnostics:['يحتاج محتوى الدرس إذن Chrome للمصدر: https://content.example.test'],blockedFrames:[{origin:'https://content.example.test'}]};
      const lateLoading=lateLoadingAtMs!==null&&elapsed>=lateLoadingAtMs;
      const loading=!unmarked||lateLoading&&frameResult;
      const framePending=(!unmarked||lateLoading)&&!frameResult;
      const pending=readyAfterMs===null?reads<=loadingReads:elapsed<readyAfterMs;
      const diagnostics=locked?['هذا القسم غير مسند أو مقفل في ألف؛ لا يمكن تجاوز القفل تلقائيًا.']:
        lateDiagnostic&&elapsed>=diagnosticAtMs?[lateDiagnostic]:[];
      if(forever||pending)return {ok:true,page:page(),stage:'instruction',loading,framePending,frameResult,fingerprint:'shell-'+reads,question:null,lessons:[],navigation:[],diagnostics};
      mode=frameResult?'parent-next':'question';
    }
    if(mode==='parent-next')return {ok:true,page:page(),stage:'instruction',loading:true,frameResult:true,completed:false,fingerprint:'parent-next',question:null,lessons:[],navigation:[{id:'parent-next',kind:'next'}]};
    if(mode==='complete')return {ok:true,page:page(),stage:'complete',completed:true,fingerprint:'complete-'+current,lessons:[],navigation:[{id:'back',kind:'back'}]};
    return {ok:true,page:page(),stage:'question',loading:readyQuestionWithProgress,completed:false,fingerprint:'question-'+current,question:unsupportedQuestion?null:question(),lessons:[],navigation:[],
      ...(unsupportedQuestion?{diagnostics:['السؤال الظاهر يستخدم تفاعلًا غير مدعوم في قارئ الاختبار.']}:{})};
  };
  const content=async message=>{
    switch(message.type){
      case 'ALEF_SCAN':return {...snapshot(),subjects:[subject]};
      case 'ALEF_SELECT_SUBJECT':mode='catalog';return {ok:true};
      case 'ALEF_INSPECT':return snapshot();
      case 'ALEF_OPEN_LESSON':current=message.lessonId;opened.push(current);reads=0;lessonStarted=clock;mode='loading';url=`https://moe.alefed.com/#/progress/ncle/class/readiness-class/lesson/${current}`;return {ok:true};
      case 'ALEF_APPLY':sent.push(current);mode='complete';return {ok:true,applied:true,submitted:true};
      case 'ALEF_NAVIGATE':navigation.push(message.actionId);if(message.actionId==='parent-next'){mode='question';return {ok:true};}assert.equal(message.actionId,'back');mode='catalog';url=catalogURL;return {ok:true};
      case 'ALEF_CANCEL':return {ok:true};
      default:throw new Error('Unexpected message '+message.type);
    }
  };
  const chrome={
    runtime:{id:'readiness-test',getURL:path=>'chrome-extension://readiness-test/'+path,getPlatformInfo:async()=>({}),onMessage:{addListener(fn){handler=fn;}},sendMessage:async message=>events.push(structuredClone(message))},
    storage:{session:{get:async key=>({[key]:storage[key]}),set:async items=>Object.assign(storage,structuredClone(items)),remove:async key=>{delete storage[key];}}},
    tabs:{get:async()=>({id:1,url}),sendMessage:async(_id,message)=>structuredClone(await content(message)),create:async()=>{},onRemoved:{addListener(){}},update:async(_id,update)=>{url=update.url;mode='catalog';return{id:1,url};}},
    scripting:{executeScript:async()=>{}},action:{onClicked:{addListener(){}}},
  };
  vm.runInNewContext(workerSource,{chrome,URL,AbortController,AbortSignal,DOMException,Date:Clock,setTimeout:timeout,clearTimeout,setInterval,clearInterval,
    fetch:async url=>Response.json(String(url).endsWith('/api/health')
      ?{ok:true,configured:true,provider:'ollama',modelReady:true,protocolVersion:3,visionReady:true}
      :{answer:{optionIds:['b'],text:'',explanation:'مزود اختبار فقط',confidence:.99},verified:false,needsReview:false})});
  const send=message=>new Promise((resolve,reject)=>{if(!handler({tabId:1,...message},{id:'readiness-test',url:'chrome-extension://readiness-test/dashboard.html'},resolve))reject(new Error('Rejected message'));});
  t.after(()=>send({type:'STOP'}));
  return {events,opened,sent,navigation,send,elapsed:()=>clock,start:async()=>{assert.equal((await send({type:'CONNECT'})).ok,true);assert.equal((await send({type:'START',subjectId:subject.id,config})).ok,true);}};
}
const of=(h,kind)=>h.events.find(row=>row.event?.kind===kind)?.event;
async function waitFor(predicate,description){const until=Date.now()+5000;while(!predicate()){if(Date.now()>until)assert.fail(description);await new Promise(resolve=>setTimeout(resolve,5));}}

test('a mounted NCLE loading shell waits until controls appear instead of declaring manual interaction immediately',async t=>{
  const h=harness(t);await h.start();await waitFor(()=>of(h,'complete'),JSON.stringify(h.events));
  assert.deepEqual(h.opened,['one','two']);assert.deepEqual(h.sent,['one','two']);
  assert.equal(of(h,'review'),undefined);assert.equal(of(h,'error'),undefined);
  assert.ok(h.events.some(row=>row.event?.phase==='loading'));
});

test('a permanent progress indicator does not prevent a real actionable question from being solved',async t=>{
  const h=harness(t,{loadingReads:0,readyQuestionWithProgress:true});await h.start();await waitFor(()=>of(h,'complete'),JSON.stringify(h.events));
  assert.deepEqual(h.sent,['one','two']);assert.equal(of(h,'review'),undefined);
  assert.equal(h.events.some(row=>row.event?.phase==='loading'),false);
});

test('child result loading waits for the parent ordinary next control before submitting or completing the lesson',async t=>{
  const h=harness(t,{frameResult:true});await h.start();await waitFor(()=>of(h,'complete'),JSON.stringify(h.events));
  assert.deepEqual(h.sent,['one','two']);assert.deepEqual(h.navigation,['parent-next','back','parent-next','back']);
  assert.equal((await h.send({type:'GET_STATE'})).state.stats.lessonsCompleted,2);
});

test('a frame permission requirement appears immediately even while the player reports loading',async t=>{
  const h=harness(t,{permissionAfter:2});await h.start();await waitFor(()=>of(h,'review'),JSON.stringify(h.events));
  assert.equal(of(h,'review').cause,'frame_permission_required');assert.deepEqual(h.opened,['one']);assert.deepEqual(h.sent,[]);
  assert.ok(h.elapsed()<30000);
});

test('STOP interrupts the loading wait and prevents opening a later lesson or submitting a late question',async t=>{
  const h=harness(t,{forever:true});await h.start();await waitFor(()=>h.events.some(row=>row.event?.phase==='loading'),JSON.stringify(h.events));
  assert.equal((await h.send({type:'STOP'})).ok,true);await new Promise(resolve=>setTimeout(resolve,15));
  assert.deepEqual(h.opened,['one']);assert.deepEqual(h.sent,[]);assert.equal(of(h,'complete'),undefined);
  assert.equal((await h.send({type:'GET_STATE'})).state.running,false);
});

test('loading timeout is bounded and leaves the current lesson in review with all later lessons pending',async t=>{
  const h=harness(t,{forever:true});await h.start();await waitFor(()=>of(h,'review'),JSON.stringify(h.events));
  const state=(await h.send({type:'GET_STATE'})).state;
  assert.match(of(h,'review').message,/30 ثانية/);assert.deepEqual(h.opened,['one']);assert.deepEqual(h.sent,[]);
  assert.equal(state.queue[0].status,'review');assert.equal(state.queue[1].status,'pending');assert.equal(state.stats.lessonsCompleted,0);
  assert.ok(h.elapsed()>=30000&&h.elapsed()<32000,'Virtual time verifies the real deadline without a wall-clock sleep');
});

test('an NCLE shell without a spinner waits for its delayed visible question and submits before opening the next lesson',async t=>{
  const h=harness(t,{unmarked:true});await h.start();await waitFor(()=>of(h,'complete'),JSON.stringify(h.events));
  assert.deepEqual(h.opened,['one','two']);assert.deepEqual(h.sent,['one','two']);
  assert.equal(of(h,'review'),undefined);assert.equal(of(h,'error'),undefined);
  assert.ok(h.events.some(row=>row.event?.phase==='waiting_controls'));
  assert.ok(h.elapsed()<12000,'The adapter proceeds as soon as the question appears instead of sleeping for the whole grace period');
});

test('late ordinary Next after an unmarked shell is clicked once before solving the question',async t=>{
  const h=harness(t,{unmarked:true,frameResult:true});await h.start();await waitFor(()=>of(h,'complete'),JSON.stringify(h.events));
  assert.deepEqual(h.sent,['one','two']);assert.deepEqual(h.navigation,['parent-next','back','parent-next','back']);
  assert.equal(of(h,'review'),undefined);
});

test('STOP interrupts unmarked shell stabilization before any solver or later lesson activity',async t=>{
  const h=harness(t,{unmarked:true,forever:true});await h.start();
  await waitFor(()=>h.events.some(row=>row.event?.phase==='waiting_controls'),JSON.stringify(h.events));
  assert.equal((await h.send({type:'STOP'})).ok,true);await new Promise(resolve=>setTimeout(resolve,15));
  assert.deepEqual(h.opened,['one']);assert.deepEqual(h.sent,[]);assert.equal(of(h,'complete'),undefined);
  assert.equal((await h.send({type:'GET_STATE'})).state.running,false);
});

test('an unreadable unmarked shell times out with a reading diagnostic instead of inventing a viewing requirement',async t=>{
  const h=harness(t,{unmarked:true,forever:true});await h.start();await waitFor(()=>of(h,'review'),JSON.stringify(h.events));
  const review=of(h,'review'),state=(await h.send({type:'GET_STATE'})).state;
  assert.match(review.message,/قراءة السؤال|زر متابعة/);assert.match(review.message,/12 ثانية/);
  assert.doesNotMatch(review.message,/يتطلب هذا الدرس مشاهدة/);
  assert.deepEqual(h.opened,['one']);assert.deepEqual(h.sent,[]);
  assert.equal(state.queue[0].status,'review');assert.equal(state.queue[1].status,'pending');
  assert.ok(h.elapsed()>=12000&&h.elapsed()<14000,'No spinner means a short bounded readiness grace, not an unbounded loop');
});

test('a known locked lesson returns its actual reason immediately without stabilization or navigation',async t=>{
  const h=harness(t,{unmarked:true,locked:true});await h.start();await waitFor(()=>of(h,'review'),JSON.stringify(h.events));
  assert.equal(of(h,'review').cause,'lesson_locked');assert.match(of(h,'review').message,/مقفل/);
  assert.deepEqual(h.opened,['one']);assert.deepEqual(h.sent,[]);
  assert.equal(h.events.some(row=>row.event?.phase==='waiting_controls'),false);
  assert.ok(h.elapsed()<12000);
});

test('a recognized unsupported question leaves the readiness wait with its reading error and never opens another lesson',async t=>{
  const h=harness(t,{unmarked:true,unsupportedQuestion:true});await h.start();await waitFor(()=>of(h,'review'),JSON.stringify(h.events));
  assert.match(of(h,'review').message,/تفاعلًا غير مدعوم/);
  assert.doesNotMatch(of(h,'review').message,/يتطلب هذا الدرس مشاهدة/);
  assert.deepEqual(h.opened,['one']);assert.deepEqual(h.sent,[]);assert.ok(h.elapsed()<12000);
});

for(const frameResult of [false,true])test(`an unmarked shell promotes to the original 30 second deadline when late ${frameResult?'loading':'framePending'} appears and proceeds on readiness`,async t=>{
  const h=harness(t,{unmarked:true,lateLoadingAtMs:10000,readyAfterMs:16000,frameResult,singleLesson:true});
  await h.start();await waitFor(()=>of(h,'complete'),JSON.stringify(h.events));
  assert.deepEqual(h.opened,['one']);assert.deepEqual(h.sent,['one']);
  assert.equal(of(h,'review'),undefined);assert.equal(of(h,'error'),undefined);
  assert.ok(h.elapsed()>=16000&&h.elapsed()<18000,'Late loading may outlive 12s but readiness must not wait for the whole 30s budget');
  if(frameResult)assert.deepEqual(h.navigation,['parent-next','back']);
});

test('late loading promotes only to 30 seconds total rather than restarting its deadline',async t=>{
  const issue='صيغة السؤال داخل إطار الدرس غير مقروءة بعد التحميل.';
  const h=harness(t,{unmarked:true,forever:true,lateLoadingAtMs:10000,lateDiagnostic:issue,diagnosticAtMs:20000});await h.start();
  await waitFor(()=>of(h,'review'),JSON.stringify(h.events));
  const review=of(h,'review'),state=(await h.send({type:'GET_STATE'})).state;
  assert.match(review.message,/30 ثانية/);assert.doesNotMatch(review.message,/12 ثانية/);assert.ok(review.message.includes(issue));
  assert.ok(h.elapsed()>=30000&&h.elapsed()<32000,'The 30s maximum is measured from the original wait, not late frame arrival');
  assert.deepEqual(h.opened,['one']);assert.deepEqual(h.sent,[]);
  assert.equal(state.queue[0].status,'review');assert.equal(state.queue[1].status,'pending');
});

test('STOP still interrupts a readiness wait after late loading promotes its budget',async t=>{
  const h=harness(t,{unmarked:true,forever:true,lateLoadingAtMs:10000});await h.start();
  await waitFor(()=>h.elapsed()>=10500,JSON.stringify(h.events));
  assert.equal((await h.send({type:'STOP'})).ok,true);await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal((await h.send({type:'GET_STATE'})).state.running,false);
  assert.deepEqual(h.opened,['one']);assert.deepEqual(h.sent,[]);assert.equal(of(h,'complete'),undefined);assert.equal(of(h,'review'),undefined);
  assert.ok(h.elapsed()<20000,'STOP does not wait for the promoted deadline');
});

test('an unmarked timeout preserves the final specific reading diagnostic',async t=>{
  const issue='ظهر إطار الدرس، لكن صيغة السؤال داخل الإطار غير مقروءة.';
  const h=harness(t,{unmarked:true,forever:true,lateDiagnostic:issue,diagnosticAtMs:8000});await h.start();
  await waitFor(()=>of(h,'review'),JSON.stringify(h.events));
  const review=of(h,'review');assert.ok(review.message.includes(issue));assert.match(review.message,/12 ثانية/);
  assert.ok(h.elapsed()>=12000&&h.elapsed()<14000,'A stable unreadable shell without explicit loading retains its short deadline');
  assert.deepEqual(h.opened,['one']);assert.deepEqual(h.sent,[]);
});

for(const cause of ['permission','lock'])test(`late ${cause} exits a promoted readiness wait immediately with its own reason`,async t=>{
  const h=harness(t,{unmarked:true,forever:true,lateLoadingAtMs:10000,
    ...(cause==='permission'?{permissionAtMs:18000}:{lateDiagnostic:'هذا القسم مقفل في ألف.',diagnosticAtMs:18000})});
  await h.start();await waitFor(()=>of(h,'review'),JSON.stringify(h.events));
  const review=of(h,'review');assert.equal(review.cause,cause==='permission'?'frame_permission_required':'lesson_locked');
  assert.ok(h.elapsed()>=18000&&h.elapsed()<20000,'Explicit blockers must not consume the remaining readiness budget');
  assert.doesNotMatch(review.message,/خلال 12 ثانية|خلال 30 ثانية/);
  assert.deepEqual(h.opened,['one']);assert.deepEqual(h.sent,[]);
});
