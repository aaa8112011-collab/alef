import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createAppServer} from '../server/index.mjs';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

// A real second HTTP origin displays PNG bytes without granting canvas access.
// The application fixture models interaction only, not geometry/model accuracy.
export async function createCorsQuestion(t,{language='en',completeOnSubmit=false,ariaHidden=false,dpr=1,kind='image'}={}){
  const h=await createBrowserHarness();t.after(()=>h.close());
  if(dpr!==1){
    // Use a real browser context device scale. A metrics-only CDP override
    // changes devicePixelRatio but does not resize the screenshot surface.
    const original=h.page,dispatch=await original.evaluate(()=>window.__dispatchExtension.toString());
    const context=await original.context().browser().newContext({deviceScaleFactor:dpr,viewport:original.viewportSize(),locale:'ar-AE'});
    const page=await context.newPage();await page.goto(original.url());
    await page.evaluate(source=>{
      window.__extensionListeners=[];
      window.chrome={runtime:{id:'fixture-extension',onMessage:{addListener(listener){window.__extensionListeners.push(listener);}},sendMessage(){return Promise.resolve();}}};
      window.__dispatchExtension=(0,eval)('('+source+')');
    },dispatch);
    await page.addScriptTag({content:h.contentScript});
    h.page=page;h.send=message=>page.evaluate(value=>window.__dispatchExtension(value),message);
  }
  if(process.env.ALEF_VISUAL_TEST_CONTENT){
    const baseline=await readFile(process.env.ALEF_VISUAL_TEST_CONTENT,'utf8');
    await h.page.evaluate(()=>{window.__extensionListeners.length=0;delete window.__alefAssistantInstalled;});
    await h.page.addScriptTag({content:baseline});
  }
  const png=await h.page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=220;
    const context=canvas.getContext('2d');context.fillStyle='white';context.fillRect(0,0,320,220);
    context.fillStyle='#005adc';context.fillRect(24,52,80,70);
    context.strokeStyle='#222';context.lineWidth=3;context.beginPath();context.moveTo(30,195);context.lineTo(170,30);context.lineTo(290,195);context.closePath();context.stroke();
    context.fillStyle='#000';context.font='18px sans-serif';context.fillText('45°',52,180);context.fillText('70°',157,70);
    return canvas.toDataURL('image/png');
  });
  const bytes=Buffer.from(png.split(',')[1],'base64'),requests=[];
  const imageServer=createServer((request,response)=>{
    requests.push({path:request.url,origin:request.headers.origin||null});
    response.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});response.end(bytes);
  });
  await new Promise((resolve,reject)=>{imageServer.once('error',reject);imageServer.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise(resolve=>{imageServer.close(resolve);imageServer.closeAllConnections();}));
  const imageURL=`http://127.0.0.1:${imageServer.address().port}/authored-diagram.png`;
  await h.page.evaluate(async({language,imageURL,completeOnSubmit,ariaHidden,kind})=>{
    document.documentElement.dir=language==='ar'?'rtl':'ltr';
    history.replaceState(null,'','#/progress/ncle/class/cors-fixture/lesson/geometry/material/content');
    document.body.innerHTML=`<main id="player-container"><div data-testid="ncle-activity-page-player">
      <div role="progressbar" style="height:8px;width:520px">2/5</div>
      <section class="lib-dropdown-container lib-question-widget">
        <p>${language==='ar'?'اختر الإجابات الصحيحة من القائمتين.':'Choose the correct options from the drop-down lists.'}</p>
        <p>${language==='ar'?'قياس الزاوية':'The angle is'} <select name="angle"><option value="">Select...</option><option value="angle-one">70°</option><option value="angle-two">65°</option></select>
        ${language==='ar'?'والمثلثان':'and the triangles'} <select name="relationship"><option value="">Select...</option><option value="relationship-one">${language==='ar'?'متشابهان':'are similar'}</option><option value="relationship-two">${language==='ar'?'غير متشابهين':'are not similar'}</option></select>.</p>
      </section>
      <div class="lib-question-statement-container">${language==='ar'?'استعمل الرسم المرفق لإكمال قياس الزاوية والعلاقة بين المثلثين.':'Use the accompanying figure to complete the angle and triangle relationship.'}</div>
      <img id="authored-diagram" width="320" height="220" alt="Triangle diagram">
      <button id="fixture-submit" disabled>Submit Answer</button>
    </div></main>`;
    window.corsQuestionState={changes:[],submitted:[]};
    for(const select of document.querySelectorAll('select'))select.addEventListener('change',()=>{
      window.corsQuestionState.changes.push({name:select.name,value:select.value});
      document.querySelector('#fixture-submit').disabled=[...document.querySelectorAll('select')].some(node=>!node.value);
    });
    document.querySelector('#fixture-submit').addEventListener('click',()=>{
      window.corsQuestionState.submitted.push([...document.querySelectorAll('select')].map(node=>({name:node.name,value:node.value})));
      if(completeOnSubmit)document.querySelector('main').innerHTML='<section data-alef-completed>Completed</section>';
    });
    const image=document.querySelector('#authored-diagram');
    if(kind==='foreign-svg'){
      const wrap=document.createElement('div');
      wrap.innerHTML='<svg id="authored-diagram" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Triangle diagram" width="320" height="220" viewBox="0 0 320 220"><rect width="320" height="220" fill="white"/><foreignObject x="24" y="52" width="80" height="70"><div xmlns="http://www.w3.org/1999/xhtml" style="width:80px;height:70px;background:#005adc"></div></foreignObject><path d="M 30 195 L 170 30 L 290 195 Z" stroke="#222" stroke-width="3" fill="none"/><text x="52" y="180" font-size="18">45°</text><text x="157" y="70" font-size="18">70°</text></svg>';
      image.replaceWith(wrap.firstElementChild);
    }else{
      if(ariaHidden)image.setAttribute('aria-hidden','true');
      image.src=imageURL;await image.decode();
    }
  },{language,imageURL,completeOnSubmit,ariaHidden,kind});
  return {h,imageURL,png,bytes,requests,async installContentBridge(handler){
    await h.page.exposeFunction('__corsAssetBridge',handler);
    await h.page.evaluate(()=>{chrome.runtime.sendMessage=message=>window.__corsAssetBridge(message);});
  },async read(){
    const result=await h.send({type:'ALEF_GET_QUESTION'});
    if(!result.ok||!result.question)throw Error(JSON.stringify(result));
    return result.question;
  },capture(question){return h.send({type:'ALEF_GET_VISUALS',questionId:question.id,questionFingerprint:question.fingerprint});}};
}

export async function assertCorsPng(h,image,{scale=1}={}){
  const pixels=await h.page.evaluate(async({image,scale})=>{
    const bitmap=new Image();bitmap.src=`data:${image.mimeType};base64,${image.data}`;await bitmap.decode();
    const canvas=document.createElement('canvas');canvas.width=bitmap.naturalWidth;canvas.height=bitmap.naturalHeight;
    const context=canvas.getContext('2d');context.drawImage(bitmap,0,0);
    return {width:canvas.width,height:canvas.height,blue:[...context.getImageData(50*scale,80*scale,1,1).data]};
  },{image,scale});
  if(pixels.width!==320*scale||pixels.height!==220*scale||pixels.blue.join(',')!=='0,90,220,255')throw Error('The original authored pixels were not preserved: '+JSON.stringify(pixels));
  return pixels;
}


export async function createCorsPipeline(t,{language='en',assetPermission=true,activeTab=true,deferAssetFetch=false,ariaHidden=false,dpr=1,kind='image'}={}){
  let releaseAsset;const assetGate=new Promise(resolve=>{releaseAsset=resolve;});t.after(()=>releaseAsset());
  const f=await createCorsQuestion(t,{language,completeOnSubmit:true,ariaHidden,dpr,kind}),{h}=f;
  const token='cors-actual-http-fixture-only',chats=[],events=[],assets=[],executions=[],pixelMethods=[],captureReplies=[];
  let screenshotCalls=0,handler;
  const app=createAppServer({provider:'ollama',model:'qwen3:8b',visionModel:'qwen3-vl:8b',pairingToken:token,
    requestTimeoutMs:10000,healthTimeoutMs:1500,fetchImpl:async(url,options={})=>{
      if(url.endsWith('/api/tags'))return Response.json({models:[{name:'qwen3:8b'},{name:'qwen3-vl:8b'}]});
      if(url.endsWith('/api/show'))return Response.json({capabilities:['completion','vision']});
      assertEndpoint(url.endsWith('/api/chat'),'Unexpected provider endpoint');
      const chat=JSON.parse(options.body),question=JSON.parse(chat.messages[1].content).question;chats.push(chat);
      assertEndpoint(chat.model==='qwen3-vl:8b'&&question.type==='dropdowns'&&question.fields.length===2,'The original multi-field question must reach vision');
      assertEndpoint(chat.messages[1].images?.length===1,'The graph cannot disappear from the model request');
      const selections=question.fields.map(field=>({fieldId:field.id,optionId:field.options[0].id}));
      return Response.json({message:{content:JSON.stringify({optionIds:[],text:'',selections,confidence:.99,
        explanation:'Deterministic original-ID transport fixture, not geometry inference.'})}});
    }});
  await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise(resolve=>{app.close(resolve);app.closeAllConnections();}));
  const serverUrl=`http://127.0.0.1:${app.address().port}`,storage={};
  const tab=()=>({id:1,windowId:4,active:activeTab,url:h.page.url()});
  const chrome={runtime:{id:'fixture-extension',getURL:path=>'chrome-extension://fixture-extension/'+path,getPlatformInfo:async()=>({}),
      onMessage:{addListener(fn){handler=fn;}},sendMessage:async message=>events.push(structuredClone(message))},
    storage:{session:{get:async key=>({[key]:storage[key]}),set:async values=>Object.assign(storage,structuredClone(values)),remove:async key=>{delete storage[key];}}},
    permissions:{contains:async()=>assetPermission},
    tabs:{get:async()=>tab(),query:async()=>[activeTab?tab():{id:2,windowId:4,active:true,url:'https://unrelated.example/'}],
      sendMessage:async(_id,message)=>h.send(message),onRemoved:{addListener(){}},
      captureVisibleTab:async()=>{screenshotCalls++;return 'data:image/png;base64,'+(await h.page.screenshot()).toString('base64');}},
    windows:{get:async()=>({id:4,type:'normal',state:'normal'})},
    webNavigation:{getAllFrames:async()=>[{frameId:0,parentFrameId:-1,url:h.page.url(),documentId:'cors-browser-document'}]},
    scripting:{executeScript:async request=>{
      executions.push({world:request.world,functionName:request.func?.name,target:structuredClone(request.target)});
      if(!request.func)return [];
      const result=await h.page.evaluate(({source,args})=>(0,eval)('('+source+')')(...args),{source:request.func.toString(),args:request.args||[]});
      return [{frameId:0,documentId:'cors-browser-document',result}];
    }},action:{onClicked:{addListener(){}}}};
  const context=vm.createContext({chrome,URL,AbortController,AbortSignal,DOMException,Blob,Response,Headers,TextEncoder,
    setTimeout,clearTimeout,setInterval,clearInterval,fetch:async(url,options)=>{
      if(String(url)===f.imageURL){assets.push({url:String(url),credentials:options?.credentials,redirect:options?.redirect});if(deferAssetFetch)await assetGate;}
      return fetch(url,options);
    }});
  vm.runInContext(await readFile(new URL('../extension/background.js',import.meta.url),'utf8'),context);
  vm.runInContext(await readFile(new URL('../extension/visual-bridge.js',import.meta.url),'utf8'),context);
  // Execute the production rasterization functions with real Chromium image
  // decoding and OffscreenCanvas. Only Chrome APIs/worker scheduling are stubs.
  const helpers=['rasterizeVisualBitmap','rasterizeVisualBlob','cropVisualCapture'].map(name=>{
    assertEndpoint(typeof context[name]==='function','Missing production visual helper '+name);return context[name].toString();
  }).join('\n');
  await h.page.evaluate(source=>{window.__actualVisualRaster=(0,eval)('(()=>{'+source+';return {rasterizeVisualBlob,cropVisualCapture};})()');},helpers);
  context.rasterizeVisualBlob=async(blob,crop=null)=>{
    pixelMethods.push('source');
    return h.page.evaluate(async({bytes,type,crop})=>window.__actualVisualRaster.rasterizeVisualBlob(new Blob([new Uint8Array(bytes)],{type}),crop),
      {bytes:[...new Uint8Array(await blob.arrayBuffer())],type:blob.type,crop});
  };
  context.cropVisualCapture=async(data,geometry)=>{
    pixelMethods.push('crop');return h.page.evaluate(({data,geometry})=>window.__actualVisualRaster.cropVisualCapture(data,geometry),{data,geometry});
  };
  const send=(message,sender={id:'fixture-extension',url:'chrome-extension://fixture-extension/dashboard.html'})=>new Promise((resolve,reject)=>{
    if(!handler({tabId:1,...message},sender,resolve))reject(Error('Worker refused '+message.type));
  });
  await f.installContentBridge(async message=>{
    const response=await send(message,{id:'fixture-extension',tab:tab(),frameId:0,documentId:'cors-browser-document',url:h.page.url()});
    if(message.type==='ALEF_CAPTURE_VISUAL')captureReplies.push(response);return response;
  });
  t.after(()=>send({type:'STOP'}));
  return {...f,chats,events,assets,executions,pixelMethods,captureReplies,releaseAsset,get screenshotCalls(){return screenshotCalls;},send,async start(){
    const connected=await send({type:'CONNECT'});assertEndpoint(connected.ok===true,JSON.stringify(connected));
    const subject=connected.subjects.find(row=>row.id==='current');assertEndpoint(!!subject,JSON.stringify(connected));
    const started=await send({type:'START',subjectId:subject.id,config:{serverUrl,token,qualityMode:true,verify:true,autoSubmit:true,skipInstruction:true}});
    assertEndpoint(started.ok===true,JSON.stringify(started));
  }};
}
function assertEndpoint(value,message){if(!value)throw Error(message);}
