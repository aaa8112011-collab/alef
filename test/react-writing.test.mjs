import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {buildSync} from 'esbuild';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

const bundle=buildSync({entryPoints:[fileURLToPath(new URL('fixtures/react-writing.jsx',import.meta.url))],
  bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text;
async function setup(t,{language='ar',kind='textarea',mode='normal'}={}) {
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.addScriptTag({content:bundle});
  await h.page.evaluate(settings=>window.mountReactWriting(settings),{language,kind,mode});
  await h.page.waitForFunction(()=>window.reactWriting?.ready);
  const read=await h.send({type:'ALEF_GET_QUESTION'});assert.equal(read.ok,true,JSON.stringify(read));
  assert.equal(read.question.type,'text');
  return {h,apply:text=>h.send({type:'ALEF_APPLY',questionId:read.question.id,questionFingerprint:read.question.fingerprint,
    answer:{optionIds:[],text,confidence:.99,explanation:'Interaction fixture, not model inference.'},autoSubmit:true})};
}

for(const [language,text] of [['ar','العِلْمُ نورٌ'],['en','Knowledge is light.']])test(`${language}: native setter and input events update real React18 textarea state before one submission`,async t=>{
  const {h,apply}=await setup(t,{language}),result=await apply(text);
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.submitted,true);
  const state=await h.page.evaluate(()=>window.reactWriting);
  assert.deepEqual(state.changes,[text]);assert.equal(state.value,text);assert.deepEqual(state.submitted,[text]);
});

test('Arabic decimal digits update a real React controlled number field with the valid normalized value',async t=>{
  const {h,apply}=await setup(t,{kind:'number'}),result=await apply('٢٫٥');
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.submitted,true);
  const state=await h.page.evaluate(()=>window.reactWriting);
  assert.equal(state.value,'2.5');assert.deepEqual(state.changes,['2.5']);assert.deepEqual(state.submitted,['2.5']);
});

for(const mode of ['remount','delayed'])test(`React ${mode} retains the committed writing answer before Submit`,async t=>{
  const {h,apply}=await setup(t,{mode}),result=await apply('إجابة ثابتة');
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.submitted,true);
  const state=await h.page.evaluate(()=>window.reactWriting);
  assert.equal(state.value,'إجابة ثابتة');assert.deepEqual(state.submitted,['إجابة ثابتة']);
});

test('a real React controlled field rejecting the change cannot be mistaken for a retained answer',async t=>{
  const {h,apply}=await setup(t,{mode:'reject'}),result=await apply('إجابة مرفوضة');
  assert.equal(result.ok,false,JSON.stringify(result));assert.match(result.error,/لم يؤكد الموقع إدخال نص صالح/);
  const state=await h.page.evaluate(()=>window.reactWriting);
  assert.deepEqual(state.changes,['إجابة مرفوضة']);assert.equal(state.value,'');assert.deepEqual(state.submitted,[]);
});
