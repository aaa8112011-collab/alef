import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {buildSync} from 'esbuild';
import {createAppServer} from '../server/index.mjs';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

// Real React, DOM reader, worker and authenticated HTTP server. Chrome APIs
// and numeric answers are explicit transport fixtures, not model inference.
const bundle=buildSync({stdin:{resolveDir:process.cwd(),loader:'jsx',contents:`
import React,{useState,useEffect,useRef} from 'react';
import {createRoot} from 'react-dom/client';
function Graph({index}){
 const ref=useRef(null);
 useEffect(()=>{
  const ctx=ref.current.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,260,180);
  ctx.fillStyle=index?'#dd5500':'#005adc';ctx.fillRect(20,20,40,40);
  ctx.strokeStyle='black';ctx.beginPath();ctx.moveTo(25,150);ctx.lineTo(220,25);ctx.lineTo(220,150);ctx.closePath();ctx.stroke();
 },[index]);
 return <canvas ref={ref} width="260" height="180" aria-label="Authored question diagram"/>;
}
function Lesson({language}){
 const ar=language==='ar',state=window.acceptedFeedbackE2E;
 const [index,setIndex]=useState(0),[value,setValue]=useState(''),[accepted,setAccepted]=useState(false),[complete,setComplete]=useState(false);
 useEffect(()=>{state.commits.push({index,value,accepted});state.ready=true;},[index,value,accepted]);
 if(complete)return <main><section data-alef-completed>Lesson completed</section></main>;
 const icon='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path d="M2 10l5 5 10-12" stroke="green" fill="none"/></svg>');
 return <main id="player-container"><div data-testid="ncle-activity-page-player">
  <style>{'.lib-option-icon{display:none;width:20px;height:20px}.lib-field-is-correct .lib-option-icon{display:inline-block}'}</style>
  <div data-testid="progress-bar-slide-count">{index?'4/5':'3/5'}</div>
  <section className="lib-fib-container lib-question-widget">
   <h2>{ar?'اكتب الإجابة الصحيحة.':'Type the correct answer(s).'}</h2>
   <p>{ar?(index?'أوجد قيمة ص باستخدام الرسم.':'أوجد قيمة س باستخدام الرسم.'):(index?'Find the value of y using the diagram.':'Find the value of x using the diagram.')}</p>
   <div className={'lib-fib-input-field-container'+(accepted?' lib-is-correct lib-field-is-correct':'')}>
    <span>{index?'y = ':'x = '}</span><input type="text" placeholder="Type..." value={value} disabled={accepted}
     onChange={event=>{state.changes.push({index,value:event.target.value});setValue(event.target.value);}}/>
    <img className="lib-option-icon lib-option-correct-icon" alt="incorrect icon" tabIndex={-1} src={icon}/>
   </div><Graph index={index}/>
  </section>
  {accepted?<><div data-testid="default-question-feedback-container">Awesome!</div><button onClick={()=>{
   state.nexts++;setValue('');setAccepted(false);setIndex(1);
  }}>Next</button></>:<button disabled={!value} onClick={()=>{
   state.submissions.push({index,value});if(index)setComplete(true);else setAccepted(true);
  }}>Submit Answer</button>}
 </div></main>;
}
window.mountAcceptedFeedbackE2E=language=>{
 window.acceptedFeedbackE2E={ready:false,commits:[],changes:[],submissions:[],nexts:0};
 document.documentElement.dir=language==='ar'?'rtl':'ltr';
 document.body.innerHTML='<main><button data-alef-subject="math">Math</button></main>';
 document.querySelector('button').onclick=()=>{
  history.replaceState(null,'','#/progress/ncle/class/accepted-feedback/lesson/one/material/content');
  document.body.innerHTML='<div id="accepted-feedback-root"></div>';
  createRoot(document.querySelector('#accepted-feedback-root')).render(<Lesson language={language}/>);
 };
};
`},bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text;

async function setup(t,language){
 const h=await createBrowserHarness();t.after(()=>h.close());
 await h.page.addScriptTag({content:bundle});
 await h.page.evaluate(language=>window.mountAcceptedFeedbackE2E(language),language);
 const chats=[],events=[],snapshots=[],token='accepted-feedback-e2e-fixture-token';
 const app=createAppServer({provider:'ollama',model:'qwen3:8b',visionModel:'qwen3-vl:8b',pairingToken:token,
  requestTimeoutMs:10000,healthTimeoutMs:1500,fetchImpl:async(url,options={})=>{
   if(url.endsWith('/api/tags'))return Response.json({models:[{name:'qwen3:8b'},{name:'qwen3-vl:8b'}]});
   if(url.endsWith('/api/show'))return Response.json({capabilities:['completion','vision']});
   assert.ok(url.endsWith('/api/chat'),url);
   const body=JSON.parse(options.body),question=JSON.parse(body.messages[1].content).question;chats.push(body);
   assert.equal(question.type,'text');assert.deepEqual(question.options,[]);
   assert.equal(body.model,'qwen3-vl:8b');assert.equal(body.messages[1].images.length,1,'The result icon must not become a second question image');
   const second=/قيمة ص|value of y/.test(question.text);
   return Response.json({message:{content:JSON.stringify({optionIds:[],text:second?'19/6':'17/6',confidence:.99,
    explanation:'Deterministic transport fixture only.'})}});
  }});
 await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve);});
 t.after(()=>new Promise(resolve=>{app.close(resolve);app.closeAllConnections();}));
 const serverUrl='http://127.0.0.1:'+app.address().port,storage={};let listener;
 const chrome={runtime:{id:'fixture-extension',getURL:path=>'chrome-extension://fixture-extension/'+path,
   getPlatformInfo:async()=>({}),onMessage:{addListener(fn){listener=fn;}},sendMessage:async message=>events.push(structuredClone(message))},
  storage:{session:{get:async key=>({[key]:storage[key]}),set:async values=>Object.assign(storage,structuredClone(values)),remove:async key=>{delete storage[key];}}},
  tabs:{get:async()=>({id:1,url:h.page.url()}),sendMessage:async(_id,message)=>{
   const result=await h.send(message);if(result?.question)snapshots.push({feedback:result.feedback,question:structuredClone(result.question)});return result;
  },onRemoved:{addListener(){}}},scripting:{executeScript:async()=>{}},action:{onClicked:{addListener(){}}}};
 vm.runInNewContext(await readFile(new URL('../extension/background.js',import.meta.url),'utf8'),
  {chrome,URL,AbortController,AbortSignal,DOMException,setTimeout,clearTimeout,setInterval,clearInterval,fetch});
 const send=message=>new Promise((resolve,reject)=>{
  if(!listener({tabId:1,...message},{id:'fixture-extension',url:'chrome-extension://fixture-extension/dashboard.html'},resolve))reject(Error('Worker refused '+message.type));
 });
 t.after(()=>send({type:'STOP'}));
 return {h,chats,events,snapshots,async start(){
  assert.equal((await send({type:'CONNECT'})).ok,true);
  const start=await send({type:'START',subjectId:'math',config:{serverUrl,token,qualityMode:false,verify:false,
   autoSubmit:true,skipInstruction:true,allowUncertain:true}});
  assert.equal(start.ok,true,JSON.stringify(start));
 }};
}

for(const language of ['ar','en'])test(`${language}: an accepted React FIB advances Next and solves only the genuinely new question`,async t=>{
 const f=await setup(t,language);await f.start();
 const deadline=Date.now()+14000;
 let end;
 while(!(end=f.events.find(row=>['complete','review','error'].includes(row.event?.kind))?.event)){
  if(Date.now()>deadline)assert.fail(JSON.stringify(f.events));
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 assert.equal(end.kind,'complete',JSON.stringify({end,chats:f.chats.length,events:f.events}));
 assert.equal(f.chats.length,2,'There must be one solve for each real question, without resolving the accepted field');
 const state=await f.h.page.evaluate(()=>window.acceptedFeedbackE2E);
 assert.deepEqual(state.submissions,[{index:0,value:'17/6'},{index:1,value:'19/6'}]);
 assert.deepEqual(state.changes,state.submissions);assert.equal(state.nexts,1);
 assert.ok(state.commits.some(commit=>commit.index===0&&commit.value==='17/6'&&commit.accepted));
 assert.ok(state.commits.some(commit=>commit.index===1&&commit.value==='19/6'));
 assert.equal(f.events.filter(row=>row.event?.kind==='submitted').length,2);
 const accepted=f.snapshots.find(row=>row.feedback==='correct'),before=f.snapshots.find(row=>row.question.type==='text');
 assert.ok(accepted);assert.equal(accepted.question.id,before.question.id);
 assert.equal(accepted.question.fingerprint,before.question.fingerprint);
 assert.deepEqual(accepted.question.visuals,before.question.visuals);assert.equal(accepted.question.visuals.length,1);
 const questions=f.chats.map(chat=>JSON.parse(chat.messages[1].content).question);
 assert.notEqual(questions[0].id,questions[1].id);
 for(const [index,chat] of f.chats.entries()){
  const image=chat.messages[1].images[0];
  const pixels=await f.h.page.evaluate(async data=>{
   const image=new Image();image.src='data:image/png;base64,'+data;await image.decode();
   const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
   const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
   return {width:canvas.width,height:canvas.height,color:[...ctx.getImageData(25,25,1,1).data]};
  },image);
  assert.deepEqual(pixels,{width:260,height:180,color:index?[221,85,0,255]:[0,90,220,255]});
  assert.equal(JSON.stringify(f.events).includes(image),false);
 }
});
