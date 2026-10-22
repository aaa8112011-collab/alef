import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

// These local layouts reproduce the missing-stem symptom from the screenshots.
// They exercise known player boundaries and standard ARIA; they are not an
// authenticated Alef capture or a benchmark of the local language model.
const wording={
  en:{stem:'If two triangles are similar by AA, what can be concluded about their corresponding side lengths?',
    instruction:'Select the correct answer.',options:['They are equal.','They differ by a constant sum.','Nothing can be concluded.','They are proportional.']},
  ar:{stem:'إذا تشابه مثلثان بزاويتين، فماذا نستنتج عن أطوال أضلاعهما المتناظرة؟',
    instruction:'اختر الإجابة الصحيحة.',options:['أطوالها متساوية.','تختلف بمجموع ثابت.','لا يمكن استنتاج شيء.','أطوالها متناسبة.']},
};
async function mount(t,{language='en',mode='renderer',visual=false}={}) {
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(({words,mode,visual})=>{
    const choices=words.options.map((label,index)=>'<label><input type="radio" name="answer" value="option-'+index+'">'+label+'</label>').join('');
    const stem='<div id="external-stem"><h2>'+words.stem+'</h2>'+(visual?'<svg role="img" aria-label="triangle diagram" xmlns="http://www.w3.org/2000/svg" width="180" height="140"><path d="M10 120L70 20L130 120Z" fill="lightblue"/></svg>':'')+'</div>';
    const group='<div role="radiogroup" aria-describedby="external-stem"><h3>'+words.instruction+'</h3>'+choices+'</div>';
    const question=mode==='renderer'?'<section data-testid="question-renderer"><div data-testid="question-renderer-AA">'+group+'</div></section>':group;
    const player=mode==='main'?'<main id="player-container" data-testid="math-player-container"><div class="contentmode-player-wrapper">'+stem+question:
      '<main><article data-testid="assessment-content-player">'+stem+question;
    document.body.innerHTML='<aside><h2>SIDEBAR_PRIVATE_LESSON_TITLE</h2></aside>'+player+'<button id="submit" disabled>Submit Answer</button>'+(mode==='main'?'</div></main>':'</article></main>');
    window.externalStemFixture={selected:null,submissions:0};
    const submit=document.querySelector('#submit');
    for(const input of document.querySelectorAll('input'))input.onchange=()=>{window.externalStemFixture.selected=input.value;submit.disabled=false;};
    submit.onclick=()=>{window.externalStemFixture.submissions++;};
  },{words:wording[language],mode,visual});
  return h;
}

for(const language of ['en','ar'])test(`${language} stem outside the question renderer stays with its options and is submitted once`,async t=>{
  const h=await mount(t,{language});
  const snapshot=await h.send({type:'ALEF_INSPECT'});
  assert.equal(snapshot.stage,'question',JSON.stringify(snapshot));assert.ok(snapshot.question);
  assert.ok(snapshot.question.text.includes(wording[language].stem),snapshot.question.text);
  assert.equal(snapshot.question.text.split(wording[language].stem).length,2,'An ARIA-associated stem must be read only once');
  assert.ok(snapshot.question.text.includes(wording[language].instruction));
  assert.doesNotMatch(snapshot.question.text,/SIDEBAR_PRIVATE_LESSON_TITLE|Submit Answer/);
  for(const label of wording[language].options)assert.ok(!snapshot.question.text.includes(label),'Choices must remain separate from the question stem');
  assert.deepEqual(snapshot.question.options.map(row=>row.text),wording[language].options);
  const applied=await h.send({type:'ALEF_APPLY',questionId:snapshot.question.id,questionFingerprint:snapshot.question.fingerprint,
    answer:{optionIds:['option-3'],text:'',explanation:'Deterministic DOM fixture only.',confidence:.99},autoSubmit:true});
  assert.equal(applied.submitted,true,JSON.stringify(applied));
  assert.deepEqual(await h.page.evaluate(()=>window.externalStemFixture),{selected:'option-3',submissions:1});
});

test('published player-container and aria-describedby keep the statement outside a bare radiogroup',async t=>{
  const h=await mount(t,{mode:'main'});
  const s=await h.send({type:'ALEF_INSPECT'});
  assert.equal(s.stage,'question',JSON.stringify(s));assert.ok(s.question);
  assert.ok(s.question.text.includes(wording.en.stem),s.question.text);
  assert.deepEqual(s.question.options.map(row=>row.id),['option-0','option-1','option-2','option-3']);
});

test('Arabic aria-labelledby keeps an external stem instead of using the generic instruction as its only label',async t=>{
  const h=await mount(t,{language:'ar',mode:'main'});
  await h.page.locator('[role="radiogroup"]').evaluate(node=>{
    node.removeAttribute('aria-describedby');node.setAttribute('aria-labelledby','external-stem');
  });
  const s=await h.send({type:'ALEF_INSPECT'});
  assert.ok(s.question?.text.includes(wording.ar.stem),JSON.stringify(s));
  assert.equal(s.question.text.split(wording.ar.stem).length,2);
});

test('an unlinked semantic heading in a single assessment player remains part of its question',async t=>{
  const h=await mount(t);
  await h.page.locator('[role="radiogroup"]').evaluate(node=>node.removeAttribute('aria-describedby'));
  const s=await h.send({type:'ALEF_INSPECT'});
  assert.ok(s.question?.text.includes(wording.en.stem),JSON.stringify(s));
});

test('an authored header in the question player is retained without treating it as account navigation',async t=>{
  const h=await mount(t);
  await h.page.locator('#external-stem').evaluate(node=>{
    const header=document.createElement('header');header.id=node.id;header.innerHTML=node.innerHTML;node.replaceWith(header);
  });
  await h.page.locator('[role="radiogroup"]').evaluate(node=>node.removeAttribute('aria-describedby'));
  const s=await h.send({type:'ALEF_INSPECT'});
  assert.ok(s.question?.text.includes(wording.en.stem),JSON.stringify(s));
});

test('a player control before the question is excluded from the recovered statement',async t=>{
  const h=await mount(t);
  await h.page.locator('[data-testid="assessment-content-player"]').evaluate(node=>node.insertAdjacentHTML('afterbegin','<button>PRIVATE_CONTROL_LABEL</button><div role="button">PRIVATE_ROLE_BUTTON_LABEL</div>'));
  const s=await h.send({type:'ALEF_INSPECT'});
  assert.ok(s.question?.text.includes(wording.en.stem),JSON.stringify(s));
  assert.doesNotMatch(s.question.text,/PRIVATE_CONTROL_LABEL|PRIVATE_ROLE_BUTTON_LABEL/);
});

for(const language of ['en','ar'])test(`${language} instruction alone is diagnosed before requesting an answer`,async t=>{
  const h=await mount(t,{language});
  await h.page.locator('#external-stem').evaluate(node=>node.remove());
  const s=await h.send({type:'ALEF_INSPECT'});
  assert.equal(s.stage,'question');assert.equal(s.question,null);
  assert.match(s.diagnostics.join(' '),/نص المسألة.*تعليمات اختيار الإجابة/);
  assert.equal((await h.page.evaluate(()=>window.externalStemFixture)).submissions,0);
});

test('ARIA stem references use their own shadow tree instead of an unrelated same-ID account node',async t=>{
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(()=>{
    document.body.innerHTML='<p id="stem">PRIVATE_UNRELATED_ACCOUNT_TEXT</p><div id="host"></div>';
    document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<h2 id="stem">What is 6 multiplied by 7?</h2><div role="radiogroup" aria-describedby="stem"><p>Select the correct answer.</p><label><input type="radio" name="q" value="a">42</label><label><input type="radio" name="q" value="b">43</label></div>';
  });
  const s=await h.send({type:'ALEF_INSPECT'});
  assert.match(s.question?.text||'',/6 multiplied by 7/);
  assert.doesNotMatch(s.question.text,/PRIVATE_UNRELATED_ACCOUNT_TEXT/);
});

test('a sibling diagram is captured with its statement rather than reducing the question to the selection instruction',async t=>{
  const h=await mount(t,{visual:true}),s=await h.send({type:'ALEF_INSPECT'});
  assert.ok(s.question?.text.includes(wording.en.stem),JSON.stringify(s));
  assert.equal(s.question.requiresVision,true);assert.equal(s.question.visuals.length,1);
  const capture=await h.send({type:'ALEF_GET_VISUALS',questionId:s.question.id,questionFingerprint:s.question.fingerprint});
  assert.equal(capture.ok,true,JSON.stringify(capture));assert.equal(capture.images.length,1);assert.ok(capture.images[0].data.length>100);
});

test('external HTML math preserves powers and excludes stylesheet-hidden terms',async t=>{
  const h=await mount(t);
  await h.page.locator('#external-stem').evaluate(node=>{
    node.innerHTML='<style>.hidden-external-term{visibility:hidden}</style><h2>Evaluate 2<sup>3</sup> + 1 <span class="hidden-external-term">+ 100</span></h2>';
  });
  const s=await h.send({type:'ALEF_INSPECT'});
  assert.match(s.question?.text||'',/2\^\(3\) \+ 1/);
  assert.doesNotMatch(s.question.text,/100|hidden-external-term|23/);
});

test('external stem changes invalidate a pending answer before any radio click or submission',async t=>{
  const h=await mount(t),before=await h.send({type:'ALEF_INSPECT'});
  await h.page.locator('#external-stem h2').evaluate(node=>node.textContent='What can be concluded about their corresponding angles?');
  const after=await h.send({type:'ALEF_INSPECT'});
  assert.notEqual(after.question.fingerprint,before.question.fingerprint);
  const stale=await h.send({type:'ALEF_APPLY',questionId:before.question.id,questionFingerprint:before.question.fingerprint,
    answer:{optionIds:['option-3'],text:'',explanation:'Stale fixture answer.',confidence:.99},autoSubmit:true});
  assert.equal(stale.ok,false);assert.match(stale.error,/تغير السؤال/);
  assert.deepEqual(await h.page.evaluate(()=>window.externalStemFixture),{selected:null,submissions:0});
});

test('hidden prior questions, sidebar text and visible result feedback stay out of the external stem',async t=>{
  const h=await mount(t);
  await h.page.evaluate(()=>{
    const player=document.querySelector('[data-testid="assessment-content-player"]');
    player.insertAdjacentHTML('afterbegin','<section hidden data-alef-question="old"><h2>OLD_HIDDEN_QUESTION</h2><label><input type="radio" name="old" value="old-a">OLD_CHOICE</label></section>');
    player.insertAdjacentHTML('beforeend','<div data-testid="general-answer-feedback"><p>RESULT_FEEDBACK_PRIVATE</p><svg role="img" width="80" height="80"><path d="M0 0H80V80H0Z"/></svg></div><div role="alert">ALERT_FEEDBACK_PRIVATE</div>');
  });
  const s=await h.send({type:'ALEF_INSPECT'});
  assert.ok(s.question?.text.includes(wording.en.stem),JSON.stringify(s));
  assert.doesNotMatch(s.question.text,/OLD_HIDDEN_QUESTION|OLD_CHOICE|RESULT_FEEDBACK_PRIVATE|ALERT_FEEDBACK_PRIVATE|SIDEBAR_PRIVATE/);
  assert.notEqual(s.question.requiresVision,true,'A feedback illustration is not evidence for the current question');
});

test('several visible question owners remain ambiguous instead of borrowing a neighbouring stem',async t=>{
  const h=await mount(t);
  await h.page.locator('[data-testid="assessment-content-player"]').evaluate(player=>player.insertAdjacentHTML('beforeend',
    '<section data-alef-question="second"><h2>ANOTHER_VISIBLE_QUESTION</h2><label><input type="radio" name="second" value="other-a">Other A</label><label><input type="radio" name="second" value="other-b">Other B</label></section>'));
  const s=await h.send({type:'ALEF_INSPECT'});
  assert.equal(s.question,null);assert.match(s.diagnostics.join(' '),/عدة أسئلة/);
  assert.equal((await h.page.evaluate(()=>window.externalStemFixture)).submissions,0);
});

test('worker receives the full external stem and applies a deterministic fixture answer to its original option ID',async t=>{
  const h=await mount(t),requests=[],events=[];
  let handler;
  const chrome={
    runtime:{id:'external-stem-test',getURL:path=>'chrome-extension://external-stem-test/'+path,getPlatformInfo:async()=>({}),
      onMessage:{addListener(fn){handler=fn;}},sendMessage:async message=>events.push(structuredClone(message))},
    storage:{session:{get:async()=>({}),set:async()=>{}}},
    tabs:{get:async()=>({id:1,url:h.page.url()}),sendMessage:async(_tab,message)=>h.send(message),onRemoved:{addListener(){}}},
    scripting:{executeScript:async()=>{}},action:{onClicked:{addListener(){}}},
  };
  const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
  vm.runInNewContext(source,{chrome,URL,AbortController,AbortSignal,DOMException,setTimeout,clearTimeout,setInterval,clearInterval,
    fetch:async(url,options)=>{
      if(url.endsWith('/api/health'))return Response.json({ok:true,configured:true,provider:'ollama',modelReady:true,protocolVersion:3,visionReady:true});
      const request=JSON.parse(options.body);requests.push(request);
      assert.ok(request.question.text.includes(wording.en.stem),request.question.text);
      const option=request.question.options.find(row=>row.text==='They are proportional.');assert.ok(option);
      return Response.json({answer:{optionIds:[option.id],text:'',explanation:'Deterministic integration fixture; no real model call.',confidence:.99},verified:false,needsReview:false});
    }});
  const send=message=>new Promise(resolve=>handler({tabId:1,...message},{id:'external-stem-test',url:'chrome-extension://external-stem-test/dashboard.html'},resolve));
  const close=h.close;
  h.close=async()=>{await send({type:'STOP'});await close();};
  assert.equal((await send({type:'CONNECT'})).ok,true);
  assert.equal((await send({type:'START',subjectId:'current',config:{serverUrl:'http://127.0.0.1:4318',token:'fixture-only',verify:false,qualityMode:false,
    autoSubmit:true,skipInstruction:true,minConfidence:.85}})).ok,true);
  const deadline=Date.now()+6000;
  while(!events.some(row=>row.event?.kind==='submitted')){
    if(Date.now()>=deadline)assert.fail(JSON.stringify({events,requests}));
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(requests.length,1);assert.equal((await h.page.evaluate(()=>window.externalStemFixture)).submissions,1);
  assert.equal((await send({type:'STOP'})).ok,true);
});
