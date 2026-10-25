import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {buildSync} from 'esbuild';
import {createAppServer} from '../server/index.mjs';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

// Actual React controls, DOM reader, worker and authenticated HTTP server.
// Chrome APIs and model answers are explicit stubs: 4.2 is a transport fixture,
// not an inference result or a hard-coded answer to the user's live question.
const bundle=buildSync({stdin:{resolveDir:process.cwd(),loader:'jsx',contents:`
import React,{useState,useEffect,useRef} from 'react';
import {createRoot} from 'react-dom/client';
function Graph({stage}){
 const ref=useRef(null);
 useEffect(()=>{
  const canvas=ref.current,ctx=canvas.getContext('2d');
  ctx.fillStyle='white';ctx.fillRect(0,0,260,180);
  ctx.fillStyle=stage==='text'?'#005adc':'#dd5500';ctx.fillRect(20,20,36,36);
  ctx.strokeStyle='black';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(20,155);ctx.lineTo(220,25);ctx.lineTo(220,155);ctx.closePath();ctx.stroke();
  ctx.font='16px sans-serif';ctx.fillStyle='black';ctx.fillText(stage==='text'?'fixture B':'fixture A',75,65);
 },[stage]);
 return <canvas ref={ref} width="260" height="180" aria-label="Authored transport diagram"/>;
}
function Lesson({language}){
 const ar=language==='ar',state=window.textAnswerE2E;
 const [stage,setStage]=useState('dropdowns'),[values,setValues]=useState(['','']),[value,setValue]=useState('');
 const [answered,setAnswered]=useState(false);
 useEffect(()=>{state.stage=stage;state.value=value;state.commits.push({stage,value});state.ready=true;},[stage,value]);
 if(stage==='complete')return <main><section data-alef-completed>Lesson completed</section></main>;
 const dropdown=stage==='dropdowns';
 return <main id="player-container"><div data-testid="ncle-activity-page-player">
  <div data-testid="progress-bar-slide-count">{dropdown?'2/5':'3/5'}</div>
  <section className={(dropdown?'lib-dropdown-container':'lib-fib-container')+' lib-question-widget'}>
   <h2>{dropdown?(ar?'اختر من القائمتين.':'Choose the options from both drop-down lists.'):(ar?'اكتب الإجابة الصحيحة.':'Type the correct answer(s).')}</h2>
   {dropdown?<p>{ar?'القيمة الأولى':'First value'} <select name="first" value={values[0]} disabled={answered} onChange={event=>setValues([event.target.value,values[1]])}><option value="">Select...</option><option value="initial-alpha">alpha</option><option value="initial-beta">beta</option></select> {ar?'والقيمة الثانية':'and second value'} <select name="second" value={values[1]} disabled={answered} onChange={event=>setValues([values[0],event.target.value])}><option value="">Select...</option><option value="initial-gamma">gamma</option><option value="initial-delta">delta</option></select>.</p>
    :<><p>{ar?'اقرأ الرسم وأوجد قيمة س.':'Read the diagram and find the value of x.'}</p><p>x = <input type="text" placeholder="Type..." aria-label={ar?'الإجابة':'Answer'} value={value} onChange={event=>{state.changes.push(event.target.value);setValue(event.target.value);}}/></p></>}
   <Graph stage={stage}/>
  </section>
  {answered?<><p data-testid="correct-answer-feedback">Correct answer</p><button onClick={()=>{state.nexts++;setAnswered(false);setStage('text');}}>Next</button></>
   :<button data-alef-submit disabled={dropdown?values.some(item=>!item):!value} onClick={()=>{
    if(dropdown){state.dropdownSubmissions.push([...values]);setAnswered(true);}
    else{state.submissions.push(value);setStage('complete');}
   }}>Submit Answer</button>}
 </div></main>;
}
window.mountTextAnswerE2E=language=>{
 window.textAnswerE2E={stage:'subject',value:'',changes:[],commits:[],submissions:[],dropdownSubmissions:[],nexts:0,ready:false};
 document.documentElement.dir=language==='ar'?'rtl':'ltr';
 document.body.innerHTML='<main><button data-alef-subject="math">Math</button></main>';
 document.querySelector('button').onclick=()=>{
  history.replaceState(null,'','#/progress/ncle/class/text-contract/lesson/one/material/content');
  document.body.innerHTML='<div id="text-answer-react-root"></div>';
  createRoot(document.querySelector('#text-answer-react-root')).render(<Lesson language={language}/>);
 };
};
`},bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text;

async function setup(t,{language='en',invalidRepair=false}={}){
 const h=await createBrowserHarness();t.after(()=>h.close());
 await h.page.addScriptTag({content:bundle});
 await h.page.evaluate(language=>window.mountTextAnswerE2E(language),language);
 const chats=[],snapshots=[],events=[],solves=[],token='text-answer-e2e-fixture-token';
 let textCalls=0;
 const app=createAppServer({provider:'ollama',model:'qwen3:8b',visionModel:'qwen3-vl:8b',pairingToken:token,
  requestTimeoutMs:10000,healthTimeoutMs:1500,fetchImpl:async(url,options={})=>{
   if(url.endsWith('/api/tags'))return Response.json({models:[{name:'qwen3:8b'},{name:'qwen3-vl:8b'}]});
   if(url.endsWith('/api/show'))return Response.json({capabilities:['completion','vision']});
   assert.ok(url.endsWith('/api/chat'),url);
   const body=JSON.parse(options.body),question=JSON.parse(body.messages[1].content).question;chats.push(body);
   assert.equal(body.model,'qwen3-vl:8b');assert.equal(body.messages[1].images.length,1);
   const answer={optionIds:[],text:'',confidence:.99,explanation:'Deterministic response-format transport fixture.'};
   if(question.type==='dropdowns')answer.selections=question.fields.map(field=>({fieldId:field.id,optionId:field.options[0].id}));
   else{
    assert.equal(question.type,'text');assert.deepEqual(question.options,[]);assert.equal(question.fields,undefined);
    textCalls++;
    const repair=body.messages.some(message=>message.role==='system'&&message.content.includes('Correct only the response format'));
    if(textCalls===1||repair&&invalidRepair)answer.optionIds=['4.2'];
    else answer.text='4.2';
   }
   return Response.json({message:{content:JSON.stringify(answer)}});
  }});
 await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve);});
 t.after(()=>new Promise(resolve=>{app.close(resolve);app.closeAllConnections();}));
 const serverUrl=`http://127.0.0.1:${app.address().port}`,storage={};let listener;
 const chrome={runtime:{id:'fixture-extension',getURL:path=>'chrome-extension://fixture-extension/'+path,
  getPlatformInfo:async()=>({}),onMessage:{addListener(fn){listener=fn;}},sendMessage:async message=>events.push(structuredClone(message))},
  storage:{session:{get:async key=>({[key]:storage[key]}),set:async values=>Object.assign(storage,structuredClone(values)),remove:async key=>{delete storage[key];}}},
  tabs:{get:async()=>({id:1,url:h.page.url()}),sendMessage:async(_id,message)=>{const result=await h.send(message);if(result?.question)snapshots.push(structuredClone(result.question));return result;},onRemoved:{addListener(){}}},
  scripting:{executeScript:async()=>{}},action:{onClicked:{addListener(){}}}};
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
 return {h,chats,snapshots,events,solves,send,async start(){
  assert.equal((await send({type:'CONNECT'})).ok,true);
  const start=await send({type:'START',subjectId:'math',config:{serverUrl,token,qualityMode:true,verify:true,autoSubmit:true,skipInstruction:true,allowUncertain:true}});
  assert.equal(start.ok,true,JSON.stringify(start));
 }};
}
async function terminal(f){
 const deadline=Date.now()+18000;
 for(;;){
  const end=f.events.find(row=>['complete','review','error'].includes(row.event?.kind))?.event;
  if(end)return end;
  if(Date.now()>deadline)assert.fail(JSON.stringify(f.events));
  await new Promise(resolve=>setTimeout(resolve,25));
 }
}
function textChats(f){return f.chats.filter(chat=>JSON.parse(chat.messages[1].content).question.type==='text');}
async function assertTransition(f){
 const types=f.snapshots.map(question=>question.type);
 assert.ok(types.includes('dropdowns'));assert.ok(types.includes('text'));
 const before=f.snapshots.find(question=>question.type==='dropdowns'),after=f.snapshots.find(question=>question.type==='text');
 assert.notEqual(before.fingerprint,after.fingerprint);assert.deepEqual(after.options,[]);assert.equal(after.fields,undefined);
 assert.equal(after.requiresVision,true);assert.equal(after.visuals.length,1);
 const state=await f.h.page.evaluate(()=>window.textAnswerE2E);
 assert.deepEqual(state.dropdownSubmissions,[['initial-alpha','initial-gamma']]);assert.equal(state.nexts,1);
 const calls=textChats(f),image=calls[0].messages[1].images[0];
 for(const call of calls){
  assert.equal(call.messages[1].images[0],image,'The same complete graph must reach solving, repair and independent verification');
  const question=JSON.parse(call.messages[1].content).question;
  assert.deepEqual(question.options,[]);assert.equal(question.fields,undefined);
  assert.equal(call.format.properties.optionIds.maxItems,0);
  assert.equal(JSON.stringify(question).includes('initial-alpha'),false);
 }
 const colors=await f.h.page.evaluate(async data=>{
  const image=new Image();image.src='data:image/png;base64,'+data;await image.decode();
  const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
  const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return [...ctx.getImageData(25,25,1,1).data];
 },image);
 assert.deepEqual(colors,[0,90,220,255],'The text graph must replace the preceding orange dropdown graph');
 assert.equal(JSON.stringify(f.events).includes(image),false);
 return {state,calls};
}

for(const language of ['ar','en'])test(`${language}: dropdown to React writing with a graph repairs one malformed text response before one committed submission`,async t=>{
 const f=await setup(t,{language});await f.start();const end=await terminal(f);
 assert.equal(end.kind,'complete',JSON.stringify({end,chats:f.chats.length,solves:f.solves}));
 const {state,calls}=await assertTransition(f);
 assert.equal(calls.length,3,'Exactly one repair and one independent verification follow the invalid text response');
 assert.equal(calls[1].messages.some(message=>message.role==='system'&&message.content.includes('Correct only the response format')),true);
 assert.equal(calls[2].messages.some(message=>message.role==='system'&&message.content.includes('Correct only the response format')),false);
 assert.match(calls[2].messages[0].content,/Solve independently from the original evidence/);
 assert.equal(calls[2].messages[1].content,calls[0].messages[1].content,'Independent verification receives the original question, not the first answer');
 assert.deepEqual(state.changes,['4.2']);assert.deepEqual(state.submissions,['4.2']);
 assert.ok(state.commits.some(commit=>commit.stage==='text'&&commit.value==='4.2'));
 assert.equal(f.events.filter(row=>row.event?.kind==='submitted'&&row.event.question?.type==='text').length,1);
 assert.equal(f.solves.at(-1).verified,true);assert.equal(f.solves.at(-1).answer.text,'4.2');
});

for(const language of ['ar','en'])test(`${language}: a still-invalid text repair stops before changing the React input or submitting`,async t=>{
 const f=await setup(t,{language,invalidRepair:true});await f.start();const end=await terminal(f);
 assert.equal(end.kind,'review',JSON.stringify({end,chats:f.chats.length,solves:f.solves}));
 const {state,calls}=await assertTransition(f);
 assert.equal(calls.length,2,'A failed repair must stop without another repair or a verifier request');
 assert.equal(f.solves.at(-1).reason,'invalid_text_answer');
 assert.equal(state.value,'');assert.deepEqual(state.changes,[]);assert.deepEqual(state.submissions,[]);
 assert.equal(state.stage,'text');
 assert.equal(f.events.filter(row=>row.event?.kind==='submitted'&&row.event.question?.type==='text').length,0);
});
