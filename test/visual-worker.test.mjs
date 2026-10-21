import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createAppServer} from '../server/index.mjs';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

async function setup(t,{language='en',oldServer=false,visionReady=true,broken=false}={}) {
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(async({language,broken})=>{
    const statement=language==='ar'?'الشكل أ′ب′ج′ هو تمدد للشكل أبج. اقرأ الرسم البياني وأوجد معامل التمدد.':'Figure A′B′C′ is a dilation of figure ABC. Read the graph and find the scale factor.';
    document.body.innerHTML='<button data-alef-subject="math">الرياضيات</button><main><section data-alef-question="graph-question"><h2 data-alef-question-text></h2><div id="drawing"></div><label data-alef-option="one"><input type="radio" name="answer" value="one">1.5</label><label data-alef-option="two"><input type="radio" name="answer" value="two">2</label><button data-alef-submit>Submit Answer</button></section></main>';
    document.querySelector('h2').textContent=statement;window.visualSubmissions=0;
    const canvas=document.createElement('canvas');canvas.width=240;canvas.height=160;
    const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,240,160);ctx.fillStyle='#0060dd';ctx.fillRect(20,20,60,60);ctx.fillStyle='black';ctx.font='16px sans-serif';ctx.fillText('E (2, 4)',100,40);ctx.fillText('E′ (3, 6)',100,70);
    if(broken){const image=new Image();image.width=240;image.height=160;image.alt='coordinate graph';image.src='data:image/png;base64,invalid';document.querySelector('#drawing').append(image);await new Promise(resolve=>{if(image.complete)resolve();else{image.onload=resolve;image.onerror=resolve;}});}
    else document.querySelector('#drawing').append(canvas);
    document.querySelector('[data-alef-submit]').onclick=()=>{window.visualSubmissions++;document.querySelector('main').innerHTML='<section data-alef-completed>Lesson completed</section>';};
  },{language,broken});
  const chats=[];let shown=0;
  const app=createAppServer({provider:'ollama',model:'qwen3:8b',visionModel:'qwen3-vl:8b',pairingToken:'test-visual-local-token',healthTimeoutMs:1500,requestTimeoutMs:10000,fetchImpl:async(url,options={})=>{
    if(url.endsWith('/api/tags'))return Response.json({models:[{name:'qwen3:8b'},{name:'qwen3-vl:8b'}]});
    if(url.endsWith('/api/show')){shown++;return Response.json({capabilities:visionReady?['completion','vision']:['completion']});}
    assert.ok(url.endsWith('/api/chat'),url);
    const body=JSON.parse(options.body);chats.push(body);
    assert.equal(body.model,'qwen3-vl:8b');
    assert.equal(body.messages[1].images.length,1);
    assert.ok(Buffer.from(body.messages[1].images[0],'base64').subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
    return Response.json({message:{content:JSON.stringify({optionIds:['one'],text:'',explanation:'اختبار نقل الصورة فقط؛ ليس استدلال نموذج حقيقي.',confidence:.99})}});
  }});
  await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise(resolve=>{app.close(resolve);app.closeAllConnections();}));
  const serverUrl=`http://127.0.0.1:${app.address().port}`;
  const events=[],storage={};let handler;
  const chrome={runtime:{id:'fixture-extension',getURL:path=>'chrome-extension://fixture-extension/'+path,getPlatformInfo:async()=>({}),onMessage:{addListener(fn){handler=fn;}},sendMessage:async message=>events.push(structuredClone(message))},
    storage:{session:{get:async key=>({[key]:storage[key]}),set:async items=>Object.assign(storage,structuredClone(items)),remove:async key=>{delete storage[key];}}},
    tabs:{get:async()=>({id:1,url:h.page.url()}),sendMessage:async(_id,message)=>h.send(message),create:async()=>{},onRemoved:{addListener(){}}},scripting:{executeScript:async()=>{}},action:{onClicked:{addListener(){}}}};
  vm.runInNewContext(await readFile(new URL('../extension/background.js',import.meta.url),'utf8'),{chrome,URL,AbortController,AbortSignal,DOMException,setTimeout,clearTimeout,setInterval,clearInterval,
    fetch:oldServer?async(url,options)=>{assert.ok(url.endsWith('/api/health'));assert.equal(options.method,undefined);return Response.json({ok:true,configured:true,provider:'ollama',model:'qwen3:8b',modelReady:true});}:fetch});
  const send=message=>new Promise((resolve,reject)=>{if(!handler({tabId:1,...message},{id:'fixture-extension',url:'chrome-extension://fixture-extension/dashboard.html'},resolve))reject(new Error('Rejected worker message.'));});
  t.after(()=>send({type:'STOP'}));
  return {h,chats,events,shown:()=>shown,send,start:async()=>{
    const connection=await send({type:'CONNECT'});assert.equal(connection.ok,true,JSON.stringify(connection));
    const start=await send({type:'START',subjectId:'math',config:{serverUrl,token:'test-visual-local-token',qualityMode:true,verify:false,autoSubmit:true}});assert.equal(start.ok,true,JSON.stringify(start));
  }};
}
async function terminal(h){
  const end=Date.now()+12000;
  for(;;){const event=h.events.find(row=>['complete','review','error'].includes(row.event?.kind))?.event;if(event)return event;if(Date.now()>end)assert.fail(JSON.stringify(h.events));await new Promise(resolve=>setTimeout(resolve,30));}
}

for(const language of ['ar','en'])test(`${language} text and real graph pixels travel together through worker, authenticated server and both visual verification calls`,async t=>{
  const h=await setup(t,{language});await h.start();
  const event=await terminal(h);assert.equal(event.kind,'complete',JSON.stringify(event));
  assert.equal(h.chats.length,2,'Accuracy mode verifies independently even if a stale verify flag was false');
  assert.ok(h.shown()>0,'Vision capability must be checked, not inferred from the model name');
  for(const chat of h.chats){const sent=JSON.parse(chat.messages[1].content);assert.match(sent.question.text,language==='ar'?/معامل التمدد/:/scale factor/);assert.equal(sent.question.requiresVision,true);assert.equal(sent.question.images,undefined,'Images belong in Ollama images, not duplicated into text');}
  const image=h.chats[0].messages[1].images[0];
  assert.equal(h.chats[1].messages[1].images[0],image);
  assert.equal(await h.h.page.evaluate(()=>window.visualSubmissions),1);
  assert.equal(JSON.stringify(h.events).includes(image),false,'Large pixel data must not persist in UI events');
});

for(const [name,options,reason] of [
  ['outdated text-only backend',{oldServer:true},/قديمة/],
  ['model that does not actually support images',{visionReady:false},/الرؤية|بصري|للصور/],
  ['unreadable required graph',{broken:true},/صورة|صور|رسم/],
])test(`${name} stops before any solve or automatic submission`,async t=>{
  const h=await setup(t,options);await h.start();const event=await terminal(h);
  assert.ok(['review','error'].includes(event.kind),JSON.stringify(event));assert.match(event.message,reason);
  assert.equal(h.chats.length,0);assert.equal(await h.h.page.evaluate(()=>window.visualSubmissions),0);
});
