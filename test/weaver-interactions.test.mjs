import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserHarness } from '../scripts/test-browser.mjs';

const answer = (optionIds = [], text = '') => ({ optionIds, text, explanation: 'تفسير محلي للاختبار', confidence: .99 });

async function mount(t, kind = 'mcq') {
  const h = await createBrowserHarness();
  t.after(() => h.close());
  await h.page.evaluate(kind => {
    document.body.innerHTML = '<main></main>';
    const main = document.querySelector('main');
    window.weaverFixture = { submissions: 0, selections: 0, selectionStarted: false, gestures: [], acknowledged: false };
    const state = window.weaverFixture;
    const submit = document.createElement('button');
    submit.id = 'navigation-next-button';
    submit.setAttribute('data-testid', 'navigation-next-button');
    submit.setAttribute('aria-label', 'Next Button');
    submit.textContent = 'Submit Answer';
    submit.disabled = true;
    submit.onclick = () => { state.submissions += 1; };
    const ready = () => setTimeout(() => { submit.disabled = false; }, 90);
    if (kind === 'mcq') {
      main.innerHTML = '<div class="mcq-container question-widget" id="polynomial-widget"><div data-testid="question-statement-container" id="polynomial-statement">Find the sum of (3c² + 2c − 1) and (c² − c + 5).</div><div role="radiogroup" aria-describedby="polynomial-statement"><h3>Select the correct answer.</h3><div role="radio" tabindex="0" class="mcq-option-container" aria-checked="false" aria-label="MCQOption 1: (3c² + 2c − 1)" aria-describedby="option-a-content"><span id="option-a-content" class="mcq-item-label">3c² + 2c − 1</span></div><div role="radio" tabindex="0" class="mcq-option-container" aria-checked="false" aria-label="MCQOption 2: (4c² + c + 4)" aria-describedby="option-b-content"><span id="option-b-content" class="mcq-item-label">4c² + c + 4</span></div></div></div>';
      for (const node of main.querySelectorAll('[role="radio"]')) {
        node.setAttribute('data-testid', 'mcq-option-container');
        node.querySelector('span').setAttribute('data-testid', 'mcq-item-label');
        node.onclick = () => {
          state.selectionStarted = true;
          state.selections += 1;
          setTimeout(() => {
            for (const other of main.querySelectorAll('[role="radio"]')) {
              other.setAttribute('aria-checked', String(other === node));
              other.setAttribute('aria-label', other.getAttribute('aria-label').replace(/\. Selected$/, '') + (other === node ? '. Selected' : ''));
            }
            state.acknowledged = true;
            ready();
          }, 90);
        };
      }
    } else if (kind === 'dropdown') {
      main.innerHTML = '<div class="dropdown-container question-widget" id="dropdown-widget"><div data-testid="question-statement-container" id="dropdown-statement">Complete: the capital of the UAE is <span class="dropdown-input-field-container"><span class="dropdown-single-value-content">Choose an answer</span><input role="combobox" aria-describedby="dropdown-statement" aria-controls="dropdown-options" aria-expanded="false"></span>.</div></div>';
      const input = main.querySelector('[role="combobox"]');
      const display = main.querySelector('.dropdown-single-value-content');
      const close = () => { document.querySelector('#dropdown-options')?.remove(); input.setAttribute('aria-expanded', 'false'); };
      const open = () => {
        if (document.querySelector('#dropdown-options')) return;
        const portal = document.createElement('div');
        portal.id = 'dropdown-options';
        portal.setAttribute('role', 'listbox');
        for (const [id, label] of [['a', 'Dubai'], ['b', 'Abu Dhabi']]) {
          const option = document.createElement('div');
          option.id = 'dropdown-option-' + id;
          option.setAttribute('role', 'option');
          option.textContent = label;
          option.onclick = () => {
            state.selectionStarted = true;
            state.selections += 1;
            setTimeout(() => {
              display.textContent = label;
              state.acknowledged = true;
              close();
              ready();
            }, 90);
          };
          portal.append(option);
        }
        document.body.append(portal);
        input.setAttribute('aria-expanded', 'true');
      };
      input.addEventListener('keydown', event => { if (event.key === 'ArrowDown') open(); if (event.key === 'Escape') close(); });
      input.parentElement.addEventListener('mousedown', open);
    } else if (kind === 'text') {
      main.innerHTML = '<div class="open-ended-container question-widget" id="open-widget"><div data-testid="question-statement-container">اكتب اسم عاصمة الإمارات العربية المتحدة.</div><textarea aria-label="Your answer"></textarea></div>';
      main.querySelector('textarea').addEventListener('input', () => { state.acknowledged = true; ready(); });
    } else if (kind === 'dnd') {
      main.innerHTML = '<div class="dnd-container question-widget" id="word-widget"><div data-testid="question-statement-container">أكمل الجملة بالكلمة المناسبة.</div><div class="template-container">عاصمة الإمارات هي <span class="dnd-droppable" id="droppable-1" data-index="1" style="display:inline-block;width:180px;height:60px;border:1px solid #777"></span>.</div><div class="dnd-options-draggable" id="word-a" style="display:inline-block;padding:20px">أبوظبي</div><div class="dnd-options-draggable" id="word-b" style="display:inline-block;padding:20px">دبي</div></div>';
      let active;
      for (const node of main.querySelectorAll('.dnd-options-draggable')) {
        node.addEventListener('mousedown', event => {
          active = { node, at: performance.now(), button: event.button };
          const started = active;
          state.gestures.push('mousedown');
          setTimeout(() => {
            if (active !== started || event.button !== 0) return;
            node.classList.add('is-dragging');node.setAttribute('aria-pressed', 'true');
          }, 100);
        });
        node.addEventListener('dragstart', () => state.gestures.push('html5-dragstart'));
      }
      document.addEventListener('mousemove', event => {
        if (!active || performance.now() - active.at < 120 || active.button !== 0) return;
        const target = main.querySelector('.dnd-droppable');
        const rect = target.getBoundingClientRect();
        if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) { active.over = true; target.classList.add('is-about-to-drop'); state.gestures.push('mousemove'); }
      });
      document.addEventListener('mouseup', () => {
        if (!active) return;
        state.gestures.push('mouseup');
        const current = active; active = null;
        if (!current.over) return;
        state.selections += 1;
        setTimeout(() => {
          main.querySelector('.dnd-droppable').textContent = current.node.textContent;
          main.querySelector('.dnd-droppable').classList.add('is-selected');
          main.querySelector('.dnd-droppable').classList.remove('is-about-to-drop');
          current.node.remove();
          state.acknowledged = true;
          ready();
        }, 90);
      });
    }
    main.append(submit);
  }, kind);
  return h;
}

async function question(h) {
  const result = await h.send({ type: 'ALEF_GET_QUESTION' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.question, JSON.stringify(result));
  return result.question;
}

function apply(h, q, value, autoSubmit = true) {
  return h.send({ type: 'ALEF_APPLY', questionId: q.id, questionFingerprint: q.fingerprint, answer: value, autoSubmit });
}

test('Weaver MCQ reads the authored statement outside the radiogroup without option or selection labels', async t => {
  const h = await mount(t);
  const q = await question(h);
  assert.equal(q.type, 'single');
  assert.match(q.text, /Find the sum of \(3c² \+ 2c − 1\) and \(c² − c \+ 5\)/);
  assert.equal(q.text.includes('4c² + c + 4'), false, 'Answer labels cannot become part of the problem stem');
  assert.deepEqual(q.options.map(row => row.text), ['3c² + 2c − 1', '4c² + c + 4']);
});

test('Weaver MCQ waits for framework selection and delayed submit enablement, with one click and stable identity', async t => {
  const h = await mount(t);
  const q = await question(h);
  const chosen = q.options.find(row => row.text === '4c² + c + 4');
  const result = await apply(h, q, answer([chosen.id]));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted, true, JSON.stringify(result));
  assert.deepEqual(await h.page.evaluate(() => ({ selected: window.weaverFixture.selections, sent: window.weaverFixture.submissions, ack: window.weaverFixture.acknowledged })), { selected: 1, sent: 1, ack: true });
  const after = await question(h);
  assert.equal(after.id, q.id);
  assert.equal(after.fingerprint, q.fingerprint, 'Adding . Selected to accessibility labels cannot change question identity');
  assert.deepEqual(after.options, q.options);
});

test('cancelling while Weaver is acknowledging an answer never submits a late selection', async t => {
  const h = await mount(t);
  const q = await question(h);
  const pending = apply(h, q, answer([q.options[0].id]));
  await h.page.waitForFunction(() => window.weaverFixture.selectionStarted);
  assert.equal((await h.send({ type: 'ALEF_CANCEL' })).ok, true);
  const result = await pending;
  assert.equal(result.ok, false, JSON.stringify(result));
  await h.page.waitForTimeout(240);
  assert.equal(await h.page.evaluate(() => window.weaverFixture.submissions), 0);
});

test('Weaver dropdown discovers portal options and preserves the stem after delayed controlled selection', async t => {
  const h = await mount(t, 'dropdown');
  const prepared = await h.send({ type: 'ALEF_PREPARE_QUESTION' });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.ok(prepared.question, JSON.stringify(prepared));
  const q = prepared.question;
  assert.equal(q.type, 'single');
  assert.match(q.text, /capital of the UAE/);
  assert.equal(q.text.includes('Choose an answer'), false, 'Placeholder belongs to the answer control');
  const chosen = q.options.find(row => row.text === 'Abu Dhabi');
  assert.ok(chosen, JSON.stringify(q));
  const result = await apply(h, q, answer([chosen.id]));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted, true, JSON.stringify(result));
  assert.equal(await h.page.locator('.dropdown-single-value-content').textContent(), 'Abu Dhabi');
  assert.equal(await h.page.evaluate(() => window.weaverFixture.submissions), 1);
  assert.equal((await question(h)).fingerprint, q.fingerprint);
});

test('Weaver open-ended widget writes and submits the visible textarea after framework acknowledgement', async t => {
  const h = await mount(t, 'text');
  const q = await question(h);
  assert.equal(q.type, 'text');
  assert.match(q.text, /عاصمة الإمارات/);
  const result = await apply(h, q, answer([], 'أبوظبي'));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted, true, JSON.stringify(result));
  assert.equal(await h.page.locator('textarea').inputValue(), 'أبوظبي');
  assert.equal(await h.page.evaluate(() => window.weaverFixture.submissions), 1);
});

test('Weaver word blank uses the exposed MouseSensor gesture and waits for the filled blank before submitting', async t => {
  const h = await mount(t, 'dnd');
  const q = await question(h);
  assert.equal(q.type, 'matching', JSON.stringify(q));
  assert.match(q.text, /عاصمة الإمارات/);
  assert.equal(q.items.length, 1);
  const target = q.targets.find(row => row.text === 'أبوظبي');
  assert.ok(target, JSON.stringify(q));
  const result = await apply(h, q, { ...answer(), matches: [{ itemId: q.items[0].id, targetId: target.id }] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted, true, JSON.stringify(result));
  assert.equal(await h.page.locator('#droppable-1').textContent(), 'أبوظبي');
  const state = await h.page.evaluate(() => window.weaverFixture);
  assert.equal(state.selections, 1, 'Only one valid drag can assign the word');
  assert.equal(state.submissions, 1);
  assert.deepEqual(state.gestures, ['mousedown', 'mousemove', 'mouseup']);
});

test('NCLE instruction traversal exposes the normal Next button without a sidebar assessment shortcut', async t => {
  const h = await createBrowserHarness(); t.after(() => h.close());
  await h.page.evaluate(() => {
    document.body.innerHTML = '<main><section data-testid="ncle-activity-page"><nav data-testid="ncle-main-contents"><button data-testid="ncle-component-item" class="text-primary-100" aria-current="step"><span dir="ltr">Learn</span></button><button data-testid="ncle-component-item" class="text-primary-100" id="sidebar-assessment"><span dir="ltr">Exit Ticket</span></button></nav><article data-testid="ncle-activity-page-player"><h2>Explanation slide one</h2><button id="slide-next">Next</button></article></section></main>';
    window.instructionFixture = { next: 0, sidebar: 0 };
    document.querySelector('#sidebar-assessment').onclick = () => { window.instructionFixture.sidebar += 1; };
    document.querySelector('#slide-next').onclick = () => { window.instructionFixture.next += 1; document.querySelector('h2').textContent = 'Explanation slide two'; };
  });
  const snapshot = await h.send({ type: 'ALEF_INSPECT' });
  assert.equal(snapshot.stage, 'instruction', JSON.stringify(snapshot));
  assert.equal(snapshot.navigation.some(action => action.id === 'sidebar-assessment'), false);
  const next = snapshot.navigation.find(action => action.kind === 'next');
  assert.ok(next, JSON.stringify(snapshot));
  const result = await h.send({ type: 'ALEF_NAVIGATE', actionId: next.id, fingerprint: snapshot.fingerprint });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(await h.page.evaluate(() => window.instructionFixture), { next: 1, sidebar: 0 });
});

test('identical instructional slides advance through their visible slide count without a false repeated-step stop', async t => {
  const h = await createBrowserHarness(); t.after(() => h.close());
  await h.page.evaluate(() => {
    document.body.innerHTML = '<header><span data-testid="progress-bar-slide-count">1 / 3</span></header><main><section data-testid="ncle-activity-page"><article data-testid="ncle-activity-page-player"><p>Read this explanation.</p><button data-testid="navigation-next-button" aria-label="Next Button">Next</button></article></section></main>';
    window.introCount = 1;
    document.querySelector('button').onclick = () => {
      window.introCount++;
      document.querySelector('[data-testid="progress-bar-slide-count"]').textContent = window.introCount + ' / 3';
    };
  });
  for (let index = 1; index <= 2; index++) {
    const before = await h.send({type:'ALEF_INSPECT'});
    assert.equal(before.stage, 'instruction');
    const action = before.navigation.find(row => row.kind === 'next');
    assert.ok(action);
    assert.equal((await h.send({type:'ALEF_NAVIGATE',actionId:action.id,fingerprint:before.fingerprint})).ok, true);
    const after = await h.send({type:'ALEF_INSPECT'});
    assert.notEqual(after.fingerprint, before.fingerprint, 'The actual slide counter distinguishes otherwise identical content');
  }
  assert.equal(await h.page.evaluate(() => window.introCount), 3);
});

test('Weaver single whole-number FIB uses the native controlled input and waits for submit readiness', async t => {
  const h = await mount(t, 'text');
  await h.page.evaluate(() => {
    const widget = document.querySelector('.open-ended-container');
    widget.className = 'fib-container question-widget';
    const input = document.createElement('input'); input.type = 'text'; input.setAttribute('data-testid','whole-input-1');
    input.oninput = () => setTimeout(() => { window.weaverFixture.acknowledged = true; document.querySelector('#navigation-next-button').disabled = false; }, 85);
    widget.querySelector('textarea').replaceWith(input);
  });
  const q = await question(h);
  assert.equal(q.type, 'text');
  const result = await apply(h, q, answer([], '7'));
  assert.equal(result.submitted, true, JSON.stringify(result));
  assert.equal(await h.page.locator('input').inputValue(), '7');
  assert.equal(await h.page.evaluate(() => window.weaverFixture.submissions), 1);
});

test('custom equation editors are reported without typing into an internal textarea or submitting', async t => {
  const h = await mount(t, 'text');
  await h.page.evaluate(() => {
    const input = document.querySelector('textarea');
    const editor = document.createElement('math-field'); input.replaceWith(editor); editor.append(input);
  });
  const result = await h.send({type:'ALEF_GET_QUESTION'});
  assert.equal(result.ok, false);
  assert.match(result.error, /محرر معادلات/);
  assert.equal(await h.page.locator('textarea').inputValue(), '');
  assert.equal(await h.page.evaluate(() => window.weaverFixture.submissions), 0);
});
