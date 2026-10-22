import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import vm from 'node:vm';
import {chromium} from 'playwright';

// These fixtures use two actual HTTP origins. The Chrome bridge below models
// frame-targeted extension APIs; it does not grant Chrome host permissions.
const childHTML=`<!doctype html><meta charset="utf-8"><title>Embedded lesson</title>
<style>body{font:18px system-ui;padding:15px}button,label{display:block;margin:15px;padding:12px}</style><main></main><script>
const main=document.querySelector('main'),lesson=location.pathname.split('/').pop();
const tell=(kind,extra={})=>top.postMessage({fixture:true,kind,lesson,...extra},'*');
function instruction(){main.innerHTML='<p>Read the ordinary lesson introduction.</p><button>Start</button>';main.querySelector('button').onclick=()=>{tell('child-start');question()};}
function question(){
  main.innerHTML='<section data-alef-question="embedded-question"><h2 data-alef-question-text>ما ناتج 2 + 2؟ What is 2 + 2?</h2><label data-alef-option="a"><input type="radio" name="answer" value="a">3</label><label data-alef-option="b"><input type="radio" name="answer" value="b">4</label><button data-alef-submit disabled>Submit Answer</button></section>';
  const submit=main.querySelector('button');
  main.querySelectorAll('input').forEach(input=>input.onchange=()=>{tell('choice',{answer:input.value});submit.disabled=false});
  submit.onclick=()=>{
    const answer=main.querySelector('input:checked')?.value;tell('submit',{answer});
    if(answer!=='b')throw Error('Incorrect fixture answer.');
    submit.remove();main.querySelectorAll('input').forEach(input=>input.disabled=true);
    const feedback=document.createElement('p');feedback.setAttribute('data-testid','answer-feedback');feedback.textContent='Correct answer';main.append(feedback);
    const next=document.createElement('button');next.textContent='Next';next.setAttribute('data-alef-next','');next.onclick=()=>{tell('child-next');main.innerHTML='<section data-alef-completed>Lesson completed</section>';tell('child-complete')};main.append(next);
  };
}
instruction();
</script>`;

function parentHTML(childOrigin){return `<!doctype html><html lang="ar"><meta charset="utf-8"><title>Frame transport course fixture</title>
<style>body{font:18px system-ui;max-width:1000px;margin:20px auto}button{padding:12px;margin:12px}article{border:1px solid #ddd;padding:12px}iframe{width:800px;height:470px}</style>
<main></main><script>
const main=document.querySelector('main'),childOrigin=${JSON.stringify(childOrigin)};
const state={actions:[],completed:[],lesson:null,childDone:false};
const record=(kind,extra={})=>state.actions.push({kind,lesson:state.lesson,...extra});
const button=(label,testId,fn)=>{const b=document.createElement('button');b.textContent=label;if(testId)b.setAttribute('data-testid',testId);b.onclick=fn;return b};
function catalog(){
  history.replaceState(null,'','#/classes/frame-class?tab=assigned');main.innerHTML='<h1>اللغة العربية</h1><button role="tab" aria-selected="true" data-state="active" data-testid="core-coursework-assigned-tab-select">المهام المسندة</button><button aria-pressed="true" data-testid="core-coursework-assigned-all-chip-filter">الكل</button>';
  for(const id of ['one','two']){
    const card=document.createElement('article');card.setAttribute('data-testid','core-coursework-assigned-activity-card-navigate');
    const title=document.createElement('h3');title.dir='ltr';title.textContent=id==='one'?'1. الاستعارة':'2. Review';card.append(title);
    card.append(button(state.completed.includes(id)?'Review':'Start','core-coursework-assigned-activity-btn-navigate',()=>open(id)));main.append(card);
  }
}
function open(id){
  state.lesson=id;state.childDone=false;record('open');history.replaceState(null,'','#/progress/ncle/class/frame-class/lesson/'+id+'/material/embedded');
  main.innerHTML='<section data-testid="ncle-activity-page"><div data-testid="ncle-activity-page-player"></div></section>';
  const player=main.querySelector('div');const frame=document.createElement('iframe');frame.setAttribute('data-testid','iframed-mlo');frame.src=childOrigin+'/lesson/'+id;player.append(frame);
  const help=document.createElement('aside');help.setAttribute('data-alef-supplementary','');const helpFrame=document.createElement('iframe');helpFrame.src=childOrigin+'/help';helpFrame.style.height='80px';help.append(helpFrame);player.append(help);
  const next=button('Next','activity-navigation-bar__next-button',()=>{
    record('parent-next',{childDone:state.childDone});if(!state.childDone)throw Error('Skipped unfinished component.');
    player.innerHTML='<section data-testid="ncle-assessment-result">Section result</section>';
    player.append(button('Finish','activity-navigation-bar__finish-button',()=>{
      record('parent-finish');state.completed.push(id);main.innerHTML='<section data-testid="ncle-completion-page"><h1>Completed</h1></section>';
      main.firstElementChild.append(button('Back to coursework','ncle-completion-page-back',()=>{record('back');catalog()}));
    }));
  });next.disabled=true;player.append(next);
}
window.addEventListener('message',event=>{if(event.origin!==childOrigin||!event.data.fixture||event.data.lesson!==state.lesson)return;const {kind,lesson,...extra}=event.data;record(kind,extra);if(kind==='child-complete'){state.childDone=true;setTimeout(()=>{const next=document.querySelector('[data-testid="activity-navigation-bar__next-button"]');if(next)next.disabled=false},240)}});
window.frameFixture={get state(){return structuredClone(state)}};
const subject=button('اللغة العربية',null,()=>{record('subject');catalog()});subject.setAttribute('data-alef-subject','arabic');main.append(subject);
</script></html>`;}

async function listen(html){
  const server=createServer((request,response)=>{response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end(typeof html==='function'?html(request):html)});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  return {server,origin:`http://127.0.0.1:${server.address().port}`};
}
const closeServer=server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections()});

async function setup(t,{granted=true,holdSolve=false,sameOrigin=false}={}){
  const child=await listen(childHTML);
  const top=sameOrigin
    ?await listen(request=>/^\/(?:lesson\/|help)/.test(request.url)?childHTML:parentHTML(top.origin))
    :await listen(parentHTML(child.origin));
  const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH||existsSync('/usr/bin/chromium')?{executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'}:{}),args:['--no-sandbox','--disable-dev-shm-usage']});
  const page=await browser.newPage({locale:'ar-AE'});
  let sendWorker,releaseSolve=()=>{};
  t.after(async()=>{try{if(sendWorker)await sendWorker({type:'STOP'})}finally{releaseSolve();await browser.close();await Promise.all([closeServer(top.server),closeServer(child.server)])}});
  await page.addInitScript(()=>{
    window.__handlers=[];window.chrome={runtime:{id:'frame-test',onMessage:{addListener(fn){window.__handlers.push(fn)}}}};
    window.__sendContent=message=>new Promise((resolve,reject)=>{
      for(const listener of window.__handlers){let answered=false;const accepted=listener(message,{id:'frame-test'},result=>{answered=true;resolve(result)});if(answered||accepted===true)return}
      reject(new Error('Content message was not accepted: '+message.type));
    });
  });
  await page.goto(top.origin);
  const content=await readFile(new URL('../extension/content.js',import.meta.url),'utf8');
  const frameIds=new Map([[page.mainFrame(),0]]),injected=[],messages=[],permissionChecks=[],events=[],storage={},requests=[];
  let nextFrameId=1,permissionGranted=granted,handler,frameScans=0;
  const solveGate=holdSolve?new Promise(resolve=>{releaseSolve=resolve}):Promise.resolve();
  function idOf(frame){if(!frameIds.has(frame))frameIds.set(frame,nextFrameId++);return frameIds.get(frame)}
  function getFrame(id){return page.frames().find(frame=>idOf(frame)===id)}
  const chrome={
    runtime:{id:'frame-test',getURL:path=>'chrome-extension://frame-test/'+path,getPlatformInfo:async()=>({}),onMessage:{addListener(fn){handler=fn}},sendMessage:async message=>events.push(structuredClone(message))},
    storage:{session:{get:async key=>({[key]:storage[key]}),set:async values=>Object.assign(storage,structuredClone(values)),remove:async key=>{delete storage[key]}}},
    permissions:{contains:async request=>{permissionChecks.push(structuredClone(request));return permissionGranted&&request.origins.every(origin=>origin===child.origin+'/*')}},
    webNavigation:{getAllFrames:async()=>{frameScans++;return page.frames().map(frame=>({frameId:idOf(frame),parentFrameId:frame.parentFrame()?idOf(frame.parentFrame()):-1,url:frame.url(),documentId:'document-'+idOf(frame),errorOccurred:false}))}},
    scripting:{executeScript:async({target})=>{
      assert.ok(Array.isArray(target.frameIds),'Injection must explicitly target frame IDs');
      for(const id of target.frameIds){const frame=getFrame(id);assert.ok(frame,'Injected frame must exist');assert.ok(id===0||permissionGranted,'Unpermitted child must never be injected');injected.push({frameId:id,url:frame.url()});await frame.addScriptTag({content})}
    }},
    tabs:{get:async()=>({id:1,url:page.url()}),sendMessage:async(_id,message,options)=>{
      const frameId=options?.frameId??0;messages.push({frameId,type:message.type});const frame=getFrame(frameId);if(!frame)throw Error('Frame detached');return frame.evaluate(value=>window.__sendContent(value),message);
    },update:async(_id,update)=>{await page.goto(update.url);return{id:1,url:page.url()}},create:async()=>{},onRemoved:{addListener(){}}},
    action:{onClicked:{addListener(){}}},
  };
  vm.runInNewContext(await readFile(new URL('../extension/background.js',import.meta.url),'utf8'),{chrome,URL,AbortController,AbortSignal,DOMException,setTimeout,clearTimeout,setInterval,clearInterval,fetch:async(url,options)=>{
    if(url.endsWith('/api/health'))return Response.json({ok:true,protocolVersion:2,visionReady:true});
    assert.ok(url.endsWith('/api/solve'),String(url));const {question}=JSON.parse(options.body);requests.push(structuredClone(question));
    assert.match(question.text,/2 \+ 2/,'The child question must reach the solver');
    await solveGate;
    const answer=question.options.find(option=>option.text.trim()==='4');assert.ok(answer,JSON.stringify(question));
    return Response.json({answer:{optionIds:[answer.id],text:'',explanation:'Deterministic frame transport fixture, not a model accuracy test.',confidence:.99},verified:false,needsReview:false});
  }},{filename:'frame-worker-background.js'});
  const send=message=>new Promise((resolve,reject)=>{if(!handler({tabId:1,...message},{id:'frame-test',url:'chrome-extension://frame-test/dashboard.html'},value=>resolve(structuredClone(value))))reject(Error('Worker rejected '+message.type))});
  sendWorker=send;
  const config={serverUrl:'http://127.0.0.1:4318',token:'test-frame-local-only',qualityMode:false,verify:false,autoSubmit:true,skipInstruction:true,minConfidence:.85};
  return {page,send,config,events,requests,injected,messages,permissionChecks,releaseSolve,frameScans:()=>frameScans,childOrigin:sameOrigin?top.origin:child.origin,grant(){permissionGranted=true},state:()=>page.evaluate(()=>window.frameFixture.state),async start(){
    const connection=await send({type:'CONNECT'});assert.equal(connection.ok,true,JSON.stringify(connection));const subject=connection.subjects.find(subject=>subject.id==='arabic')||connection.subjects.find(subject=>subject.id==='current');assert.ok(subject);
    const result=await send({type:'START',subjectId:subject.id,config});assert.equal(result.ok,true,JSON.stringify(result));
  }};
}

async function waitFor(h,predicate,{after=0,timeout=20000}={}){
  const deadline=Date.now()+timeout;
  for(;;){const event=h.events.slice(after).map(item=>item.event).find(event=>event&&predicate(event));if(event)return event;if(Date.now()>deadline)assert.fail(JSON.stringify({events:h.events,requests:h.requests,messages:h.messages}));await new Promise(resolve=>setTimeout(resolve,25))}
}
async function assertCompleted(h){
  const terminal=await waitFor(h,event=>['complete','review','error'].includes(event.kind));
  const actual=await h.state();
  assert.equal(terminal.kind,'complete',JSON.stringify({terminal,actions:actual.actions,messages:h.messages.slice(-24)}));
  assert.deepEqual(actual.completed,['one','two']);
  assert.equal(actual.actions.filter(action=>action.kind==='subject').length,1);
  for(const lesson of ['one','two']){
    for(const kind of ['open','child-start','choice','submit','child-next','child-complete','parent-next','parent-finish'])assert.equal(actual.actions.filter(action=>action.lesson===lesson&&action.kind===kind).length,1,lesson+': '+kind);
    const actions=actual.actions.filter(action=>action.lesson===lesson).map(action=>action.kind);
    assert.ok(actions.indexOf('child-complete')<actions.indexOf('parent-next'));
    assert.ok(actions.indexOf('parent-next')<actions.indexOf('parent-finish'));
    assert.equal(actual.actions.find(action=>action.lesson===lesson&&action.kind==='submit').answer,'b');
    assert.equal(actual.actions.find(action=>action.lesson===lesson&&action.kind==='parent-next').childDone,true);
  }
  const firstFinish=actual.actions.findIndex(action=>action.kind==='parent-finish'&&action.lesson==='one');
  const secondOpen=actual.actions.findIndex(action=>action.kind==='open'&&action.lesson==='two');
  assert.ok(firstFinish>=0&&secondOpen>firstFinish,'Child completion alone must not advance to another NCLE lesson');
  assert.equal(h.requests.length,2,'Each embedded question is solved exactly once');
  assert.ok(h.messages.some(message=>message.type==='ALEF_APPLY'&&message.frameId!==0));
  assert.ok(h.messages.filter(message=>['ALEF_SCAN','ALEF_SELECT_SUBJECT','ALEF_OPEN_LESSON'].includes(message.type)).every(message=>message.frameId===0));
  assert.equal(h.injected.some(row=>row.url.endsWith('/help')),false,'A visible supplementary frame must never receive the lesson content script');
  const state=(await h.send({type:'GET_STATE'})).state;assert.equal(state.stats.solved,2);assert.equal(state.stats.lessonsCompleted,2);assert.equal(state.stats.review,0);assert.deepEqual(state.blockedFrames,[]);
  return actual;
}

test('permitted cross-origin lesson frames submit once and traverse the parent NCLE completion sequence',async t=>{
  const h=await setup(t);await h.start();await assertCompleted(h);
  assert.ok(h.injected.some(row=>row.frameId!==0&&row.url.startsWith(h.childOrigin)));
  assert.ok(h.permissionChecks.some(request=>request.origins.includes(h.childOrigin+'/*')));
});

test('a readable same-origin required material still completes the parent NCLE sequence before the next lesson',async t=>{
  const h=await setup(t,{sameOrigin:true,holdSolve:true});await h.start();
  await waitFor(h,event=>event.kind==='question');
  assert.equal(await h.page.locator('iframe[data-testid="iframed-mlo"]').evaluate(frame=>!!frame.contentDocument?.documentElement),true);
  assert.equal((await h.state()).completed.length,0,'A mounted readable child cannot mark the parent lesson complete');
  h.releaseSolve();await assertCompleted(h);
  assert.ok(h.injected.some(row=>row.frameId!==0&&row.url.startsWith(h.childOrigin+'/lesson/')),'Required readable materials also use explicit child routing');
});

test('loaded static instruction uses the SDK-unlocked parent Next without requiring a child completion marker',async t=>{
  const h=await setup(t);
  await h.page.locator('[data-alef-subject]').click();
  await h.page.locator('[data-testid="core-coursework-assigned-activity-btn-navigate"]').first().click();
  await h.page.frameLocator('iframe[data-testid="iframed-mlo"]').getByRole('button',{name:'Start',exact:true}).waitFor();
  const content=h.page.frames().find(frame=>frame.url()===h.childOrigin+'/lesson/one');assert.ok(content);
  await content.waitForLoadState('load');
  await content.evaluate(()=>{main.innerHTML='<article><h1>الاستعارة</h1><p>اقرأ أمثلة الدرس قبل المتابعة.</p></article>';tell('child-complete')});
  await h.page.locator('[data-testid="activity-navigation-bar__next-button"]').waitFor({state:'visible'});
  await h.page.waitForFunction(()=>!document.querySelector('[data-testid="activity-navigation-bar__next-button"]').disabled);
  await h.start();
  const terminal=await waitFor(h,event=>['review','error','complete'].includes(event.kind));
  assert.equal(terminal.kind,'complete',JSON.stringify(terminal));
  assert.equal(h.requests.length,0,'Instructional HTML does not need a fabricated question or solver request');
  const state=await h.state();assert.deepEqual(state.completed,['one']);
  assert.equal(state.actions.filter(action=>action.kind==='parent-next').length,1);
  assert.equal(state.actions.filter(action=>action.kind==='parent-finish').length,1);
});

test('missing frame permission keeps the current lesson and resumes it without opening the subject or lesson again',async t=>{
  const h=await setup(t,{granted:false});await h.start();
  const blocked=await waitFor(h,event=>['review','error'].includes(event.kind));
  assert.equal(blocked.kind,'review',JSON.stringify(blocked));assert.equal(blocked.cause,'frame_permission_required');
  assert.deepEqual(blocked.blockedFrames,[{origin:h.childOrigin}]);assert.equal(h.requests.length,0);
  assert.equal(h.injected.some(row=>row.frameId!==0),false);
  const before=await h.state();assert.equal(before.actions.filter(action=>action.kind==='open').length,1);assert.equal(before.actions.filter(action=>action.kind==='submit').length,0);
  const blockedState=(await h.send({type:'GET_STATE'})).state;
  assert.deepEqual(blockedState.blockedFrames,[{origin:h.childOrigin}]);
  assert.equal(blockedState.queue.filter(lesson=>lesson.status==='pending').length,1,'Later lessons must remain pending');
  // A real Chrome permission request is initiated by the dashboard user gesture.
  h.grant();const boundary=h.events.length;
  const resumed=await h.send({type:'RESUME_FRAMES',config:h.config});assert.equal(resumed.ok,true,JSON.stringify(resumed));
  const terminal=await waitFor(h,event=>['complete','review','error'].includes(event.kind),{after:boundary});
  assert.equal(terminal.kind,'complete',JSON.stringify(terminal));
  // Reuse the shared assertion while excluding the already-handled pause event.
  h.events.splice(0,boundary);await assertCompleted(h);
});

test('two visible required question frames stop before solving or selecting either answer',async t=>{
  const h=await setup(t);
  await h.page.locator('[data-alef-subject]').click();
  await h.page.locator('[data-testid="core-coursework-assigned-activity-btn-navigate"]').first().click();
  await h.page.locator('iframe[data-testid="iframed-mlo"]').waitFor();
  const secondURL=h.childOrigin+'/lesson/second-question';
  await Promise.all([
    h.page.waitForEvent('framenavigated',frame=>frame.url()===secondURL),
    h.page.evaluate(url=>{const frame=document.createElement('iframe');frame.src=url;frame.setAttribute('data-testid','iframed-mlo');document.querySelector('[data-testid="ncle-activity-page-player"]').append(frame)},secondURL),
  ]);
  for(const frame of h.page.frames().filter(frame=>frame.url().startsWith(h.childOrigin+'/lesson/'))){await frame.waitForLoadState('load');await frame.evaluate(()=>question())}
  await h.start();
  const terminal=await waitFor(h,event=>['review','error','complete'].includes(event.kind));
  assert.ok(['review','error'].includes(terminal.kind),JSON.stringify(terminal));assert.match(terminal.message,/أكثر من سؤال/);
  assert.equal(h.requests.length,0);assert.equal(h.messages.some(message=>message.type==='ALEF_APPLY'),false);
  assert.equal((await h.state()).actions.some(action=>['choice','submit'].includes(action.kind)),false);
  assert.equal(h.injected.some(row=>row.url.endsWith('/help')),false);
});

test('STOP cancels an active child frame and ignores a delayed model response',async t=>{
  const h=await setup(t,{holdSolve:true});await h.start();
  await waitFor(h,event=>event.kind==='question');
  const deadline=Date.now()+5000;
  while(h.requests.length===0){if(Date.now()>deadline)assert.fail('The child solve request did not start');await new Promise(resolve=>setTimeout(resolve,20))}
  const result=await h.send({type:'STOP'});assert.equal(result.ok,true);
  h.releaseSolve();await new Promise(resolve=>setTimeout(resolve,120));
  const actual=await h.state();assert.equal(actual.actions.some(action=>['choice','submit'].includes(action.kind)),false);
  assert.equal(h.messages.some(message=>message.type==='ALEF_APPLY'),false,'A response that arrives after STOP must not reach any frame');
  assert.ok(h.messages.some(message=>message.type==='ALEF_CANCEL'&&message.frameId===0));
  assert.ok(h.messages.some(message=>message.type==='ALEF_CANCEL'&&message.frameId!==0),'STOP must cancel the injected child, too');
  assert.equal((await h.send({type:'GET_STATE'})).state.status,'stopped');
});

test('question pixels are captured in the active cross-origin frame and never persisted in events',async t=>{
  const h=await setup(t);
  await h.page.locator('[data-alef-subject]').click();
  await h.page.locator('[data-testid="core-coursework-assigned-activity-btn-navigate"]').first().click();
  const deadline=Date.now()+5000;let child;
  while(!child){child=h.page.frames().find(frame=>frame.url()===h.childOrigin+'/lesson/one');if(Date.now()>deadline)assert.fail('Child did not load');if(!child)await new Promise(resolve=>setTimeout(resolve,20))}
  await child.waitForLoadState('load');
  await child.evaluate(()=>{
    question();
    const canvas=document.createElement('canvas');canvas.width=240;canvas.height=160;canvas.setAttribute('aria-label','Two plus two visual evidence');
    const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,240,160);ctx.fillStyle='#0060dd';ctx.fillRect(20,20,60,60);
    document.querySelector('[data-alef-question]').append(canvas);
  });
  await h.start();
  const terminal=await waitFor(h,event=>['complete','review','error'].includes(event.kind));assert.equal(terminal.kind,'complete',JSON.stringify(terminal));
  assert.equal(h.requests.length,1);const request=h.requests[0];assert.equal(request.requiresVision,true);assert.equal(request.images.length,1);
  assert.ok(Buffer.from(request.images[0],'base64').subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'The actual frame canvas must become PNG pixels');
  const capture=h.messages.find(message=>message.type==='ALEF_GET_VISUALS');const apply=h.messages.find(message=>message.type==='ALEF_APPLY');
  assert.ok(capture.frameId!==0);assert.equal(capture.frameId,apply.frameId,'Evidence and mutation must use the same question frame');
  assert.equal(JSON.stringify(h.events).includes(request.images[0]),false,'Pixel data must not enter stored dashboard events');
  assert.deepEqual((await h.state()).completed,['one'],'The embedded result still traverses the parent Finish');
});

test('an ordinary foreign HTTPS lesson frame never inherits its Alef or local initiator permission',async t=>{
  const h=await setup(t),foreignURL='https://foreign-frame.invalid/lesson';
  await h.page.route('https://foreign-frame.invalid/**',route=>route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:childHTML}));
  await h.page.locator('[data-alef-subject]').click();
  await h.page.locator('[data-testid="core-coursework-assigned-activity-btn-navigate"]').first().click();
  await Promise.all([
    h.page.waitForEvent('framenavigated',frame=>frame.url()===foreignURL),
    h.page.locator('iframe[data-testid="iframed-mlo"]').evaluate((frame,url)=>{frame.src=url},foreignURL),
  ]);
  const foreign=h.page.frames().find(frame=>frame.url()===foreignURL);assert.ok(foreign);await foreign.waitForLoadState('load');
  await h.start();
  const deadline=Date.now()+5000;
  while(h.frameScans()<2&&!h.events.some(item=>['review','error','complete'].includes(item.event?.kind))){
    if(Date.now()>deadline)assert.fail('Worker did not inspect the foreign frame');await new Promise(resolve=>setTimeout(resolve,25));
  }
  await h.send({type:'STOP'});
  assert.ok(h.frameScans()>0);assert.equal(h.injected.some(row=>row.url===foreignURL),false,'An ordinary HTTPS URL cannot use related-frame initiator fallback');
  assert.equal(h.permissionChecks.length,0,'Foreign frames must not even cause an optional host-permission probe');
  assert.equal(h.requests.length,0);assert.equal(h.messages.some(message=>message.type==='ALEF_APPLY'),false);
  assert.deepEqual((await h.send({type:'GET_STATE'})).state.blockedFrames,[],'No permission prompt may be offered for an unrelated origin');
});

for(const wrapperKind of ['http','srcdoc'])test(`a required cross-origin lesson nested inside an accessible ${wrapperKind} wrapper uses its actual child frame ID`,async t=>{
  const h=await setup(t),topOrigin=new URL(h.page.url()).origin,wrapperURL=wrapperKind==='srcdoc'?'about:srcdoc':topOrigin+'/wrapper';
  await h.page.route(h.childOrigin+'/lesson/one',route=>route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:childHTML.replace('parent.postMessage(', 'top.postMessage(')}));
  const wrapperHTML='<!doctype html><title>Accessible wrapper</title><iframe data-testid="iframed-mlo" style="width:780px;height:450px" src="'+h.childOrigin+'/lesson/one"></iframe>';
  if(wrapperKind==='http')await h.page.route(wrapperURL,route=>route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:wrapperHTML}));
  await h.page.locator('[data-alef-subject]').click();
  await h.page.locator('[data-testid="core-coursework-assigned-activity-btn-navigate"]').first().click();
  await Promise.all([
    h.page.waitForEvent('framenavigated',frame=>frame.url()===wrapperURL),
    h.page.locator('iframe[data-testid="iframed-mlo"]').evaluate((frame,{kind,url,html})=>{if(kind==='srcdoc')frame.srcdoc=html;else frame.src=url},{kind:wrapperKind,url:wrapperURL,html:wrapperHTML}),
  ]);
  const wrapper=h.page.frames().find(frame=>frame.url()===wrapperURL);assert.ok(wrapper);
  await wrapper.frameLocator('iframe').getByRole('button',{name:'Start',exact:true}).waitFor();
  const nested=wrapper.childFrames().find(frame=>frame.url()===h.childOrigin+'/lesson/one');assert.ok(nested);await nested.waitForLoadState('load');
  await h.start();
  const terminal=await waitFor(h,event=>['review','error','complete'].includes(event.kind));assert.equal(terminal.kind,'complete',JSON.stringify(terminal));
  assert.equal(h.requests.length,1);assert.deepEqual((await h.state()).completed,['one']);
  assert.equal(h.injected.some(row=>row.url===wrapperURL),true,'The required NCLE wrapper is inspected independently from the full lesson');
  const child=h.injected.find(row=>row.url===h.childOrigin+'/lesson/one');assert.ok(child);
  assert.ok(h.messages.some(message=>message.type==='ALEF_APPLY'&&message.frameId===child.frameId));
  assert.equal(h.injected.some(row=>row.url.endsWith('/help')),false);
});
