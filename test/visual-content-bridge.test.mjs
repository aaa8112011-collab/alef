import test from 'node:test';
import assert from 'node:assert/strict';
import {createCorsQuestion} from './visual-cors-fixture.mjs';

// These explicit bridge replies test reader ownership/cancellation. The
// separate CORS/worker suites exercise actual HTTP transport and image pixels.
const reply=f=>({ok:true,data:f.png.split(',')[1],mimeType:'image/png',method:'source'});
const noMarkers=async f=>assert.equal(await f.h.page.locator('[data-alef-visual-target]').count(),0);

test('reader requests only its selected diagram and removes its temporary capture marker',async t=>{
  const f=await createCorsQuestion(t),q=await f.read(),requests=[];
  await f.installContentBridge(async message=>{requests.push(message);return reply(f);});
  const result=await f.capture(q);assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(requests.length,1);const message=requests[0];
  assert.equal(message.type,'ALEF_CAPTURE_VISUAL');assert.equal(message.kind,'image');
  assert.equal(message.source,f.imageURL);assert.equal(message.expectedURL,f.h.page.url());
  assert.match(message.target,/^[0-9a-f-]{36}$/);assert.equal(message.token,undefined);
  assert.equal((await f.read()).fingerprint,q.fingerprint);await noMarkers(f);
});

for(const action of ['cancel','question','image'])test(`a pending capture cannot return evidence after ${action} changes its ownership`,async t=>{
  const f=await createCorsQuestion(t),q=await f.read();let release,requested;
  const pending=new Promise(resolve=>{requested=resolve;});
  await f.installContentBridge(()=>new Promise(resolve=>{release=resolve;requested();}));
  const capture=f.capture(q);await pending;
  if(action==='cancel'){
    await f.h.send({type:'ALEF_CANCEL'});await noMarkers(f);
  }else if(action==='question')await f.h.page.locator('.lib-question-statement-container').evaluate(node=>{node.textContent='A different question is now visible.';});
  else await f.h.page.locator('#authored-diagram').evaluate((node,png)=>{node.src=png;},f.png);
  release(reply(f));const result=await capture;
  assert.equal(result.ok,false,JSON.stringify(result));assert.equal(result.images,undefined);
  assert.match(result.error,action==='cancel'?/إيقاف/:/تغير|تغيّر/);await noMarkers(f);
});

test('a clipped-diagram response scrolls the selected element once and retries with the same marker',async t=>{
  const f=await createCorsQuestion(t),q=await f.read(),requests=[];
  await f.installContentBridge(message=>{requests.push(message);return requests.length===1
    ?{ok:false,code:'visual_not_fully_visible',error:'The selected diagram is clipped.'}:reply(f);});
  const result=await f.capture(q);assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(requests.length,2);assert.equal(requests[0].target,requests[1].target);await noMarkers(f);
});

test('a diagram that remains clipped never starts an unbounded capture loop',async t=>{
  const f=await createCorsQuestion(t),q=await f.read();let requests=0;
  await f.installContentBridge(()=>{requests++;return {ok:false,code:'visual_not_fully_visible',error:'الرسم غير ظاهر كاملًا.'};});
  const result=await f.capture(q);assert.equal(result.ok,false);assert.equal(result.images,undefined);
  assert.equal(requests,2);assert.match(result.error,/غير ظاهر كاملًا/);await noMarkers(f);
});

for(const [name,change] of [
  ['unexpected MIME',r=>({...r,mimeType:'text/html'})],
  ['invalid pixel encoding',r=>({...r,data:'not-base64!'})],
  ['oversized pixels',r=>({...r,data:'A'.repeat(1_398_105)})],
])test(`reader refuses a bridge reply with ${name}`,async t=>{
  const f=await createCorsQuestion(t),q=await f.read();
  await f.installContentBridge(()=>change(reply(f)));
  const result=await f.capture(q);assert.equal(result.ok,false,JSON.stringify(result));
  assert.equal(result.images,undefined);assert.match(result.error,/رد التقاط الرسم غير صالح/);await noMarkers(f);
});

test('a failed image load cannot use a screenshot of a placeholder as question evidence',async t=>{
  const f=await createCorsQuestion(t);
  await f.h.page.locator('#authored-diagram').evaluate(async node=>{
    node.src='data:image/png;base64,broken';try{await node.decode();}catch{}
  });
  const q=await f.read();let calls=0;
  await f.installContentBridge(()=>{calls++;return reply(f);});
  const result=await f.capture(q);assert.equal(result.ok,false);assert.equal(result.images,undefined);
  assert.equal(calls,0);await noMarkers(f);
});
