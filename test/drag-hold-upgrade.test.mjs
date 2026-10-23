import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserHarness } from '../scripts/test-browser.mjs';

// Exercise the adapter's real mouse sequence. This fixture intentionally does
// not accept HTML5 drag events or a drop before its MouseSensor has activated.
async function mount(t, options = {}) {
  const h = await createBrowserHarness(); t.after(() => h.close());
  await h.page.evaluate(options => {
    const config = { hold: 1000, slots: 1, language: 'ar', ...options };
    document.body.innerHTML = '<main><div class="dnd-container question-widget" id="hold-question"><div data-testid="question-statement-container"></div><div class="template-container"></div><div id="word-bank"></div></div><button id="navigation-next-button" data-testid="navigation-next-button" disabled>Submit Answer</button></main>';
    const widget = document.querySelector('#hold-question'), template = widget.querySelector('.template-container'), bank = widget.querySelector('#word-bank');
    widget.querySelector('[data-testid="question-statement-container"]').textContent = config.language === 'ar' ? 'ضع كل كلمة في فراغها الصحيح.' : 'Place each word in the correct blank.';
    const words = config.language === 'ar' ? ['ماء', 'ماء مالح'] : ['water', 'salt water'];
    window.holdFixture = { events: [], submissions: 0, drops: [], cancelled: 0, activation: [], coordinates: [], held: false };
    const state = window.holdFixture;
    const submit = document.querySelector('button');
    submit.onclick = () => { state.submissions += 1; };
    for (let index = 1; index <= config.slots; index++) {
      const blank = document.createElement('span');
      blank.id = 'droppable-' + index; blank.className = 'dnd-droppable'; blank.dataset.index = String(index);
      blank.style.cssText = 'display:block;width:170px;height:50px;margin:20px;border:1px solid #666';
      template.append(blank);
    }
    let active = null;
    const clear = () => {
      if (!active) return;
      clearTimeout(active.timer); active.node.classList.remove('is-dragging'); active.node.setAttribute('aria-pressed', 'false');
      for (const blank of template.children) blank.classList.remove('is-about-to-drop');
      active = null; state.held = false;
    };
    for (const word of words) {
      const node = document.createElement('div'); node.className = 'dnd-options-draggable'; node.textContent = word;
      node.style.cssText = 'display:inline-block;padding:20px;margin:10px;border:1px solid #999'; bank.append(node);
      node.addEventListener('mousedown', event => {
        state.events.push({ kind: 'down', buttons: event.buttons, word });
        if (event.button !== 0 || event.buttons !== 1 || active) return;
        active = { node, word, at: performance.now(), activated: false, over: null, moved: false };
        state.held = true; const pressed = active;
        active.timer = setTimeout(() => {
          if (active !== pressed) return;
          active.activated = true; node.classList.add('is-dragging'); node.setAttribute('aria-pressed', 'true');
          state.activation.push(performance.now() - active.at);
          if (config.shiftOnActivate) template.style.marginTop = '950px';
        }, config.hold);
      });
      node.addEventListener('dragstart', () => state.events.push({ kind: 'html5' }));
    }
    document.addEventListener('mousemove', event => {
      if (!active) return;
      state.events.push({ kind: 'move', buttons: event.buttons, activated: active.activated });
      active.over = null;
      for (const blank of template.children) blank.classList.remove('is-about-to-drop');
      if (!active.activated || event.buttons !== 1) return;
      for (const blank of template.children) {
        const r = blank.getBoundingClientRect();
        if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) continue;
        if (config.shiftAfterFirstMove && !active.moved) { active.moved = true; blank.style.marginLeft = '270px'; return; }
        active.over = blank; blank.classList.add('is-about-to-drop');
        state.coordinates.push({ x: event.clientX, y: event.clientY, left: r.left, right: r.right, top: r.top, bottom: r.bottom, blank: blank.dataset.index });
      }
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && active) { state.cancelled += 1; clear(); } });
    document.addEventListener('mouseup', event => {
      state.events.push({ kind: 'up', buttons: event.buttons });
      if (!active) return;
      const drop = active; clear();
      if (!drop.activated || !drop.over || event.buttons !== 0) return;
      state.drops.push({ blank: drop.over.dataset.index, word: drop.word, heldMs: performance.now() - drop.at });
      setTimeout(() => {
        const blank = config.wrongSlot ? template.children[1] : drop.over;
        const label = config.substring ? words[1] : drop.word;
        blank.innerHTML = '<span class="selected-option"></span><span class="dnd-droppable__edit-label-tab">Edit</span>';
        blank.querySelector('.selected-option').textContent = label; blank.classList.add('is-selected'); drop.node.remove();
        if (config.corruptEarlier && state.drops.length === config.slots) template.children[0].querySelector('.selected-option').textContent = 'wrong placement';
        if(config.corruptBeforeSubmit){setTimeout(()=>{blank.querySelector('.selected-option').textContent='wrong placement';},100);setTimeout(()=>{submit.disabled=false;},260);}
        else submit.disabled = false;
      }, 70);
    });
  }, options);
  const read = await h.send({ type: 'ALEF_GET_QUESTION' });
  assert.equal(read.ok, true, JSON.stringify(read)); assert.equal(read.question?.type, 'matching', JSON.stringify(read));
  return { h, q: read.question };
}

const apply = (h, q, matches) => h.send({ type: 'ALEF_APPLY', questionId: q.id, questionFingerprint: q.fingerprint, answer: { optionIds: [], text: '', matches, explanation: 'تجربة التفاعل', confidence: .99 }, autoSubmit: true });
const pairs = q => q.items.map((item, index) => ({ itemId: item.id, targetId: q.targets[index].id }));

test('Arabic drag holds for actual one-second activation, tracks layout/scroll and preserves both original word IDs', async t => {
  const { h, q } = await mount(t, { slots: 2, hold: 1000, shiftOnActivate: true, shiftAfterFirstMove: true });
  assert.deepEqual(q.targets.map(row => row.text), ['ماء', 'ماء مالح']);
  const result = await apply(h, q, pairs(q));
  assert.equal(result.ok, true, JSON.stringify({result,state:await h.page.evaluate(()=>window.holdFixture)})); assert.equal(result.submitted, true);
  const state = await h.page.evaluate(() => window.holdFixture);
  assert.deepEqual(state.drops.map(({ blank, word }) => ({ blank, word })), [{ blank: '1', word: 'ماء' }, { blank: '2', word: 'ماء مالح' }]);
  assert.ok(state.drops.every(row => row.heldMs >= 1000));
  assert.ok(state.events.filter(row => row.kind === 'move').every(row => row.buttons === 1 && row.activated));
  assert.equal(state.events.filter(row => row.kind === 'down').length, 2); assert.equal(state.events.filter(row => row.kind === 'up').length, 2);
  assert.equal(state.events.some(row => row.kind === 'html5'), false); assert.equal(state.held, false); assert.equal(state.submissions, 1);
  assert.ok(state.coordinates.length >= 2);
  assert.ok(state.coordinates.every(row => row.x >= row.left && row.x <= row.right && row.y >= row.top && row.y <= row.bottom));
  const after = await h.send({ type: 'ALEF_GET_QUESTION' });
  assert.equal(after.question.fingerprint, q.fingerprint, 'Consumed source words must not change the current question identity');
  assert.deepEqual(after.question.targets, q.targets);
});

test('English drag proceeds when the actual 100-ms sensor is ready and submits exactly once', async t => {
  const { h, q } = await mount(t, { hold: 100, language: 'en' });
  const result = await apply(h, q, pairs(q)); assert.equal(result.ok, true, JSON.stringify(result));
  const state = await h.page.evaluate(() => window.holdFixture);
  assert.equal(state.activation.length, 1); assert.equal(state.drops.length, 1); assert.ok(state.drops[0].heldMs >= 100);
  assert.deepEqual(state.events.map(row => row.kind), ['down', 'move', 'up']); assert.equal(state.submissions, 1);
});

test('STOP during a one-second drag hold releases the primary button and never drops or submits later', async t => {
  const { h, q } = await mount(t, { hold: 1000 });
  const pending = apply(h, q, pairs(q));
  await h.page.waitForFunction(() => window.holdFixture.held);
  assert.equal((await h.send({ type: 'ALEF_CANCEL' })).ok, true);
  const result = await pending; assert.equal(result.ok, false, JSON.stringify(result));
  await h.page.waitForTimeout(1100);
  const state = await h.page.evaluate(() => window.holdFixture);
  assert.equal(state.held, false); assert.equal(state.cancelled, 1); assert.deepEqual(state.drops, []); assert.equal(state.submissions, 0);
  assert.deepEqual(state.events.map(row => row.kind), ['down', 'up']); assert.equal(state.events.at(-1).buttons, 0);
});

test('a longer Arabic word cannot acknowledge a shorter requested word or enable submission', async t => {
  const { h, q } = await mount(t, { hold: 100, substring: true });
  const result = await apply(h, q, pairs(q)); assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(result.error, /لم يؤكد الموقع وضع الكلمة/); assert.equal(await h.page.evaluate(() => window.holdFixture.submissions), 0);
});

test('a word placed in the wrong blank blocks the whole matching submission', async t => {
  const { h, q } = await mount(t, { hold: 100, slots: 2, wrongSlot: true });
  const result = await apply(h, q, pairs(q)); assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(result.error, /لم يؤكد الموقع وضع الكلمة/); assert.equal(await h.page.evaluate(() => window.holdFixture.submissions), 0);
});

test('a later drop cannot silently replace an earlier correctly placed word before submit', async t => {
  const { h, q } = await mount(t, { hold: 100, slots: 2, corruptEarlier: true });
  const result = await apply(h, q, pairs(q)); assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(result.error, /تثبيت جميع الكلمات/); assert.equal(await h.page.evaluate(() => window.holdFixture.submissions), 0);
});

test('all placed words are checked again when delayed Submit becomes enabled', async t => {
  const { h, q } = await mount(t, { hold: 100, corruptBeforeSubmit: true });
  const result = await apply(h, q, pairs(q)); assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.submitted, false);
  assert.equal(await h.page.evaluate(() => window.holdFixture.submissions), 0);
});

test('Pathways click-to-fill also rejects a longer word instead of the requested exact Arabic word', async t => {
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(()=>{
    document.body.innerHTML='<main><section data-alef-question="pathways-words"><h2>ضع الكلمة في الفراغ المناسب.</h2><span data-testid="fill-blank-dd-slot"></span><div data-testid="draggableChoice">ماء</div><div data-testid="draggableChoice">ماء مالح</div><button data-alef-submit>Submit answer</button></section></main>';
    window.pathwaysSubmissions=0;
    document.querySelector('[data-testid="fill-blank-dd-slot"]').onclick=event=>{event.currentTarget.innerHTML='<span>ماء مالح</span><button aria-label="Edit">Edit</button>';};
    document.querySelector('[data-alef-submit]').onclick=()=>window.pathwaysSubmissions++;
  });
  const {question:q}=await h.send({type:'ALEF_GET_QUESTION'});assert.equal(q.type,'matching');
  const requested=q.targets.find(row=>row.text==='ماء');
  const result=await apply(h,q,[{itemId:q.items[0].id,targetId:requested.id}]);
  assert.equal(result.ok,false,JSON.stringify(result));assert.match(result.error,/لم يؤكد الموقع وضع الكلمة/);
  assert.equal(await h.page.evaluate(()=>window.pathwaysSubmissions),0);
});

test('click-pair selections are checked again if their acknowledgement disappears before Submit is ready', async t=>{
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(()=>{
    document.body.innerHTML='<main><section data-alef-question="click-pair-final"><h2>صل العدد باسمه.</h2><div data-testid="matching-choice-one"><span>1</span></div><div data-testid="matching-answer-name"><span>واحد</span></div><button data-alef-submit disabled>Submit answer</button></section></main>';
    window.clickPairSubmissions=0;
    const item=document.querySelector('[data-testid="matching-choice-one"]'),target=document.querySelector('[data-testid="matching-answer-name"]'),submit=document.querySelector('button');
    item.firstElementChild.onclick=()=>{};
    target.firstElementChild.onclick=()=>{item.classList.add('selected');target.classList.add('selected');setTimeout(()=>item.classList.remove('selected'),150);setTimeout(()=>submit.disabled=false,280);};
    submit.onclick=()=>window.clickPairSubmissions++;
  });
  const{question:q}=await h.send({type:'ALEF_GET_QUESTION'});const result=await apply(h,q,[{itemId:'one',targetId:'name'}]);
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.submitted,false);assert.equal(await h.page.evaluate(()=>window.clickPairSubmissions),0);
});
