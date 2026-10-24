import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Chrome privileges and the pixel renderer are explicit protocol stubs here.
// The companion CORS browser tests execute the production renderer unchanged.
const worker=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
const bridge=await readFile(new URL('../extension/visual-bridge.js',import.meta.url),'utf8');
const topURL='https://moe.alefed.com/#/progress/ncle/class/visual/lesson/one';
const childURL='https://content.alefed.com/visual.html';
const asset='https://file-delivery.alefed.com/files/diagram.png';
const target='fcad399d-7b16-4811-b287-626fda3385ff';
const privateShot='data:image/png;base64,FULL_VIEWPORT_PRIVATE_DATA';
const cropped={data:'Q1JPUFBFRF9ESUFHUkFN',mimeType:'image/png',width:320,height:220};

function setup({frameId=0,permission=true,activeRun=true,visible=true,source=asset,kind='image'}={}){
  let listener,activationListener,activeTab=true,visibleId=1,windowId=8,top=topURL,documentId=frameId?'child-document':'top-document';
  let frameURL=frameId?childURL:topURL,recordDocument=documentId,replyDocument=documentId;
  let geometry={ok:true,kind,source,rect:{x:100,y:80,width:320,height:220},viewport:{width:1280,height:720,scale:1,x:0,y:0},fullyVisible:visible};
  let beforeInspect=null,beforeFetch=null,beforeCapture=null;
  let response=()=>new Response(new Uint8Array([137,80,78,71]),{headers:{'content-type':'image/png'}});
  const executions=[],fetches=[],captures=[],decoded=[],crops=[],pauses=[];
  const sender={id:'visual-test',tab:{id:1,url:topURL},frameId,documentId,url:frameURL};
  const message={type:'ALEF_CAPTURE_VISUAL',target,expectedURL:frameURL,kind,source};
  const chrome={runtime:{id:'visual-test',getURL:path=>'chrome-extension://visual-test/'+path,
    onMessage:{addListener(fn){listener=fn;}},sendMessage:async()=>{}},
    storage:{session:{get:async()=>({}),set:async()=>{}}},
    permissions:{contains:async()=>permission},
    webNavigation:{getAllFrames:async()=>[{frameId:0,parentFrameId:-1,url:top,documentId:'top-document'},
      ...(frameId?[{frameId,parentFrameId:0,url:frameURL,documentId:recordDocument}]:[])]},
    tabs:{get:async()=>({id:1,url:top,active:activeTab,windowId}),query:async()=>[{id:visibleId}],
      captureVisibleTab:async(id,options)=>{captures.push({id,options});await beforeCapture?.();return privateShot;},onRemoved:{addListener(){}},onActivated:{addListener(fn){activationListener=fn;}}},
    scripting:{executeScript:async request=>{
      executions.push(request);await beforeInspect?.();
      return [{frameId,documentId:replyDocument,result:structuredClone(geometry)}];
    }},action:{onClicked:{addListener(){}}}};
  const context=vm.createContext({chrome,URL,AbortController,AbortSignal,DOMException,Blob,Response,Uint8Array,
    Date,setTimeout,clearTimeout,setInterval,clearInterval,
    fetch:async(url,options)=>{fetches.push({url,options});await beforeFetch?.();return response();}});
  vm.runInContext(worker,context);vm.runInContext(bridge,context);
  vm.runInContext(`globalThis.visualTestController=new AbortController();
    states.set(1,{page:{url:${JSON.stringify(topURL)}}});
    const visualTestRoutes=routeState(1);visualTestRoutes.active=${frameId};visualTestRoutes.injected.add(${frameId});
    ${activeRun?'runs.set(1,visualTestController);':''}`,context);
  context.rasterizeVisualBlob=async blob=>{decoded.push({size:blob.size,type:blob.type});return cropped;};
  context.cropVisualCapture=async(raw,proof)=>{crops.push({raw,proof:structuredClone(proof)});return cropped;};
  context.pause=async(ms,signal)=>{assert.equal(signal.aborted,false);pauses.push(ms);};
  const send=(request=message,from=sender)=>new Promise(resolve=>{
    const accepted=listener(request,from,value=>resolve(structuredClone(value)));
    if(!accepted)resolve({accepted:false});
  });
  return {send,message,sender,context,executions,fetches,captures,decoded,crops,pauses,
    activate(tabId){visibleId=tabId;activeTab=tabId===1;activationListener?.({tabId,windowId});},
    stop(){context.visualTestController.abort();},set activeTab(value){activeTab=value;},set visibleId(value){visibleId=value;},
    set windowId(value){windowId=value;},set topURL(value){top=value;},set recordDocument(value){recordDocument=value;},
    set replyDocument(value){replyDocument=value;},set geometry(value){geometry=value;},get geometry(){return geometry;},
    set beforeInspect(fn){beforeInspect=fn;},set beforeFetch(fn){beforeFetch=fn;},set beforeCapture(fn){beforeCapture=fn;},
    set response(fn){response=fn;}};
}

test('the worker reads only the attested permitted Alef source, without credentials or redirects',async()=>{
  const h=setup(),result=await h.send();
  assert.deepEqual(result,{ok:true,...cropped,method:'source'});assert.equal(h.fetches.length,1);assert.equal(h.captures.length,0);
  assert.equal(h.fetches[0].url,asset);assert.equal(h.fetches[0].options.credentials,'omit');assert.equal(h.fetches[0].options.redirect,'error');
  assert.deepEqual(h.decoded,[{size:4,type:'image/png'}]);
  for(const execution of h.executions){
    assert.equal(execution.world,'ISOLATED');assert.equal(execution.func,h.context.inspectVisualTarget);
    assert.deepEqual(structuredClone(execution.target),{tabId:1,documentIds:['top-document']});
    assert.equal(JSON.stringify(execution).includes('token'),false);
  }
});

test('a permitted embedded diagram uses its verified source without capturing the top tab',async()=>{
  const h=setup({frameId:7}),result=await h.send();assert.equal(result.ok,true);assert.equal(result.method,'source');
  assert.deepEqual(structuredClone(h.executions[0].target),{tabId:1,documentIds:['child-document']});assert.equal(h.captures.length,0);
});

test('permitted source reading continues in a background tab without any visible-tab capture',async()=>{
  const h=setup();h.activeTab=false;h.visibleId=9;
  const result=await h.send();assert.equal(result.ok,true);assert.equal(result.method,'source');assert.equal(h.captures.length,0);assert.equal(h.fetches.length,1);
});

test('an ungranted source falls back to a bounded crop of the bound active tab',async()=>{
  const h=setup({permission:false}),result=await h.send();assert.deepEqual(result,{ok:true,...cropped,method:'visible-crop'});
  assert.equal(h.fetches.length,0);assert.deepEqual(structuredClone(h.captures),[{id:8,options:{format:'png'}}]);assert.equal(h.crops.length,1);
  assert.equal(h.crops[0].raw,privateShot);assert.equal(JSON.stringify(result).includes('FULL_VIEWPORT_PRIVATE_DATA'),false);
});

test('a foreign diagram source is never fetched, even with broad permission stubs',async()=>{
  const h=setup({source:'https://foreign.example/diagram.png'}),result=await h.send();
  assert.equal(result.method,'visible-crop');assert.equal(h.fetches.length,0);assert.equal(h.captures.length,1);
});

for(const [label,change] of [
  ['another extension',h=>({...h.sender,id:'other-extension'})],
  ['another tab',h=>({...h.sender,tab:{id:2}})],
  ['another frame',h=>({...h.sender,frameId:7})],
  ['a stale document',h=>({...h.sender,documentId:'old-document'})],
])test('visual requests from '+label+' do not fetch or capture',async()=>{
  const h=setup(),result=await h.send(h.message,change(h));assert.notEqual(result.ok,true);assert.equal(h.fetches.length,0);assert.equal(h.captures.length,0);
});

for(const patch of [{target:'img, input'},{kind:'script'},{source:null},{expectedURL:topURL+'-changed'}])test('malformed visual descriptors are refused: '+JSON.stringify(patch),async()=>{
  const h=setup(),result=await h.send({...h.message,...patch});assert.notEqual(result.ok,true);assert.equal(h.executions.length,0);assert.equal(h.fetches.length,0);assert.equal(h.captures.length,0);
});

test('a request URL different from the attested source is not a privileged fetch capability',async()=>{
  const h=setup(),result=await h.send({...h.message,source:'https://file-delivery.alefed.com/private/other.png'});
  assert.equal(result.ok,false);assert.equal(h.fetches.length,0);assert.equal(h.captures.length,0);
});

test('inactive and different visible tabs never produce a screenshot',async()=>{
  for(const option of ['inactive','different']){
    const h=setup({permission:false});if(option==='inactive')h.activeTab=false;else h.visibleId=9;
    const result=await h.send();assert.equal(result.ok,false);assert.equal(h.captures.length,0);
  }
});

test('an offscreen or clipped diagram requests one bounded content scroll instead of a partial capture',async()=>{
  const h=setup({permission:false,visible:false}),result=await h.send();assert.equal(result.ok,false);assert.equal(result.code,'visual_not_fully_visible');assert.equal(h.captures.length,0);
});

test('capture rejects a tab switch while the browser API is pending and never returns the full screenshot',async()=>{
  const h=setup({permission:false});h.beforeCapture=()=>{h.visibleId=4;h.activeTab=false;};
  const result=await h.send();assert.equal(result.ok,false);assert.equal(h.captures.length,1);assert.equal(h.crops.length,0);
  assert.equal(JSON.stringify(result).includes('FULL_VIEWPORT_PRIVATE_DATA'),false);
});

test('switching away and back during capture cannot accept pixels from the intervening tab',async()=>{
  const h=setup({permission:false});h.beforeCapture=()=>{h.activate(4);h.activate(1);};
  const result=await h.send();assert.equal(result.ok,false);assert.equal(h.captures.length,1);assert.equal(h.crops.length,0);
  assert.equal(JSON.stringify(result).includes('FULL_VIEWPORT_PRIVATE_DATA'),false);
});

test('image URLs with embedded credentials are never fetched or captured',async()=>{
  const h=setup({source:'https://name:password@file-delivery.alefed.com/files/diagram.png'});
  const result=await h.send();assert.equal(result.ok,false);assert.equal(result.code,'visual_invalid_source');assert.equal(h.fetches.length,0);assert.equal(h.captures.length,0);
});

test('changed geometry after capture invalidates the crop',async()=>{
  const h=setup({permission:false});h.beforeCapture=()=>{h.geometry={...h.geometry,rect:{...h.geometry.rect,x:140}};};
  const result=await h.send();assert.equal(result.ok,false);assert.equal(h.captures.length,1);assert.equal(h.crops.length,0);
});

test('STOP before a request or during its source fetch cannot return pixels or trigger screenshot fallback',async()=>{
  const before=setup();before.stop();assert.equal((await before.send()).ok,false);assert.equal(before.executions.length,0);
  const pending=setup();pending.beforeFetch=()=>pending.stop();assert.equal((await pending.send()).ok,false);assert.equal(pending.captures.length,0);
});

test('a new frame document in the attestation result is rejected before fetching',async()=>{
  const h=setup();h.replyDocument='new-document';assert.equal((await h.send()).ok,false);assert.equal(h.fetches.length,0);assert.equal(h.captures.length,0);
});

for(const [label,response] of [
  ['non-image MIME',()=>new Response('private HTML',{headers:{'content-type':'text/html'}})],
  ['oversized source',()=>new Response('x',{headers:{'content-type':'image/png','content-length':'8388609'}})],
  ['oversized streamed source',()=>new Response(new Uint8Array(8_388_609),{headers:{'content-type':'image/png'}})],
  ['redirected source',()=>({ok:true,redirected:true,headers:new Headers({'content-type':'image/png'})})],
])test(label+' is not decoded and can use only the attested visible crop',async()=>{
  const h=setup();h.response=response;const result=await h.send();assert.equal(result.ok,true);assert.equal(result.method,'visible-crop');assert.equal(h.decoded.length,0);assert.equal(h.captures.length,1);
});

test('capture requests are serialized below the browser quota',async()=>{
  const h=setup({permission:false});await h.send();await h.send();assert.equal(h.captures.length,2);assert.ok(h.pauses.some(ms=>ms>0&&ms<=550));
});
