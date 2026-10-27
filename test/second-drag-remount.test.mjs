import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

// Real React+DndKit words keep stable authored IDs while the bank reorders
// and remounts after the first committed drop. Model inference is not tested.
const bundle=buildSync({entryPoints:[fileURLToPath(new URL('fixtures/second-drag-remount.jsx',import.meta.url))],bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text;
async function setup(t,settings){
 const h=await createBrowserHarness();t.after(()=>h.close());
 await h.page.addScriptTag({content:bundle});await h.page.evaluate(settings=>window.mountSecondDrag(settings),settings);
 await h.page.waitForFunction(()=>window.secondDragState.ready);
 const before=await h.send({type:'ALEF_GET_QUESTION'});assert.equal(before.ok,true,JSON.stringify(before));
 const q=before.question;assert.equal(q.type,'matching');assert.equal(q.items.length,2);assert.equal(q.targets.length,7);
 const labels=settings.language==='ar'?['ماء','ماء مالح']:['water','salt water'];
 const answer={optionIds:[],text:'',matches:q.items.map((item,index)=>({itemId:item.id,targetId:q.targets.find(target=>target.text===labels[index]).id})),confidence:.99,explanation:'Interaction fixture only.'};
 const message={type:'ALEF_APPLY',questionId:q.id,questionFingerprint:q.fingerprint,answer,autoSubmit:true};
 // Only the fixture that exhausts both activation waits needs more than the
 // shared harness's seven seconds. Keep its reply budget local to this test.
 const apply=()=>settings.applyReplyTimeout?h.page.evaluate(({message,timeout})=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Local drag fixture reply timed out')),timeout);
  const listener=window.__extensionListeners[0];
  const returned=listener(message,{id:'fixture-extension',tab:{id:1}},value=>{clearTimeout(timer);resolve(value);});
  if(returned!==true){clearTimeout(timer);reject(new Error('The drag fixture expected an asynchronous content reply'));}
 }),{message,timeout:settings.applyReplyTimeout}):h.send(message);
 return {h,q,apply};
}
for(const language of ['ar','en'])for(const delayed of [false,true])test(`${language}: second held drag survives a ${delayed?'delayed':'committed'} seven-word bank reorder and remount`,async t=>{
 const {h,apply}=await setup(t,{language,delayed}),result=await apply();
 const state=await h.page.evaluate(()=>window.secondDragState);
 assert.equal(result.ok,true,JSON.stringify({result,state}));assert.equal(result.submitted,true);
 assert.equal(state.epoch,1);assert.deepEqual(state.ends,[{word:'word-0',blank:'droppable-0'},{word:'word-1',blank:'droppable-1'}]);
 assert.equal(state.starts.length,2);assert.equal(state.downs.length,2);
 assert.ok(state.starts.every((start,index)=>start.at-state.downs[index].at>=950),'Both mouse sensors retain the one-second hold');
 assert.equal(state.submitted.length,1);assert.equal(state.submitted[0]['droppable-1'].id,'word-1');
 assert.equal(await h.page.locator('[data-word-id="word-0"][aria-disabled="true"]').count(),1,'The used word stays disabled in the remounted bank');
});
test('STOP at the second real drag preserves the first placement and prevents a second drop or submission',async t=>{
 const {h,apply}=await setup(t,{language:'ar',delayed:true,cancelSecond:true}),result=await apply();
 const state=await h.page.evaluate(()=>window.secondDragState);
 assert.equal(result.ok,false,JSON.stringify({result,state}));assert.equal(state.stopSent,true);
 assert.deepEqual(state.ends,[{word:'word-0',blank:'droppable-0'}]);assert.equal(state.cancelled,1);
 assert.equal(state.answers['droppable-0'].id,'word-0');assert.equal(state.answers['droppable-1'],undefined);assert.deepEqual(state.submitted,[]);
});

for(const language of ['ar','en'])test(`${language}: published 100ms activation with a real drop overlay permits the next word after remount`,async t=>{
 const {h,apply}=await setup(t,{language,delayed:true,sensorDelay:100,overlay:true}),result=await apply();
 const state=await h.page.evaluate(()=>window.secondDragState);
 assert.equal(result.ok,true,JSON.stringify({result,state}));assert.equal(result.submitted,true);
 assert.deepEqual(state.ends,[{word:'word-0',blank:'droppable-0'},{word:'word-1',blank:'droppable-1'}]);
 assert.equal(state.starts.length,2);assert.equal(state.submitted.length,1);
 assert.ok(state.starts.every((start,index)=>start.at-state.downs[index].at>=90));
});

for(const language of ['ar','en'])test(`${language}: one unstarted second press recovers with a fresh remounted source without replaying the first word`,async t=>{
 const {h,apply}=await setup(t,{language,sensorDelay:100,overlay:true,blockSecondPresses:1,remountBlockedPress:true}),result=await apply();
 const state=await h.page.evaluate(()=>window.secondDragState);
 assert.equal(result.ok,true,JSON.stringify({result,state}));assert.equal(result.submitted,true);
 assert.equal(state.blocked.length,1);assert.deepEqual(state.downs.map(row=>row.id),['word-0','word-1','word-1']);
 assert.notEqual(state.downs[1].epoch,state.downs[2].epoch,'The retry presses the replacement source element');
 assert.deepEqual(state.starts.map(row=>row.id),['word-0','word-1']);
 assert.deepEqual(state.ends,[{word:'word-0',blank:'droppable-0'},{word:'word-1',blank:'droppable-1'}]);
 assert.equal(state.answers['droppable-0'].id,'word-0');assert.equal(state.answers['droppable-1'].id,'word-1');
 assert.equal(state.submitted.length,1);
});

for(const language of ['ar','en'])test(`${language}: an ignored second press on a stable source recovers after the activation wait`,async t=>{
 const {h,apply}=await setup(t,{language,sensorDelay:100,overlay:true,blockSecondPresses:1}),result=await apply();
 const state=await h.page.evaluate(()=>window.secondDragState);
 assert.equal(result.ok,true,JSON.stringify({result,state}));assert.equal(result.submitted,true);
 assert.equal(state.blocked.length,1);assert.deepEqual(state.downs.map(row=>row.id),['word-0','word-1','word-1']);
 assert.equal(state.downs[1].epoch,state.downs[2].epoch,'The source is not remounted to short-circuit the activation wait');
 assert.deepEqual(state.starts.map(row=>row.id),['word-0','word-1']);
 assert.deepEqual(state.ends,[{word:'word-0',blank:'droppable-0'},{word:'word-1',blank:'droppable-1'}]);
 assert.equal(state.answers['droppable-0'].id,'word-0');assert.equal(state.answers['droppable-1'].id,'word-1');
 assert.equal(state.submitted.length,1);
});

test('a persistently unstarted second source stops after two presses and retains the first placement',async t=>{
 const {h,apply}=await setup(t,{language:'ar',sensorDelay:100,blockSecondPresses:20,applyReplyTimeout:10000}),result=await apply();
 const state=await h.page.evaluate(()=>window.secondDragState);
 assert.equal(result.ok,false,JSON.stringify({result,state}));assert.match(result.error,/لم يبدأ الموقع سحب الكلمة/);
 assert.equal(state.blocked.length,2);assert.deepEqual(state.downs.map(row=>row.id),['word-0','word-1','word-1']);
 assert.deepEqual(state.starts.map(row=>row.id),['word-0']);assert.deepEqual(state.ends,[{word:'word-0',blank:'droppable-0'}]);
 assert.equal(state.answers['droppable-0'].id,'word-0');assert.equal(state.answers['droppable-1'],undefined);assert.deepEqual(state.submitted,[]);
});

test('STOP during an unstarted second press prevents recovery and preserves the committed first word',async t=>{
 const {h,apply}=await setup(t,{language:'ar',sensorDelay:100,blockSecondPresses:1,remountBlockedPress:true,cancelBlockedPress:true}),result=await apply();
 const state=await h.page.evaluate(()=>window.secondDragState);
 assert.equal(result.ok,false,JSON.stringify({result,state}));assert.equal(state.stopSent,true);
 assert.equal(state.blocked.length,1);assert.deepEqual(state.downs.map(row=>row.id),['word-0','word-1']);
 assert.deepEqual(state.starts.map(row=>row.id),['word-0']);assert.deepEqual(state.ends,[{word:'word-0',blank:'droppable-0'}]);
 assert.equal(state.answers['droppable-0'].id,'word-0');assert.equal(state.answers['droppable-1'],undefined);assert.deepEqual(state.submitted,[]);
});

test('a changed question during an unstarted second press stops without retrying or submitting the old mapping',async t=>{
 const {h,apply}=await setup(t,{language:'en',sensorDelay:100,blockSecondPresses:1,remountBlockedPress:true,changeQuestionBlockedPress:true}),result=await apply();
 const state=await h.page.evaluate(()=>window.secondDragState);
 assert.equal(result.ok,false,JSON.stringify({result,state}));assert.match(result.error,/تغير السؤال أثناء الحل/);assert.equal(state.questionChanged,true);
 assert.equal(state.blocked.length,1);assert.deepEqual(state.downs.map(row=>row.id),['word-0','word-1']);
 assert.deepEqual(state.starts.map(row=>row.id),['word-0']);assert.deepEqual(state.ends,[{word:'word-0',blank:'droppable-0'}]);
 assert.equal(state.answers['droppable-0'].id,'word-0');assert.equal(state.answers['droppable-1'],undefined);assert.deepEqual(state.submitted,[]);
});
