import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const workerSource=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
const subject={id:'math',name:'الرياضيات'};
const catalogURL='https://moe.alefed.com/#/classes/readiness-class?tab=assigned';
const config={serverUrl:'http://127.0.0.1:4318',token:'readiness-test-only',verify:false,qualityMode:false,autoSubmit:true,skipInstruction:true,minConfidence:.85};

function harness(t,{loadingReads=3,forever=false,permissionAfter=0,readyQuestionWithProgress=false,frameResult=false}={}) {
  const events=[],storage={},opened=[],sent=[],navigation=[];
  let handler,mode='catalog',current=null,reads=0,clock=0;
  let url=catalogURL;
  class Clock extends Date {static now(){return clock;}}
  const timeout=(fn,ms)=>setTimeout(()=>{clock+=ms;fn();},1);
  const page=()=>({url,title:'اختبار جاهزية الدرس'});
  const question=()=>({id:'question-'+current,fingerprint:'question-'+current,text:'ما ناتج 1 + 1؟',type:'single',options:[{id:'a',text:'1'},{id:'b',text:'2'}]});
  const snapshot=()=>{
    if(mode==='catalog')return {ok:true,page:page(),stage:'lessons',completed:false,fingerprint:'catalog',catalog:{type:'core-coursework',tab:'assigned',filter:'all',loading:false},subjects:[subject],navigation:[],lessons:['one','two'].map(id=>({id,name:'درس '+id,kind:'core-lesson',completed:false,locked:false}))};
    if(mode==='loading'){
      reads++;
      if(permissionAfter&&reads>=permissionAfter)return {ok:true,page:page(),stage:'instruction',permissionRequired:true,loading:true,fingerprint:'permission',question:null,lessons:[],navigation:[],diagnostics:['يحتاج محتوى الدرس إذن Chrome للمصدر: https://content.example.test'],blockedFrames:[{origin:'https://content.example.test'}]};
      if(forever||reads<=loadingReads)return {ok:true,page:page(),stage:'instruction',loading:true,framePending:!frameResult,frameResult,fingerprint:'spinner-'+reads,question:null,lessons:[],navigation:[]};
      mode=frameResult?'parent-next':'question';
    }
    if(mode==='parent-next')return {ok:true,page:page(),stage:'instruction',loading:true,frameResult:true,completed:false,fingerprint:'parent-next',question:null,lessons:[],navigation:[{id:'parent-next',kind:'next'}]};
    if(mode==='complete')return {ok:true,page:page(),stage:'complete',completed:true,fingerprint:'complete-'+current,lessons:[],navigation:[{id:'back',kind:'back'}]};
    return {ok:true,page:page(),stage:'question',loading:readyQuestionWithProgress,completed:false,fingerprint:'question-'+current,question:question(),lessons:[],navigation:[]};
  };
  const content=async message=>{
    switch(message.type){
      case 'ALEF_SCAN':return {...snapshot(),subjects:[subject]};
      case 'ALEF_SELECT_SUBJECT':mode='catalog';return {ok:true};
      case 'ALEF_INSPECT':return snapshot();
      case 'ALEF_OPEN_LESSON':current=message.lessonId;opened.push(current);reads=0;mode='loading';url=`https://moe.alefed.com/#/progress/ncle/class/readiness-class/lesson/${current}`;return {ok:true};
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
    fetch:async()=>Response.json({answer:{optionIds:['b'],text:'',explanation:'مزود اختبار فقط',confidence:.99},verified:false,needsReview:false})});
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
