import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Deterministic worker protocol test. Chrome APIs and inference are simulated;
// another suite verifies cross-origin DOM and the content-script interaction.
async function harness(t) {
  let listener, topURL='https://moe.alefed.com/#/progress/ncle/class/guard-class/lesson/one/material/first';
  let childURL='https://content.alefed.com/lesson/player.html#/first',documentId='child-document-one';
  let applied=false,releaseSolve;
  const gate=new Promise(resolve=>{releaseSolve=resolve});
  const events=[],messages=[],storage={};
  const question={id:'same-id',fingerprint:'same-question',text:'What is 2 + 2?',type:'single',options:[{id:'a',text:'3'},{id:'b',text:'4'}]};
  const topSnapshot=()=>({ok:true,page:{url:topURL,title:'Arabic lesson'},subjects:[{id:'current',name:'اللغة العربية'}],
    lessons:[],question:null,stage:applied?'complete':'instruction',completed:applied,loading:false,navigation:[],fingerprint:'top-question',
    frames:applied?[]:[{url:'https://content.alefed.com/lesson/player.html',origin:'https://content.alefed.com',initiatorOrigin:'https://moe.alefed.com',kind:'url',required:true,accessible:false}]});
  const records=()=>[{frameId:0,parentFrameId:-1,url:topURL,documentId:'top-document'},
    {frameId:7,parentFrameId:0,url:childURL,documentId,errorOccurred:false}];
  const chrome={
    runtime:{id:'guard-test',getURL:path=>'chrome-extension://guard-test/'+path,getPlatformInfo:async()=>({}),onMessage:{addListener(fn){listener=fn}},sendMessage:async message=>events.push(structuredClone(message.event))},
    storage:{session:{get:async key=>({[key]:storage[key]}),set:async values=>Object.assign(storage,structuredClone(values)),remove:async key=>{delete storage[key]}}},
    permissions:{contains:async()=>true},
    webNavigation:{getAllFrames:async()=>records()},
    scripting:{executeScript:async()=>{}},
    tabs:{get:async()=>({id:1,url:topURL}),sendMessage:async(_tab,message,options)=>{
      const target=options?.frameId??0;messages.push({type:message.type,target,options:structuredClone(options)});
      if(message.type==='ALEF_CANCEL'||message.type==='ALEF_BEGIN'||message.type==='ALEF_SELECT_SUBJECT')return {ok:true};
      if(target===0&&['ALEF_SCAN','ALEF_INSPECT'].includes(message.type))return topSnapshot();
      if(target===7&&message.type==='ALEF_INSPECT')return {ok:true,page:{url:childURL,title:'Embedded player'},stage:'question',completed:false,loading:false,question:structuredClone(question),fingerprint:'child-snapshot',navigation:[],frames:[]};
      if(target===7&&message.type==='ALEF_GET_QUESTION')return {ok:true,question:structuredClone(question)};
      if(target===7&&message.type==='ALEF_APPLY'){applied=true;return {ok:true,applied:true,submitted:true};}
      throw Error('Unexpected worker message '+message.type+' to '+target);
    },create:async()=>{},onRemoved:{addListener(){}}},
    action:{onClicked:{addListener(){}}},
  };
  let solveStarted=false;
  vm.runInNewContext(await readFile(new URL('../extension/background.js',import.meta.url),'utf8'),{
    chrome,URL,AbortController,AbortSignal,DOMException,setTimeout,clearTimeout,setInterval,clearInterval,
    fetch:async(url,options)=>{
      if(url.endsWith('/api/health'))return Response.json({ok:true,configured:true,provider:'ollama',modelReady:true,protocolVersion:3,visionReady:true});
      assert.ok(url.endsWith('/api/solve'));assert.equal(JSON.parse(options.body).question.id,'same-id');solveStarted=true;
      await gate;
      return Response.json({answer:{optionIds:['b'],text:'',explanation:'Protocol fixture.',confidence:.99},verified:false,needsReview:false});
    },
  },{filename:'frame-context-worker.js'});
  const send=message=>new Promise((resolve,reject)=>{
    if(!listener({tabId:1,...message},{id:'guard-test',url:'chrome-extension://guard-test/dashboard.html'},result=>resolve(structuredClone(result))))reject(Error('Worker rejected '+message.type));
  });
  t.after(()=>send({type:'STOP'}));
  async function waitFor(predicate,timeout=6000){const end=Date.now()+timeout;while(!predicate()){if(Date.now()>end)assert.fail(JSON.stringify({events,messages}));await new Promise(resolve=>setTimeout(resolve,15));}}
  const connection=await send({type:'CONNECT'});assert.equal(connection.ok,true,JSON.stringify(connection));
  const started=await send({type:'START',subjectId:'current',config:{serverUrl:'http://127.0.0.1:4318',token:'guard-fixture',verify:false,qualityMode:false,autoSubmit:true,skipInstruction:true}});
  assert.equal(started.ok,true,JSON.stringify(started));await waitFor(()=>solveStarted);
  return {events,messages,releaseSolve,changeDocument(){documentId='child-document-two'},changeTopLesson(){topURL=topURL.replace('/lesson/one/','/lesson/two/')},changeChildRoute(){childURL='https://content.alefed.com/lesson/player.html#/different-lesson'},
    get applied(){return applied},async terminal(){await waitFor(()=>events.some(event=>['complete','error','review'].includes(event.kind)));return events.find(event=>['complete','error','review'].includes(event.kind))}};
}

for(const [label,mutate] of [
  ['a new child document at the same URL',h=>h.changeDocument()],
  ['a different top lesson in the same class',h=>h.changeTopLesson()],
  ['a different lesson route within the same child document',h=>h.changeChildRoute()],
])test('a delayed answer is rejected after '+label+' even when question identity is identical',async t=>{
  const h=await harness(t);mutate(h);h.releaseSolve();const terminal=await h.terminal();
  assert.equal(h.applied,false,JSON.stringify({terminal,messages:h.messages}));
  assert.equal(h.messages.some(message=>message.type==='ALEF_APPLY'),false,'A stale answer must not be sent to any frame');
  assert.ok(['review','error'].includes(terminal.kind),JSON.stringify(terminal));
});

test('an unchanged child question applies to the captured frame and document',async t=>{
  const h=await harness(t);h.releaseSolve();const terminal=await h.terminal();
  assert.equal(terminal.kind,'complete',JSON.stringify(terminal));assert.equal(h.applied,true);
  const apply=h.messages.find(message=>message.type==='ALEF_APPLY');assert.ok(apply);
  assert.equal(apply.target,7);assert.equal(apply.options.documentId,'child-document-one');
});
