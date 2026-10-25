import test from 'node:test';
import assert from 'node:assert/strict';
import {createCorsPipeline,assertCorsPng} from './visual-cors-fixture.mjs';

// Real DOM, CORS-denied HTTP image, Chromium screenshot/crop, worker and local
// authenticated server. Tab APIs and provider replies are explicit stubs. A
// separate red browser page represents private pixels from an unrelated tab.
async function waitFor(predicate,describe,timeout=12000){
  const deadline=Date.now()+timeout;
  while(!predicate()){
    if(Date.now()>deadline)assert.fail(describe());
    await new Promise(resolve=>setTimeout(resolve,15));
  }
}
async function terminal(f){
  await waitFor(()=>f.events.some(row=>['complete','review','error'].includes(row.event?.kind)),()=>JSON.stringify(f.events));
  return f.events.find(row=>['complete','review','error'].includes(row.event?.kind)).event;
}
async function screenshotPending(f){
  await waitFor(()=>f.screenshotCalls===1,()=>JSON.stringify({events:f.events,updates:f.tabUpdates}),5000);
  await f.screenshotStarted;
}
async function noAnswer(f){
  assert.equal(f.chats.length,0,'Invalidated screenshot pixels must not reach inference');
  assert.deepEqual(await f.h.page.evaluate(()=>window.corsQuestionState.submitted),[]);
  assert.equal(f.events.some(row=>row.event?.kind==='submitted'),false);
  assert.equal(f.windowUpdates.length,0,'Capture must not focus or resize a Chrome window');
}

for(const language of ['ar','en'])test(`${language}: an inactive Alef tab is automatically selected for its graph crop then the previous tab is restored`,async t=>{
  const f=await createCorsPipeline(t,{language,assetPermission:false,activeTab:false,autoActivateTabs:true});
  assert.equal(f.activeTabId,2);
  await f.start();const end=await terminal(f);
  assert.equal(end.kind,'complete',JSON.stringify({end,updates:f.tabUpdates,events:f.events}));
  assert.deepEqual(f.tabUpdates,[{id:1,options:{active:true}},{id:2,options:{active:true}}]);
  assert.equal(f.activeTabId,2,'The previously selected unrelated tab must be restored');
  assert.equal(f.windowUpdates.length,0);assert.equal(f.screenshotCalls,1);assert.equal(f.assets.length,0);
  assert.deepEqual(f.pixelMethods,['crop']);assert.equal(f.chats.length,2);
  const pixels=f.chats[0].messages[1].images[0];
  assert.equal(f.chats[1].messages[1].images[0],pixels);
  await assertCorsPng(f.h,{data:pixels,mimeType:'image/png'});
  assert.equal(f.events.filter(row=>row.event?.kind==='submitted').length,1);
  assert.deepEqual(await f.h.page.evaluate(()=>window.corsQuestionState.submitted),
    [[{name:'angle',value:'angle-one'},{name:'relationship',value:'relationship-one'}]]);
  assert.equal(await f.h.page.locator('[data-alef-visual-target]').count(),0);
  assert.equal(JSON.stringify(f.events).includes(pixels),false);
});

test('a permitted graph source is read in an inactive tab without selecting a tab or focusing a window',async t=>{
  const f=await createCorsPipeline(t,{assetPermission:true,activeTab:false,autoActivateTabs:true});
  await f.start();const end=await terminal(f);
  assert.equal(end.kind,'complete',JSON.stringify(end));
  assert.deepEqual(f.tabUpdates,[]);assert.deepEqual(f.windowUpdates,[]);assert.equal(f.activeTabId,2);
  assert.equal(f.screenshotCalls,0);assert.equal(f.assets.length,1);assert.deepEqual(f.pixelMethods,['source']);
  await assertCorsPng(f.h,{data:f.chats[0].messages[1].images[0],mimeType:'image/png'});
});

test('STOP during automatic capture discards late pixels and restores only its unchanged temporary selection',async t=>{
  const f=await createCorsPipeline(t,{assetPermission:false,activeTab:false,autoActivateTabs:true,deferScreenshot:true});
  await f.start();await screenshotPending(f);
  assert.equal(f.activeTabId,1);assert.equal((await f.send({type:'STOP'})).ok,true);
  f.releaseScreenshot();
  await waitFor(()=>f.captureReplies.length===1,()=>JSON.stringify(f.events));
  assert.equal(f.captureReplies[0].ok,false);assert.equal(Object.hasOwn(f.captureReplies[0],'data'),false);await noAnswer(f);
  assert.deepEqual(f.tabUpdates,[{id:1,options:{active:true}},{id:2,options:{active:true}}]);
  assert.equal(f.activeTabId,2);
});

for(const returnToAlef of [false,true])test(`a user's tab switch during automatic capture ${returnToAlef?'and return to Alef ':''}invalidates the pixels without restoring over the user`,async t=>{
  const f=await createCorsPipeline(t,{assetPermission:false,activeTab:false,autoActivateTabs:true,deferScreenshot:true});
  await f.start();await screenshotPending(f);
  await f.activateTab(3);if(returnToAlef)await f.activateTab(1);
  f.releaseScreenshot();const end=await terminal(f);
  assert.notEqual(end.kind,'complete',JSON.stringify(end));await noAnswer(f);
  assert.equal(f.captureReplies[0].ok,false);
  assert.equal(Object.hasOwn(f.captureReplies[0],'data'),false,'An invalidated capture must not return unrelated pixels');
  assert.deepEqual(f.tabUpdates,[{id:1,options:{active:true}}],'No unconditional restoration may steal the user-selected tab');
  assert.equal(f.activeTabId,returnToAlef?1:3);
});

test('a changed question during automatic capture cannot submit stale graph pixels',async t=>{
  const f=await createCorsPipeline(t,{assetPermission:false,activeTab:false,autoActivateTabs:true,deferScreenshot:true});
  await f.start();await screenshotPending(f);
  await f.h.page.evaluate(()=>{document.querySelector('.lib-question-statement-container').textContent='A new question now owns the diagram.';});
  f.releaseScreenshot();const end=await terminal(f);
  assert.notEqual(end.kind,'complete',JSON.stringify(end));await noAnswer(f);
  assert.equal(f.activeTabId,2);assert.deepEqual(f.tabUpdates,[{id:1,options:{active:true}},{id:2,options:{active:true}}]);
});
