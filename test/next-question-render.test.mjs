import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

// Real DOM reader, matching clicks, Submit/Next handlers and worker. The
// delayed render is an explicit transition fixture, not a measured Alef delay.
// Chrome and model responses are stubs; answer accuracy is not under test.
async function setup(t,{language='ar',renderDelay=600,identical=false,stall=false,fastClock=false,authoredIds=identical}={}){
 const h=await createBrowserHarness();let stop=async()=>{};
 t.after(async()=>{await stop();await h.close();});
 await h.page.evaluate(settings=>{
  const {language,renderDelay,identical,stall,authoredIds}=settings,ar=language==='ar';
  document.documentElement.dir=ar?'rtl':'ltr';
  document.body.innerHTML='<main><button data-alef-subject="language">Language</button></main>';
  window.renderTransition={submits:[],nexts:0,phase:'before',renderDelay,identical,stall};
  const words=ar?['الأولى','الثانية','الثالثة','الرابعة','الخامسة','السادسة','السابعة']:['first','second','third','fourth','fifth','sixth','seventh'];
  window.mountRenderQuestion=index=>{
   const state=window.renderTransition,count=index===2||identical?3:2,q=document.querySelector('#question');
   state.phase='question-'+index;
   if(authoredIds)q.setAttribute('data-question-id','question-'+index);else q.removeAttribute('data-question-id');
   const label=identical?(ar?'ضع ثلاث كلمات في فراغاتها.':'Place three words into their blanks.')
    :index===2?(ar?'السؤال السابق يتضمن ثلاثة فراغات.':'The preceding question has three blanks.')
    :(ar?'السؤال الحالي يتضمن فراغين.':'The current question has two blanks.');
   q.innerHTML='<h2>'+label+'</h2>'+Array.from({length:count},(_,i)=>'<span data-testid="fill-blank-dd-'+i+'" style="display:inline-block;border:1px solid;width:110px;height:44px;margin:8px"></span>').join('')+'<div id="word-bank"></div>';
   const button=document.querySelector('#action');button.textContent=ar?'أرسل إجابتي':'Submit Answer';button.disabled=true;
   let selected;
   for(const word of words){const node=document.createElement('button');node.dataset.testid='draggableChoice';node.textContent=word;node.onclick=()=>{selected=word;};document.querySelector('#word-bank').append(node);}
   for(const blank of q.querySelectorAll('[data-testid^="fill-blank-dd-"]'))blank.onclick=()=>{
    if(selected)blank.textContent=selected;
    button.disabled=[...q.querySelectorAll('[data-testid^="fill-blank-dd-"]')].some(node=>!node.textContent);
   };
   button.onclick=()=>{
    state.submits.push(index);state.phase='accepted-'+index;
    if(index===3){document.querySelector('main').innerHTML='<section data-alef-completed>Lesson completed</section>';return;}
    button.textContent=ar?'التالي':'Next';button.onclick=()=>{
     state.nexts++;state.phase='between';
     document.querySelector('[data-testid="progress-bar-slide-count"]').textContent='3/5';
     if(!stall)setTimeout(()=>window.mountRenderQuestion(3),renderDelay);
    };
   };
  };
  document.querySelector('button').onclick=()=>{
   history.replaceState(null,'','#/progress/ncle/class/render-transition/lesson/one');
   document.body.innerHTML='<main id="player-container"><div data-testid="assessment-content-player"><div data-testid="progress-bar-slide-count">2/5</div><section id="question" data-testid="question-renderer" data-question-id="question-2"></section><button id="action"></button></div></main>';
   window.mountRenderQuestion(2);
  };
 },{language,renderDelay,identical,stall,authoredIds});
 const events=[],requests=[],snapshots=[];let listener,clock=0;
 class Clock extends Date {static now(){return clock;}}
 const timeout=fastClock?(fn,ms)=>setTimeout(()=>{clock+=ms;fn();},1):setTimeout;
 const chrome={runtime:{id:'fixture-extension',getURL:path=>'chrome-extension://fixture-extension/'+path,getPlatformInfo:async()=>({}),
   onMessage:{addListener(fn){listener=fn;}},sendMessage:async message=>events.push(structuredClone(message.event))},
  storage:{session:{get:async()=>({}),set:async()=>{}}},
  tabs:{get:async()=>({id:1,url:h.page.url()}),sendMessage:async(_id,message)=>{
   const result=await h.send(message);
   if(message.type==='ALEF_INSPECT'&&result.question)snapshots.push(structuredClone(result));
   return result;
  },onRemoved:{addListener(){}}},scripting:{executeScript:async()=>{}},action:{onClicked:{addListener(){}}}};
 const worker=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
 vm.runInNewContext(worker,{chrome,URL,AbortController,AbortSignal,DOMException,Date:fastClock?Clock:Date,
  setTimeout:timeout,clearTimeout,setInterval,clearInterval,fetch:async(url,options={})=>{
   if(url.endsWith('/api/health'))return Response.json({ok:true,configured:true,provider:'ollama',modelReady:true,protocolVersion:3});
   assert.ok(url.endsWith('/api/solve'));
   const q=JSON.parse(options.body).question;requests.push(structuredClone(q));
   // If an old request escapes the render wait, let the actual new DOM mount
   // before it returns. Existing application guards must reject that answer.
   if(requests.length===2&&(identical?q.id==='question-2':q.text===requests[0].text)&&!fastClock)await new Promise(resolve=>setTimeout(resolve,renderDelay+300));
   return Response.json({answer:{optionIds:[],text:'',matches:q.items.map((item,index)=>({itemId:item.id,targetId:q.targets[index].id})),
    explanation:'Deterministic transition fixture only.',confidence:.99},verified:false,needsReview:false});
  }});
 const send=message=>new Promise((resolve,reject)=>{
  if(!listener({tabId:1,...message},{id:'fixture-extension',url:'chrome-extension://fixture-extension/dashboard.html'},resolve))reject(Error('Worker refused '+message.type));
 });
 stop=()=>send({type:'STOP'});
 return {h,events,requests,snapshots,send,async start(){
  assert.equal((await send({type:'CONNECT'})).ok,true);
  const started=await send({type:'START',subjectId:'language',config:{serverUrl:'http://127.0.0.1:4318',token:'transition-fixture-token',qualityMode:false,
   verify:false,autoSubmit:true,skipInstruction:true}});
  assert.equal(started.ok,true,JSON.stringify(started));
 }};
}
const terminal=f=>f.events.find(event=>['complete','review','error'].includes(event.kind));
async function finish(f){
 await f.start();const deadline=Date.now()+18000;
 while(!terminal(f)){
  if(Date.now()>deadline)assert.fail(JSON.stringify(f.events));
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 return terminal(f);
}

for(const language of ['ar','en'])test(`${language}: progress-first Next waits for the new matching content rather than solving the old three blanks again`,async t=>{
 const f=await setup(t,{language}),end=await finish(f);
 assert.equal(end.kind,'complete',JSON.stringify({end,requests:f.requests,events:f.events}));
 assert.equal(f.requests.length,2);assert.notEqual(f.requests[0].text,f.requests[1].text);
 assert.deepEqual(f.requests.map(q=>q.items.length),[3,2]);
 assert.ok(f.requests.every(q=>q.id.startsWith('question-')&&q.id!=='question-2'&&q.id!=='question-3'),'These player questions use reader-derived IDs, not authored IDs');
 const state=await f.h.page.evaluate(()=>window.renderTransition);
 assert.deepEqual(state.submits,[2,3]);assert.equal(state.nexts,1);
 const old=f.snapshots.filter(row=>row.question.items.length===3);
 assert.ok(old.length>=2);
 assert.equal(new Set(old.map(row=>row.question.contentFingerprint)).size,1,'Only progress changed while the old content was mounted');
 assert.equal(typeof old[0].question.contentFingerprint,'string');
});

test('identical matching content with a genuinely new authored question ID still receives its own answer',async t=>{
 const f=await setup(t,{language:'en',identical:true}),end=await finish(f);
 assert.equal(end.kind,'complete',JSON.stringify({end,requests:f.requests,events:f.events}));
 assert.deepEqual(f.requests.map(q=>q.id),['question-2','question-3']);
 assert.equal(f.requests[0].text,f.requests[1].text);assert.deepEqual(f.requests[0].items,f.requests[1].items);
 const first=f.snapshots.find(row=>row.question.id==='question-2'),second=f.snapshots.find(row=>row.question.id==='question-3');
 assert.equal(typeof first.question.contentFingerprint,'string');
 assert.notEqual(first.question.contentFingerprint,second.question.contentFingerprint,'Authored question identity remains evidence');
 const state=await f.h.page.evaluate(()=>window.renderTransition);assert.deepEqual(state.submits,[2,3]);assert.equal(state.nexts,1);
});

test('a counter-only stalled Next stops within the existing wait without repeating Next or generating an old answer',async t=>{
 const f=await setup(t,{stall:true,fastClock:true}),end=await finish(f);
 assert.equal(end.kind,'review',JSON.stringify({end,requests:f.requests,events:f.events}));
 assert.match(end.message,/لم يكتمل الانتقال/);
 assert.equal(f.requests.length,1);
 const state=await f.h.page.evaluate(()=>window.renderTransition);assert.deepEqual(state.submits,[2]);assert.equal(state.nexts,1);
});

test('STOP while Next is waiting for new content prevents a later model request and submission',async t=>{
 const f=await setup(t,{renderDelay:900});await f.start();
 await f.h.page.waitForFunction(()=>window.renderTransition.nexts===1);
 assert.equal((await f.send({type:'STOP'})).ok,true);
 await f.h.page.waitForTimeout(1000);
 assert.equal(f.requests.length,1);
 const state=await f.h.page.evaluate(()=>window.renderTransition);assert.deepEqual(state.submits,[2]);assert.equal(state.nexts,1);
 assert.ok(f.events.some(event=>event.kind==='stopped'));
});
