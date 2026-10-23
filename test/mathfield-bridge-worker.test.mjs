import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Chrome and inference are explicit protocol stubs here. The separate MathLive
// suite executes this exact MAIN function against the real custom element.
const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
const topURL='https://moe.alefed.com/#/progress/ncle/class/bridge/lesson/one/material/content';
const childURL='https://content.alefed.com/material/player.html#/question';
const target='5d472a00-b467-4fa4-8944-0985bbbe59d1';

function setup({frameId=0,documentId='top-document',permission=true,active=true}={}) {
  let listener,beforeFrames=null,beforeExecute=null,currentTopURL=topURL,resultDocument=documentId||'observed-document';
  let records=[{frameId:0,parentFrameId:-1,url:topURL,documentId:'top-document'},
    {frameId:7,parentFrameId:0,url:childURL,documentId:'child-document'}];
  const executions=[],requests=[];
  let result={ok:true,value:'\\frac{3}{2}',valid:true,disabled:false,readOnly:false};
  const sender={id:'bridge-test',tab:{id:1,url:topURL},frameId,url:frameId?childURL:topURL,...(documentId?{documentId}:{})};
  const chrome={
    runtime:{id:'bridge-test',getURL:path=>'chrome-extension://bridge-test/'+path,
      onMessage:{addListener(fn){listener=fn;}},sendMessage:async()=>{}},
    storage:{session:{get:async()=>({}),set:async()=>{}}},
    permissions:{contains:async()=>permission},
    webNavigation:{getAllFrames:async()=>{await beforeFrames?.();return records;}},
    tabs:{get:async()=>({id:1,url:currentTopURL}),onRemoved:{addListener(){}}},
    scripting:{executeScript:async request=>{
      executions.push(request);await beforeExecute?.();
      return [{frameId,documentId:resultDocument,result}];
    }},action:{onClicked:{addListener(){}}},
  };
  const context=vm.createContext({chrome,URL,AbortController,AbortSignal,DOMException,setTimeout,clearTimeout,setInterval,clearInterval,
    fetch:async(url,options={})=>{
      requests.push({url,...options});
      if(url.endsWith('/api/health'))return Response.json({ok:true,provider:'ollama',protocolVersion:3,capabilities:{mathField:true}});
      return Response.json({answer:{optionIds:[],text:'\\frac{3}{2}',confidence:.99,explanation:'Protocol fixture.'}});
    }});
  vm.runInContext(source,context);
  vm.runInContext(`globalThis.fixtureController=new AbortController();
    states.set(1,{page:{url:${JSON.stringify(topURL)}}});
    const fixtureRoutes=routeState(1);fixtureRoutes.active=${frameId};fixtureRoutes.injected.add(${frameId});
    ${active?'runs.set(1,fixtureController);':''}`,context);
  const message={type:'ALEF_MATH_FIELD',operation:'write',target,value:'\\frac{3}{2}',expectedURL:sender.url};
  const send=(input=message,origin=sender)=>new Promise(resolve=>{
    const accepted=listener(input,origin,value=>resolve(structuredClone(value)));
    if(!accepted)resolve({accepted:false});
  });
  return {context,sender,message,send,executions,requests,
    stop(){context.fixtureController.abort();},
    set records(value){records=value;},set beforeFrames(fn){beforeFrames=fn;},set beforeExecute(fn){beforeExecute=fn;},
    set result(value){result=value;},set resultDocument(value){resultDocument=value;},set topURL(value){currentTopURL=value;}};
}

test('the active top MathLive request executes only the fixed MAIN function in the sender document',async()=>{
  const h=setup();const response=await h.send();
  assert.deepEqual(response,{ok:true,value:'\\frac{3}{2}',valid:true,disabled:false,readOnly:false});
  assert.equal(h.executions.length,1);
  const execution=h.executions[0];
  assert.equal(execution.world,'MAIN');assert.equal(execution.func,h.context.mathFieldMain);
  assert.deepEqual(structuredClone(execution.target),{tabId:1,documentIds:['top-document']});
  assert.deepEqual(structuredClone(execution.args),['write',target,'\\frac{3}{2}',topURL]);
  assert.equal(JSON.stringify(execution).includes('token'),false);
});

test('an observed permitted child MathLive request stays in its active frame and document',async()=>{
  const h=setup({frameId:7,documentId:'child-document'});
  const response=await h.send({...h.message,operation:'read'});assert.equal(response.ok,true,JSON.stringify(response));
  assert.deepEqual(structuredClone(h.executions[0].target),{tabId:1,documentIds:['child-document']});
  assert.deepEqual(structuredClone(h.executions[0].args),['read',target,null,childURL]);
});

test('senders without document IDs still target exactly their verified frame',async()=>{
  const h=setup({documentId:null});assert.equal((await h.send()).ok,true);
  assert.deepEqual(structuredClone(h.executions[0].target),{tabId:1,frameIds:[0]});
});

test('external senders and extension dashboards cannot invoke the page MathLive bridge',async()=>{
  const h=setup();
  assert.deepEqual(await h.send(h.message,{...h.sender,id:'other-extension'}),{accepted:false});
  assert.deepEqual(await h.send(h.message,{...h.sender,url:'chrome-extension://bridge-test/dashboard.html'}),{accepted:false});
  assert.equal(h.executions.length,0);
});

for(const [label,change] of [
  ['an inactive tab',h=>({...h.sender,tab:{id:2,url:topURL}})],
  ['a different frame',h=>({...h.sender,frameId:7,url:childURL,documentId:'child-document'})],
  ['a stale document',h=>({...h.sender,documentId:'previous-document'})],
])test('the bridge rejects '+label+' before MAIN execution',async()=>{
  const h=setup(),sender=change(h);const response=await h.send({...h.message,expectedURL:sender.url},sender);
  assert.equal(response.ok,false,JSON.stringify(response));assert.equal(h.executions.length,0);
});

test('foreign frames and ungranted Alef content origins never receive a MathLive operation',async()=>{
  for(const foreign of [true,false]){
    const h=setup({frameId:7,documentId:'child-document',permission:false});
    const sender=foreign?{...h.sender,url:'https://foreign.example/editor'}:h.sender;
    const response=await h.send({...h.message,expectedURL:sender.url},sender);
    assert.equal(response.ok,false);assert.equal(h.executions.length,0);
  }
});

for(const [label,patch] of [
  ['selector text',{target:'math-field, input'}],
  ['an arbitrary operation',{operation:'executeCommand'}],
  ['a changed page',{expectedURL:topURL+'-different'}],
  ['an oversized value',{value:'x'.repeat(4097)}],
])test('the bridge refuses '+label+' without passing it to MAIN',async()=>{
  const h=setup();assert.equal((await h.send({...h.message,...patch})).ok,false);assert.equal(h.executions.length,0);
});

test('a stopped or superseded run cannot begin or finish a MathLive write',async()=>{
  const inactive=setup({active:false});assert.equal((await inactive.send()).ok,false);assert.equal(inactive.executions.length,0);
  const stopped=setup();stopped.stop();assert.equal((await stopped.send()).ok,false);assert.equal(stopped.executions.length,0);
  const pending=setup();pending.beforeFrames=()=>pending.stop();
  assert.equal((await pending.send()).ok,false);assert.equal(pending.executions.length,0);
  const dispatched=setup();dispatched.beforeExecute=()=>dispatched.stop();
  assert.equal((await dispatched.send()).ok,false);assert.equal(dispatched.executions.length,1,'An already dispatched mutation is never replayed');
});

test('a changed document or top origin during dispatch cannot acknowledge an answer',async()=>{
  const document=setup();document.beforeExecute=()=>{document.resultDocument='replacement-document';};
  assert.equal((await document.send()).ok,false);assert.equal(document.executions.length,1);
  const origin=setup();origin.beforeExecute=()=>{origin.topURL='https://foreign.example/';};
  assert.equal((await origin.send()).ok,false);assert.equal(origin.executions.length,1);
});

test('malformed or failed MAIN replies never turn into successful value acknowledgement',async()=>{
  for(const result of [{ok:false,error:'لم يكتمل تجهيز المحرر.'},{ok:true,value:'x'},
    {ok:true,value:'x'.repeat(4097),valid:true,disabled:false,readOnly:false}]){
    const h=setup();h.result=result;assert.equal((await h.send()).ok,false);assert.equal(h.executions.length,1);
  }
});

test('MathLive answers require the new backend capability and preserve their LaTeX format',async()=>{
  const h=setup(),signal=new AbortController().signal;
  const config={serverUrl:'http://127.0.0.1:4318',token:'protocol-only',verify:false,qualityMode:false};
  await h.context.checkMathFieldBackend(config,signal,false);
  assert.equal(config.backendHealth.capabilities.mathField,true);
  await assert.rejects(h.context.checkMathFieldBackend({...config,backendHealth:{ok:true,protocolVersion:3}},signal,false),/حدّث المشروع كاملًا/);
  await h.context.solve({id:'math-fixture',text:'Find the scale factor.',type:'text',options:[],answerFormat:'latex'},'Math',config,signal);
  const body=JSON.parse(h.requests.find(request=>request.url.endsWith('/api/solve')).body);
  assert.equal(body.question.answerFormat,'latex');
});
