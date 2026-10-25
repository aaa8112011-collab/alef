import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Chrome privileges and pixel decoding are explicit protocol stubs. The
// companion browser suite tests the production crop against actual pixels.
const worker=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
const bridge=await readFile(new URL('../extension/visual-bridge.js',import.meta.url),'utf8');
const topURL='https://moe.alefed.com/#/progress/ncle/class/auto-visual/lesson/current';
const asset='https://file-delivery.alefed.com/files/auto-fixture.png';
const target='15568af8-cde7-49fa-a6fb-005492366fd2';
const fullShot='data:image/png;base64,PRIVATE_FULL_VIEWPORT';
const cropped={data:'RElBR1JBTV9DUk9Q',mimeType:'image/png',width:320,height:220};

function setup({permission=false,initialActive=2,updateMode='normal'}={}){
  let listener,activeId=initialActive,windowId=8,previousWindowId=8,windowState='normal',recordDocument='bound-document',top=topURL;
  let acknowledgedBoundActivation=false,paintReady=true,restorationAcknowledgements=0;
  let beforeInspect=null,beforeQuery=null,beforeUpdate=null,beforeCapture=null,previousClosed=false;
  let geometry={ok:true,kind:'image',source:asset,rect:{x:100,y:80,width:320,height:220},
    viewport:{width:1280,height:720,scale:1,x:0,y:0},fullyVisible:true};
  const activationListeners=new Set(),updates=[],captures=[],crops=[],fetches=[],queries=[],focusCalls=[];
  const timers=new Set();
  const activate=id=>{
    activeId=id;
    if(id===1)acknowledgedBoundActivation=true;
    if(id===2)restorationAcknowledgements++;
    for(const fn of [...activationListeners])fn({tabId:id,windowId});
  };
  const tab=id=>({id,url:id===1?top:'https://unrelated.example/context',windowId:id===2?previousWindowId:windowId,active:activeId===id});
  const chrome={runtime:{id:'auto-visual-test',getURL:path=>'chrome-extension://auto-visual-test/'+path,
      onMessage:{addListener(fn){listener=fn;}},sendMessage:async()=>{}},
    storage:{session:{get:async()=>({}),set:async()=>{}}},permissions:{contains:async()=>permission},
    tabs:{
      get:async id=>{if(id===2&&previousClosed)throw Error('Previous tab closed');return tab(id);},
      query:async query=>{queries.push(structuredClone(query));await beforeQuery?.(query);return [tab(activeId)];},
      update:async(id,options)=>{
        updates.push({id,options:structuredClone(options)});await beforeUpdate?.(id,options);
        assert.deepEqual(structuredClone(options),{active:true},'Selection must not navigate a tab or add unrelated tab mutations');
        if(id===2&&previousClosed)throw Error('Previous tab closed');
        if(id===1&&updateMode==='denied')throw Error('Selection denied');
        if(id===1&&updateMode==='no-change')return tab(id);
        activeId=id;
        if(id===1&&updateMode==='delayed-event'){
          const timer=setTimeout(()=>{timers.delete(timer);activate(id);},25);timers.add(timer);
        }else if(id===2&&updateMode==='delayed-restore'){
          // Longer than the screenshot quota interval: an early queue release
          // would otherwise be masked by the existing 550ms capture spacing.
          const timer=setTimeout(()=>{timers.delete(timer);activate(id);},650);timers.add(timer);
        }else if(updateMode!=='no-event'||id!==1)activate(id);
        return tab(id);
      },
      captureVisibleTab:async(id,options)=>{
        assert.ok(initialActive===1||acknowledgedBoundActivation,'Automatic selection must acknowledge its own activation before capturing');
        captures.push({id,options:structuredClone(options),activeId});
        await beforeCapture?.();return fullShot;
      },
      onRemoved:{addListener(){}},
      onActivated:{addListener(fn){activationListeners.add(fn);},removeListener(fn){activationListeners.delete(fn);}},
    },
    windows:{get:async id=>({id,state:windowState,type:'normal',focused:false}),
      update:async(...args)=>{focusCalls.push(args);throw Error('Window focus must remain untouched');}},
    webNavigation:{getAllFrames:async()=>[{frameId:0,parentFrameId:-1,url:top,documentId:recordDocument}]},
    scripting:{executeScript:async request=>{
      await beforeInspect?.(request);
      if(request.func?.name==='waitVisualPaint')return [{frameId:0,documentId:recordDocument,result:{ok:paintReady}}];
      return [{frameId:0,documentId:recordDocument,result:structuredClone(geometry)}];
    }},action:{onClicked:{addListener(){}}}};
  const context=vm.createContext({chrome,URL,AbortController,AbortSignal,DOMException,Blob,Response,Uint8Array,
    Date,setTimeout,clearTimeout,setInterval,clearInterval,
    fetch:async(url,options)=>{fetches.push({url,credentials:options.credentials});return new Response(new Uint8Array([137,80,78,71]),{headers:{'content-type':'image/png'}});}});
  vm.runInContext(worker,context);vm.runInContext(bridge,context);
  vm.runInContext(`globalThis.autoVisualController=new AbortController();
    states.set(1,{page:{url:${JSON.stringify(topURL)}}});runs.set(1,autoVisualController);
    const routes=routeState(1);routes.active=0;routes.injected.add(0);`,context);
  context.rasterizeVisualBlob=async()=>cropped;
  context.cropVisualCapture=async(raw,proof)=>{crops.push({raw,proof:structuredClone(proof)});return cropped;};
  const sender={id:'auto-visual-test',tab:tab(1),frameId:0,documentId:'bound-document',url:topURL};
  const message={type:'ALEF_CAPTURE_VISUAL',target,expectedURL:topURL,kind:'image',source:asset};
  return {updates,captures,crops,fetches,queries,focusCalls,context,activate,
    get activeId(){return activeId;},get geometry(){return geometry;},set geometry(value){geometry=value;},
    get restorationAcknowledgements(){return restorationAcknowledgements;},
    set beforeInspect(fn){beforeInspect=fn;},set beforeQuery(fn){beforeQuery=fn;},
    set beforeUpdate(fn){beforeUpdate=fn;},set beforeCapture(fn){beforeCapture=fn;},
    set recordDocument(value){recordDocument=value;},set topURL(value){top=value;},set windowId(value){windowId=value;},
    set previousClosed(value){previousClosed=value;},
    set previousWindowId(value){previousWindowId=value;},set windowState(value){windowState=value;},
    set paintReady(value){paintReady=value;},
    stop(){context.autoVisualController.abort();},
    close(){for(const timer of timers)clearTimeout(timer);},
    send(){return new Promise(resolve=>{const accepted=listener(message,sender,value=>resolve(structuredClone(value)));if(!accepted)resolve({accepted:false});});},
  };
}

test('inactive bound Alef selection captures only its crop and restores the prior tab without focusing a window',async t=>{
  const h=setup();t.after(()=>h.close());const result=await h.send();
  assert.deepEqual(result,{ok:true,...cropped,method:'visible-crop'});
  assert.deepEqual(h.updates,[{id:1,options:{active:true}},{id:2,options:{active:true}}]);
  assert.deepEqual(h.captures,[{id:8,options:{format:'png'},activeId:1}]);
  assert.equal(h.activeId,2);assert.deepEqual(h.focusCalls,[]);
  assert.equal(h.crops.length,1);assert.equal(h.crops[0].raw,fullShot);
  assert.equal(JSON.stringify(result).includes('PRIVATE_FULL_VIEWPORT'),false);
});

test('a successful permitted source in the background performs no automatic tab selection',async t=>{
  const h=setup({permission:true});t.after(()=>h.close());const result=await h.send();
  assert.equal(result.ok,true);assert.equal(result.method,'source');assert.equal(h.fetches.length,1);
  assert.deepEqual(h.updates,[]);assert.deepEqual(h.captures,[]);assert.equal(h.activeId,2);assert.deepEqual(h.focusCalls,[]);
});

test('an already selected bound tab needs no temporary activation or restoration',async t=>{
  const h=setup({initialActive:1});t.after(()=>h.close());const result=await h.send();
  assert.equal(result.ok,true);assert.equal(result.method,'visible-crop');assert.deepEqual(h.updates,[]);
  assert.equal(h.captures.length,1);assert.equal(h.activeId,1);
});

test('delayed onActivated acknowledgement is observed before the temporary tab crop',async t=>{
  const h=setup({updateMode:'delayed-event'});t.after(()=>h.close());const result=await h.send();
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(h.captures.length,1);
  assert.equal(h.activeId,2);assert.equal(h.updates.length,2);
});

for(const updateMode of ['denied','no-change','no-event'])test(`failed tab selection (${updateMode}) cannot capture the previously active page`,async t=>{
  const h=setup({updateMode});t.after(()=>h.close());const result=await h.send();
  assert.equal(result.ok,false);assert.equal(h.captures.length,0);assert.equal(h.crops.length,0);
  if(updateMode!=='no-event')assert.equal(h.activeId,2);
  assert.deepEqual(h.focusCalls,[]);
});

test('STOP while inspecting the question prevents any temporary tab selection',async t=>{
  const h=setup();t.after(()=>h.close());h.beforeInspect=()=>h.stop();const result=await h.send();
  assert.equal(result.ok,false);assert.equal(h.updates.length,0);assert.equal(h.captures.length,0);assert.equal(h.activeId,2);
});

test('STOP during the pre-selection active-tab query cannot select or capture a tab',async t=>{
  const h=setup();t.after(()=>h.close());h.beforeQuery=()=>h.stop();const result=await h.send();
  assert.equal(result.ok,false);assert.deepEqual(h.updates,[]);assert.deepEqual(h.captures,[]);assert.equal(h.activeId,2);
});

test('a minimized Alef window is never restored or focused for an automatic capture',async t=>{
  const h=setup();t.after(()=>h.close());h.windowState='minimized';const result=await h.send();
  assert.equal(result.ok,false);assert.deepEqual(h.updates,[]);assert.deepEqual(h.captures,[]);assert.deepEqual(h.focusCalls,[]);
});

test('a replaced document after automatic selection cannot produce or acknowledge graph pixels',async t=>{
  const h=setup();t.after(()=>h.close());h.beforeUpdate=id=>{if(id===1)h.recordDocument='replacement-document';};
  const result=await h.send();assert.equal(result.ok,false);assert.equal(h.captures.length,0);assert.equal(h.crops.length,0);
});

test('STOP during capture rejects pixels and does not issue another capture',async t=>{
  const h=setup();t.after(()=>h.close());h.beforeCapture=()=>h.stop();const result=await h.send();
  assert.equal(result.ok,false);assert.equal(h.captures.length,1);assert.equal(h.crops.length,0);
  assert.equal(JSON.stringify(result).includes('PRIVATE_FULL_VIEWPORT'),false);
  assert.equal(h.activeId,2,'Cancellation restores an unchanged temporary selection without another capture');
});

test('STOP during tab selection waits for its delayed activation only to restore the previous tab',async t=>{
  const h=setup({updateMode:'delayed-event'});t.after(()=>h.close());
  h.beforeUpdate=id=>{if(id===1)h.stop();};
  const result=await h.send();
  assert.equal(result.ok,false);assert.equal(h.captures.length,0);assert.equal(h.crops.length,0);
  assert.deepEqual(h.updates,[{id:1,options:{active:true}},{id:2,options:{active:true}}]);
  assert.equal(h.activeId,2);assert.deepEqual(h.focusCalls,[]);
});

for(const backToBound of [false,true])test(`user tab switch during capture${backToBound?' and return':''} rejects pixels and suppresses automatic restoration`,async t=>{
  const h=setup();t.after(()=>h.close());h.beforeCapture=()=>{h.activate(3);if(backToBound)h.activate(1);};
  const result=await h.send();assert.equal(result.ok,false);assert.equal(h.captures.length,1);assert.equal(h.crops.length,0);
  assert.deepEqual(h.updates,[{id:1,options:{active:true}}]);assert.equal(h.activeId,backToBound?1:3);
  assert.equal(JSON.stringify(result).includes('PRIVATE_FULL_VIEWPORT'),false);
});

test('closing the old tab before restoration cannot discard the valid verified crop',async t=>{
  const h=setup();t.after(()=>h.close());h.beforeCapture=()=>{h.previousClosed=true;};
  const result=await h.send();assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.method,'visible-crop');
  assert.equal(h.captures.length,1);assert.equal(h.crops.length,1);assert.deepEqual(h.focusCalls,[]);
});

test('moving the old tab to another window suppresses restoration without discarding the crop',async t=>{
  const h=setup();t.after(()=>h.close());h.beforeCapture=()=>{h.previousWindowId=9;};
  const result=await h.send();assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.method,'visible-crop');
  assert.deepEqual(h.updates,[{id:1,options:{active:true}}]);assert.equal(h.activeId,1);assert.equal(h.crops.length,1);
});

test('geometry changed while activating the bound tab is rejected before capture',async t=>{
  const h=setup();t.after(()=>h.close());h.beforeUpdate=id=>{if(id===1)h.geometry={...h.geometry,rect:{...h.geometry.rect,x:140}};};
  const result=await h.send();assert.equal(result.ok,false);assert.equal(h.captures.length,0);assert.equal(h.crops.length,0);
});

test('a newly selected tab without a ready compositor frame is restored without a screenshot',async t=>{
  const h=setup();t.after(()=>h.close());h.paintReady=false;
  const result=await h.send();assert.equal(result.ok,false);assert.equal(h.captures.length,0);assert.equal(h.crops.length,0);
  assert.equal(h.activeId,2);assert.deepEqual(h.updates,[{id:1,options:{active:true}},{id:2,options:{active:true}}]);
});

test('queued automatic captures finish their own restoration before selecting the next diagram',async t=>{
  const h=setup();t.after(()=>h.close());const results=await Promise.all([h.send(),h.send()]);
  assert.ok(results.every(result=>result.ok===true),JSON.stringify(results));
  assert.equal(h.captures.length,2);assert.ok(h.captures.every(capture=>capture.activeId===1));
  assert.deepEqual(h.updates,[{id:1,options:{active:true}},{id:2,options:{active:true}},
    {id:1,options:{active:true}},{id:2,options:{active:true}}]);
  assert.equal(h.activeId,2);assert.deepEqual(h.focusCalls,[]);
});

test('queued captures wait for delayed restoration events before making the next automatic selection',async t=>{
  const h=setup({updateMode:'delayed-restore'});t.after(()=>h.close());
  h.beforeUpdate=id=>{
    if(id===1&&h.updates.filter(update=>update.id===1).length===2)
      assert.equal(h.restorationAcknowledgements,1,'The first restoration must be acknowledged before the next selection');
  };
  const results=await Promise.all([h.send(),h.send()]);
  assert.ok(results.every(result=>result.ok===true),JSON.stringify(results));
  assert.deepEqual(h.updates,[{id:1,options:{active:true}},{id:2,options:{active:true}},
    {id:1,options:{active:true}},{id:2,options:{active:true}}]);
  assert.equal(h.captures.length,2);assert.equal(h.crops.length,2);assert.equal(h.activeId,2);
  assert.equal(h.restorationAcknowledgements,2);assert.deepEqual(h.focusCalls,[]);
});
