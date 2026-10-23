import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

const bundle=buildSync({
  entryPoints:[fileURLToPath(new URL('fixtures/react-select-library.jsx',import.meta.url))],
  bundle:true,write:false,format:'iife',platform:'browser',
  define:{'process.env.NODE_ENV':'"production"'},
}).outputFiles[0].text;
async function mount(t,settings={}){
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(settings=>{
    document.documentElement.dir=settings.language==='ar'?'rtl':'ltr';
    document.body.innerHTML='<div id="root"></div>';
    window.__reactSelectSettings=settings;
  },settings);
  await h.page.addScriptTag({content:bundle});
  await h.page.waitForFunction(()=>window.__realSelect?.ready);
  assert.equal(await h.page.locator('[data-alef-question],[data-question-id]').count(),0,'Discover the published widget, not a test-only question marker');
  const initial=await h.send({type:'ALEF_INSPECT'});
  assert.equal(initial.stage,'question',JSON.stringify(initial));
  assert.equal(initial.needsPreparation,true,JSON.stringify(initial));
  assert.equal(initial.loading,false,'A persistent lesson progress bar cannot hide ready answer controls');
  const prepared=await h.send({type:'ALEF_PREPARE_QUESTION'});
  assert.equal(prepared.ok,true,JSON.stringify(prepared));
  assert.ok(prepared.question,JSON.stringify(prepared));
  return {h,q:prepared.question};
}
function answer(question){
  return {optionIds:question.type==='single'?[question.options[0].id]:[],text:'',
    ...(question.type==='dropdowns'?{selections:question.fields.map(field=>({fieldId:field.id,optionId:field.options[0].id}))}:{}),
    explanation:'اختبار تفاعل المكتبة الفعلية، وليس استدلال نموذج.',confidence:.99};
}
const apply=(h,q)=>h.send({type:'ALEF_APPLY',questionId:q.id,questionFingerprint:q.fingerprint,answer:answer(q),autoSubmit:true});

for(const language of ['ar','en'])test(`${language}: actual React Select nested SingleValue labels acknowledge both inline answers and submit once`,async t=>{
  const {h,q}=await mount(t,{language});
  assert.equal(q.type,'dropdowns');assert.equal(q.fields.length,2);
  assert.equal(q.requiresVision,true);assert.equal(q.visuals.length,1);
  assert.match(q.text,/\[dropdown:field-1\]/);assert.match(q.text,/\[dropdown:field-2\]/);
  const before=await h.send({type:'ALEF_GET_QUESTION'});assert.equal(before.question.fingerprint,q.fingerprint);
  assert.equal(await h.page.locator('[role="listbox"]').count(),0,'Preparation closes both real body portals');
  const result=await apply(h,q);assert.equal(result.submitted,true,JSON.stringify(result));
  const state=await h.page.evaluate(()=>window.__realSelect);
  assert.deepEqual(state.changes.map(change=>change.field),[0,1]);
  assert.deepEqual(state.submissions,[[{id:1,text:'70°'},{id:1,text:language==='ar'?'متشابهان':'are similar'}]]);
});

test('actual React Select single-dropdown contract also acknowledges its nested authored label',async t=>{
  const {h,q}=await mount(t,{single:true});assert.equal(q.type,'single');
  const result=await apply(h,q);assert.equal(result.submitted,true,JSON.stringify(result));
  assert.equal(await h.page.evaluate(()=>window.__realSelect.submissions.length),1);
});

test('legacy unprefixed React Select widgets still prepare both fields and submit once',async t=>{
  const {h,q}=await mount(t,{legacyClasses:true});assert.equal(q.type,'dropdowns');
  assert.equal(await h.page.locator('.dropdown-container.question-widget').count(),1);
  const result=await apply(h,q);assert.equal(result.submitted,true,JSON.stringify(result));
  assert.equal(await h.page.evaluate(()=>window.__realSelect.submissions.length),1);
});

test('published K4 Cancel menu action is excluded while a genuine answer named Cancel is retained',async t=>{
  const {h,q}=await mount(t,{k4:true});
  assert.deepEqual(q.fields[0].options.map(option=>option.text),['70°','65°','Cancel']);
  assert.deepEqual(q.fields[1].options.map(option=>option.text),['are similar','are not similar']);
  const result=await apply(h,q);assert.equal(result.submitted,true,JSON.stringify(result));
  assert.equal(await h.page.evaluate(()=>window.__realSelect.changes.some(change=>change.id===-1)),false);
});

test('actual React Select choosing 2 cannot acknowledge a rendered 12',async t=>{
  const {h,q}=await mount(t,{single:true,numeric:true,wrongLabel:true});
  const result=await apply(h,q);assert.equal(result.ok,false,JSON.stringify(result));
  assert.match(result.error,/لم يؤكد الموقع اختيار القائمة/);
  const state=await h.page.evaluate(()=>window.__realSelect);
  assert.equal(state.answers[0].content.text,'2','The actual onChange fired, but the incorrect rendered label is not accepted');
  assert.deepEqual(state.submissions,[]);
});

test('two separate visible authored labels remain ambiguous even inside one real SingleValue',async t=>{
  const {h,q}=await mount(t,{single:true,duplicateLabels:true});
  const result=await apply(h,q);assert.equal(result.ok,false,JSON.stringify(result));
  assert.match(result.error,/لم يؤكد الموقع اختيار القائمة/);
  assert.deepEqual(await h.page.evaluate(()=>window.__realSelect.submissions),[]);
});
