import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

// Published progress roots and DND validation IMG classes are player chrome.
// These browser-reader tests do not run a model or an authenticated account.
async function setup(t,{language='ar',progressTestId='slides-progress-bar',progressId='',legacy=false,authoredImage=null,authoredId=null}={}){
 const h=await createBrowserHarness();t.after(()=>h.close());
 await h.page.evaluate(async settings=>{
  const {language,progressTestId,progressId,legacy,authoredImage,authoredId}=settings;
  const ar=language==='ar',w=value=>legacy?value:'lib-'+value;
  document.documentElement.dir=ar?'rtl':'ltr';
  document.body.innerHTML=`<main id="player-container"><div data-testid="assessment-content-player">
   <section class="${w('dnd-container')} ${w('question-widget')}">
    <div id="progress-fixture-host"></div><div data-testid="progress-bar-slide-count">1/5</div>
    <h2>${ar?'اقرأ العبارة ثم ضع كل كلمة في الفراغ المناسب.':'Read the statement and place each word in its blank.'}</h2>
    <div class="${w('template-container')}">${ar?'النوع':'Type'}
     <span id="droppable-0" data-index="0" class="${w('dnd-droppable')}" style="display:inline-block;width:150px;height:45px;border:1px solid"></span>
     ${ar?'لأن العنصر':'because the element'}
     <span id="droppable-1" data-index="1" class="${w('dnd-droppable')}" style="display:inline-block;width:150px;height:45px;border:1px solid"></span>.</div>
    <div class="${w('dnd-options-wrapper')}"></div>
   </section><button disabled>${ar?'أرسل إجابتي':'Submit Answer'}</button>
  </div></main>`;
  const section=document.querySelector('section');if(authoredId)section.dataset.questionId=authoredId;
  const bar=document.createElement('div');bar.style.cssText='height:30px;width:300px';
  if(progressTestId)bar.dataset.testid=progressTestId;if(progressId)bar.id=progressId;
  document.querySelector('#progress-fixture-host').append(bar);
  const labels=ar?['ماء','ماء مالح','هواء','شمس','أرض','قمر','نبات']:['water','salt water','air','sun','earth','moon','plant'];
  for(const label of labels){const node=document.createElement('div');node.className=w('dnd-options-draggable');node.textContent=label;document.querySelector('.'+w('dnd-options-wrapper')).append(node);}
  const source=color=>'data:image/svg+xml,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="7" fill="${color}"/></svg>`);
  const image=async({color='green',className='',alt=''})=>{const node=new Image(20,20);node.src=source(color);node.className=className;node.alt=alt;await node.decode();return node;};
  if(authoredImage){
   const node=await image({color:'blue',className:authoredImage==='same-class-outside'?w('validationIcon'):'',alt:'Required authored miniature'});
   if(authoredImage==='inside-blank')document.querySelector('#droppable-0').append(node);
   else if(authoredImage==='adjacent')document.querySelector('[data-testid="assessment-content-player"]').append(node);
   else section.append(node);
  }
  window.setProgressChrome=async kind=>{
   bar.replaceChildren();
   const captions=document.createElement('span');captions.textContent=ar?'السؤال 1 السؤال 2 السؤال 3 السؤال 4 السؤال 5':'Question 1 Question 2 Question 3 Question 4 Question 5';bar.append(captions);
   bar.append(await image({color:kind==='correct'?'green':'red',alt:kind==='correct'?'Correct':'Incorrect'}));
   const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('width','20');svg.setAttribute('height','20');svg.setAttribute('role','img');
   const circle=document.createElementNS(svg.namespaceURI,'circle');circle.setAttribute('cx','10');circle.setAttribute('cy','10');circle.setAttribute('r','7');circle.setAttribute('fill',kind==='correct'?'green':'red');svg.append(circle);bar.append(svg);
  };
  window.setDndResult=async kind=>{
   for(const [index,blank] of [...document.querySelectorAll('[id^="droppable-"]')].entries()){
    blank.replaceChildren();blank.classList.add(w('is-selected'));
    const selected=document.createElement('span');selected.className=w('selected-option');selected.textContent=labels[index];blank.append(selected);
    blank.append(await image({color:kind==='correct'?'green':'red',className:w('validationIcon'),alt:'valdation icon'}));
   }
  };
 },{language,progressTestId,progressId,legacy,authoredImage,authoredId});
 const read=async()=>{
  const result=await h.send({type:'ALEF_GET_QUESTION'});assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.question?.type,'matching',JSON.stringify(result));
  assert.equal(result.question.items.length,2);assert.equal(result.question.targets.length,7);return result.question;
 };
 return {h,read};
}
function sameEvidence(before,after){
 assert.equal(after.text,before.text);assert.equal(after.id,before.id);assert.equal(after.fingerprint,before.fingerprint);
 assert.equal(typeof after.contentFingerprint,'string');assert.equal(after.contentFingerprint,before.contentFingerprint);
 assert.deepEqual(after.items,before.items);assert.deepEqual(after.targets,before.targets);
 assert.equal(after.requiresVision,before.requiresVision);assert.deepEqual(after.visuals,before.visuals);
}

for(const language of ['ar','en'])for(const progressTestId of ['slides-progress-bar','k4-slides-progress-bar','section-result-slides-progress-bar','section-result-k4-slides-progress-bar'])test(`${language}: ${progressTestId} status IMG, SVG and question captions do not change authored evidence`,async t=>{
 const {h,read}=await setup(t,{language,progressTestId}),before=await read();
 assert.equal(before.requiresVision,undefined);assert.equal(before.visuals,undefined);
 for(const kind of ['correct','incorrect']){
  await h.page.evaluate(kind=>window.setProgressChrome(kind),kind);const after=await read();
  sameEvidence(before,after);assert.ok(!/السؤال [1-5]|Question [1-5]/.test(after.text));
 }
});

for(const progressId of ['slides-progress-bar','k4-slides-progress-bar'])test(`the published #${progressId} root is chrome even without its test ID`,async t=>{
 const {h,read}=await setup(t,{progressTestId:'',progressId}),before=await read();
 await h.page.evaluate(()=>window.setProgressChrome('correct'));sameEvidence(before,await read());
});

for(const language of ['ar','en'])test(`${language}: an early counter change changes position identity without changing content identity`,async t=>{
 const {h,read}=await setup(t,{language}),before=await read();
 await h.page.locator('[data-testid="progress-bar-slide-count"]').evaluate(node=>{node.textContent='2/5';});
 const after=await read();assert.equal(after.text,before.text);
 assert.equal(typeof after.contentFingerprint,'string');assert.equal(after.contentFingerprint,before.contentFingerprint);
 assert.notEqual(after.fingerprint,before.fingerprint);assert.notEqual(after.id,before.id);
 assert.ok(!after.text.includes('1/5')&&!after.text.includes('2/5'));
});

test('a fresh authored question ID distinguishes identical authored evidence at the same position',async t=>{
 const {h,read}=await setup(t,{authoredId:'first-authored-question'}),before=await read();
 await h.page.locator('section').evaluate(node=>{node.dataset.questionId='second-authored-question';});
 const after=await read();assert.equal(after.text,before.text);assert.equal(after.fingerprint,before.fingerprint);
 assert.notEqual(after.id,before.id);assert.notEqual(after.contentFingerprint,before.contentFingerprint);
});

for(const authoredImage of ['inside-blank','inside','adjacent'])test(`a genuine 20px ${authoredImage} diagram remains required while progress status chrome is excluded`,async t=>{
 const {h,read}=await setup(t,{authoredImage}),before=await read();
 assert.equal(before.requiresVision,true);assert.equal(before.visuals.length,1);assert.equal(before.visuals[0].alt,'Required authored miniature');
 await h.page.evaluate(()=>window.setProgressChrome('correct'));sameEvidence(before,await read());
});

for(const language of ['ar','en'])for(const legacy of [false,true])test(`${language}: ${legacy?'legacy':'published lib-'} DND result validation icons preserve both bindings and text-only identity`,async t=>{
 const {h,read}=await setup(t,{language,legacy}),before=await read();
 assert.equal(before.requiresVision,undefined);assert.equal(before.visuals,undefined);
 for(const kind of ['correct','incorrect']){await h.page.evaluate(kind=>window.setDndResult(kind),kind);sameEvidence(before,await read());}
});

test('the validationIcon class on an authored image outside the DND blank remains required',async t=>{
 const {h,read}=await setup(t,{authoredImage:'same-class-outside'}),before=await read();
 assert.equal(before.requiresVision,true);assert.equal(before.visuals.length,1);assert.equal(before.visuals[0].alt,'Required authored miniature');
 await h.page.evaluate(()=>window.setDndResult('correct'));sameEvidence(before,await read());
});
