import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

// Real React+DndKit mappings and real text-only button discovery. Chrome
// messaging is the explicit harness stub; this is not an authenticated run.
const bundle=buildSync({entryPoints:[fileURLToPath(new URL('fixtures/arabic-submit.jsx',import.meta.url))],bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text;
async function setup(t,settings={}){
 const h=await createBrowserHarness();t.after(()=>h.close());
 await h.page.addScriptTag({content:bundle});await h.page.evaluate(settings=>window.mountArabicSubmit(settings),settings);
 await h.page.waitForFunction(()=>window.arabicSubmitState.ready);
 assert.equal(await h.page.locator('[data-alef-submit],[data-alef-question],[data-question-id]').count(),0);
 const read=await h.send({type:'ALEF_GET_QUESTION'});assert.equal(read.ok,true,JSON.stringify(read));
 const q=read.question;assert.equal(q.type,'matching');assert.equal(q.items.length,2);assert.equal(q.targets.length,7);
 assert.ok(!q.text.includes(settings.label||'أرسل إجابتي'),'The action label is not authored question evidence');
 const labels=settings.language==='en'?['water','salt water']:['ماء','ماء مالح'];
 const answer={optionIds:[],text:'',matches:q.items.map((item,index)=>({itemId:item.id,targetId:q.targets.find(target=>target.text===labels[index]).id})),confidence:.99,explanation:'Interaction fixture only.'};
 return {h,q,apply:()=>h.send({type:'ALEF_APPLY',questionId:q.id,questionFingerprint:q.fingerprint,answer,autoSubmit:true})};
}
async function assertTwoDrops(h){
 const state=await h.page.evaluate(()=>window.arabicSubmitState);
 assert.deepEqual(state.starts,['word-0','word-1']);
 assert.deepEqual(state.ends,[{word:'word-0',blank:'droppable-0'},{word:'word-1',blank:'droppable-1'}]);
 assert.equal(state.answers['droppable-0'].id,'word-0');assert.equal(state.answers['droppable-1'].id,'word-1');
 return state;
}
for(const [name,settings] of [
 ['Arabic visible submit label',{label:'أرسل إجابتي'}],
 ['Arabic submit label with diacritics',{label:'أَرْسِلْ إِجَابَتِي'}],
 ['English visible submit label',{language:'en',label:'Submit Answer'}],
 ['Arabic input submit value',{label:'أرسل إجابتي',inputSubmit:true}]
])test(`${name}: two real drag placements reach one unmarked Submit handler`,async t=>{
 const {h,apply}=await setup(t,settings),result=await apply(),state=await assertTwoDrops(h);
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.submitted,true,JSON.stringify(result));
 assert.equal(state.submitted.length,1);assert.equal(state.otherSubmitted,0);
 assert.equal(state.submitted[0].answers['droppable-1'].id,'word-1');
});

for(const settings of [{testId:'next-button'},{testId:'',buttonId:'alef-next-button'}])test(`Arabic submit stays outside Next actions with ${settings.testId||settings.buttonId}`,async t=>{
 const {h,apply}=await setup(t,settings);
 // Make it enabled before inspection to exercise discoverActions, without
 // allowing submission before both real drag placements are acknowledged.
 await h.page.locator('button').evaluate(node=>{node.disabled=false;});
 const snapshot=await h.send({type:'ALEF_INSPECT'});
 assert.equal(snapshot.canNext,false,JSON.stringify(snapshot.navigation));
 assert.ok(!snapshot.navigation.some(action=>action.kind==='next'));
 const next=await h.send({type:'ALEF_NEXT'});assert.equal(next.clicked,false);
 assert.equal((await h.page.evaluate(()=>window.arabicSubmitState)).submitted.length,0);
 const result=await apply(),state=await assertTwoDrops(h);assert.equal(result.submitted,true,JSON.stringify(result));assert.equal(state.submitted.length,1);
});

test('Arabic submit waits for delayed React enabling after both exact placements',async t=>{
 const {h,apply}=await setup(t,{enableDelay:350}),result=await apply(),state=await assertTwoDrops(h);
 assert.equal(result.submitted,true,JSON.stringify(result));assert.equal(state.submitted.length,1);
 assert.ok(state.submitted[0].at>=state.enabledAt);
});

test('a disabled Arabic submit is never forced after both placements',async t=>{
 const {h,apply}=await setup(t,{neverEnable:true}),result=await apply(),state=await assertTwoDrops(h);
 assert.equal(result.ok,true);assert.equal(result.applied,true);assert.equal(result.submitted,false);
 assert.match(result.reason,/لم يظهر زر إرسال متاح/);assert.deepEqual(state.submitted,[]);
});

test('STOP while React is enabling Arabic submit retains both words without sending',async t=>{
 const {h,apply}=await setup(t,{enableDelay:450,cancelWhileEnabling:true}),result=await apply(),state=await assertTwoDrops(h);
 assert.equal(result.ok,false,JSON.stringify(result));assert.equal(state.stopSent,true);assert.deepEqual(state.submitted,[]);
 await h.page.waitForTimeout(500);assert.deepEqual((await h.page.evaluate(()=>window.arabicSubmitState)).submitted,[]);
});

test('two enabled Arabic submit controls remain ambiguous rather than sending twice',async t=>{
 const {h,apply}=await setup(t,{duplicate:true}),result=await apply(),state=await assertTwoDrops(h);
 assert.equal(result.ok,false,JSON.stringify(result));assert.match(result.error,/زر الإرسال غير واضح/);
 assert.deepEqual(state.submitted,[]);assert.equal(state.otherSubmitted,0);
});

test('an unrelated Arabic button does not become submit by a partial phrase match',async t=>{
 const {h,apply}=await setup(t,{label:'لا ترسل إجابتي الآن'}),result=await apply(),state=await assertTwoDrops(h);
 assert.equal(result.submitted,false);assert.deepEqual(state.submitted,[]);
});

for(const settings of [
 {label:'أرسل إجابتي',id:'native-submit'},
 {label:'حفظ الإجابة',testId:'next-button'},
 {label:'حفظ الإجابة',id:'alef-next-button'}
])test(`native player choices anchor ${settings.label} without treating ${settings.id||settings.testId} as Next`,async t=>{
 const h=await createBrowserHarness();t.after(()=>h.close());
 await h.page.evaluate(settings=>{
  document.body.innerHTML='<main id="player-container"><div data-testid="assessment-content-player"><h2>ما ناتج جمع 2 و2؟</h2><div><label><input type="radio" name="sum" value="a">4</label><label><input type="radio" name="sum" value="b">5</label></div><button></button></div></main>';
  const button=document.querySelector('button');button.textContent=settings.label;
  if(settings.id)button.id=settings.id;if(settings.testId)button.dataset.testid=settings.testId;
  window.nativeSubmissions=0;button.onclick=()=>window.nativeSubmissions++;
 },settings);
 const read=await h.send({type:'ALEF_GET_QUESTION'});assert.equal(read.ok,true,JSON.stringify(read));assert.equal(read.question?.type,'single',JSON.stringify(read));
 const snapshot=await h.send({type:'ALEF_INSPECT'});assert.equal(snapshot.canNext,false,JSON.stringify(snapshot.navigation));
 const next=await h.send({type:'ALEF_NEXT'});assert.equal(next.clicked,false);assert.equal(await h.page.evaluate(()=>window.nativeSubmissions),0);
 const q=read.question;assert.ok(q.text.includes('ما ناتج جمع 2 و2'));assert.ok(!q.text.includes(settings.label));
 const correct=q.options.find(option=>option.text==='4');assert.ok(correct,JSON.stringify(q.options));
 const result=await h.send({type:'ALEF_APPLY',questionId:q.id,questionFingerprint:q.fingerprint,answer:{optionIds:[correct.id],text:'',explanation:'Fixture only.',confidence:.99},autoSubmit:true});
 assert.equal(result.submitted,true,JSON.stringify(result));assert.equal(await h.page.evaluate(()=>window.nativeSubmissions),1);
});
