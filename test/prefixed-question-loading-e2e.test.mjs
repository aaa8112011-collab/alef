import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {buildSync} from 'esbuild';
import {createAppServer} from '../server/index.mjs';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

// Actual React Select and the published Weaver lib- class contract, followed
// through the worker and an authenticated local server. Ollama/Chrome APIs are
// explicitly mocked; this verifies reading and interaction, not model accuracy.
const bundle=buildSync({entryPoints:[fileURLToPath(new URL('fixtures/react-select-library.jsx',import.meta.url))],
  bundle:true,write:false,format:'iife',platform:'browser',define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text;
const workerSource=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');

async function setup(t,language){
  const h=await createBrowserHarness();t.after(()=>h.close());
  // Optional baseline replay does not alter production files or require Git in
  // a downloaded project. The normal suite always uses the shipped reader.
  if(process.env.ALEF_PREFIX_TEST_CONTENT){
    const baseline=await readFile(process.env.ALEF_PREFIX_TEST_CONTENT,'utf8');
    await h.page.evaluate(()=>{window.__extensionListeners.length=0;delete window.__alefAssistantInstalled;});
    await h.page.addScriptTag({content:baseline});
  }
  await h.page.evaluate(language=>{
    document.documentElement.dir=language==='ar'?'rtl':'ltr';
    // Enter through a visible lesson step so the legacy reader has an already
    // connected subject before the published dropdown question is revealed.
    // This reproduces the reported in-run timeout, rather than stopping at
    // CONNECT just because the legacy reader cannot discover this question.
    document.body.innerHTML='<main id="player-container"><div data-testid="ncle-activity-page"><h2>Lesson introduction</h2><button id="intro-next">Next</button></div></main><div id="root" hidden></div>';
    document.querySelector('#intro-next').addEventListener('click',()=>{
      document.querySelector('main#player-container').remove();
      document.querySelector('#root').hidden=false;
    });
    history.replaceState(null,'','#/progress/ncle/class/published-fixture/lesson/aa-similarity/material/content');
    window.__reactSelectSettings={language};
  },language);
  await h.page.addScriptTag({content:bundle});
  await h.page.waitForFunction(()=>window.__realSelect?.ready);
  assert.equal(await h.page.locator('.lib-dropdown-container.lib-question-widget').count(),1,'Use the published lib- roots, not a test-only question marker');
  assert.equal(await h.page.locator('[data-alef-question],[data-question-id]').count(),0);
  assert.equal(await h.page.locator('[role="progressbar"]').count(),1,'The question keeps its persistent lesson progress indicator');

  const chats=[],snapshots=[],token='published-prefix-local-fixture-only';
  const app=createAppServer({provider:'ollama',model:'qwen3:8b',visionModel:'qwen3-vl:8b',pairingToken:token,
    requestTimeoutMs:10000,healthTimeoutMs:1500,fetchImpl:async(url,options={})=>{
      if(url.endsWith('/api/tags'))return Response.json({models:[{name:'qwen3:8b'},{name:'qwen3-vl:8b'}]});
      if(url.endsWith('/api/show'))return Response.json({capabilities:['completion','vision']});
      assert.ok(url.endsWith('/api/chat'),url);
      const chat=JSON.parse(options.body),question=JSON.parse(chat.messages[1].content).question;chats.push(chat);
      assert.equal(chat.model,'qwen3-vl:8b');assert.equal(question.type,'dropdowns');assert.equal(question.fields.length,2);
      assert.equal(question.requiresVision,true);assert.equal(chat.messages[1].images.length,1);
      assert.deepEqual(Buffer.from(chat.messages[1].images[0],'base64').subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
      for(const field of question.fields){
        assert.ok(question.text.includes(`[dropdown:${field.id}]`),question.text);
        const branch=chat.format.properties.selections.items.anyOf.find(row=>row.properties.fieldId.enum[0]===field.id);
        assert.ok(branch);assert.deepEqual(branch.properties.optionId.enum,field.options.map(option=>option.id));
      }
      const selections=question.fields.map(field=>({fieldId:field.id,optionId:field.options[0].id}));
      if(chats.length===2)selections.reverse();
      return Response.json({message:{content:JSON.stringify({optionIds:[],text:'',selections,confidence:.99,
        explanation:'Deterministic transport and interaction fixture, not geometry inference.'})}});
    }});
  await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise(resolve=>{app.close(resolve);app.closeAllConnections();}));
  const serverUrl=`http://127.0.0.1:${app.address().port}`,events=[],storage={};let listener,clock=Date.now();
  class WorkerClock extends Date {static now(){return clock;}}
  // Accelerate only worker readiness polling. React Select, canvas, focus,
  // portal closing and the content adapter all retain real browser timing.
  const workerTimeout=(callback,ms=0,...args)=>setTimeout(()=>{clock+=ms;callback(...args);},Math.min(ms,2));
  const chrome={runtime:{id:'fixture-extension',getURL:path=>'chrome-extension://fixture-extension/'+path,
    getPlatformInfo:async()=>({}),onMessage:{addListener(fn){listener=fn;}},sendMessage:async message=>events.push(structuredClone(message))},
    storage:{session:{get:async key=>({[key]:storage[key]}),set:async values=>Object.assign(storage,structuredClone(values)),remove:async key=>{delete storage[key];}}},
    tabs:{get:async()=>({id:1,url:h.page.url()}),sendMessage:async(_tab,message)=>{
      const result=await h.send(message);
      if(message.type==='ALEF_INSPECT')snapshots.push({stage:result.stage,loading:result.loading,needsPreparation:result.needsPreparation,
        question:result.question?structuredClone(result.question):null});
      return result;
    },onRemoved:{addListener(){}}},
    webNavigation:{getAllFrames:async()=>[{frameId:0,parentFrameId:-1,url:h.page.url(),documentId:'published-fixture-document'}]},
    scripting:{executeScript:async()=>{}},action:{onClicked:{addListener(){}}}};
  vm.runInNewContext(workerSource,{chrome,URL,AbortController,AbortSignal,DOMException,Date:WorkerClock,
    setTimeout:workerTimeout,clearTimeout,setInterval,clearInterval,fetch});
  const send=message=>new Promise((resolve,reject)=>{
    if(!listener({tabId:1,...message},{id:'fixture-extension',url:'chrome-extension://fixture-extension/dashboard.html'},resolve))reject(Error('Worker refused request'));
  });
  t.after(()=>send({type:'STOP'}));
  return {h,chats,events,snapshots,send,start:async()=>{
    const connected=await send({type:'CONNECT'});assert.equal(connected.ok,true,JSON.stringify(connected));
    const current=connected.subjects.find(subject=>subject.id==='current');assert.ok(current,JSON.stringify(connected));
    const started=await send({type:'START',subjectId:current.id,config:{serverUrl,token,qualityMode:true,verify:true,
      autoSubmit:true,skipInstruction:true,minConfidence:.85}});assert.equal(started.ok,true,JSON.stringify(started));
  }};
}

for(const language of ['ar','en'])test(`${language}: published lib- question roots with a persistent progress bar reach real dropdown submission instead of the 30-second loading timeout`,async t=>{
  const h=await setup(t,language);await h.start();
  const deadline=Date.now()+14000;
  while(!h.events.some(row=>['complete','review','error'].includes(row.event?.kind))){
    if(Date.now()>deadline)assert.fail(JSON.stringify(h.events));await new Promise(resolve=>setTimeout(resolve,20));
  }
  const terminal=h.events.find(row=>['complete','review','error'].includes(row.event?.kind)).event;
  assert.equal(terminal.kind,'complete',JSON.stringify({terminal:{kind:terminal.kind,message:terminal.message},
    chats:h.chats.length,stages:[...new Set(h.snapshots.map(row=>`${row.stage}:loading=${row.loading}:prepare=${row.needsPreparation}`))]}));
  assert.equal(h.chats.length,2,'The whole two-field question and figure reach independent visual verification');
  assert.ok(h.snapshots.some(snapshot=>snapshot.needsPreparation&&!snapshot.loading),'The visible lib- dropdowns are ready for preparation, not loading');
  assert.ok(h.snapshots.some(snapshot=>snapshot.question?.type==='dropdowns'&&!snapshot.loading));
  assert.equal(h.events.some(row=>row.event?.phase==='loading'||/30 ثانية|لم يكتمل تحميل/.test(row.event?.message||'')),false);
  assert.equal(h.events.filter(row=>row.event?.kind==='submitted').length,1);
  const state=await h.h.page.evaluate(()=>window.__realSelect);
  assert.deepEqual(state.changes.map(row=>row.field),[0,1]);
  assert.deepEqual(state.submissions,[[{id:1,text:'70°'},{id:1,text:language==='ar'?'متشابهان':'are similar'}]]);
  const pixel=h.chats[0].messages[1].images[0];assert.equal(h.chats[1].messages[1].images[0],pixel);
  assert.equal(JSON.stringify(h.events).includes(pixel),false);
});
