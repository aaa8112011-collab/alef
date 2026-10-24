import test from 'node:test';
import assert from 'node:assert/strict';
import {createCorsPipeline,assertCorsPng} from './visual-cors-fixture.mjs';

async function terminal(f){
  const end=Date.now()+14000;
  for(;;){
    const event=f.events.find(row=>['complete','review','error'].includes(row.event?.kind))?.event;
    if(event)return event;
    if(Date.now()>end)assert.fail(JSON.stringify(f.events));
    await new Promise(resolve=>setTimeout(resolve,20));
  }
}

for(const language of ['ar','en'])for(const assetPermission of [true,false])test(`${language}: a displayed two-dropdown question with a no-CORS graph reaches vision and submits through ${assetPermission?'permitted original-source pixels':'a bounded visible crop'}`,async t=>{
  const f=await createCorsPipeline(t,{language,assetPermission}),question=await f.read();
  assert.equal(question.type,'dropdowns');assert.equal(question.fields.length,2);
  assert.equal(question.requiresVision,true);assert.equal(question.visuals.length,1);
  assert.equal(await f.h.page.locator('[data-alef-question],[data-question-id]').count(),0);
  const direct=await f.h.page.evaluate(()=>{
    const image=document.querySelector('#authored-diagram'),canvas=document.createElement('canvas');
    canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;canvas.getContext('2d').drawImage(image,0,0);
    try{canvas.toDataURL();return {loaded:image.complete,width:image.naturalWidth,tainted:false};}
    catch(error){return {loaded:image.complete,width:image.naturalWidth,tainted:error.name==='SecurityError'};}
  });
  assert.deepEqual(direct,{loaded:true,width:320,tainted:true},'Real Chromium must display the image while denying page canvas access');
  await f.start();
  const end=await terminal(f);assert.equal(end.kind,'complete',JSON.stringify({end,chats:f.chats.length,events:f.events}));
  assert.equal(f.chats.length,2,'Both independent vision requests retain the actual graph');
  const pixels=f.chats[0].messages[1].images[0];assert.equal(f.chats[1].messages[1].images[0],pixels);
  await assertCorsPng(f.h,{data:pixels,mimeType:'image/png'});
  assert.equal(f.events.filter(row=>row.event?.kind==='submitted').length,1);
  const state=await f.h.page.evaluate(()=>window.corsQuestionState);
  assert.deepEqual(state.submitted,[[{name:'angle',value:'angle-one'},{name:'relationship',value:'relationship-one'}]]);
  assert.equal(f.screenshotCalls,assetPermission?0:1,'The source path must work without a visible-tab screenshot');
  assert.deepEqual(f.pixelMethods,[assetPermission?'source':'crop']);
  if(assetPermission){assert.equal(f.assets.length,1);assert.equal(f.assets[0].credentials,'omit');assert.equal(f.assets[0].redirect,'error');}
  else assert.equal(f.assets.length,0,'Missing asset permission must not be bypassed by privileged fetch');
  assert.equal(JSON.stringify(f.events).includes(pixels),false,'Pixel data never enters the UI run history');
  assert.equal(await f.h.page.locator('[data-alef-visual-target]').count(),0,'The temporary target is removed after capture');
});

test('a no-CORS graph in an inactive tab is never replaced by pixels from another tab',async t=>{
  const f=await createCorsPipeline(t,{assetPermission:false,activeTab:false});await f.start();
  const end=await terminal(f);assert.notEqual(end.kind,'complete',JSON.stringify(end));
  assert.equal(f.screenshotCalls,0);assert.equal(f.assets.length,0);assert.equal(f.chats.length,0);
  assert.deepEqual(await f.h.page.evaluate(()=>window.corsQuestionState.submitted),[]);
});

async function waitFor(predicate,describe){
  const end=Date.now()+7000;
  while(!predicate()){if(Date.now()>end)assert.fail(describe());await new Promise(resolve=>setTimeout(resolve,10));}
}

test('changing the question while a real no-CORS image read is pending cannot start inference for stale pixels',async t=>{
  const f=await createCorsPipeline(t,{deferAssetFetch:true});await f.start();
  await waitFor(()=>f.assets.length===1,()=>JSON.stringify(f.events));
  await f.h.page.evaluate(()=>{document.querySelector('.lib-question-statement-container').textContent='A new question is now visible. Read this different graph.';});
  f.releaseAsset();
  const end=await terminal(f);assert.notEqual(end.kind,'complete');
  assert.equal(f.chats.length,0);assert.equal(f.screenshotCalls,0);assert.deepEqual(await f.h.page.evaluate(()=>window.corsQuestionState.submitted),[]);
});

test('STOP during a pending no-CORS image read never produces a late model request or submission',async t=>{
  const f=await createCorsPipeline(t,{deferAssetFetch:true});await f.start();
  await waitFor(()=>f.assets.length===1,()=>JSON.stringify(f.events));
  assert.equal((await f.send({type:'STOP'})).ok,true);f.releaseAsset();
  await waitFor(()=>f.captureReplies.length===1,()=>JSON.stringify(f.events));
  assert.equal(f.chats.length,0);assert.equal(f.screenshotCalls,0);assert.deepEqual(await f.h.page.evaluate(()=>window.corsQuestionState.submitted),[]);
  assert.equal(f.events.some(row=>row.event?.kind==='submitted'),false);
  assert.equal(await f.h.page.locator('[data-alef-visual-target]').count(),0);
});


async function assertCompletedCapture(f,{scale=1,method='crop'}={}){
  await f.start();const end=await terminal(f);
  assert.equal(end.kind,'complete',JSON.stringify({end,chats:f.chats.length,events:f.events}));
  assert.equal(f.chats.length,2);
  const image=f.chats[0].messages[1].images[0];assert.equal(f.chats[1].messages[1].images[0],image);
  const pixels=await assertCorsPng(f.h,{data:image,mimeType:'image/png'},{scale});
  assert.equal(f.events.filter(row=>row.event?.kind==='submitted').length,1);
  assert.deepEqual((await f.h.page.evaluate(()=>window.corsQuestionState)).submitted,[[{name:'angle',value:'angle-one'},{name:'relationship',value:'relationship-one'}]]);
  assert.deepEqual(f.pixelMethods,[method]);assert.equal(f.screenshotCalls,method==='source'?0:1);
  assert.equal(JSON.stringify(f.events).includes(image),false);
  return pixels;
}

test('a visibly rendered authored graph marked aria-hidden retains its original source pixels',async t=>{
  const f=await createCorsPipeline(t,{ariaHidden:true});
  assert.equal(await f.h.page.locator('#authored-diagram').getAttribute('aria-hidden'),'true');
  const question=await f.read();assert.equal(question.requiresVision,true);assert.equal(question.visuals.length,1);
  await assertCompletedCapture(f,{method:'source'});assert.equal(f.assets.length,1);
});

test('a DPR 2 visible crop preserves all 640 by 440 physical pixels of the 320 by 220 CSS diagram',async t=>{
  const f=await createCorsPipeline(t,{assetPermission:false,dpr:2});
  assert.equal(await f.h.page.evaluate(()=>devicePixelRatio),2);
  const rect=await f.h.page.locator('#authored-diagram').boundingBox();assert.equal(rect.width,320);assert.equal(rect.height,220);
  const pixels=await assertCompletedCapture(f,{scale:2});
  assert.deepEqual(pixels,{width:640,height:440,blue:[0,90,220,255]});assert.equal(f.assets.length,0);
});

test('a visible SVG foreignObject graph reaches vision through a stable complete rendered crop',async t=>{
  const f=await createCorsPipeline(t,{assetPermission:false,kind:'foreign-svg'});
  assert.equal(await f.h.page.locator('svg#authored-diagram foreignObject').count(),1);
  assert.equal(await f.h.page.locator('svg#authored-diagram img').count(),0,'No nested image can duplicate the SVG evidence');
  const question=await f.read();assert.equal(question.visuals.length,1);assert.equal(question.visuals[0].kind,'svg');
  assert.equal((await f.read()).fingerprint,question.fingerprint);
  await assertCompletedCapture(f);assert.equal(f.assets.length,0);
});
