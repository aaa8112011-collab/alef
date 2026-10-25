'use strict';

// Fixed DOM inspection in the sender's isolated world. The request identifies
// an already selected diagram, never an arbitrary URL or CSS selector.
function inspectVisualTarget(target,kind,source,expectedURL) {
  try {
    if(location.href!==expectedURL||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target))throw Error('تغير مستند الرسم.');
    const found=[];
    const visit=root=>{
      for(const node of root.querySelectorAll('[data-alef-visual-target]'))if(node.getAttribute('data-alef-visual-target')===target)found.push(node);
      for(const node of root.querySelectorAll('*'))if(node.shadowRoot&&node.tagName!=='MATH-FIELD')visit(node.shadowRoot);
    };
    visit(document);
    if(found.length!==1)throw Error('لم يعد الرسم المحدد ظاهرًا.');
    const node=found[0],parents=[];
    for(let parent=node;parent;parent=parent.parentElement||parent.getRootNode()?.host)parents.push(parent);
    const questions='[data-alef-question],[data-question-id],[data-testid="question-renderer"],[data-testid="new-question-renderer"],.lib-question-widget,.question-widget';
    const player=parents.find(parent=>parent.matches('main#player-container,[data-testid="assessment-content-player"],[data-testid="ncle-activity-page-player"],[data-alef-question-scope]'));
    if(!parents.some(parent=>parent.matches(questions))&&(!player||player.querySelectorAll(questions).length!==1))throw Error('الرسم ليس داخل سؤال واضح.');
    if(!node.isConnected||!node.getClientRects().length)throw Error('لم يعد الرسم ظاهرًا.');
    for(const parent of parents){
      const style=getComputedStyle(parent);
      // aria-hidden is accessibility metadata; Weaver can place a visible
      // authored diagram there. Match the reader's rendered-visibility rules.
      if(parent.matches('[hidden],[inert]')||style.display==='none'||['hidden','collapse'].includes(style.visibility))throw Error('لم يعد الرسم ظاهرًا.');
    }
    let actual=source;
    if(kind==='image'){
      if(node.tagName!=='IMG'||!node.complete||!node.naturalWidth||!node.naturalHeight)throw Error('لم يكتمل تحميل الرسم.');
      actual=node.currentSrc||node.src;
      if(actual!==source)throw Error('تغير مصدر الرسم.');
    }else if(kind==='background'){
      const urls=[...getComputedStyle(node).backgroundImage.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g)].map(match=>new URL(match[1]||match[2]||match[3]?.trim()||'',node.baseURI).href);
      if(!urls.includes(source))throw Error('تغير مصدر الرسم.');
    }else if(kind==='canvas'){
      if(node.tagName!=='CANVAS'||!node.width||!node.height||!source.startsWith(`${node.width}x${node.height}:`))throw Error('تغير الرسم.');
      actual=`${node.width}x${node.height}`;
    }else if(kind==='svg'){
      if(node.tagName.toLowerCase()!=='svg')throw Error('تغير الرسم.');
      const copy=node.cloneNode(true);copy.removeAttribute('data-alef-visual-target');
      if(copy.outerHTML!==source)throw Error('تغير الرسم.');
      actual=copy.outerHTML;
    }else throw Error('نوع الرسم غير مدعوم.');
    const box=node.getBoundingClientRect(),rect={x:box.left,y:box.top,width:box.width,height:box.height};
    const viewport={width:innerWidth,height:innerHeight,scale:visualViewport?.scale??1,x:visualViewport?.offsetLeft??0,y:visualViewport?.offsetTop??0};
    let fullyVisible=box.width>0&&box.height>0&&box.left>=0&&box.top>=0&&box.right<=innerWidth&&box.bottom<=innerHeight;
    for(const parent of parents.slice(1)){
      const style=getComputedStyle(parent),clip=parent.getBoundingClientRect();
      if(/hidden|clip|scroll|auto/.test(style.overflowX)&& (box.left<clip.left||box.right>clip.right))fullyVisible=false;
      if(/hidden|clip|scroll|auto/.test(style.overflowY)&& (box.top<clip.top||box.bottom>clip.bottom))fullyVisible=false;
    }
    const composedContains=(outer,inner)=>{
      for(let current=inner;current;current=current.parentElement||current.getRootNode()?.host)if(current===outer)return true;
      return false;
    };
    if(fullyVisible){
      const dx=Math.min(3,box.width/4),dy=Math.min(3,box.height/4);
      for(const [x,y] of [[box.left+dx,box.top+dy],[box.right-dx,box.top+dy],[box.left+dx,box.bottom-dy],[box.right-dx,box.bottom-dy],[box.left+box.width/2,box.top+box.height/2]]){
        const hit=document.elementFromPoint(x,y);
        if(!hit||!composedContains(hit,node)&&!composedContains(node,hit))fullyVisible=false;
      }
    }
    return {ok:true,source:actual,kind,rect,viewport,fullyVisible};
  }catch{return {ok:false,error:'تغير الرسم أو تعذر تحديده داخل السؤال الحالي.'};}
}

// These pixel helpers also run unchanged in real-browser tests. Full viewport
// screenshots are kept only in worker memory and never returned to the reader.
async function rasterizeVisualBitmap(bitmap,crop=null) {
  const input=crop||{x:0,y:0,width:bitmap.width,height:bitmap.height};
  if(![input.x,input.y,input.width,input.height].every(Number.isFinite)||input.width<=0||input.height<=0||input.x<0||input.y<0||
    input.x+input.width>bitmap.width+.01||input.y+input.height>bitmap.height+.01||bitmap.width*bitmap.height>40_000_000)throw Error('أبعاد الرسم خارج حدود القراءة.');
  const scale=Math.min(1,1600/Math.max(input.width,input.height));
  let width=Math.max(1,Math.round(input.width*scale)),height=Math.max(1,Math.round(input.height*scale));
  const draw=()=>{
    const canvas=new OffscreenCanvas(width,height),ctx=canvas.getContext('2d');
    if(!ctx)throw Error('تعذر تجهيز صورة الرسم.');
    ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);ctx.drawImage(bitmap,input.x,input.y,input.width,input.height,0,0,width,height);
    return canvas;
  };
  let canvas=draw(),blob=await canvas.convertToBlob({type:'image/png'});
  if(blob.size>1_048_576)blob=await canvas.convertToBlob({type:'image/jpeg',quality:.88});
  if(blob.size>1_048_576){width=Math.max(1,Math.round(width*.75));height=Math.max(1,Math.round(height*.75));canvas=draw();blob=await canvas.convertToBlob({type:'image/jpeg',quality:.8});}
  if(blob.size>1_048_576||!['image/png','image/jpeg'].includes(blob.type))throw Error('حجم الرسم يتجاوز حدود القراءة.');
  const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';
  for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
  return {data:btoa(binary),mimeType:blob.type,width,height};
}
async function rasterizeVisualBlob(blob,crop=null){
  const bitmap=await createImageBitmap(blob);
  try{return await rasterizeVisualBitmap(bitmap,crop);}finally{bitmap.close?.();}
}
async function cropVisualCapture(dataURL,geometry){
  if(typeof dataURL!=='string'||dataURL.length>64_000_000||!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(dataURL))throw Error('تعذر قراءة لقطة الرسم.');
  const viewport=geometry.viewport,rect=geometry.rect;
  if(!geometry.fullyVisible||viewport.scale!==1||viewport.x!==0||viewport.y!==0||viewport.width<=0||viewport.height<=0)throw Error('يلزم إظهار الرسم كاملًا دون تكبير باللمس.');
  const binary=atob(dataURL.slice(dataURL.indexOf(',')+1)),bytes=Uint8Array.from(binary,char=>char.charCodeAt(0));
  const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
  try{
    const sx=bitmap.width/viewport.width,sy=bitmap.height/viewport.height;
    if(!Number.isFinite(sx)||!Number.isFinite(sy)||Math.abs(sx/sy-1)>.015)throw Error('تغير حجم نافذة الرسم أثناء الالتقاط.');
    return await rasterizeVisualBitmap(bitmap,{x:rect.x*sx,y:rect.y*sy,width:rect.width*sx,height:rect.height*sy});
  }finally{bitmap.close?.();}
}

// Selecting a background tab needs a fresh compositor frame before a crop.
// This fixed function executes only in the already verified question document.
async function waitVisualPaint(expectedURL){
  if(location.href!==expectedURL||document.visibilityState!=='visible')return {ok:false};
  return new Promise(resolve=>{
    let done=false;
    const finish=ok=>{if(done)return;done=true;clearTimeout(timer);resolve({ok:ok&&location.href===expectedURL&&document.visibilityState==='visible'});};
    const timer=setTimeout(()=>finish(false),900);
    requestAnimationFrame(()=>requestAnimationFrame(()=>finish(true)));
  });
}

var visualCaptureQueue=Promise.resolve();
var lastVisualCaptureAt=0;
var visualActivationEpochs=new Map();
var visualActivationLeases=new Map();
if(typeof chrome!=='undefined')chrome.tabs?.onActivated?.addListener(({windowId,tabId})=>{
  const epoch=(visualActivationEpochs.get(windowId)||0)+1;
  visualActivationEpochs.set(windowId,epoch);
  const lease=visualActivationLeases.get(windowId);
  if(!lease)return;
  if(!lease.acknowledged&&!lease.interrupted&&tabId===lease.tabId&&epoch===lease.startEpoch+1){
    lease.acknowledged=true;lease.epoch=epoch;
  }else lease.interrupted=true;
  lease.wake?.();
});
function awaitVisualActivation(lease,signal){
  return new Promise((resolve,reject)=>{
    let timer;
    const finish=()=>{
      if(!signal.aborted&&!lease.acknowledged&&!lease.interrupted)return;
      clearTimeout(timer);signal.removeEventListener('abort',finish);lease.wake=null;
      if(signal.aborted)reject(aborted());
      else if(lease.interrupted)reject(Error('تغير التبويب أثناء تجهيز الرسم.'));
      else resolve();
    };
    lease.wake=finish;
    timer=setTimeout(()=>{lease.interrupted=true;finish();},1200);
    signal.addEventListener('abort',finish,{once:true});finish();
  });
}
async function restoreVisualSelection(lease,expectedURL,frameId,documentId){
  if(!lease?.acknowledged||lease.interrupted||visualActivationEpochs.get(lease.windowId)!==lease.epoch)return;
  try{
    const [bound,previous,selected,records]=await Promise.all([
      chrome.tabs.get(lease.tabId),chrome.tabs.get(lease.previousId),
      chrome.tabs.query({active:true,windowId:lease.windowId}),chrome.webNavigation.getAllFrames({tabId:lease.tabId}),
    ]);
    const record=records?.find(item=>item.frameId===frameId);
    if(lease.interrupted||visualActivationEpochs.get(lease.windowId)!==lease.epoch||
      !bound.active||bound.windowId!==lease.windowId||previous.windowId!==lease.windowId||
      selected.length!==1||selected[0].id!==lease.tabId||!record||record.url!==expectedURL||
      documentId&&record.documentId!==documentId)return;
    // Cleanup may restore our own selection after STOP. Never restore across
    // a user's switch, and never focus or resize any browser/game window.
    const restored={tabId:lease.previousId,windowId:lease.windowId,startEpoch:lease.epoch,
      acknowledged:false,interrupted:false,epoch:null,wake:null};
    visualActivationLeases.set(lease.windowId,restored);
    try{
      await chrome.tabs.update(lease.previousId,{active:true});
      // Do not release the capture queue while a late restoration event could
      // be mistaken for interference with the next automatic selection.
      await awaitVisualActivation(restored,new AbortController().signal);
    }finally{if(visualActivationLeases.get(lease.windowId)===restored)visualActivationLeases.delete(lease.windowId);}
  }catch{/* A closed/moved previous tab cannot invalidate valid graph pixels. */}
}
async function handleVisualCapture(message,sender){
  const failure=(code,error)=>({ok:false,code,error});
  try{
    const tabId=checkedTabId(sender.tab?.id),frameId=sender.frameId;
    if(sender.id!==chrome.runtime.id||!Number.isSafeInteger(frameId)||frameId<0||
      !['image','background','canvas','svg'].includes(message.kind)||typeof message.target!=='string'||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(message.target)||
      !bridgeSenderMatchesURL(sender,message.expectedURL)||typeof message.source!=='string'||
      message.source.length>(message.kind==='svg'?1_000_000:8192))return failure('visual_invalid_request','طلب قراءة الرسم غير صالح.');
    const controller=runs.get(tabId),routes=frameRoutes.get(tabId),state=states.get(tabId);
    const active=()=>{
      if(!controller||controller.signal.aborted||runs.get(tabId)!==controller||!routes||routes.active!==frameId||
        !routes.injected.has(frameId)||!state?.page?.url)throw Error('توقف التقاط الرسم أو تغير إطار السؤال.');
    };
    active();
    const topOrigin=new URL(state.page.url).origin;
    const binding=async()=>{
      active();const tab=await checkedTab(tabId,topOrigin);active();
      const host=frameOrigin(sender.url,topOrigin);
      if(!host||!await framePermission(host,topOrigin))throw Error('لا يوجد إذن لإطار الرسم.');
      active();
      if(!chrome.webNavigation?.getAllFrames)throw Error('تعذر التحقق من مستند الرسم.');
      const records=await chrome.webNavigation.getAllFrames({tabId});active();
      const record=records?.find(entry=>entry.frameId===frameId);
      if(!record||record.errorOccurred||record.url!==message.expectedURL||sender.documentId&&record.documentId!==sender.documentId)throw Error('تغير مستند الرسم.');
      return tab;
    };
    const attest=async()=>{
      await binding();
      const result=await chrome.scripting.executeScript({world:'ISOLATED',target:{tabId,...(sender.documentId?{documentIds:[sender.documentId]}:{frameIds:[frameId]})},
        func:inspectVisualTarget,args:[message.target,message.kind,message.source,message.expectedURL]});
      active();
      if(!Array.isArray(result)||result.length!==1||result[0].frameId!==frameId||sender.documentId&&result[0].documentId!==sender.documentId||result[0].result?.ok!==true)throw Error('تغير الرسم المحدد داخل السؤال.');
      const proof=result[0].result;
      if(proof.kind!==message.kind||typeof proof.source!=='string'||
        ['image','background','svg'].includes(message.kind)&&proof.source!==message.source||
        !proof.rect||!proof.viewport||![proof.rect.x,proof.rect.y,proof.rect.width,proof.rect.height,proof.viewport.width,proof.viewport.height,proof.viewport.scale,proof.viewport.x,proof.viewport.y].every(Number.isFinite)||
        proof.rect.width<=0||proof.rect.height<=0||proof.viewport.width<=0||proof.viewport.height<=0||typeof proof.fullyVisible!=='boolean')throw Error('تعذرت مطابقة موضع الرسم.');
      return proof;
    };
    const proof=await attest();
    if(['image','background'].includes(message.kind)){
      let sourceURL;try{sourceURL=new URL(proof.source);}catch{}
      if(!sourceURL||sourceURL.username||sourceURL.password)return failure('visual_invalid_source','عنوان مصدر الرسم غير صالح للقراءة.');
    }
    const stillSame=async()=>{
      const current=await attest();
      if(JSON.stringify(current)!==JSON.stringify(proof))throw Error('تغير الرسم أثناء قراءته.');
    };
    // Host permissions belong to the worker; content-script CORS does not
    // inherit them. Only the attested source on a permitted Alef origin is read.
    const assetOrigin=['image','background'].includes(message.kind)?frameOrigin(proof.source,topOrigin):null;
    if(assetOrigin&&await framePermission(assetOrigin,topOrigin)){
      active();
      let rendered=null;
      try{
        const response=await fetch(proof.source,{credentials:'omit',redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(6000)])});
        const mime=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
        if(!response.ok||response.redirected||!['image/png','image/jpeg','image/webp','image/gif','image/svg+xml'].includes(mime))throw Error('نوع مصدر الرسم غير صالح.');
        const declared=Number(response.headers.get('content-length')||0);
        if(declared>8_388_608||!response.body)throw Error('حجم مصدر الرسم خارج الحدود.');
        const chunks=[];let length=0;
        for await(const chunk of response.body){length+=chunk.byteLength;if(length>8_388_608)throw Error('حجم مصدر الرسم خارج الحدود.');chunks.push(chunk);}
        rendered=await rasterizeVisualBlob(new Blob(chunks,{type:mime}));
      }catch{active();}
      if(rendered){await stillSame();return {ok:true,...rendered,method:'source'};}
    }
    // A privileged screenshot captures the active tab in one window. If the
    // source is unavailable, temporarily select only the verified bound tab.
    if(frameId!==0)return failure('visual_frame_capture_unavailable','اضغط «افحص موادي» واسمح بصور ألف، ثم أعد المحاولة في الدرس الحالي.');
    if(!proof.fullyVisible||proof.viewport?.scale!==1||proof.viewport?.x!==0||proof.viewport?.y!==0)return failure('visual_not_fully_visible','أظهر الرسم كاملًا في صفحة ألف ثم أعد المحاولة.');
    let release,lease=null;const previous=visualCaptureQueue;
    visualCaptureQueue=new Promise(resolve=>{release=resolve;});
    await previous.catch(()=>{});
    try{
      active();
      const wait=550-(Date.now()-lastVisualCaptureAt);if(wait>0)await pause(wait,controller.signal);
      await stillSame();
      let tab=await binding();
      if(!Number.isSafeInteger(tab.windowId)||!chrome.tabs.query||!chrome.tabs.captureVisibleTab)return failure('visual_tab_inactive','تعذر تجهيز تبويب ألف لقراءة الرسم تلقائيًا. افتح تبويب ألف ثم أعد المحاولة.');
      if(chrome.windows?.get){
        const window=await chrome.windows.get(tab.windowId);active();
        if(window.state==='minimized')return failure('visual_window_minimized','نافذة ألف مصغّرة. أعد فتحها ثم ابدأ؛ سيختار مُعين التبويب ويلتقط الرسم تلقائيًا.');
      }
      if(!tab.active){
        if(!chrome.tabs.update||!chrome.tabs.onActivated?.addListener)return failure('visual_tab_inactive','تعذر تفعيل تبويب ألف تلقائيًا. افتحه ثم أعد المحاولة.');
        const selectionEpoch=visualActivationEpochs.get(tab.windowId)||0;
        const selected=await chrome.tabs.query({active:true,windowId:tab.windowId});active();
        if((visualActivationEpochs.get(tab.windowId)||0)!==selectionEpoch||selected.length!==1||!Number.isSafeInteger(selected[0].id)||selected[0].id===tabId)throw Error('تغير التبويب قبل تجهيز الرسم.');
        lease={tabId,windowId:tab.windowId,previousId:selected[0].id,startEpoch:selectionEpoch,
          acknowledged:false,interrupted:false,epoch:null,wake:null};
        visualActivationLeases.set(tab.windowId,lease);
        await chrome.tabs.update(tabId,{active:true});active();
        await awaitVisualActivation(lease,controller.signal);active();
        tab=await binding();
        const painted=await chrome.scripting.executeScript({world:'ISOLATED',target:{tabId,...(sender.documentId?{documentIds:[sender.documentId]}:{frameIds:[frameId]})},
          func:waitVisualPaint,args:[message.expectedURL]});
        active();
        if(lease.interrupted||visualActivationEpochs.get(lease.windowId)!==lease.epoch||!tab.active||tab.windowId!==lease.windowId||
          !Array.isArray(painted)||painted.length!==1||painted[0].frameId!==frameId||
          sender.documentId&&painted[0].documentId!==sender.documentId||painted[0].result?.ok!==true)throw Error('لم يستقر رسم السؤال بعد اختيار تبويبه.');
        await stillSame();
      }
      const activationEpoch=lease?.epoch??(visualActivationEpochs.get(tab.windowId)||0);
      const unchangedActivation=()=>{if(lease?.interrupted||(visualActivationEpochs.get(tab.windowId)||0)!==activationEpoch)throw Error('تغير التبويب الظاهر أثناء التقاط الرسم.');};
      const activeTabs=await chrome.tabs.query({active:true,windowId:tab.windowId});active();
      unchangedActivation();
      if(activeTabs.length!==1||activeTabs[0].id!==tabId)throw Error('تغير التبويب الظاهر قبل التقاط الرسم.');
      // No asynchronous work belongs between this final active-tab query and
      // the capture API call. A later switch still invalidates the result.
      lastVisualCaptureAt=Date.now();
      const raw=await chrome.tabs.captureVisibleTab(tab.windowId,{format:'png'});
      const after=await binding(),visible=await chrome.tabs.query({active:true,windowId:tab.windowId});active();
      unchangedActivation();
      if(!after.active||after.windowId!==tab.windowId||visible.length!==1||visible[0].id!==tabId)throw Error('تغير التبويب الظاهر أثناء التقاط الرسم.');
      await stillSame();
      const cropped=await cropVisualCapture(raw,proof);active();
      await stillSame();
      unchangedActivation();
      return {ok:true,...cropped,method:'visible-crop'};
    }finally{
      try{
        // STOP can arrive before our own activation event. Wait only for the
        // bounded cleanup acknowledgment; an aborted solve never captures.
        if(lease&&!lease.acknowledged&&!lease.interrupted){
          try{await awaitVisualActivation(lease,new AbortController().signal);}catch{}
        }
        await restoreVisualSelection(lease,message.expectedURL,frameId,sender.documentId);
      }
      finally{if(lease&&visualActivationLeases.get(lease.windowId)===lease)visualActivationLeases.delete(lease.windowId);release();}
    }
  }catch{return failure('visual_capture_failed','تعذرت قراءة الرسم بأمان. حدّث صفحة ألف وأعد المحاولة في الدرس الحالي.');}
}
