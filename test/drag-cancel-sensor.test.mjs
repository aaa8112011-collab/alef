import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

// The published DndKit AbstractPointerSensor uses event.code === 'Escape'
// in handleKeydown, not event.key. Its mouseup ends the active drag using
// the last collision; mouseup coordinates do not cancel that collision.
// Keep that contract here: a key-only Escape must NOT make this fixture pass.
async function setup(t,language='ar') {
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(language=>{
    document.body.innerHTML='<main><section class="dnd-container question-widget"><h2 data-testid="question-statement-container"></h2><div class="template-container"><span id="droppable-0" data-index="0" class="dnd-droppable" style="display:block;width:160px;height:48px;border:1px solid #666;margin:20px"></span></div><div class="dnd-options-draggable" style="display:inline-block;border:1px solid #666;padding:20px"></div></section><button data-alef-submit disabled>Submit Answer</button></main>';
    document.querySelector('h2').textContent=language==='ar'?'ضع الكلمة في مكانها الصحيح.':'Place the word in the correct blank.';
    const source=document.querySelector('.dnd-options-draggable'),blank=document.querySelector('.dnd-droppable');
    source.textContent=language==='ar'?'ماء':'water';
    const state=window.sensorCancel={moves:0,cancelled:0,drops:0,submits:0,events:[],active:false};
    let timer=null,lastCollision=null,activated=false;
    const detach=()=>{clearTimeout(timer);state.active=false;activated=false;source.classList.remove('is-dragging');};
    source.addEventListener('mousedown',event=>{
      if(event.button!==0||state.active)return;
      state.active=true;state.events.push('down');
      timer=setTimeout(()=>{if(state.active){activated=true;source.classList.add('is-dragging');}},100);
    });
    document.addEventListener('mousemove',()=>{
      if(!state.active||!activated)return;
      state.moves++;lastCollision=blank;
      // A collision is pending while the requested DOM hover acknowledgement
      // has not appeared. The adapter must cancel rather than commit it.
    });
    document.addEventListener('keydown',event=>{
      if(!state.active)return;
      state.events.push('key:'+event.key+':'+event.code);
      if(event.code==='Escape'){state.cancelled++;state.events.push('cancel');detach();}
    });
    document.addEventListener('mouseup',()=>{
      state.events.push('up');
      if(!state.active)return;
      if(activated&&lastCollision){state.drops++;state.events.push('drop');}
      detach();
    });
    document.querySelector('button').onclick=()=>state.submits++;
  },language);
  const read=await h.send({type:'ALEF_GET_QUESTION'});assert.equal(read.ok,true,JSON.stringify(read));
  const q=read.question;assert.equal(q.type,'matching');
  return {h,apply:()=>h.send({type:'ALEF_APPLY',questionId:q.id,questionFingerprint:q.fingerprint,autoSubmit:true,
    answer:{optionIds:[],text:'',matches:[{itemId:q.items[0].id,targetId:q.targets[0].id}],confidence:.99,explanation:'Fixture only'}})};
}

for(const language of ['ar','en'])test(`${language}: STOP after a held mouse move sends the sensor's Escape code before releasing, without committing a pending drop`,async t=>{
  const {h,apply}=await setup(t,language),pending=apply();
  await h.page.waitForFunction(()=>window.sensorCancel.moves>0);
  assert.equal((await h.send({type:'ALEF_CANCEL'})).ok,true);
  const result=await pending;assert.equal(result.ok,false,JSON.stringify(result));
  const state=await h.page.evaluate(()=>window.sensorCancel);
  assert.equal(state.cancelled,1);assert.equal(state.active,false);assert.equal(state.drops,0);assert.equal(state.submits,0);
  assert.ok(state.events.includes('key:Escape:Escape'),JSON.stringify(state.events));
  assert.ok(state.events.indexOf('cancel')<state.events.indexOf('up'));
});

test('an unacknowledged hover timeout cancels the MouseSensor before cleanup mouseup can end the pending drag',async t=>{
  const {h,apply}=await setup(t),result=await apply();
  assert.equal(result.ok,false,JSON.stringify(result));assert.match(result.error,/موضع إسقاط/);
  const state=await h.page.evaluate(()=>window.sensorCancel);
  assert.ok(state.moves>0);assert.equal(state.cancelled,1);assert.equal(state.drops,0);assert.equal(state.submits,0);
  assert.equal(state.active,false);assert.ok(state.events.indexOf('cancel')<state.events.indexOf('up'));
});
