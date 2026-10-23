import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {buildSync} from 'esbuild';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

// Real MathLive0.110.0 and React18, with the actual content script in a CDP
// isolated world. Chrome messaging/injection is explicitly simulated using
// the fixed production MAIN function, not a replacement editor implementation.
const bundle=buildSync({entryPoints:[fileURLToPath(new URL('fixtures/mathlive-writing.jsx',import.meta.url))],
  bundle:true,write:false,format:'iife',platform:'browser',define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text;

async function mainBridgeSource(){
  const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
  const noop={addListener(){}};
  const context={chrome:{runtime:{id:'fixture-extension',getURL:path=>'chrome-extension://fixture-extension/'+path,onMessage:noop},
    action:{onClicked:noop},tabs:{onRemoved:noop},storage:{}},URL,AbortController,AbortSignal,DOMException,setTimeout,clearTimeout,setInterval,clearInterval};
  vm.createContext(context);vm.runInContext(source,context);
  assert.equal(typeof context.mathFieldMain,'function','Use the fixed production bridge, not a test substitute');
  return context.mathFieldMain.toString();
}

async function setup(t,settings={}){
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.addScriptTag({content:bundle});
  await h.page.evaluate(settings=>window.mountMathLive(settings),settings);
  await h.page.waitForFunction(()=>window.realMathLive?.ready&&typeof document.querySelector('math-field')?.setValue==='function');
  assert.equal(await h.page.locator('[data-alef-question],[data-question-id]').count(),0);
  const cdp=await h.page.context().newCDPSession(h.page),frame=(await cdp.send('Page.getFrameTree')).frameTree.frame;
  const {executionContextId:contextId}=await cdp.send('Page.createIsolatedWorld',{frameId:frame.id,worldName:'alef-math-test-isolated'});
  await cdp.send('Runtime.addBinding',{name:'__mathFixtureBridge',executionContextId:contextId});
  const requests=[];
  let bridge;
  cdp.on('Runtime.bindingCalled',async event=>{
    if(event.name!=='__mathFixtureBridge'||event.executionContextId!==contextId)return;
    const {id,message}=JSON.parse(event.payload);requests.push(structuredClone(message));
    let result;
    try{
      assert.equal(message.type,'ALEF_MATH_FIELD');
      bridge??=await mainBridgeSource();
      result=await h.page.evaluate(({source,message})=>(0,eval)('('+source+')')(message.operation,message.target,message.value,message.expectedURL),{source:bridge,message});
    }catch(error){result={ok:false,error:error.message};}
    await cdp.send('Runtime.evaluate',{contextId,expression:`window.__mathFixtureReplies.get(${id})(${JSON.stringify(result)});window.__mathFixtureReplies.delete(${id});`}).catch(()=>{});
  });
  const evaluate=async(expression,{awaitPromise=true}={})=>{
    const result=await cdp.send('Runtime.evaluate',{contextId,expression,awaitPromise,returnByValue:true});
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
    return result.result.value;
  };
  await evaluate(`(()=>{
    window.__extensionListeners=[];window.__mathFixtureReplies=new Map();let sequence=0;
    window.chrome={runtime:{id:'fixture-extension',onMessage:{addListener:fn=>window.__extensionListeners.push(fn)},
      sendMessage:message=>new Promise(resolve=>{const id=++sequence;window.__mathFixtureReplies.set(id,resolve);window.__mathFixtureBridge(JSON.stringify({id,message}));})}};
    window.__dispatchIsolated=message=>new Promise((resolve,reject)=>{
      const listener=window.__extensionListeners[0];if(!listener)return reject(Error('No isolated content handler'));
      const returned=listener(message,{id:'fixture-extension',tab:{id:1}},resolve);
      if(returned&&typeof returned.then==='function')returned.then(resolve,reject);
      else if(returned!==true)reject(Error('Isolated content handler refused '+message.type));
    });
  })()`);
  const content=process.env.ALEF_MATH_TEST_CONTENT?await readFile(process.env.ALEF_MATH_TEST_CONTENT,'utf8'):h.contentScript;
  await evaluate(content);
  const send=message=>evaluate(`window.__dispatchIsolated(${JSON.stringify(message)})`);
  return {h,send,requests,evaluate,async read(){
    const result=await send({type:'ALEF_GET_QUESTION'});assert.equal(result.ok,true,JSON.stringify(result));
    assert.equal(result.question.type,'text');assert.equal(result.question.answerFormat,'latex');return result.question;
  },async apply(question,text,autoSubmit=true){return send({type:'ALEF_APPLY',questionId:question.id,questionFingerprint:question.fingerprint,
    answer:{optionIds:[],text,confidence:.99,explanation:'Actual editor interaction fixture, not model inference.'},autoSubmit});}};
}

test('MathLive API is truly absent from the isolated DOM wrapper while available in MAIN',async t=>{
  const f=await setup(t);
  assert.deepEqual(await f.evaluate(`({valueType:typeof document.querySelector('math-field').value,setterType:typeof document.querySelector('math-field').setValue})`),
    {valueType:'undefined',setterType:'undefined'});
  assert.equal(await f.h.page.evaluate(()=>typeof document.querySelector('math-field').setValue),'function');
  assert.equal(await f.h.page.evaluate(()=>window.realMathLive.version),'0.110.0');
});

for(const language of ['ar','en'])test(`${language}: isolated reader writes a fraction through real MathLive and commits one React submission`,async t=>{
  const f=await setup(t,{language}),question=await f.read();
  assert.match(question.text,language==='ar'?/معامل القياس/:/scale factor/);
  assert.equal(question.requiresVision,undefined,'Editor rendering is not a question figure');
  const before=await f.send({type:'ALEF_INSPECT'});assert.equal(before.loading,false);assert.equal(before.stage,'question');
  const result=await f.apply(question,'\\frac{3}{2}');assert.equal(result.submitted,true,JSON.stringify(result));
  const state=await f.h.page.evaluate(()=>window.realMathLive);
  assert.deepEqual(state.changes,['\\frac{3}{2}']);assert.deepEqual(state.submitted,['\\frac{3}{2}']);
  assert.equal((await f.read()).fingerprint,question.fingerprint,'Typed editor display must not change question identity');
  assert.equal(f.requests.filter(request=>request.operation==='write').length,1);
  assert.ok(f.requests.some(request=>request.operation==='read'));
});

for(const [name,text,expected] of [['Arabic decimal','١٫٥','1.5'],['algebraic expression','x^{2}+1','x^{2}+1']])test(`${name} reaches actual MathLive without editing its internal keyboard sink`,async t=>{
  const f=await setup(t,{language:'ar'}),question=await f.read(),result=await f.apply(question,text);
  assert.equal(result.submitted,true,JSON.stringify(result));
  assert.deepEqual(await f.h.page.evaluate(()=>window.realMathLive.submitted),[expected]);
});

for(const mode of ['remount','delayed'])test(`real MathLive ${mode} retains the committed answer before Submit`,async t=>{
  const f=await setup(t,{mode}),question=await f.read(),result=await f.apply(question,'1.5');
  assert.equal(result.submitted,true,JSON.stringify(result));
  const state=await f.h.page.evaluate(()=>window.realMathLive);assert.deepEqual(state.submitted,['1.5']);assert.equal(state.value,'1.5');
});

test('a real MathLive field reset by the application never submits a stale answer',async t=>{
  const f=await setup(t,{mode:'reject'}),question=await f.read(),result=await f.apply(question,'1.5');
  assert.equal(result.ok,false,JSON.stringify(result));
  assert.deepEqual(await f.h.page.evaluate(()=>window.realMathLive.submitted),[]);
});

test('cancelling after the real MathLive write prevents submission and removes the temporary target',async t=>{
  const f=await setup(t),question=await f.read(),pending=f.apply(question,'1.5');
  await f.h.page.waitForFunction(()=>window.realMathLive.changes.length===1);
  await f.send({type:'ALEF_CANCEL'});
  const result=await pending;assert.equal(result.ok,false,JSON.stringify(result));
  assert.deepEqual(await f.h.page.evaluate(()=>window.realMathLive.submitted),[]);
  assert.equal(f.requests.filter(request=>request.operation==='write').length,1);
  assert.equal(await f.h.page.locator('[data-alef-math-target]').count(),0);
});

test('a late real MathLive reset after initial stability cannot submit when the delayed button becomes ready',async t=>{
  const f=await setup(t,{mode:'late-reset'}),question=await f.read(),result=await f.apply(question,'1.5');
  assert.equal(result.submitted,false,JSON.stringify(result));assert.ok(result.reason,JSON.stringify(result));
  const state=await f.h.page.evaluate(()=>window.realMathLive);
  assert.equal(state.lateReset,true);assert.equal(state.submitReady,true);
  assert.equal(state.value,'');assert.deepEqual(state.submitted,[]);
  assert.equal(await f.h.page.locator('[data-alef-math-target]').count(),0);
});

for(const settings of [{readOnly:true},{disabled:true}])test(`real MathLive ${Object.keys(settings)[0]} field receives no write or submission`,async t=>{
  const f=await setup(t,settings),question=await f.read(),result=await f.apply(question,'1.5');
  assert.equal(result.ok,false,JSON.stringify(result));
  assert.deepEqual(await f.h.page.evaluate(()=>window.realMathLive.changes),[]);
  assert.deepEqual(await f.h.page.evaluate(()=>window.realMathLive.submitted),[]);
});

test('multiple MathLive blanks remain unsupported without partially writing either editor',async t=>{
  const f=await setup(t,{multiple:true}),result=await f.send({type:'ALEF_GET_QUESTION'});
  assert.equal(result.ok,false,JSON.stringify(result));
  assert.deepEqual(await f.h.page.evaluate(()=>window.realMathLive.changes),[]);
  assert.equal(f.requests.filter(request=>request.operation==='write').length,0);
});
