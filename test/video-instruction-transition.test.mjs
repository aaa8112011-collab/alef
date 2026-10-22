import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

// The slide/progress structure follows published Weaver SlideContainer and
// SlidesProgressBar components. Media is an inert local DOM fixture; this does
// not seek a video, bypass a viewing requirement, or use a signed-in account.
const slideIds=[
  '21611738-4354-4c12-8dc4-8e9f2269e001',
  '21611738-4354-4c12-8dc4-8e9f2269e002',
  '21611738-4354-4c12-8dc4-8e9f2269e003',
];
async function mount(t,{language='en',k4=false,stalled=false}={}) {
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(({language,k4,stalled,slideIds})=>{
    const title=language==='ar'?'التشابه بزاويتين':'AA Similarity';
    const next=language==='ar'?'التالي':'Next';
    const prefix=k4?'k4-':'';
    const progress='<div id="'+prefix+'slides-progress-bar" data-testid="'+prefix+'slides-progress-bar" data-progressbar-no-of-slides="3" style="display:flex;gap:4px">'+
      Array.from({length:3},(_,index)=>'<div style="height:8px;width:80px;background:teal" data-testid="'+prefix+'bar-'+(index===0?'active':'inactive')+'"></div>').join('')+'</div>';
    document.body.innerHTML='<main id="player-container" data-alef-instruction><h2>'+title+'</h2><div id="slide-owner" data-testid="'+slideIds[0]+'">'+
      (k4?'<div>'+progress+'</div>':progress)+
      '<div data-testid="video-component"><div class="lib-video-player-container"><div data-testid="video-player"><video preload="none" src="/unchanged-lesson-video.mp4"></video></div>'+ 
      '<div class="lib-controls-bar"><span class="lib-volume-slider-time-section">0:00 / 0:50</span><button data-testid="video-control-button" aria-label="Play"></button></div></div></div>'+
      '<button data-alef-next>'+next+'</button></div></main>';
    const state=window.videoStepFixture={step:0,clicks:[],completed:false,playRequests:0};
    document.querySelector('video').play=async()=>{state.playRequests++;};
    window.advanceVideoStep=(step,{sameSlideId=false}={})=>{
      state.step=step;
      if(!sameSlideId)document.querySelector('#slide-owner').dataset.testid=slideIds[step];
      const bars=document.querySelectorAll('[data-testid="'+prefix+'slides-progress-bar"] > div');
      bars.forEach((bar,index)=>bar.dataset.testid=prefix+'bar-'+(index<=step?'active':'inactive'));
    };
    document.querySelector('[data-alef-next]').onclick=()=>{
      state.clicks.push(state.step);
      if(stalled){
        const bar=document.querySelector('[data-testid="'+prefix+'slides-progress-bar"]');
        bar.replaceWith(bar.cloneNode(true));
        document.querySelector('[data-testid="video-component"]').setAttribute('aria-busy','true');
        return;
      }
      if(state.step<2)window.advanceVideoStep(state.step+1);
      else {state.completed=true;document.querySelector('main').innerHTML='<section data-alef-completed>Lesson completed</section>';}
    };
  },{language,k4,stalled,slideIds});
  return h;
}

for(const language of ['en','ar'])test(`${language} coloured slide bars advance the instruction identity with unchanged text, route, button and media`,async t=>{
  const h=await mount(t,{language});
  const initial=await h.send({type:'ALEF_INSPECT'});
  assert.equal(initial.stage,'instruction');assert.equal(initial.question,null);
  await h.page.evaluate(()=>window.advanceVideoStep(1,{sameSlideId:true}));
  const advanced=await h.send({type:'ALEF_INSPECT'});
  assert.equal(advanced.stage,'instruction');assert.equal(advanced.navigation[0].id,initial.navigation[0].id);
  assert.equal(advanced.page.url,initial.page.url);
  assert.notEqual(advanced.transitionFingerprint,initial.transitionFingerprint,'A real segmented-bar change must unlock the next ordinary Next');
});

test('a new published slide UUID distinguishes otherwise identical video instruction slides',async t=>{
  const h=await mount(t),initial=await h.send({type:'ALEF_INSPECT'});
  await h.page.locator('#slide-owner').evaluate((node,id)=>node.dataset.testid=id,slideIds[1]);
  const advanced=await h.send({type:'ALEF_INSPECT'});
  assert.notEqual(advanced.transitionFingerprint,initial.transitionFingerprint);
});

test('K4 progress bars nested under their layout wrapper still distinguish the active slide',async t=>{
  const h=await mount(t,{k4:true}),initial=await h.send({type:'ALEF_INSPECT'});
  await h.page.evaluate(()=>window.advanceVideoStep(1,{sameSlideId:true}));
  assert.notEqual((await h.send({type:'ALEF_INSPECT'})).transitionFingerprint,initial.transitionFingerprint);
});

test('video playback properties, buffering and a hidden old slide cannot invent a new instruction step',async t=>{
  const h=await mount(t),initial=await h.send({type:'ALEF_INSPECT'});
  await h.page.evaluate(()=>{
    const video=document.querySelector('video');
    Object.defineProperties(video,{currentTime:{configurable:true,value:23},paused:{configurable:true,value:false},readyState:{configurable:true,value:4}});
    video.src='blob:'+location.origin+'/temporary-playback-source';
    document.querySelector('.lib-volume-slider-time-section').textContent='0:23 / 0:50';
    const component=document.querySelector('[data-testid="video-component"]');
    component.setAttribute('aria-busy','true');component.classList.add('playing','buffering');
    const old=document.querySelector('#slide-owner').cloneNode(true);old.id='hidden-old-slide';old.hidden=true;old.dataset.testid='21611738-4354-4c12-8dc4-8e9f2269efff';
    old.querySelectorAll('[data-testid="bar-inactive"]').forEach(node=>node.dataset.testid='bar-active');
    document.querySelector('main').append(old);
  });
  const busy=await h.send({type:'ALEF_INSPECT'});
  assert.equal(busy.loading,true);assert.notEqual(busy.fingerprint,initial.fingerprint);
  assert.equal(busy.transitionFingerprint,initial.transitionFingerprint);
});

async function workerBridge(t,h) {
  const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
  const events=[],requests=[];
  let handler,clock=0;
  class Clock extends Date {static now(){return clock;}}
  const timeout=(fn,ms)=>setTimeout(()=>{clock+=ms;fn();},1);
  const chrome={
    runtime:{id:'video-transition-test',getURL:path=>'chrome-extension://video-transition-test/'+path,getPlatformInfo:async()=>({}),
      onMessage:{addListener(fn){handler=fn;}},sendMessage:async message=>events.push(structuredClone(message))},
    storage:{session:{get:async()=>({}),set:async()=>{}}},
    tabs:{get:async()=>({id:1,url:h.page.url()}),sendMessage:async(_tab,message)=>h.send(message),onRemoved:{addListener(){}}},
    scripting:{executeScript:async()=>{}},action:{onClicked:{addListener(){}}},
  };
  vm.runInNewContext(source,{chrome,URL,AbortController,AbortSignal,DOMException,Date:Clock,setTimeout:timeout,clearTimeout,setInterval,clearInterval,
    fetch:async endpoint=>{
      if(endpoint.endsWith('/api/health'))return Response.json({ok:true,configured:true,provider:'ollama',modelReady:true,protocolVersion:3});
      requests.push(endpoint);throw new Error('Instruction transitions must not invoke inference');
    }});
  const send=message=>new Promise(resolve=>handler({tabId:1,...message},{id:'video-transition-test',url:'chrome-extension://video-transition-test/dashboard.html'},resolve));
  const close=h.close;h.close=async()=>{await send({type:'STOP'});await close();};
  return {events,requests,send,elapsed:()=>clock,start:async()=>{
    assert.equal((await send({type:'CONNECT'})).ok,true);
    assert.equal((await send({type:'START',subjectId:'current',config:{serverUrl:'http://127.0.0.1:4318',token:'test-only',verify:false,
      qualityMode:false,autoSubmit:true,skipInstruction:true,minConfidence:.85}})).ok,true);
  }};
}
async function terminal(h) {
  const deadline=Date.now()+6000;
  let event;
  while(!(event=h.events.find(row=>['complete','review','error'].includes(row.event?.kind))?.event)){
    if(Date.now()>=deadline)assert.fail(JSON.stringify(h.events));
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  return event;
}

test('the worker traverses three text-identical video instruction slides exactly once without inference or sidebar jumps',async t=>{
  const h=await mount(t),worker=await workerBridge(t,h);await worker.start();
  const result=await terminal(worker);
  assert.equal(result.kind,'complete',JSON.stringify(result));
  assert.deepEqual(await h.page.evaluate(()=>window.videoStepFixture),{step:2,clicks:[0,1,2],completed:true,playRequests:0});
  assert.deepEqual(worker.requests,[]);
});

test('a re-rendered but unchanged video instruction stays guarded against a second Next click',async t=>{
  const h=await mount(t,{stalled:true}),worker=await workerBridge(t,h);await worker.start();
  const result=await terminal(worker);
  assert.equal(result.kind,'review',JSON.stringify(result));
  assert.deepEqual((await h.page.evaluate(()=>window.videoStepFixture)).clicks,[0]);
  assert.deepEqual(worker.requests,[]);assert.ok(worker.elapsed()>=30000&&worker.elapsed()<32000);
});
