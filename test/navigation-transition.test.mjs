import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
const config={serverUrl:'http://127.0.0.1:4318',token:'transition-test-only',qualityMode:false,
  verify:false,autoSubmit:true,skipInstruction:true,minConfidence:.85};

function harness(t,scenario='stalled') {
  const events=[],navigation=[],applied=[];
  let listener,clock=0,mode='catalog',step=1,clickedAt=null,finished=false;
  let url='https://moe.alefed.com/#/classes/transition-test?tab=assigned';
  const subject={id:'math',name:'الرياضيات'};
  const question={id:'q',fingerprint:'q',type:'single',text:'1 + 1 = ?',options:[{id:'a',text:'1'},{id:'b',text:'2'}]};
  const snapshot=()=>{
    const base={ok:true,page:{url},subjects:[subject],lessons:[],navigation:[],completed:false,loading:false};
    if(mode==='catalog')return {...base,stage:'lessons',fingerprint:'catalog-'+finished,transitionFingerprint:'catalog-'+finished,
      catalog:{type:'core-coursework',tab:'assigned',filter:'all',loading:false},lessons:[
        {id:'one',name:'الدرس الأول',kind:'core-lesson',locked:false,completed:finished},
        ...(scenario==='stalled'?[{id:'two',name:'الدرس الثاني',kind:'core-lesson',locked:false,completed:false}]:[])]};
    if(mode==='complete')return {...base,stage:'complete',completed:true,fingerprint:'complete',transitionFingerprint:'complete',navigation:[{id:'back',kind:'back'}]};
    if(scenario==='after-submit-progress'&&mode==='correct'&&clickedAt!==null&&clock-clickedAt>=750) {
      mode='instruction';step=2;clickedAt=null;
    }
    const busyInstruction=mode==='correct'&&clickedAt!==null&&scenario!=='after-submit';
    if(mode==='question'||mode==='correct')return {...base,stage:busyInstruction?'instruction':'question',question:busyInstruction?null:question,
      fingerprint:mode+(clickedAt===null?'':'-loading'),transitionFingerprint:mode,loading:clickedAt!==null,
      ...(mode==='correct'?{feedback:'correct',navigation:[{id:'next',kind:'next'}]}:{})};
    if(['progress','after-submit-progress'].includes(scenario)&&clickedAt!==null&&clock-clickedAt>=750) {
      clickedAt=null;
      if(step===1){step=2;}
      else if(scenario==='after-submit-progress'){mode='complete';finished=true;return snapshot();}
      else {mode='question';return snapshot();}
    }
    const finish=scenario==='finish'&&clickedAt!==null;
    return {...base,stage:'instruction',fingerprint:`step-${step}-${clickedAt===null?'ready':'loading'}`,
      transitionFingerprint:`step-${step}`,loading:clickedAt!==null,
      navigation:[finish?{id:'finish',kind:'finish'}:{id:'next',kind:'next'}]};
  };
  const content=async message=>{
    if(message.type==='ALEF_SCAN'||message.type==='ALEF_INSPECT')return snapshot();
    if(message.type==='ALEF_SELECT_SUBJECT'||message.type==='ALEF_CANCEL')return {ok:true};
    if(message.type==='ALEF_OPEN_LESSON'){
      assert.equal(message.lessonId,'one','Unresolved lessons must never advance the queue');
      mode=scenario.startsWith('after-submit')?'question':'instruction';
      url='https://moe.alefed.com/#/progress/ncle/class/transition-test/lesson/one';
      return {ok:true,clicked:true};
    }
    if(message.type==='ALEF_NAVIGATE'){
      navigation.push({id:message.actionId,step,time:clock});
      if(message.actionId==='back'){mode='catalog';url='https://moe.alefed.com/#/classes/transition-test?tab=assigned';}
      else if(message.actionId==='finish'){mode='complete';finished=true;}
      else clickedAt=clock;
      return {ok:true,clicked:true};
    }
    if(message.type==='ALEF_APPLY'){
      applied.push(message.answer.optionIds);
      if(scenario.startsWith('after-submit'))mode='correct';
      else {mode='complete';finished=true;}
      return {ok:true,applied:true,submitted:true};
    }
    throw new Error('Unexpected message '+message.type);
  };
  class Clock extends Date {static now(){return clock;}}
  const timeout=(fn,ms)=>setTimeout(()=>{clock+=ms;fn();},1);
  const chrome={
    runtime:{id:'transition-test',getURL:path=>'chrome-extension://transition-test/'+path,getPlatformInfo:async()=>({}),
      onMessage:{addListener(fn){listener=fn;}},sendMessage:async message=>events.push(structuredClone(message))},
    storage:{session:{get:async()=>({}),set:async()=>{}}},
    tabs:{get:async()=>({id:1,url}),sendMessage:async(_tab,message)=>structuredClone(await content(message)),onRemoved:{addListener(){}}},
    scripting:{executeScript:async()=>{}},action:{onClicked:{addListener(){}}},
  };
  vm.runInNewContext(source,{chrome,URL,AbortController,AbortSignal,DOMException,Date:Clock,setTimeout:timeout,clearTimeout,setInterval,clearInterval,
    fetch:async endpoint=>Response.json(endpoint.endsWith('/api/health')?
      {ok:true,configured:true,provider:'ollama',modelReady:true,protocolVersion:3}:
      {answer:{optionIds:['b'],text:'',explanation:'اختبار فقط',confidence:.99},verified:false,needsReview:false})});
  const send=message=>new Promise(resolve=>listener({tabId:1,...message},{id:'transition-test',url:'chrome-extension://transition-test/dashboard.html'},resolve));
  t.after(()=>send({type:'STOP'}));
  return {events,navigation,applied,send,elapsed:()=>clock,start:async()=>{
    assert.equal((await send({type:'CONNECT'})).ok,true);
    assert.equal((await send({type:'START',subjectId:'math',config})).ok,true);
  }};
}
const terminal=h=>h.events.find(item=>['review','error','complete'].includes(item.event?.kind))?.event;
async function waitFor(predicate,description) {
  const until=Date.now()+5000;
  while(!predicate()){
    if(Date.now()>until)assert.fail(description);
    await new Promise(resolve=>setTimeout(resolve,5));
  }
}

test('loading-only fingerprint changes cannot click the same Next twice or open a later lesson',async t=>{
  const h=harness(t);await h.start();await waitFor(()=>terminal(h),JSON.stringify(h.events));
  assert.deepEqual(h.navigation.map(item=>item.id),['next']);
  assert.deepEqual(h.applied,[]);assert.equal(terminal(h).kind,'review');
  const state=(await h.send({type:'GET_STATE'})).state;
  assert.equal(state.currentLesson.id,'one');assert.equal(state.queue[1].status,'pending');
  assert.ok(h.elapsed()>=30000&&h.elapsed()<32000,'Loading has one original bounded deadline');
});

test('the same Next button advances again only after actual instructional content changes',async t=>{
  const h=harness(t,'progress');await h.start();await waitFor(()=>terminal(h),JSON.stringify(h.events));
  assert.equal(terminal(h).kind,'complete',JSON.stringify(terminal(h)));
  assert.deepEqual(h.navigation.map(item=>[item.id,item.step]),[['next',1],['next',2],['back',2]]);
  assert.ok(h.navigation[1].time-h.navigation[0].time>=750,'The in-flight first step cannot receive another click');
  assert.deepEqual(h.applied,[['b']]);
});

test('a genuinely new Finish action remains usable when instruction text stays the same',async t=>{
  const h=harness(t,'finish');await h.start();await waitFor(()=>terminal(h),JSON.stringify(h.events));
  assert.equal(terminal(h).kind,'complete');assert.deepEqual(h.navigation.map(item=>item.id),['next','finish','back']);
});

test('STOP interrupts a pending Next transition without another click or submission',async t=>{
  const h=harness(t);await h.start();await waitFor(()=>h.navigation.length===1,JSON.stringify(h.events));
  assert.equal((await h.send({type:'STOP'})).ok,true);
  await new Promise(resolve=>setTimeout(resolve,15));
  assert.deepEqual(h.navigation.map(item=>item.id),['next']);assert.deepEqual(h.applied,[]);
  assert.equal((await h.send({type:'GET_STATE'})).state.running,false);
});

test('loading-only changes after an answer cannot repeat its Next click',async t=>{
  const h=harness(t,'after-submit');await h.start();await waitFor(()=>terminal(h),JSON.stringify(h.events));
  assert.equal(terminal(h).kind,'review');assert.deepEqual(h.applied,[['b']]);
  assert.deepEqual(h.navigation.map(item=>item.id),['next']);
});

test('a busy instruction shell after an answer cannot reset the Next click guard',async t=>{
  const h=harness(t,'after-submit-stage');await h.start();await waitFor(()=>terminal(h),JSON.stringify(h.events));
  assert.equal(terminal(h).kind,'review');assert.deepEqual(h.applied,[['b']]);
  assert.deepEqual(h.navigation.map(item=>item.id),['next']);
  assert.match(terminal(h).message,/لم يكتمل الانتقال/);
});

test('a ready instruction after an answer uses its Next after the preceding transition finishes',async t=>{
  const h=harness(t,'after-submit-progress');await h.start();await waitFor(()=>terminal(h),JSON.stringify(h.events));
  assert.equal(terminal(h).kind,'complete',JSON.stringify(terminal(h)));
  assert.deepEqual(h.applied,[['b']]);
  assert.deepEqual(h.navigation.map(item=>[item.id,item.step]),[['next',1],['next',2],['back',2]]);
  assert.ok(h.navigation[1].time-h.navigation[0].time>=750);
});

test('STOP interrupts the busy instruction shell after an answer without repeating Next',async t=>{
  const h=harness(t,'after-submit-stage');await h.start();await waitFor(()=>h.navigation.length===1,JSON.stringify(h.events));
  assert.equal((await h.send({type:'STOP'})).ok,true);
  await new Promise(resolve=>setTimeout(resolve,15));
  assert.deepEqual(h.navigation.map(item=>item.id),['next']);assert.deepEqual(h.applied,[['b']]);
  assert.equal((await h.send({type:'GET_STATE'})).state.running,false);
});
