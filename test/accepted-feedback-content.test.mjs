import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

// The field/result classes and IMG tags match published Weaver FIB markup.
// These DOM fixtures verify question identity and result chrome, not inference.
async function setup(t,{language='en',legacy=false,smallDiagram=false}={}){
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(async({language,legacy,smallDiagram})=>{
    const w=token=>legacy?token:'lib-'+token;
    document.documentElement.dir=language==='ar'?'rtl':'ltr';
    const icon='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path d="M2 10l5 5 10-12" stroke="green" fill="none"/></svg>');
    document.body.innerHTML=`<style>.${w('option-icon')}{display:none;width:20px;height:20px}.${w('field-is-correct')} .${w('option-correct-icon')},.${w('field-is-incorrect')} .${w('option-incorrect-icon')}{display:inline-block}</style>
      <main id="player-container"><div data-testid="assessment-content-player">
      <div data-testid="progress-bar-slide-count">3/5</div>
      <section class="${w('fib-container')} ${w('question-widget')}">
       <h2>${language==='ar'?'اكتب الإجابة الصحيحة.':'Type the correct answer(s).'}</h2>
       <p>${language==='ar'?'أوجد قيمة س باستخدام الرسم.':'Find the value of x using the diagram.'}</p>
       <div class="${w('fib-input-field-container')}"><span>x = </span><input type="text" placeholder="Type...">
        <img class="${w('option-icon')} ${w('option-correct-icon')}" alt="incorrect icon" tabindex="-1" src="${icon}">
        <img class="${w('option-icon')} ${w('option-incorrect-icon')}" alt="correct icon" tabindex="-1" src="${icon}">
       </div><canvas id="authored-graph" width="220" height="140"></canvas>
      </section><button id="submit">Submit Answer</button>
      </div></main>`;
    const ctx=document.querySelector('canvas').getContext('2d');
    ctx.fillStyle='white';ctx.fillRect(0,0,220,140);ctx.fillStyle='#005adc';ctx.fillRect(20,20,45,45);
    if(smallDiagram){
      const image=new Image(20,20);image.id='authored-small-diagram';image.alt='A necessary small authored figure';image.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="7" fill="blue"/></svg>');
      document.querySelector('section').append(image);await image.decode();
    }
    window.setAcceptedFeedback=({kind='correct',locked=true,outside=false}={})=>{
      const field=outside?document.body.appendChild(document.createElement('div')):document.querySelector('.'+w('fib-input-field-container'));
      field.classList.add(w('fib-input-field-container'),w('is-'+kind),w('field-is-'+kind));
      const input=document.querySelector('input');input.value='17/4';input.disabled=locked===true;input.readOnly=locked==='readonly';
      const existing=document.querySelector('#submit');
      if(existing){
        const button=document.createElement('button');button.id=kind==='correct'?'next':'retry';
        button.textContent=kind==='correct'?'Next':'Try Again';existing.replaceWith(button);
      }
      const feedback=document.createElement('div');feedback.dataset.testid='default-question-feedback-container';
      feedback.textContent=kind==='correct'?'Awesome!':'Try Again';document.querySelector('main').append(feedback);
    };
  },{language,legacy,smallDiagram});
  const read=async()=>{
    const result=await h.send({type:'ALEF_GET_QUESTION'});assert.equal(result.ok,true,JSON.stringify(result));
    assert.equal(result.question?.type,'text',JSON.stringify(result));return result;
  };
  return {h,read};
}

for(const language of ['ar','en'])test(`${language}: accepted FIB result IMG keeps its question identity and authored graph before Next`,async t=>{
  const {h,read}=await setup(t,{language}),before=await read();
  assert.equal(before.question.visuals.length,1);
  await h.page.evaluate(()=>window.setAcceptedFeedback());
  const after=await read();
  assert.equal(after.question.id,before.question.id,'The result tick must not create a new question');
  assert.equal(after.question.fingerprint,before.question.fingerprint);
  assert.equal(after.question.text,before.question.text);
  assert.deepEqual(after.question.visuals,before.question.visuals);
  assert.equal(after.feedback,'correct');assert.equal(after.canNext,true);
  const snapshot=await h.send({type:'ALEF_INSPECT'});
  assert.equal(snapshot.feedback,'correct');assert.equal(snapshot.navigation.filter(action=>action.kind==='next').length,1);
});

for(const language of ['ar','en'])test(`${language}: rejected FIB result IMG keeps retry identity and preserves the required graph`,async t=>{
  const {h,read}=await setup(t,{language}),before=await read();
  await h.page.evaluate(()=>window.setAcceptedFeedback({kind:'incorrect'}));
  const after=await read();
  assert.equal(after.question.id,before.question.id);assert.equal(after.question.fingerprint,before.question.fingerprint);
  assert.deepEqual(after.question.visuals,before.question.visuals);assert.equal(after.feedback,'wrong');
  const snapshot=await h.send({type:'ALEF_INSPECT'});assert.equal(snapshot.feedback,'wrong');
  assert.equal(snapshot.navigation.filter(action=>action.kind==='retry').length,1);
});

for(const kind of ['correct','incorrect'])test(`legacy FIB ${kind} result icons retain the original question and graph`,async t=>{
  const {h,read}=await setup(t,{legacy:true}),before=await read();
  await h.page.evaluate(kind=>window.setAcceptedFeedback({kind}),kind);const after=await read();
  assert.equal(after.question.id,before.question.id);assert.equal(after.question.fingerprint,before.question.fingerprint);
  assert.deepEqual(after.question.visuals,before.question.visuals);assert.equal(after.feedback,kind==='correct'?'correct':'wrong');
});

test('a small authored image is retained while the FIB result icon is excluded',async t=>{
  const {h,read}=await setup(t,{smallDiagram:true}),before=await read();
  assert.equal(before.question.visuals.length,2,'Small authored diagrams cannot be discarded by a size-only filter');
  assert.ok(before.question.visuals.some(image=>image.alt==='A necessary small authored figure'));
  await h.page.evaluate(()=>window.setAcceptedFeedback());const after=await read();
  assert.deepEqual(after.question.visuals,before.question.visuals);assert.equal(after.question.fingerprint,before.question.fingerprint);
});

test('editable FIB styling alone does not attest that an answer was accepted',async t=>{
  const {h,read}=await setup(t);
  await h.page.evaluate(()=>window.setAcceptedFeedback({locked:false}));
  assert.notEqual((await read()).feedback,'correct');
});

test('a correct field outside the current question does not attest its answer',async t=>{
  const {h,read}=await setup(t);
  await h.page.evaluate(()=>window.setAcceptedFeedback({outside:true}));
  assert.notEqual((await read()).feedback,'correct');
});


test('an accepted read-only FIB field reports its result without changing the question',async t=>{
  const {h,read}=await setup(t),before=await read();
  await h.page.evaluate(()=>window.setAcceptedFeedback({locked:'readonly'}));const after=await read();
  assert.equal(after.feedback,'correct');assert.equal(after.question.id,before.question.id);
  assert.equal(after.question.fingerprint,before.question.fingerprint);assert.deepEqual(after.question.visuals,before.question.visuals);
});
