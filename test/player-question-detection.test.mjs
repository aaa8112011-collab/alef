import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

// Known Alef player scopes are public-source contracts. The unmarked native
// controls below exercise standard HTML semantics, not a signed-in Alef page.
async function mount(t,{language='en',kind='native',scope=true}={}) {
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(({language,kind,scope})=>{
    const prompt=language==='ar'?'الشكل التالي تمدد من الأصل. ما معامل التمدد؟':'Figure A is dilated to A prime. What is the scale factor?';
    document.body.innerHTML=`<main ${scope?'data-testid="ncle-activity-page"':''}><article ${scope?'data-testid="ncle-activity-page-player"':''}><form ${scope?'data-testid="assessment-content-player"':''}><h2>${prompt}</h2><p><span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">x^2 + 2x</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">duplicate visual formula</span></span></p><svg role="img" aria-label="A geometric scale diagram" xmlns="http://www.w3.org/2000/svg" width="180" height="140"><path d="M10 120L70 20L130 120Z" fill="lightblue"/><text x="60" y="30">A(2,4)</text><text x="80" y="70">A′(3,6)</text></svg><div id="choices"></div><input type="hidden" value="PRIVATE_HIDDEN_FORM_VALUE"><textarea hidden>PRIVATE_TYPED_ANSWER</textarea><button type="button" id="submit" disabled>${language==='ar'?'إرسال الإجابة':'Submit Answer'}</button></form></article></main>`;
    window.playerFixture={submissions:0,selected:null};
    const choices=document.querySelector('#choices'),submit=document.querySelector('#submit');
    if(kind==='semantic') {
      choices.innerHTML='<div role="radio" id="a" aria-checked="false">2</div><div role="radio" id="b" aria-checked="false">1.5</div>';
      for(const node of choices.children)node.onclick=()=>setTimeout(()=>{
        for(const other of choices.children)other.setAttribute('aria-checked',String(other===node));
        window.playerFixture.selected=node.id;submit.disabled=false;
      },70);
    }else{
      choices.innerHTML='<label><input type="radio" name="current-question" value="a">2</label><label><input type="radio" name="current-question" value="b">1.5</label>';
      choices.addEventListener('change',()=>setTimeout(()=>{window.playerFixture.selected=choices.querySelector('input:checked').value;submit.disabled=false;},70));
    }
    submit.onclick=()=>{window.playerFixture.submissions++;};
  },{language,kind,scope});
  return h;
}
const answer={optionIds:['b'],text:'',explanation:'Deterministic DOM fixture only.',confidence:.99};

for(const language of ['ar','en'])test(`${language} unmarked native radio question in a known assessment player keeps the stem, math and diagram and submits once`,async t=>{
  const h=await mount(t,{language});
  const s=await h.send({type:'ALEF_INSPECT'});
  assert.equal(s.stage,'question',JSON.stringify(s));assert.equal(s.question.type,'single');
  assert.equal(s.questionEvidence.source,'native-player-radio');
  assert.match(s.question.text,language==='ar'?/معامل التمدد/:/scale factor/);
  assert.match(s.question.text,/x\^2 \+ 2x/);
  assert.doesNotMatch(s.question.text,/duplicate visual formula/);
  assert.deepEqual(s.question.options.map(option=>({id:option.id,text:option.text})),[{id:'a',text:'2'},{id:'b',text:'1.5'}]);
  assert.equal(s.question.requiresVision,true);assert.equal(s.question.visuals.length,1);
  const visuals=await h.send({type:'ALEF_GET_VISUALS',questionId:s.question.id,questionFingerprint:s.question.fingerprint});
  assert.equal(visuals.ok,true,JSON.stringify(visuals));assert.equal(visuals.images.length,1);assert.ok(visuals.images[0].data.length>100);
  const applied=await h.send({type:'ALEF_APPLY',questionId:s.question.id,questionFingerprint:s.question.fingerprint,answer,autoSubmit:true});
  assert.equal(applied.ok,true,JSON.stringify(applied));assert.equal(applied.submitted,true);
  assert.deepEqual(await h.page.evaluate(()=>window.playerFixture),{submissions:1,selected:'b'});
  const diagnostic=await h.send({type:'ALEF_DIAGNOSTICS'});
  assert.equal(diagnostic.diagnostics.questionControls.nativeRadio,2);
  assert.equal(diagnostic.diagnostics.questionEvidence.source,'native-player-radio');
  assert.ok(diagnostic.diagnostics.controls.some(control=>control.tag==='BUTTON'&&control.label.includes(language==='ar'?'إرسال':'Submit')),'Known question-form controls remain visible in diagnostics');
  assert.doesNotMatch(JSON.stringify(diagnostic),/PRIVATE_HIDDEN_FORM_VALUE|PRIVATE_TYPED_ANSWER/);
});

test('semantic radio siblings with a primary action in a known player acknowledge selection before submit',async t=>{
  const h=await mount(t,{kind:'semantic'}),s=await h.send({type:'ALEF_INSPECT'});
  assert.equal(s.stage,'question',JSON.stringify(s));assert.equal(s.questionEvidence.source,'semantic-player-radio');
  const applied=await h.send({type:'ALEF_APPLY',questionId:s.question.id,questionFingerprint:s.question.fingerprint,answer,autoSubmit:true});
  assert.equal(applied.submitted,true,JSON.stringify(applied));
  assert.deepEqual(await h.page.evaluate(()=>window.playerFixture),{submissions:1,selected:'b'});
});

test('multiple unmarked native answer groups stop as an unreadable question instead of requiring a video',async t=>{
  const h=await mount(t);
  await h.page.locator('#choices').evaluate(node=>node.insertAdjacentHTML('beforeend','<label><input type="radio" name="another-question" value="c">3</label><label><input type="radio" name="another-question" value="d">4</label>'));
  const s=await h.send({type:'ALEF_INSPECT'});
  assert.equal(s.stage,'question');assert.equal(s.question,null);
  assert.equal(s.questionEvidence.choiceCount,4);
  assert.match(s.diagnostics.join(' '),/تظهر خيارات إجابة/);
  assert.doesNotMatch(s.diagnostics.join(' '),/مشاهدة/);
  assert.equal((await h.page.evaluate(()=>window.playerFixture)).submissions,0);
});

test('native choice inference needs a known player and a recognizable assessment action and excludes login forms',async t=>{
  const outside=await mount(t,{scope:false});
  assert.equal((await outside.send({type:'ALEF_INSPECT'})).question,null);
  const noAction=await mount(t);
  await noAction.page.locator('#submit').evaluate(node=>node.remove());
  assert.equal((await noAction.send({type:'ALEF_INSPECT'})).question,null);
  const login=await mount(t);
  await login.page.locator('form').evaluate(node=>node.insertAdjacentHTML('beforeend','<input type="password" value="PRIVATE_LOGIN_PASSWORD">'));
  const s=await login.send({type:'ALEF_INSPECT'});assert.equal(s.stage,'unknown');assert.equal(s.question,null);
  assert.doesNotMatch(JSON.stringify(await login.send({type:'ALEF_DIAGNOSTICS'})),/PRIVATE_LOGIN_PASSWORD/);
});

test('display contents question wrappers remain readable while empty and hidden wrappers remain excluded',async t=>{
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(()=>{document.body.innerHTML='<main data-testid="ncle-activity-page"><article data-testid="ncle-activity-page-player"><section class="mcq-container question-widget" style="display:contents"><h2>What is two plus two?</h2><label><input type="radio" name="q" value="a">4</label><label><input type="radio" name="q" value="b">5</label></section><button disabled>Submit Answer</button></article></main>';});
  assert.equal(await h.page.locator('.mcq-container').evaluate(node=>node.getClientRects().length),0);
  const s=await h.send({type:'ALEF_INSPECT'});assert.equal(s.stage,'question',JSON.stringify(s));assert.match(s.question.text,/two plus two/);
  await h.page.locator('.mcq-container').evaluate(node=>node.hidden=true);
  assert.equal((await h.send({type:'ALEF_INSPECT'})).question,null);
  await h.page.locator('.mcq-container').evaluate(node=>{node.hidden=false;node.innerHTML='';});
  assert.equal((await h.send({type:'ALEF_INSPECT'})).question,null);
});
