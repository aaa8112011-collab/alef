import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {buildSync} from 'esbuild';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

// Real DndKit MouseSensor/useDraggable/useDroppable and React state, using
// Weaver's observed class/blank contract. This is not an authenticated Alef run.
const bundle=buildSync({entryPoints:[fileURLToPath(new URL('fixtures/dnd-kit-library.jsx',import.meta.url))],bundle:true,
  write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text;
async function setup(t,settings={language:'ar'}) {
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.addScriptTag({content:bundle});
  await h.page.evaluate(settings=>window.mountRealDndKit(settings),settings);
  await h.page.waitForFunction(()=>window.realDndKit?.ready);
  assert.equal(await h.page.locator('[data-alef-question],[data-question-id]').count(),0,'Discover authored widget classes, not test-only question markers');
  const initial=await h.send({type:'ALEF_INSPECT'});assert.equal(initial.stage,'question',JSON.stringify(initial));
  assert.equal(initial.loading,false,'A mounted lesson progress bar is not a loading spinner for a ready drag question');
  const read=await h.send({type:'ALEF_GET_QUESTION'});assert.equal(read.ok,true,JSON.stringify(read));
  assert.equal(read.question.type,'matching');assert.equal(read.question.items.length,2);
  const q=read.question;
  return {h,apply:()=>h.send({type:'ALEF_APPLY',questionId:q.id,questionFingerprint:q.fingerprint,
    answer:{optionIds:[],text:'',matches:q.items.map((item,index)=>({itemId:item.id,targetId:q.targets[index].id})),
      explanation:'Real library interaction fixture.',confidence:.99},autoSubmit:true})};
}

for(const language of ['ar','en'])test(`${language}: real DndKit one-second MouseSensor fills both correct blanks and submits committed React mappings`,async t=>{
  const {h,apply}=await setup(t,{language}),started=Date.now(),result=await apply();
  assert.equal(result.ok,true,JSON.stringify({result,state:await h.page.evaluate(()=>window.realDndKit)}));assert.equal(result.submitted,true);
  const state=await h.page.evaluate(()=>window.realDndKit);
  assert.deepEqual(state.ends,[{word:'word-0',blank:'droppable-0'},{word:'word-1',blank:'droppable-1'}]);
  assert.equal(state.starts.length,2);assert.ok(Date.now()-started>=2000);assert.equal(state.submitted.length,1);
  assert.equal(state.submitted[0]['droppable-0'].id,'word-0');assert.equal(state.submitted[0]['droppable-1'].id,'word-1');
  assert.ok(state.submitTimes[0]-state.releaseTimes.at(-1)>=50,'Submit must reach the real React handler after the MouseSensor click guard has detached');
  assert.equal(state.cancelled,0);
});

test('legacy unprefixed DndKit classes retain the one-second sensor and both committed drops',async t=>{
  const {h,apply}=await setup(t,{language:'en',legacyClasses:true}),result=await apply();
  assert.equal(result.submitted,true,JSON.stringify(result));
  const state=await h.page.evaluate(()=>window.realDndKit);
  assert.deepEqual(state.ends,[{word:'word-0',blank:'droppable-0'},{word:'word-1',blank:'droppable-1'}]);
  assert.equal(state.submitted.length,1);
});

test('STOP over an actual DndKit droppable cancels the engine without a committed drop or submission',async t=>{
  const {h,apply}=await setup(t,{language:'ar',cancelOnOver:true}),result=await apply();
  assert.equal(result.ok,false,JSON.stringify(result));
  const state=await h.page.evaluate(()=>window.realDndKit);
  assert.equal(state.stopSent,true);assert.equal(state.cancelled,1);assert.deepEqual(state.ends,[]);assert.deepEqual(state.submitted,[]);
  assert.deepEqual(state.answers,{});assert.equal(await h.page.locator(':is(.is-dragging,.lib-is-dragging)').count(),0);
});

test('STOP while the last real drag click guard is detaching prevents automatic submission',async t=>{
  const {h,apply}=await setup(t,{language:'ar',cancelAfterFinalDrop:true}),result=await apply();
  assert.equal(result.ok,false,JSON.stringify(result));
  const state=await h.page.evaluate(()=>window.realDndKit);
  assert.equal(state.stopSent,true);assert.equal(state.ends.length,2);assert.equal(Object.keys(state.answers).length,2);
  assert.deepEqual(state.submitted,[]);assert.deepEqual(state.submitTimes,[]);
});
