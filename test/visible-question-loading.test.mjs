import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

async function mount(t,html){
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(html=>{document.body.innerHTML='<main data-testid="ncle-activity-page-player">'+html+'</main>';},html);
  return h;
}
const persistentProgress='<div role="progressbar" aria-valuenow="2" aria-valuemax="5" style="width:500px;height:8px;background:#abd"></div>';

for(const [kind,html] of [
  ['native dropdown','<section data-alef-question="native"><p>Choose the number equal to two.</p><select><option value="a">1</option><option value="b">2</option></select></section>'],
  ['Arabic writing','<section class="open-ended-container question-widget"><p>اكتب اسم عاصمة الإمارات.</p><textarea aria-label="الإجابة"></textarea></section>'],
  ['Arabic held dragging','<section class="dnd-container question-widget"><p>أكمل الجملة بالكلمة المناسبة.</p><span class="dnd-droppable" id="droppable-one" data-index="1" style="display:inline-block;width:130px;height:40px"></span><span class="dnd-options-draggable" style="display:inline-block;padding:15px">أبوظبي</span><span class="dnd-options-draggable" style="display:inline-block;padding:15px">دبي</span></section>'],
])test(`a visible ${kind} takes precedence over a persistent lesson progress indicator`,async t=>{
  const h=await mount(t,persistentProgress+html);
  const s=await h.send({type:'ALEF_INSPECT'});
  assert.equal(s.stage,'question');assert.ok(s.question,JSON.stringify(s));
  assert.equal(s.loading,false,'The question is mounted; the progress bar is not an unresolved content load');
  assert.deepEqual(s.diagnostics,[]);
});

test('an unprepared custom dropdown is ready for opening despite a persistent lesson progress indicator',async t=>{
  const h=await mount(t,persistentProgress+'<section class="dropdown-container question-widget"><p>Choose the capital of the UAE: <span class="dropdown-input-field-container"><span class="dropdown-single-value-content">Select...</span><input readonly role="combobox" aria-controls="options" aria-expanded="false"></span>.</p></section>');
  const s=await h.send({type:'ALEF_INSPECT'});
  assert.equal(s.stage,'question');assert.equal(s.needsPreparation,true);assert.equal(s.question,null);
  assert.equal(s.loading,false);assert.deepEqual(s.diagnostics,[]);
});

test('a visible unsupported answer tool keeps its precise reading error instead of pretending to load',async t=>{
  const h=await mount(t,persistentProgress+'<section class="fib-container question-widget"><p>أوجد قيمة المتغير س.</p><math-field style="display:inline-block;width:150px;height:40px">x=</math-field></section>');
  const s=await h.send({type:'ALEF_INSPECT'});
  assert.equal(s.stage,'question');assert.equal(s.question,null);assert.equal(s.loading,false);
  assert.ok(s.diagnostics.some(message=>/محرر معادلات/.test(message)),JSON.stringify(s));
});

test('an empty question wrapper with a real spinner still reports unresolved loading',async t=>{
  const h=await mount(t,'<section data-alef-question="pending"><div class="loading-spinner" style="height:40px;width:40px">Loading</div></section>');
  const s=await h.send({type:'ALEF_INSPECT'});
  assert.equal(s.question,null);assert.equal(s.needsPreparation,false);assert.equal(s.loading,true);
});

test('an empty NCLE player retains its real loading state without inventing a question',async t=>{
  const h=await mount(t,'<div class="loading-spinner" style="height:40px;width:40px">Loading</div>');
  const s=await h.send({type:'ALEF_INSPECT'});
  assert.equal(s.question,null);assert.equal(s.needsPreparation,false);assert.equal(s.loading,true);
});

test('a ready visible question cannot erase an explicitly loading required material frame',async t=>{
  const h=await mount(t,'<section data-alef-question="current"><p>Choose the number equal to two.</p><select><option value="a">1</option><option value="b">2</option></select></section><iframe data-testid="iframed-mlo" data-loading="true" srcdoc="Loading material" style="height:120px;width:300px"></iframe>');
  const s=await h.send({type:'ALEF_INSPECT'});
  assert.ok(s.question);assert.equal(s.frames.length,1);assert.equal(s.frames[0].required,true);
  assert.equal(s.frames[0].loading,true);assert.equal(s.loading,true);
});
