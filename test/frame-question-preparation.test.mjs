import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Explicit Chrome/provider protocol stubs: this exercises worker routing and
// readiness, while the DOM and actual interaction libraries have separate tests.
const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
const origin='https://moe.alefed.com';
const url=origin+'/#/progress/ncle/class/preparation/lesson/one';
const childURL=origin+'/embedded-loading-material';
const question={id:'top-dropdowns',fingerprint:'top-dropdowns-original',type:'dropdowns',
  text:'أكمل العبارة: العدد [dropdown:number] والعلاقة [dropdown:relation].',options:[],fields:[
    {id:'number',text:'العدد',options:[{id:'two',text:'٢'},{id:'three',text:'٣'}]},
    {id:'relation',text:'العلاقة',options:[{id:'equal',text:'متساويان'},{id:'other',text:'مختلفان'}]},
  ]};
function setup(t,{topReady=true}={}) {
  let handler,clock=0,mode='unprepared',childInspections=0;
  const events=[],preparations=[],applications=[],requests=[];
  const top=()=>({ok:true,page:{url},subjects:[{id:'math',name:'الرياضيات'}],lessons:[],navigation:[],
    stage:mode==='complete'?'complete':topReady?'question':'instruction',completed:mode==='complete',
    loading:!topReady,fingerprint:'top-'+mode,
    question:mode==='prepared'?structuredClone(question):null,
    needsPreparation:topReady&&mode==='unprepared',
    frames:[{url:childURL,parentURL:origin+'/',required:true,kind:'url',loading:true}]});
  const child=()=>({ok:true,page:{url:childURL},stage:'instruction',question:null,needsPreparation:false,
    completed:false,loading:true,fingerprint:'child-loading',frames:[],navigation:[],diagnostics:[]});
  const content=async(message,target={frameId:0})=>{
    if(['ALEF_SCAN','ALEF_INSPECT'].includes(message.type)) {
      if(target.frameId===7){childInspections++;return child();}
      return top();
    }
    if(['ALEF_BEGIN','ALEF_SELECT_SUBJECT','ALEF_CANCEL'].includes(message.type))return {ok:true};
    if(message.type==='ALEF_PREPARE_QUESTION') {
      assert.equal(target.frameId,0,'The ready inline fields belong to the top document');
      assert.equal(mode,'unprepared');preparations.push(target.frameId);mode='prepared';
      return {ok:true,question:structuredClone(question)};
    }
    if(message.type==='ALEF_APPLY') {
      assert.equal(target.frameId,0,'The loading child must not receive the top answer');
      assert.equal(mode,'prepared');assert.equal(message.questionId,question.id);
      assert.equal(message.questionFingerprint,question.fingerprint);
      applications.push(structuredClone(message.answer));mode='complete';
      return {ok:true,applied:true,submitted:true};
    }
    throw Error('Unexpected '+message.type);
  };
  class Clock extends Date {static now(){return clock;}}
  const chrome={
    runtime:{id:'preparation-test',getURL:path=>'chrome-extension://preparation-test/'+path,getPlatformInfo:async()=>({}),
      onMessage:{addListener(fn){handler=fn;}},sendMessage:async({event})=>events.push(structuredClone(event))},
    tabs:{get:async()=>({id:1,url}),sendMessage:async(_tab,message,target)=>content(message,target),onRemoved:{addListener(){}}},
    scripting:{executeScript:async()=>{}},
    webNavigation:{getAllFrames:async()=>[
      {frameId:0,parentFrameId:-1,url,documentId:'top-document'},
      {frameId:7,parentFrameId:0,url:childURL,documentId:'loading-child-document'},
    ]},storage:{session:{get:async()=>({}),set:async()=>{}}},action:{onClicked:{addListener(){}}},
  };
  vm.runInNewContext(source,{chrome,URL,AbortController,AbortSignal,DOMException,Date:Clock,
    setTimeout:(fn,ms)=>setTimeout(()=>{clock+=ms;fn();},1),clearTimeout,setInterval,clearInterval,
    fetch:async(endpoint,options={})=>{
      if(endpoint.endsWith('/api/health'))return Response.json({ok:true,configured:true,provider:'ollama',
        modelReady:true,protocolVersion:3,capabilities:{multiDropdown:true}});
      assert.ok(endpoint.endsWith('/api/solve'));requests.push(JSON.parse(options.body));
      return Response.json({answer:{optionIds:[],text:'',confidence:.99,explanation:'Protocol fixture only.',
        selections:[{fieldId:'number',optionId:'two'},{fieldId:'relation',optionId:'equal'}]},verified:false,needsReview:false});
    }});
  const send=message=>new Promise(resolve=>handler({tabId:1,...message},
    {id:'preparation-test',url:'chrome-extension://preparation-test/dashboard.html'},resolve));
  t.after(()=>send({type:'STOP'}));
  return {events,preparations,applications,requests,get childInspections(){return childInspections;},get elapsed(){return clock;},
    async run(){
      assert.equal((await send({type:'CONNECT'})).ok,true);
      const started=await send({type:'START',subjectId:'math',config:{serverUrl:'http://127.0.0.1:4318',
        token:'preparation-protocol-fixture-only',qualityMode:false,verify:false,autoSubmit:true,skipInstruction:true}});
      assert.equal(started.ok,true,JSON.stringify(started));
      const end=Date.now()+6000;
      for(;;){
        const terminal=events.find(event=>['complete','error','review'].includes(event.kind));
        if(terminal)return terminal;
        if(Date.now()>end)assert.fail(JSON.stringify(events));
        await new Promise(resolve=>setTimeout(resolve,5));
      }
    }};
}

test('top-level dropdowns awaiting preparation keep their document when a child still reports loading',async t=>{
  const h=setup(t),result=await h.run();
  assert.equal(result.kind,'complete',JSON.stringify(result));
  assert.deepEqual(h.preparations,[0]);assert.equal(h.requests.length,1);assert.equal(h.applications.length,1);
  assert.deepEqual(h.requests[0].question.fields,question.fields);
  assert.equal(h.childInspections,0,'A ready top question does not transfer its work to a different document');
  assert.equal(h.events.some(event=>event.phase==='loading'),false);
});

test('an actually empty top player still waits for its required loading child and never fabricates a ready question',async t=>{
  const h=setup(t,{topReady:false}),result=await h.run();
  assert.equal(result.kind,'review');assert.match(result.message,/30 ثانية/);
  assert.ok(h.childInspections>0);assert.ok(h.elapsed>=30000&&h.elapsed<31000);
  assert.deepEqual(h.preparations,[]);assert.deepEqual(h.requests,[]);assert.deepEqual(h.applications,[]);
  assert.equal(h.events.some(event=>event.kind==='complete'),false);
});
