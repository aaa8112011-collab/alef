import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Chrome's sender URL describes its script context; SPA navigation can retain
// that URL while the current frame URL changes. Explicit Chrome stubs below
// preserve that distinction. Actual MathLive interaction has a separate suite.
const source=await readFile(process.env.ALEF_MATH_SENDER_SOURCE||new URL('../extension/background.js',import.meta.url),'utf8');
const currentTop='https://moe.alefed.com/#/progress/ncle/class/sender-fixture/lesson/current/material/content';
const currentChild='https://content.alefed.com/player.html#/questions/current';
const target='1bcce333-f446-4a40-a03e-7a0aa1ca989d';

function setup({frameId=0,senderURL='https://moe.alefed.com/#/classes/sender-fixture?tab=forYou',documentId='top-document'}={}){
  let listener,beforeExecute=null,replyDocument=documentId||'top-document';
  const expectedURL=frameId?currentChild:currentTop,executions=[];
  let records=[{frameId:0,parentFrameId:-1,url:currentTop,documentId:'top-document'},
    {frameId:7,parentFrameId:0,url:currentChild,documentId:'child-document'}];
  const sender={id:'sender-url-test',tab:{id:1,url:currentTop},frameId,url:senderURL,...(documentId?{documentId}:{})};
  const chrome={runtime:{id:'sender-url-test',getURL:path=>'chrome-extension://sender-url-test/'+path,
    onMessage:{addListener(fn){listener=fn;}},sendMessage:async()=>{}},
    storage:{session:{get:async()=>({}),set:async()=>{}}},
    permissions:{contains:async()=>true},
    tabs:{get:async()=>({id:1,url:currentTop}),onRemoved:{addListener(){}}},
    webNavigation:{getAllFrames:async()=>records},
    scripting:{executeScript:async request=>{
      executions.push(request);await beforeExecute?.();
      return [{frameId,documentId:replyDocument,result:{ok:true,value:'\\frac{7}{4}',valid:true,disabled:false,readOnly:false}}];
    }},action:{onClicked:{addListener(){}}}};
  const context=vm.createContext({chrome,URL,AbortController,AbortSignal,DOMException,setTimeout,clearTimeout,setInterval,clearInterval});
  vm.runInContext(source,context);
  vm.runInContext(`globalThis.senderURLController=new AbortController();
    states.set(1,{page:{url:${JSON.stringify(currentTop)}}});
    runs.set(1,senderURLController);
    const routes=routeState(1);routes.active=${frameId};routes.injected.add(${frameId});`,context);
  const send=(patch={},from=sender)=>new Promise(resolve=>{
    const message={type:'ALEF_MATH_FIELD',operation:'write',target,value:'\\frac{7}{4}',expectedURL,...patch};
    const accepted=listener(message,from,value=>resolve(structuredClone(value)));
    if(!accepted)resolve({accepted:false});
  });
  return {send,sender,executions,context,expectedURL,
    set records(value){records=value;},set beforeExecute(fn){beforeExecute=fn;},set replyDocument(value){replyDocument=value;}};
}

for(const [label,senderURL] of [
  ['old hash','https://moe.alefed.com/#/classes/sender-fixture?tab=forYou'],
  ['old path','https://moe.alefed.com/earlier-shell#/classes/sender-fixture'],
])for(const operation of ['write','read'])test(`MathLive ${operation} accepts a cached sender ${label} in the same verified live document`,async()=>{
  const h=setup({senderURL}),result=await h.send({operation});
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.value,'\\frac{7}{4}');
  assert.equal(h.executions.length,1);
  const execution=h.executions[0];
  assert.equal(execution.world,'MAIN');assert.equal(execution.func,h.context.mathFieldMain);
  assert.deepEqual(structuredClone(execution.target),{tabId:1,documentIds:['top-document']});
  assert.deepEqual(structuredClone(execution.args),[operation,target,operation==='write'?'\\frac{7}{4}':null,currentTop]);
});

test('a permitted child uses its current URL and document rather than its initial sender fragment',async()=>{
  const h=setup({frameId:7,documentId:'child-document',senderURL:'https://content.alefed.com/player.html#/introduction'});
  const result=await h.send({operation:'read'});assert.equal(result.ok,true,JSON.stringify(result));
  assert.deepEqual(structuredClone(h.executions[0].target),{tabId:1,documentIds:['child-document']});
  assert.equal(h.executions[0].args[3],currentChild);
});

test('a sender URL with a different origin cannot borrow the current document ID',async()=>{
  const h=setup({senderURL:'https://foreign.example/#/classes/sender-fixture'});
  assert.equal((await h.send()).ok,false);assert.equal(h.executions.length,0);
});

test('a stale sender route without a document ID is refused',async()=>{
  const h=setup({documentId:null});assert.equal((await h.send()).ok,false);assert.equal(h.executions.length,0);
});

test('a current exact sender URL without a document ID retains the existing frame-targeted contract',async()=>{
  const h=setup({documentId:null,senderURL:currentTop});assert.equal((await h.send()).ok,true);
  assert.deepEqual(structuredClone(h.executions[0].target),{tabId:1,frameIds:[0]});
});

test('the current frame record must still match the request URL exactly',async()=>{
  const h=setup();h.records=[{frameId:0,parentFrameId:-1,url:currentTop+'-changed',documentId:'top-document'}];
  assert.equal((await h.send()).ok,false);assert.equal(h.executions.length,0);
});

test('a cached sender route with a replaced document is rejected before any write',async()=>{
  const h=setup({documentId:'previous-document'});assert.equal((await h.send()).ok,false);assert.equal(h.executions.length,0);
});

for(const [label,patch] of [
  ['sender credentials',{senderURL:'https://user:pass@moe.alefed.com/#/classes/sender-fixture'}],
  ['request credentials',{expectedURL:'https://user:pass@moe.alefed.com/#/progress/ncle/class/sender-fixture/lesson/current/material/content'}],
])test(`MathLive does not normalize away ${label}`,async()=>{
  const h=setup(patch.senderURL?{senderURL:patch.senderURL}:{});
  assert.equal((await h.send(patch.expectedURL?{expectedURL:patch.expectedURL}:{})).ok,false);
  assert.equal(h.executions.length,0);
});

test('a document replacement during execution cannot acknowledge the previous MathLive answer',async()=>{
  const h=setup();h.beforeExecute=()=>{h.replyDocument='replacement-document';};
  assert.equal((await h.send()).ok,false);assert.equal(h.executions.length,1,'An already dispatched write must not be replayed');
});
