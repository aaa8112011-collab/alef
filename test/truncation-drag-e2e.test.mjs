import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {buildSync} from 'esbuild';
import {createAppServer} from '../server/index.mjs';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

// Real React/DndKit controls, reader, worker and authenticated HTTP server.
// Chrome APIs and generation replies are explicit stubs. The selected labels
// exercise original-ID transport, not a model's knowledge of a live lesson.
const bundle=buildSync({stdin:{resolveDir:process.cwd(),loader:'jsx',contents:`
import React,{useState,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {DndContext,MouseSensor,useSensor,useSensors,useDraggable,useDroppable,pointerWithin} from '@dnd-kit/core';
const placeholder='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect x="3" y="3" width="15" height="15" fill="none" stroke="black"/><path d="M12 12l8 4-4 1-1 4z"/></svg>');
function Word({word,selected}){
 const {attributes,listeners,setNodeRef,isDragging}=useDraggable({id:word.id,disabled:selected});
 return <div ref={setNodeRef} {...attributes} {...listeners}
  onMouseDown={event=>{window.truncationDrag.downs.push({id:word.id,at:performance.now()});listeners?.onMouseDown?.(event);}}
  className={'lib-dnd-options-draggable'+(isDragging?' lib-is-dragging':'')+(selected?' lib-is-selected':'')}
  style={{display:'inline-block',border:'1px solid #555',padding:12,margin:5}}>{word.text}</div>;
}
function Blank({index,word}){
 const {setNodeRef,isOver}=useDroppable({id:'droppable-'+index});
 return <span ref={setNodeRef} id={'droppable-'+index} data-index={index}
  className={'lib-dnd-droppable'+(isOver?' lib-is-about-to-drop':'')+(word?' lib-is-selected':'')}
  style={{display:'block',width:250,height:58,border:'1px dashed #777',margin:12}}>
  {word?<span className="lib-selected-option">{word.text}</span>:<span className="lib-placeholder-wrapper"><img className="lib-drop-placeholder-icon" src={placeholder} width="24" height="24" alt=""/></span>}
 </span>;
}
function Question({language}){
 const ar=language==='ar',state=window.truncationDrag;
 const [answers,setAnswers]=useState({}),[complete,setComplete]=useState(false);
 const labels=ar?['الأولى','الثانية','الثالثة','الرابعة','الخامسة','السادسة','السابعة']:['first','second','third','fourth','fifth','sixth','seventh'];
 const words=labels.map((text,index)=>({id:'fixture-word-'+index,text}));
 const sensors=useSensors(useSensor(MouseSensor,{activationConstraint:{delay:1000,tolerance:5}}));
 useEffect(()=>{state.answers=answers;state.ready=true;},[answers]);
 if(complete)return <main><section data-alef-completed>Lesson completed</section></main>;
 return <DndContext sensors={sensors} collisionDetection={pointerWithin}
  onDragStart={({active})=>state.starts.push({id:active.id,at:performance.now()})}
  onDragEnd={({active,over})=>{
   state.ends.push({id:active.id,blank:over?.id||null,at:performance.now()});
   if(over)setAnswers({...answers,[over.id]:words.find(word=>word.id===active.id)});
  }}>
  <main id="player-container"><div data-testid="assessment-content-player">
   <div data-testid="progress-bar-slide-count">1/5</div>
   <section className="lib-dnd-container lib-question-widget">
    <h2 data-testid="question-statement-container">{ar?'اسحب مصطلحين إلى الفراغين المناسبين من الكلمات السبع.':'Drag two terms into the appropriate blanks from the seven words.'}</h2>
    <div className="lib-template-container">{[0,1].map(index=><Blank key={index} index={index} word={answers['droppable-'+index]}/>)}</div>
    <div className="lib-dnd-options-wrapper">{words.map(word=><Word key={word.id} word={word} selected={Object.values(answers).some(answer=>answer.id===word.id)}/>)}</div>
    <button data-alef-submit disabled={Object.keys(answers).length!==2} onClick={()=>{
     state.submitted.push(answers);state.submitTimes.push(performance.now());setComplete(true);
    }}>{ar?'أرسل إجابتي':'Submit Answer'}</button>
   </section>
  </div></main>
 </DndContext>;
}
window.mountTruncationDrag=language=>{
 window.truncationDrag={answers:{},downs:[],starts:[],ends:[],submitted:[],submitTimes:[],ready:false};
 document.documentElement.dir=language==='ar'?'rtl':'ltr';
 document.body.innerHTML='<main><button data-alef-subject="language">Language</button></main>';
 document.querySelector('button').onclick=()=>{
  history.replaceState(null,'','#/progress/ncle/class/truncation-drag/lesson/one/material/content');
  document.body.innerHTML='<div id="truncation-drag-root"></div>';
  createRoot(document.querySelector('#truncation-drag-root')).render(<Question language={language}/>);
 };
};
`},bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text;

async function setup(t,{language='ar',repeatTruncation=false}={}){
 const h=await createBrowserHarness();t.after(()=>h.close());
 await h.page.addScriptTag({content:bundle});
 await h.page.evaluate(language=>window.mountTruncationDrag(language),language);
 const chats=[],events=[],snapshots=[],solves=[],token='truncation-drag-fixture-token';
 const app=createAppServer({provider:'ollama',model:'qwen3:8b',visionModel:'qwen3-vl:8b',pairingToken:token,
  requestTimeoutMs:15000,healthTimeoutMs:1500,fetchImpl:async(url,options={})=>{
   if(url.endsWith('/api/tags'))return Response.json({models:[{name:'qwen3:8b'},{name:'qwen3-vl:8b'}]});
   if(url.endsWith('/api/show'))return Response.json({capabilities:['completion','vision']});
   assert.ok(url.endsWith('/api/chat'),url);
   const chat=JSON.parse(options.body),question=JSON.parse(chat.messages[1].content).question;chats.push(chat);
   assert.equal(chat.model,'qwen3:8b','A blank placeholder icon is not authored visual evidence');
   assert.equal(chat.messages[1].images,undefined);assert.notEqual(question.requiresVision,true);
   assert.equal(question.type,'matching');assert.equal(question.items.length,2);assert.equal(question.targets.length,7);
   if(chats.length===1||repeatTruncation)return Response.json({done:true,done_reason:'length',message:{content:'{"optionIds":[],"text":"","matches":[{"itemId":"DO_NOT_COPY_TRUNCATED_MARKER"'}});
   const desired=language==='ar'?['الثانية','السادسة']:['second','sixth'];
   const matches=question.items.map((item,index)=>({itemId:item.id,targetId:question.targets.find(target=>target.text===desired[index]).id}));
   return Response.json({done:true,done_reason:'stop',message:{content:JSON.stringify({optionIds:[],text:'',matches,
    explanation:'اختبار نقل ربط الكلمات فقط.',confidence:chats.length===2?.97:.94})}});
  }});
 await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve);});
 t.after(()=>new Promise(resolve=>{app.close(resolve);app.closeAllConnections();}));
 const serverUrl=`http://127.0.0.1:${app.address().port}`,storage={};let listener;
 const chrome={runtime:{id:'fixture-extension',getURL:path=>'chrome-extension://fixture-extension/'+path,
  getPlatformInfo:async()=>({}),onMessage:{addListener(fn){listener=fn;}},sendMessage:async message=>events.push(structuredClone(message))},
  storage:{session:{get:async key=>({[key]:storage[key]}),set:async values=>Object.assign(storage,structuredClone(values)),remove:async key=>{delete storage[key];}}},
  tabs:{get:async()=>({id:1,url:h.page.url()}),sendMessage:async(_id,message)=>{
   const result=await h.send(message);if(result?.question)snapshots.push(structuredClone(result.question));return result;
  },onRemoved:{addListener(){}}},scripting:{executeScript:async()=>{}},action:{onClicked:{addListener(){}}}};
 const trackingFetch=async(url,options={})=>{
  const response=await fetch(url,options);
  if(String(url).endsWith('/api/solve'))solves.push(await response.clone().json());
  return response;
 };
 vm.runInNewContext(await readFile(new URL('../extension/background.js',import.meta.url),'utf8'),
  {chrome,URL,AbortController,AbortSignal,DOMException,setTimeout,clearTimeout,setInterval,clearInterval,fetch:trackingFetch});
 const send=message=>new Promise((resolve,reject)=>{
  if(!listener({tabId:1,...message},{id:'fixture-extension',url:'chrome-extension://fixture-extension/dashboard.html'},resolve))reject(Error('Worker refused '+message.type));
 });
 t.after(()=>send({type:'STOP'}));
 return {h,chats,events,snapshots,solves,send,async start(){
  assert.equal((await send({type:'CONNECT'})).ok,true);
  const start=await send({type:'START',subjectId:'language',config:{serverUrl,token,qualityMode:true,verify:true,autoSubmit:true,skipInstruction:true,allowUncertain:true}});
  assert.equal(start.ok,true,JSON.stringify(start));
 }};
}
async function terminal(f){
 const deadline=Date.now()+22000;
 for(;;){
  const end=f.events.find(row=>['complete','review','error'].includes(row.event?.kind))?.event;
  if(end)return end;
  if(Date.now()>deadline)assert.fail(JSON.stringify(f.events));
  await new Promise(resolve=>setTimeout(resolve,25));
 }
}

for(const language of ['ar','en'])test(`${language}: a truncated text-only seven-choice matching answer recovers once then completes two real held drags`,async t=>{
 const f=await setup(t,{language});await f.start();const end=await terminal(f);
 assert.equal(end.kind,'complete',JSON.stringify({end,chats:f.chats.length,solves:f.solves}));
 assert.equal(f.chats.length,3,'One truncated pass, one complete recovery and one independent verifier');
 assert.equal(f.chats[0].think,true);assert.equal(f.chats[1].think,false);assert.equal(f.chats[2].think,false);
 assert.match(f.chats[2].messages[0].content,/Solve independently/);
 const evidence=f.chats[0].messages[1].content;
 for(const chat of f.chats){
  assert.equal(chat.messages.length,2);assert.equal(chat.messages[1].content,evidence);
  assert.equal(JSON.stringify(chat.messages).includes('DO_NOT_COPY_TRUNCATED_MARKER'),false);
 }
 const initial=f.snapshots.find(question=>question.type==='matching');
 assert.equal(initial.items.length,2);assert.equal(initial.targets.length,7);
 assert.notEqual(initial.requiresVision,true);assert.equal(initial.visuals,undefined);
 const state=await f.h.page.evaluate(()=>window.truncationDrag);
 assert.deepEqual(state.ends.map(row=>[row.id,row.blank]),[['fixture-word-1','droppable-0'],['fixture-word-5','droppable-1']]);
 assert.equal(state.downs.length,2);assert.equal(state.starts.length,2);assert.equal(state.submitted.length,1);
 for(let index=0;index<2;index++)assert.ok(state.ends[index].at-state.downs[index].at>=1000,'The real MouseSensor must receive a one-second held drag');
 assert.equal(state.submitted[0]['droppable-0'].id,'fixture-word-1');assert.equal(state.submitted[0]['droppable-1'].id,'fixture-word-5');
 assert.ok(state.submitTimes[0]-state.ends[1].at>=50,'Submission must follow the real DndKit click-guard cleanup');
 assert.equal(f.events.filter(row=>row.event?.kind==='submitted').length,1);
 assert.equal(f.solves.length,1);assert.equal(f.solves[0].verified,true);assert.equal(f.solves[0].answer.confidence,.94);
});

test('repeated truncation of the Arabic matching answer cannot drag or submit a partial mapping',async t=>{
 const f=await setup(t,{repeatTruncation:true});await f.start();const end=await terminal(f);
 assert.equal(end.kind,'error',JSON.stringify({end,chats:f.chats.length,solves:f.solves}));
 assert.match(end.message,/حد خرج النموذج|مبتورة/);assert.equal(f.chats.length,2,'Only one additional generation is allowed');
 const state=await f.h.page.evaluate(()=>window.truncationDrag);
 assert.deepEqual(state.downs,[]);assert.deepEqual(state.starts,[]);assert.deepEqual(state.ends,[]);assert.deepEqual(state.submitted,[]);
 assert.equal(f.events.some(row=>row.event?.kind==='submitted'),false);
});
