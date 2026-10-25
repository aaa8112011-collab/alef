import test from 'node:test';
import assert from 'node:assert/strict';
import {createCorsPipeline,assertCorsPng} from './visual-cors-fixture.mjs';

// Real DOM, cross-origin HTTP image bytes, worker and authenticated local
// server; Chrome sender metadata and Ollama replies are explicit stubs. The
// sender URL deliberately describes the earlier page in the SAME document,
// unlike the older fixture that always made it equal the live SPA route.
async function relayInitialDocumentMetadata(f,{documentId='cors-browser-document',foreignOrigin=false,
  oldPath=false,replaceExpectedURL=false}={}){
  const current=new URL(f.h.page.url()),initial=new URL(current);
  if(oldPath)initial.pathname='/initial-course';
  initial.hash='#/classes/cors-fixture?tab=forYou';
  if(foreignOrigin){initial.protocol='https:';initial.host='foreign.example';}
  if(!foreignOrigin){
    const session=await f.h.page.context().newCDPSession(f.h.page);
    try{
      await f.h.page.evaluate(url=>{
        history.replaceState(null,'',url);
        window.__senderRouteDocument=document;
      },initial.href);
      const before=(await session.send('Page.getFrameTree')).frameTree.frame;
      assert.equal(before.url+before.urlFragment,initial.href);
      await f.h.page.evaluate(url=>history.replaceState(null,'',url),current.href);
      const after=(await session.send('Page.getFrameTree')).frameTree.frame;
      assert.equal(after.url+after.urlFragment,current.href);
      assert.equal(after.id,before.id);
      assert.equal(after.loaderId,before.loaderId,'SPA route changes must retain the loaded document');
      assert.equal(await f.h.page.evaluate(()=>window.__senderRouteDocument===document),true);
    }finally{await session.detach();}
  }
  const messages=[];
  await f.h.page.exposeFunction('__initialDocumentVisualBridge',async message=>{
    messages.push(structuredClone(message));
    return f.send(replaceExpectedURL?{...message,expectedURL:initial.href}:message,
      {id:'fixture-extension',tab:{id:1,windowId:4,active:true,url:current.href},frameId:0,
        ...(documentId?{documentId}:{}),url:initial.href});
  });
  await f.h.page.evaluate(()=>{chrome.runtime.sendMessage=message=>window.__initialDocumentVisualBridge(message);});
  return {initialURL:initial.href,currentURL:current.href,messages};
}

async function terminal(f){
  const deadline=Date.now()+14000;
  for(;;){
    const event=f.events.find(row=>['complete','review','error'].includes(row.event?.kind))?.event;
    if(event)return event;
    if(Date.now()>deadline)assert.fail(JSON.stringify(f.events));
    await new Promise(resolve=>setTimeout(resolve,20));
  }
}

for(const language of ['ar','en'])test(`${language}: current graph pixels survive an initial sender URL after same-document SPA hash navigation`,async t=>{
  const f=await createCorsPipeline(t,{language}),relay=await relayInitialDocumentMetadata(f);
  assert.notEqual(relay.initialURL,relay.currentURL);
  await f.start();const end=await terminal(f);
  assert.equal(end.kind,'complete',JSON.stringify({end,chats:f.chats.length,events:f.events}));
  assert.equal(relay.messages.length,1);assert.equal(relay.messages[0].expectedURL,relay.currentURL);
  assert.equal(f.chats.length,2);const pixels=f.chats[0].messages[1].images[0];
  assert.equal(f.chats[1].messages[1].images[0],pixels);
  await assertCorsPng(f.h,{data:pixels,mimeType:'image/png'});
  assert.equal(f.assets.length,1);assert.equal(f.screenshotCalls,0);
  assert.equal(f.events.filter(row=>row.event?.kind==='submitted').length,1);
  assert.deepEqual((await f.h.page.evaluate(()=>window.corsQuestionState)).submitted,
    [[{name:'angle',value:'angle-one'},{name:'relationship',value:'relationship-one'}]]);
  assert.equal(JSON.stringify(f.events).includes(pixels),false);
});

test('same-document history pathname changes still target the current verified document for a bounded graph crop',async t=>{
  const f=await createCorsPipeline(t,{assetPermission:false}),relay=await relayInitialDocumentMetadata(f,{oldPath:true});
  assert.notEqual(new URL(relay.initialURL).pathname,new URL(relay.currentURL).pathname);
  await f.start();const end=await terminal(f);
  assert.equal(end.kind,'complete',JSON.stringify({end,chats:f.chats.length,events:f.events}));
  assert.equal(f.chats.length,2);assert.equal(f.assets.length,0);assert.equal(f.screenshotCalls,1);
  await assertCorsPng(f.h,{data:f.chats[0].messages[1].images[0],mimeType:'image/png'});
  assert.equal(f.events.filter(row=>row.event?.kind==='submitted').length,1);
});

for(const [name,options] of [
  ['a different document ID',{documentId:'stale-cors-document'}],
  ['an absent document ID with conflicting sender URL',{documentId:null}],
  ['a different sender origin',{foreignOrigin:true}],
  ['a requested URL that no longer matches the live document',{replaceExpectedURL:true}],
])test(`initial sender metadata cannot authorize ${name}`,async t=>{
  const f=await createCorsPipeline(t),relay=await relayInitialDocumentMetadata(f,options);
  await f.start();const end=await terminal(f);
  assert.notEqual(end.kind,'complete',JSON.stringify(end));assert.equal(relay.messages.length,1);
  assert.equal(f.assets.length,0);assert.equal(f.screenshotCalls,0);assert.equal(f.chats.length,0);
  assert.deepEqual(await f.h.page.evaluate(()=>window.corsQuestionState.submitted),[]);
  assert.equal(await f.h.page.locator('[data-alef-visual-target]').count(),0);
});
