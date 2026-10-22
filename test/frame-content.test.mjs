import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

// These tests use actual browser origin isolation. The extension message bridge
// is simulated; Chrome's optional host-permission UI is tested separately.
async function remoteDocument(t,html) {
  const server=createServer((_request,response)=>{
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    response.end(html);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  return `http://127.0.0.1:${server.address().port}`;
}

async function harness(t,{courseShell=true}={}) {
  const h=await createBrowserHarness();
  t.after(()=>h.close());
  await h.page.evaluate(courseShell=>{
    document.body.innerHTML=courseShell?'<main data-testid="ncle-activity-page"><article data-testid="ncle-activity-page-player"></article></main>':'<main><article></article></main>';
  },courseShell);
  return h;
}

async function mountFrame(h,{url,srcdoc,sandbox,id,hidden=false,testId='iframed-mlo'}={}) {
  const handle=await h.page.evaluateHandle(options=>{
    const frame=document.createElement('iframe');
    if(options.url)frame.src=options.url;
    if(options.srcdoc!==undefined)frame.srcdoc=options.srcdoc;
    if(options.sandbox!==undefined)frame.setAttribute('sandbox',options.sandbox);
    if(options.id)frame.id=options.id;
    if(options.testId)frame.dataset.testid=options.testId;
    frame.hidden=options.hidden;
    frame.style.cssText='width:900px;height:600px';
    document.querySelector('article').append(frame);
    return frame;
  },{url,srcdoc,sandbox,id,hidden,testId});
  const frame=await handle.asElement().contentFrame();
  await frame.waitForLoadState('load');
  return frame;
}

async function installInFrame(h,frame) {
  await frame.evaluate(()=>{
    window.__frameListeners=[];
    window.chrome={runtime:{id:'fixture-extension',onMessage:{addListener(listener){window.__frameListeners.push(listener);}}}};
    window.__frameDispatch=async(message,senderId='fixture-extension')=>{
      for(const listener of window.__frameListeners){
        let resolve;
        const response=new Promise(done=>{resolve=done;});
        let replied=false;
        const accepted=listener(message,{id:senderId},value=>{replied=true;resolve(value);});
        if(accepted===true)return Promise.race([response,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Frame operation timed out')),7000))]);
        if(replied)return response;
      }
      return null;
    };
  });
  await frame.addScriptTag({content:h.contentScript});
  return (message,senderId='fixture-extension')=>frame.evaluate(({message,senderId})=>window.__frameDispatch(message,senderId),{message,senderId});
}

function questionDocument(language='ar') {
  const prompt=language==='ar'?'ما حاصل ضرب ٦ في ٧؟':'What is 6 multiplied by 7?';
  const submit=language==='ar'?'إرسال الإجابة':'Submit Answer';
  const next=language==='ar'?'التالي':'Next';
  return `<!doctype html><meta charset="utf-8"><main>
    <div class="mcq-container question-widget" data-alef-question="${language}-embedded-question">
      <div data-testid="question-statement-container">${prompt}</div>
      <label><input type="radio" name="answer" id="correct" value="correct">42</label>
      <label><input type="radio" name="answer" id="other" value="other">36</label>
    </div>
    <button id="submit">${submit}</button><button id="next" disabled>${next}</button>
    <script>
      document.querySelector('#submit').onclick=()=>{
        document.body.dataset.submitted=document.querySelector('input:checked')?.value||'none';
        document.querySelector('#next').disabled=false;
      };
      document.querySelector('#next').onclick=()=>{document.body.dataset.advanced='true';};
    </script>
  </main>`;
}

test('cross-origin lesson frames expose safe source metadata without pretending the parent read their questions',async t=>{
  const h=await harness(t);
  const origin=await remoteDocument(t,questionDocument());
  await mountFrame(h,{url:origin+'/embed/index.html?token=PRIVATE_TEST_FRAME_TOKEN#PRIVATE_HASH'});
  assert.equal(await h.page.locator('iframe').evaluate(frame=>frame.contentDocument),null,'The parent really is isolated by browser origin rules');
  const snapshot=await h.send({type:'ALEF_INSPECT'});
  assert.equal(snapshot.question,null);
  assert.equal(snapshot.frames.length,1);
  const frame=snapshot.frames[0];
  assert.equal(frame.origin,origin);
  assert.equal(frame.url,origin+'/embed/index.html');
  assert.equal(frame.parentURL,new URL(h.page.url()).origin+'/');
  assert.equal(frame.required,true);
  assert.equal(frame.relevant,true);
  assert.equal(frame.role,'lesson');
  assert.equal(frame.accessible,false);
  assert.equal(frame.readyState,null);
  assert.ok(frame.loading===null||frame.loading===false,'An unobserved iframe load must not be invented');
  const diagnostic=await h.send({type:'ALEF_DIAGNOSTICS'});
  assert.doesNotMatch(JSON.stringify(diagnostic),/PRIVATE_TEST_FRAME_TOKEN|PRIVATE_HASH/);
  assert.ok(diagnostic.diagnostics.issues.some(issue=>issue.includes(new URL(origin).host)));
  assert.ok(diagnostic.diagnostics.issues.every(issue=>!issue.includes('لا تسمح الصفحة بقراءته')),'A missing frame reader does not prove a permanent access denial');
});

for(const language of ['ar','en']){
  test(`${language} questions in a real cross-origin child can be inspected, submitted and advanced in their own frame`,async t=>{
    const h=await harness(t);
    const origin=await remoteDocument(t,questionDocument(language));
    const frame=await mountFrame(h,{url:origin+'/embed/index.html'});
    const send=await installInFrame(h,frame);
    const snapshot=await send({type:'ALEF_INSPECT',topCourseContext:true});
    assert.equal(snapshot.stage,'question',JSON.stringify(snapshot));
    assert.equal(snapshot.context.frame,true);
    assert.equal(snapshot.loading,false);
    assert.equal(snapshot.question.id,language+'-embedded-question');
    assert.match(snapshot.question.text,language==='ar'?/حاصل ضرب ٦ في ٧/:/6 multiplied by 7/);
    const apply={type:'ALEF_APPLY',topCourseContext:true,questionId:snapshot.question.id,questionFingerprint:snapshot.question.fingerprint,
      answer:{optionIds:['correct'],text:''},autoSubmit:true};
    assert.equal(await send({type:'ALEF_BEGIN',topCourseContext:true},'foreign-extension'),null,'Other extensions cannot reset cancellation');
    await send({type:'ALEF_CANCEL',topCourseContext:true});
    await send({type:'ALEF_INSPECT',topCourseContext:true});
    assert.equal((await send(apply)).ok,false,'Inspecting a stopped frame must not restart it');
    assert.equal(await frame.locator('input:checked').count(),0);
    assert.equal((await send({type:'ALEF_BEGIN',topCourseContext:true})).ok,true);
    const applied=await send(apply);
    assert.equal(applied.ok,true,JSON.stringify(applied));
    assert.equal(applied.submitted,true);
    assert.equal(await frame.locator('body').getAttribute('data-submitted'),'correct');
    assert.equal((await send({type:'ALEF_NEXT',topCourseContext:true})).clicked,true);
    assert.equal(await frame.locator('body').getAttribute('data-advanced'),'true');
    assert.equal((await h.send({type:'ALEF_INSPECT'})).question,null,'Child answers never get associated with a different parent question');
  });
}

test('bare embed navigation needs trusted course context and loading shells remain pending',async t=>{
  const h=await harness(t);
  const origin=await remoteDocument(t,'<!doctype html><main><button id="start">Start</button><script>document.querySelector("button").onclick=()=>{document.body.dataset.started="true";};</script></main>');
  const frame=await mountFrame(h,{url:origin+'/embed/index.html'});
  const send=await installInFrame(h,frame);
  assert.equal((await send({type:'ALEF_INSPECT'})).navigation.length,0);
  const instruction=await send({type:'ALEF_INSPECT',topCourseContext:true});
  assert.equal(instruction.stage,'instruction');
  const start=instruction.navigation.find(action=>action.kind==='next');
  assert.ok(start);
  assert.equal((await send({type:'ALEF_NAVIGATE',topCourseContext:true,actionId:start.id,fingerprint:instruction.fingerprint})).ok,true);
  assert.equal(await frame.locator('body').getAttribute('data-started'),'true');
  await frame.evaluate(()=>{document.body.innerHTML='<div class="spinner" style="width:20px;height:20px"></div>';});
  assert.equal((await send({type:'ALEF_INSPECT',topCourseContext:true})).loading,true);
  await frame.evaluate(()=>{document.body.innerHTML='<button>Next</button>';});
  assert.equal((await send({type:'ALEF_INSPECT',topCourseContext:true})).loading,false);
  await frame.evaluate(()=>{document.body.innerHTML='<form id="login"><input type="password"><button>Start</button></form>';});
  const login=await send({type:'ALEF_INSPECT',topCourseContext:true});
  assert.equal(login.stage,'unknown');
  assert.equal(login.navigation.length,0,'Trusted parent context must not turn a sign-in button into a lesson action');
});

test('same-origin srcdoc remains readable while opaque and supplementary frames are identified without source payloads',async t=>{
  const h=await harness(t,{courseShell:false});
  await mountFrame(h,{srcdoc:questionDocument()});
  const readable=await h.send({type:'ALEF_INSPECT'});
  assert.equal(readable.stage,'question');
  assert.equal(readable.question.id,'ar-embedded-question');
  assert.equal(readable.frames[0].kind,'srcdoc');
  assert.equal(readable.frames[0].accessible,true);
  assert.equal(readable.frames[0].loading,false);
  assert.equal(readable.frames[0].url,'about:srcdoc');
  await h.page.locator('iframe').evaluate(frame=>frame.remove());
  await mountFrame(h,{srcdoc:'<!doctype html><p>PRIVATE_SRCDOC_PAYLOAD</p>',sandbox:'allow-scripts'});
  const opaque=await h.send({type:'ALEF_INSPECT'});
  assert.equal(opaque.frames[0].opaque,true);
  assert.equal(opaque.frames[0].accessible,false);
  assert.deepEqual(opaque.frames[0].sandbox,['allow-scripts']);
  assert.doesNotMatch(JSON.stringify(opaque.frames),/PRIVATE_SRCDOC_PAYLOAD/);
  await h.page.locator('iframe').evaluate(frame=>frame.remove());
  await mountFrame(h,{srcdoc:questionDocument(),id:'lesson-float-iframe'});
  const readableHelp=await h.send({type:'ALEF_INSPECT'});
  assert.equal(readableHelp.frames[0].accessible,true);
  assert.equal(readableHelp.frames[0].role,'supplementary');
  assert.equal(readableHelp.question,null,'A readable help-player quiz is not the current assigned lesson');
  await h.page.locator('iframe').evaluate(frame=>frame.remove());
  const origin=await remoteDocument(t,'<!doctype html><p>Optional help player</p>');
  await mountFrame(h,{url:origin+'/help',id:'lesson-float-iframe'});
  await mountFrame(h,{url:origin+'/hidden',hidden:true});
  const optional=await h.send({type:'ALEF_INSPECT'});
  assert.equal(optional.frames.length,1,'Hidden frames must never become required lesson content');
  assert.equal(optional.frames[0].role,'supplementary');
  assert.equal(optional.frames[0].required,false);
  assert.ok(optional.diagnostics.every(issue=>!issue.includes(new URL(origin).host)),'Optional help must not require permission before solving the lesson');
});

test('a readable required NCLE material keeps its question and component completion separate from its parent lesson',async t=>{
  const h=await harness(t);
  const frame=await mountFrame(h,{srcdoc:questionDocument()});
  await h.page.evaluate(()=>{
    const next=document.createElement('button');next.textContent='Next';next.dataset.testid='activity-navigation-bar__next-button';next.disabled=true;
    document.querySelector('article').append(next);
  });
  const pending=await h.send({type:'ALEF_INSPECT'});
  assert.equal(pending.frames[0].accessible,true);
  assert.equal(pending.frames[0].required,true);
  assert.equal(pending.frames[0].independent,true);
  assert.equal(pending.question,null,'The worker must inspect the required material in its own frame');
  assert.equal(pending.completed,false);
  assert.equal(pending.navigation.length,0,'The material Start/Next must not be confused with parent navigation');
  const send=await installInFrame(h,frame);
  const child=await send({type:'ALEF_INSPECT',topCourseContext:true});
  assert.equal(child.question.id,'ar-embedded-question');
  await frame.evaluate(()=>{document.body.innerHTML='<section data-alef-completed>Lesson completed</section>';});
  assert.equal((await send({type:'ALEF_INSPECT',topCourseContext:true})).completed,true);
  const componentDone=await h.send({type:'ALEF_INSPECT'});
  assert.equal(componentDone.completed,false,'Component completion cannot publish full NCLE lesson completion');
  assert.equal(componentDone.stage,'instruction');
  assert.equal(componentDone.navigation.length,0,'Wait for the actual parent Next readiness');
  await h.page.locator('[data-testid="activity-navigation-bar__next-button"]').evaluate(button=>{button.disabled=false;});
  const parentReady=await h.send({type:'ALEF_INSPECT'});
  assert.equal(parentReady.completed,false);
  assert.deepEqual(parentReady.navigation.map(action=>action.kind),['next']);
});
