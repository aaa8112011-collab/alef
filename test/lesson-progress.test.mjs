import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
const subject={id:'math',name:'الرياضيات'};
const catalogURL='https://moe.alefed.com/#/classes/progress-class?tab=assigned';
const config={serverUrl:'http://127.0.0.1:4318',token:'test-local-pairing',verify:false,autoSubmit:true,minConfidence:.85};

// Exercise the worker with a lagging route/DOM bridge. The real page can change
// its URL and catalog layout before its lesson player is ready.
function workerHarness(t,{lagReads=0,introSteps=0,needsReview=false,applyFailure=false,manualSubmit=false,returnWithoutCompletion=false,reusedQuestionId=false}={}) {
  const events=[];const storage={};const opened=[];const submissions=[];
  const completed=[];const introductions=[];let handler;let mode='catalog';let lesson=null;let reads=0;let index=0;let intro=0;
  let url=catalogURL;
  const page=()=>({url,title:'دروس الرياضيات'});
  function catalog() {
    return {ok:true,page:page(),stage:'lessons',subjects:[subject],completed:false,
      fingerprint:`catalog:${completed.join(',')}:${mode==='loading'?reads:0}`,
      catalog:{type:'core-coursework',tab:'assigned',filter:'all',loading:false,empty:false},
      lessons:['one','two'].map(id=>({id,name:`درس ${id}`,kind:'core-lesson',locked:false,completed:completed.includes(id)})),navigation:[]};
  }
  function question() {
    return {id:reusedQuestionId?'question':`${lesson}-question`,fingerprint:`${lesson}-question-${index}`,
      text:`السؤال ${index+1} في درس ${lesson}`,type:'single',options:[{id:'a',text:'1'},{id:'b',text:'2'}]};
  }
  function snapshot() {
    if(mode==='loading') {
      reads++;
      if(reads<=lagReads)return catalog();
      mode=introSteps?'instruction':'question';
    }
    if(mode==='catalog')return catalog();
    if(mode==='complete')return {ok:true,page:page(),stage:'complete',completed:true,fingerprint:`complete:${lesson}`,lessons:[],navigation:[{id:'back',kind:'back'}]};
    if(mode==='instruction')return {ok:true,page:page(),stage:'instruction',completed:false,fingerprint:`instruction:${lesson}:${intro}`,lessons:[],navigation:[
      {id:'sidebar-shortcut',kind:'assessment'},
      intro===introSteps-1?{id:`intro-${intro}`,kind:'assessment',sequential:true}:{id:`intro-${intro}`,kind:'next'},
    ]};
    return {ok:true,page:page(),stage:'question',completed:false,fingerprint:`question:${lesson}:${index}`,question:question(),lessons:[],navigation:[]};
  }
  async function content(message) {
    switch(message.type) {
      case 'ALEF_SCAN':return {...snapshot(),subjects:[subject]};
      case 'ALEF_SELECT_SUBJECT':mode='catalog';url=catalogURL;return {ok:true,selected:true};
      case 'ALEF_INSPECT':return snapshot();
      case 'ALEF_OPEN_LESSON':
        lesson=message.lessonId;opened.push(lesson);index=0;reads=0;intro=0;mode='loading';
        url=`https://moe.alefed.com/#/progress/ncle/class/progress-class/activity/${lesson}`;
        return {ok:true,clicked:true};
      case 'ALEF_APPLY':
        if(applyFailure)return {ok:false,error:'تعذر مطابقة زر الإجابة في السؤال الحالي.'};
        if(manualSubmit)return {ok:true,applied:true,submitted:false,reason:'تعذر العثور على زر إرسال الإجابة.'};
        submissions.push({lesson,id:message.questionId,fingerprint:message.questionFingerprint});
        if(returnWithoutCompletion) {mode='catalog';url=catalogURL;}
        else if(reusedQuestionId&&index===0)index++;
        else {completed.push(lesson);mode='complete';}
        return {ok:true,applied:true,submitted:true};
      case 'ALEF_NAVIGATE':
        if(message.actionId.startsWith('intro-')) {
          introductions.push({lesson,step:intro});intro++;
          mode=intro===introSteps?'question':'instruction';return {ok:true,clicked:true};
        }
        assert.equal(message.actionId,'back');mode='catalog';url=catalogURL;return {ok:true,clicked:true};
      case 'ALEF_CANCEL':return {ok:true};
      default:throw new Error('Unexpected content message '+message.type);
    }
  }
  const chrome={
    runtime:{id:'progress-test',getURL:path=>'chrome-extension://progress-test/'+path,getPlatformInfo:async()=>({}),
      onMessage:{addListener(listener){handler=listener;}},sendMessage:async message=>events.push(structuredClone(message))},
    storage:{session:{get:async key=>({[key]:storage[key]}),set:async items=>Object.assign(storage,structuredClone(items)),remove:async key=>{delete storage[key];}}},
    tabs:{get:async()=>({id:1,url}),sendMessage:async(_id,message)=>structuredClone(await content(message)),create:async()=>{},
      onRemoved:{addListener(){}},update:async(_id,update)=>{url=update.url;mode='catalog';return{id:1,url};}},
    scripting:{executeScript:async()=>{}},action:{onClicked:{addListener(){}}},
  };
  vm.runInNewContext(source,{chrome,URL,AbortController,AbortSignal,DOMException,setTimeout,clearTimeout,setInterval,clearInterval,
    fetch:async url=>url.endsWith('/api/health')?Response.json({ok:true,configured:true,provider:'ollama',modelReady:true,protocolVersion:2,visionReady:true}):Response.json({answer:{optionIds:['b'],text:'',explanation:'مزود اختبار محلي',confidence:needsReview?.4:.99},verified:false,needsReview})});
  const send=message=>new Promise((resolve,reject)=>{
    const accepted=handler({tabId:1,...message},{id:'progress-test',url:'chrome-extension://progress-test/dashboard.html'},resolve);
    if(!accepted)reject(new Error('Worker rejected '+message.type));
  });
  t.after(()=>send({type:'STOP'}));
  return {events,opened,submissions,introductions,send,start:async()=>{
    assert.equal((await send({type:'CONNECT'})).ok,true);
    assert.equal((await send({type:'START',subjectId:subject.id,config})).ok,true);
  }};
}
async function waitFor(predicate,description,timeout=7000) {
  const started=Date.now();
  while(!predicate()) {
    if(Date.now()-started>timeout)assert.fail(description);
    await new Promise(resolve=>setTimeout(resolve,20));
  }
}
const eventOf=(h,kind)=>h.events.find(item=>item.event?.kind===kind)?.event;

test('core lesson waits for its player despite catalog reflow and advances only after confirmed completion',async t=>{
  const h=workerHarness(t,{lagReads:2});await h.start();
  await waitFor(()=>eventOf(h,'complete'),JSON.stringify(h.events));
  assert.deepEqual(h.opened,['one','two'],'A lagging catalog must not be opened as a nested lesson');
  assert.deepEqual(h.submissions.map(item=>item.lesson),['one','two']);
  const state=(await h.send({type:'GET_STATE'})).state;
  assert.equal(state.stats.lessonsCompleted,2);assert.equal(state.stats.solved,2);
  assert.ok(state.queue.every(item=>item.kind==='core-lesson'));
  const submitted=h.events.filter(item=>item.event?.kind==='submitted').map(item=>item.event);
  assert.deepEqual(submitted.map(item=>[item.currentSubject.name,item.currentLesson.id,item.question.text,item.applied,item.submitted]),[
    ['الرياضيات','one','السؤال 1 في درس one',true,true],['الرياضيات','two','السؤال 1 في درس two',true,true],
  ]);
});

for(const [name,options] of [
  ['uncertain model answer',{needsReview:true}],
  ['answer control failure',{applyFailure:true}],
  ['missing submit control',{manualSubmit:true}],
]) {
  test(`${name} holds the current lesson and leaves later lessons pending`,async t=>{
    const h=workerHarness(t,options);await h.start();
    await waitFor(()=>eventOf(h,'review'),JSON.stringify(h.events));
    const state=(await h.send({type:'GET_STATE'})).state;
    assert.deepEqual(h.opened,['one']);assert.deepEqual(h.submissions,[]);
    assert.equal(state.running,false);assert.equal(state.status,'review');
    assert.equal(state.currentLesson.id,'one');assert.equal(state.queue[0].status,'review');
    assert.equal(state.queue[1].status,'pending');assert.equal(state.stats.lessonsCompleted,0);
    assert.equal(state.stats.solved,0);assert.equal(state.stats.lessonsReview,1);
    assert.equal(eventOf(h,'complete'),undefined);assert.equal(eventOf(h,'submitted'),undefined);
    assert.equal(eventOf(h,'review').question.text,'السؤال 1 في درس one');
  });
}

test('an unexpected return to the course catalog never opens an unrelated nested core lesson',async t=>{
  const h=workerHarness(t,{returnWithoutCompletion:true});await h.start();
  await waitFor(()=>eventOf(h,'review'),JSON.stringify(h.events));
  assert.deepEqual(h.opened,['one']);assert.equal(h.submissions.length,1);
  const state=(await h.send({type:'GET_STATE'})).state;
  assert.equal(state.stats.lessonsCompleted,0);assert.equal(state.queue[1].status,'pending');
  assert.match(eventOf(h,'review').message,/قائمة الدروس/);
});

test('a player that reuses question IDs still solves each changed fingerprint without a long next timeout',async t=>{
  const h=workerHarness(t,{reusedQuestionId:true});await h.start();
  await waitFor(()=>eventOf(h,'complete'),JSON.stringify(h.events));
  assert.deepEqual(h.submissions.map(item=>[item.lesson,item.id,item.fingerprint]),[
    ['one','question','one-question-0'],['one','question','one-question-1'],
    ['two','question','two-question-0'],['two','question','two-question-1'],
  ]);
  assert.equal((await h.send({type:'GET_STATE'})).state.stats.solved,4);
});

test('a long introduction follows every ordinary step including its sequential assessment start without a sidebar shortcut',async t=>{
  const h=workerHarness(t,{introSteps:14});await h.start();
  await waitFor(()=>eventOf(h,'complete'),JSON.stringify(h.events));
  assert.equal(h.introductions.length,28);
  for(const lesson of ['one','two'])assert.deepEqual(h.introductions.filter(item=>item.lesson===lesson).map(item=>item.step),Array.from({length:14},(_,index)=>index));
  assert.equal(h.submissions.length,2);
  assert.equal((await h.send({type:'GET_STATE'})).state.stats.lessonsCompleted,2);
});
