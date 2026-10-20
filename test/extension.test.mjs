import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createBrowserHarness } from '../scripts/test-browser.mjs';

const answer = (optionIds = [], text = '') => ({ optionIds, text, explanation: 'تفسير اختبار محلي', confidence: 0.99 });

async function workerBridge(harness, fetchImpl) {
  const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
  let handler;
  const events = [];
  const storage = {};
  let tabUrl = harness.page.url();
  const chrome = {
    runtime: {
      id: 'fixture-extension',
      getURL: path => 'chrome-extension://fixture-extension/' + path,
      getPlatformInfo: async () => ({}),
      onMessage: { addListener(listener) { handler = listener; } },
      sendMessage: async message => { events.push(message); },
    },
    storage: { session: {
      async get(key) { return { [key]: storage[key] }; },
      async set(items) { Object.assign(storage, structuredClone(items)); },
      async remove(key) { delete storage[key]; },
    } },
    tabs: {
      async get() { return { id: 1, url: tabUrl }; },
      sendMessage: async (_tabId, message) => harness.send(message),
      async create() {},
      onRemoved: { addListener() {} },
    },
    scripting: { async executeScript() {} },
    action: { onClicked: { addListener() {} } },
  };
  vm.runInNewContext(source, {
    chrome, URL, AbortController, AbortSignal, DOMException,
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: fetchImpl,
  }, { filename: 'background.js' });
  return {
    events,
    setTabUrl(url) { tabUrl = url; },
    send(message) {
      return new Promise((resolve, reject) => {
        const accepted = handler({ tabId: 1, ...message }, {
          id: 'fixture-extension', url: 'chrome-extension://fixture-extension/dashboard.html',
        }, resolve);
        if (!accepted) reject(new Error('Worker rejected extension message'));
      });
    },
  };
}

async function waitUntil(predicate, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(typeof message==='function'?message():message);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}

const runConfig = () => ({ serverUrl: 'http://127.0.0.1:4318', token: 'test-only-pairing-token', verify: true, autoSubmit: true, minConfidence: .85 });

function fixtureProvider(_url, options) {
  const body = JSON.parse(options.body);
  const question = body.question;
  const selected = question.type === 'single'
    ? answer([question.options.find(option => option.text.trim() === '42').id])
    : question.type === 'multiple'
      ? answer(question.options.filter(option => ['2', '3'].includes(option.text.trim())).map(option => option.id))
      : answer([], 'مثلث');
  return Promise.resolve(Response.json({ answer: selected, verified: true, needsReview: false }));
}

async function openMath(t, options) {
  const harness = await createBrowserHarness(options);
  t.after(() => harness.close());
  const selected = await harness.send({ type: 'ALEF_SELECT_SUBJECT', subjectId: 'math' });
  assert.equal(selected.ok, true, JSON.stringify(selected));
  assert.equal(await harness.page.locator('body').getAttribute('data-selected-subject'), 'math');
  return harness;
}

async function currentQuestion(harness) {
  const result = await harness.send({ type: 'ALEF_GET_QUESTION' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.question, 'A visible supported question must be extracted');
  return result.question;
}

async function apply(harness, question, selectedAnswer, autoSubmit = true) {
  return harness.send({
    type: 'ALEF_APPLY',
    questionId: question.id,
    questionFingerprint: question.fingerprint,
    answer: selectedAnswer,
    autoSubmit,
  });
}

test('DOM adapter discovers real visible subjects and survives repeated injection', async t => {
  const harness = await createBrowserHarness();
  t.after(() => harness.close());
  const scan = await harness.send({ type: 'ALEF_SCAN' });
  assert.equal(scan.ok, true, JSON.stringify(scan));
  assert.deepEqual(scan.subjects.map(subject => subject.name), ['الرياضيات', 'العلوم', 'اللغة العربية']);
  assert.equal(scan.subjects.length, 3);
  assert.match(scan.page.url, /^http:\/\/127\.0\.0\.1:/);
  await harness.page.addScriptTag({ content: harness.contentScript });
  assert.equal(await harness.page.evaluate(() => window.__extensionListeners.length), 1, 'Injection must be idempotent');
});

test('real DOM workflow selects, submits, navigates single/multiple/text questions and detects completion', async t => {
  const harness = await openMath(t, { scenario: 'complete' });
  const single = await currentQuestion(harness);
  assert.equal(single.type, 'single');
  assert.match(single.text, /6.*7/);
  assert.equal(single.options.length, 3);
  const correctOption = single.options.find(option => option.text.trim() === '42');
  assert.ok(correctOption);
  assert.equal((await apply(harness, single, answer([correctOption.id]))).submitted, true);
  assert.equal(await harness.page.locator('#feedback').getAttribute('data-correct'), 'true');
  assert.equal((await harness.send({ type: 'ALEF_NEXT' })).clicked, true);

  const multiple = await currentQuestion(harness);
  assert.equal(multiple.type, 'multiple');
  const primeIds = multiple.options.filter(option => ['2', '3'].includes(option.text.trim())).map(option => option.id);
  assert.equal(primeIds.length, 2);
  assert.equal((await apply(harness, multiple, answer(primeIds))).submitted, true);
  assert.equal(await harness.page.locator('#feedback').getAttribute('data-correct'), 'true');
  assert.equal((await harness.send({ type: 'ALEF_NEXT' })).clicked, true);

  const text = await currentQuestion(harness);
  assert.equal(text.type, 'text');
  assert.equal((await apply(harness, text, answer([], 'مثلث'))).submitted, true);
  assert.equal(await harness.page.locator('textarea').inputValue(), 'مثلث');
  assert.equal((await harness.send({ type: 'ALEF_NEXT' })).clicked, true);
  const completed = await harness.send({ type: 'ALEF_GET_QUESTION' });
  assert.equal(completed.ok, true);
  assert.equal(completed.completed, true);
  assert.equal(completed.question, null);
  const submissions = await harness.page.evaluate(() => window.fixture.submissions);
  assert.equal(submissions.length, 3);
  assert.equal(submissions.every(submission => submission.correct), true);
});

test('stale question identifiers are rejected before changing or submitting inputs', async t => {
  const harness = await openMath(t);
  const question = await currentQuestion(harness);
  const result = await apply(harness, { ...question, id: 'previous-question' }, answer([question.options[0].id]));
  assert.equal(result.ok, false);
  assert.equal(await harness.page.locator('input:checked').count(), 0);
  assert.equal((await harness.page.evaluate(() => window.fixture.submissions)).length, 0);
});

test('same-id question text changes are rejected before applying the old answer', async t => {
  const harness = await openMath(t);
  const question = await currentQuestion(harness);
  assert.ok(question.fingerprint, 'Adapter must return a stale-content fingerprint');
  await harness.page.evaluate(() => window.fixture.mutateQuestion());
  const result = await apply(harness, question, answer([question.options[0].id]));
  assert.equal(result.ok, false);
  assert.equal(await harness.page.locator('input:checked').count(), 0);
  assert.equal((await harness.page.evaluate(() => window.fixture.submissions)).length, 0);
});

test('text change events advancing to a new question never submit the new question', async t => {
  const harness = await openMath(t);
  await harness.page.evaluate(() => {
    const exercise = document.querySelector('main');
    exercise.innerHTML = '<section data-alef-question="text-old"><h2 data-alef-question-text>اكتب الإجابة.</h2><textarea data-alef-answer></textarea><button data-alef-submit>إرسال</button></section>';
    window.unexpectedSubmissions = 0;
    exercise.addEventListener('click', event => {
      if (event.target.matches('[data-alef-submit]')) window.unexpectedSubmissions += 1;
    });
    exercise.querySelector('textarea').addEventListener('change', () => {
      exercise.innerHTML = '<section data-alef-question="text-new"><h2 data-alef-question-text>اكتب الإجابة.</h2><textarea data-alef-answer></textarea><button data-alef-submit>إرسال</button></section>';
    });
  });
  const question = await currentQuestion(harness);
  assert.equal(question.type, 'text');
  const result = await apply(harness, question, answer([], 'إجابة السؤال القديم'));
  assert.equal(result.ok, false, 'Question identity must be checked again after framework input events');
  assert.equal(await harness.page.locator('[data-alef-question]').getAttribute('data-alef-question'), 'text-new');
  assert.equal(await harness.page.locator('textarea').inputValue(), '');
  assert.equal(await harness.page.evaluate(() => window.unexpectedSubmissions), 0);
});

test('framework-rejected text values prevent submission', async t => {
  const harness = await openMath(t);
  await harness.page.evaluate(() => {
    const exercise = document.querySelector('main');
    exercise.innerHTML = '<section data-alef-question="text-controlled"><h2 data-alef-question-text>اكتب الإجابة.</h2><textarea data-alef-answer></textarea><button data-alef-submit>إرسال</button></section>';
    window.unexpectedSubmissions = 0;
    exercise.querySelector('button').addEventListener('click', () => { window.unexpectedSubmissions += 1; });
    exercise.querySelector('textarea').addEventListener('input', event => { event.target.value = ''; });
  });
  const result = await apply(harness, await currentQuestion(harness), answer([], 'رفضها إطار الصفحة'));
  assert.equal(result.ok, false, 'The page must confirm the written text before submission');
  assert.equal(await harness.page.locator('textarea').inputValue(), '');
  assert.equal(await harness.page.evaluate(() => window.unexpectedSubmissions), 0);
});

test('choice change events advancing question identity prevent submission even with unchanged text', async t => {
  const harness = await openMath(t);
  const question = await currentQuestion(harness);
  await harness.page.evaluate(() => {
    document.querySelectorAll('input').forEach(input => {
      input.addEventListener('change', () => {
        document.querySelector('[data-alef-question]').dataset.alefQuestion = 'new-question-same-text';
      });
    });
  });
  const result = await apply(harness, question, answer([question.options[0].id]));
  assert.equal(result.ok, false, 'The question ID and text fingerprint must both remain unchanged');
  assert.equal((await harness.page.evaluate(() => window.fixture.submissions)).length, 0);
});

test('KaTeX math preserves source fractions without duplicate rendered text', async t => {
  const harness = await openMath(t);
  await harness.page.evaluate(() => {
    document.querySelector('[data-alef-question-text]').innerHTML = 'احسب <span class="katex"><span class="katex-mathml"><math><semantics><mi>x</mi><annotation encoding="application/x-tex">\\frac{1}{2}</annotation></semantics></math></span><span class="katex-html">duplicate</span></span>';
  });
  const question = await currentQuestion(harness);
  assert.ok(question.text.includes('$\\frac{1}{2}$'), question.text);
  assert.equal(question.text.includes('duplicate'), false);
});

test('unknown answer identifiers never partially apply or submit', async t => {
  const harness = await openMath(t);
  const question = await currentQuestion(harness);
  const result = await apply(harness, question, answer(['unknown-option']));
  assert.equal(result.ok, false);
  assert.equal(await harness.page.locator('input:checked').count(), 0);
  assert.equal((await harness.page.evaluate(() => window.fixture.submissions)).length, 0);
});

test('review mode fills answers but does not submit them', async t => {
  const harness = await openMath(t);
  const question = await currentQuestion(harness);
  const chosen = question.options.find(option => option.text.trim() === '42');
  const result = await apply(harness, question, answer([chosen.id]), false);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.applied, true);
  assert.equal(result.submitted, false);
  assert.equal(await harness.page.locator('input:checked').count(), 1);
  assert.equal((await harness.page.evaluate(() => window.fixture.submissions)).length, 0);
});

test('unsupported visual question is reported rather than guessed', async t => {
  const harness = await openMath(t);
  for (const expectedType of ['single', 'multiple', 'text']) {
    const question = await currentQuestion(harness);
    assert.equal(question.type, expectedType);
    const selectedAnswer = expectedType === 'single'
      ? answer([question.options.find(option => option.text.trim() === '42').id])
      : expectedType === 'multiple'
        ? answer(question.options.filter(option => ['2', '3'].includes(option.text.trim())).map(option => option.id))
        : answer([], 'مثلث');
    assert.equal((await apply(harness, question, selectedAnswer)).ok, true);
    assert.equal((await harness.send({ type: 'ALEF_NEXT' })).clicked, true);
  }
  const unsupported = await harness.send({ type: 'ALEF_GET_QUESTION' });
  assert.equal(unsupported.ok, false, 'A drag/drop-only question must be explicitly unsupported');
  assert.ok(unsupported.error || unsupported.message);
  assert.equal((await harness.page.evaluate(() => window.fixture.submissions)).length, 3);
});

test('ambiguous simultaneous questions are rejected before selecting any answer', async t => {
  const harness = await openMath(t);
  await harness.page.evaluate(() => {
    const extra = document.querySelector('[data-alef-question]').cloneNode(true);
    extra.dataset.alefQuestion = 'second-visible-question';
    document.querySelector('main').append(extra);
  });
  const result = await harness.send({ type: 'ALEF_GET_QUESTION' });
  assert.equal(result.ok, false);
  assert.equal(await harness.page.locator('input:checked').count(), 0);
});

test('image-dependent questions are explicitly unsupported by the text-only reader', async t => {
  const harness = await openMath(t);
  await harness.page.evaluate(() => {
    const image = document.createElement('img');
    image.alt = 'رسم هندسي مطلوب للحل';
    image.width = 64;
    image.height = 64;
    image.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="24"/></svg>';
    document.querySelector('[data-alef-question]').append(image);
  });
  const result = await harness.send({ type: 'ALEF_GET_QUESTION' });
  assert.equal(result.ok, false);
  assert.equal((await harness.page.evaluate(() => window.fixture.submissions)).length, 0);
});

test('worker autonomously completes the real local DOM workflow using an explicit test-only provider', async t => {
  const harness = await createBrowserHarness({ scenario: 'complete' });
  t.after(() => harness.close());
  let calls = 0;
  const worker = await workerBridge(harness, (url, options) => {
    calls += 1;
    assert.equal(url, 'http://127.0.0.1:4318/api/solve');
    assert.equal(options.headers.Authorization, 'Bearer test-only-pairing-token');
    assert.equal(JSON.parse(options.body).verify, true);
    return fixtureProvider(url, options);
  });
  assert.equal((await worker.send({ type: 'CONNECT' })).ok, true);
  assert.equal((await worker.send({ type: 'START', subjectId: 'math', config: runConfig() })).ok, true);
  await waitUntil(() => worker.events.some(item => item.event.kind === 'complete'), JSON.stringify(worker.events));
  const state = (await worker.send({ type: 'GET_STATE' })).state;
  assert.equal(state.status, 'complete');
  assert.equal(state.stats.solved, 3);
  assert.equal(state.stats.total, 3);
  assert.equal(state.stats.review, 0);
  assert.equal(calls, 3);
  assert.equal((await harness.page.evaluate(() => window.fixture.submissions)).every(item => item.correct), true);
});

test('worker stop aborts a pending request and never applies a late answer', async t => {
  const harness = await createBrowserHarness({ scenario: 'complete' });
  t.after(() => harness.close());
  let pending;
  let requestOptions;
  const worker = await workerBridge(harness, (_url, options) => {
    requestOptions = options;
    return new Promise(resolve => { pending = resolve; });
  });
  assert.equal((await worker.send({ type: 'CONNECT' })).ok, true);
  await worker.send({ type: 'START', subjectId: 'math', config: runConfig() });
  await waitUntil(() => !!pending, 'Solver request did not start');
  assert.equal((await worker.send({ type: 'STOP' })).ok, true);
  assert.equal(requestOptions.signal.aborted, true);
  pending(await fixtureProvider('http://127.0.0.1:4318/api/solve', requestOptions));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await harness.page.evaluate(() => window.fixture.submissions)).length, 0);
  assert.equal(await harness.page.locator('input:checked').count(), 0);
  const state = (await worker.send({ type: 'GET_STATE' })).state;
  assert.equal(state.status, 'stopped');
  assert.equal(state.running, false);
});

test('worker pauses low-confidence answers before modifying the page', async t => {
  const harness = await createBrowserHarness();
  t.after(() => harness.close());
  const worker = await workerBridge(harness, async (_url, options) => {
    const question = JSON.parse(options.body).question;
    return Response.json({ answer: { ...answer([question.options[0].id]), confidence: .51 }, verified: true, needsReview: true, reason: 'low_confidence' });
  });
  await worker.send({ type: 'CONNECT' });
  await worker.send({ type: 'START', subjectId: 'math', config: runConfig() });
  await waitUntil(() => worker.events.some(item => item.event.kind === 'review'), 'Low-confidence result did not pause');
  assert.equal(await harness.page.locator('input:checked').count(), 0);
  assert.equal((await harness.page.evaluate(() => window.fixture.submissions)).length, 0);
  assert.equal((await worker.send({ type: 'GET_STATE' })).state.stats.review, 1);
  const message = worker.events.find(item => item.event.kind === 'review').event.message;
  assert.match(message, /[\u0600-\u06ff]/);
  assert.equal(message.includes('low_confidence'), false);
});

test('worker shows the backend structured Arabic authentication error', async t => {
  const harness = await createBrowserHarness();
  t.after(() => harness.close());
  const worker = await workerBridge(harness, async () => Response.json({
    error: { code: 'UNAUTHORIZED', message: 'رمز الاقتران غير صحيح.' },
  }, { status: 401 }));
  await worker.send({ type: 'CONNECT' });
  await worker.send({ type: 'START', subjectId: 'math', config: runConfig() });
  await waitUntil(() => worker.events.some(item => item.event.kind === 'error'), 'Structured backend error did not reach the UI');
  const event = worker.events.find(item => item.event.kind === 'error').event;
  assert.equal(event.message, 'رمز الاقتران غير صحيح.');
  assert.equal((await harness.page.evaluate(() => window.fixture.submissions)).length, 0);
});

test('worker rejects external service destinations and unrelated website origins', async t => {
  const harness = await createBrowserHarness();
  t.after(() => harness.close());
  let called = false;
  const worker = await workerBridge(harness, async () => { called = true; throw new Error('Unexpected provider call'); });
  await worker.send({ type: 'CONNECT' });
  const unsafe = await worker.send({ type: 'START', subjectId: 'math', config: { ...runConfig(), serverUrl: 'http://example.com:4318' } });
  assert.equal(unsafe.ok, false);
  assert.equal(called, false);
  worker.setTabUrl('https://example.com/');
  const unrelated = await worker.send({ type: 'CONNECT' });
  assert.equal(unrelated.ok, false);
});

test('actual Alef subject-card and recommended level-card selectors are recognized',async t=>{
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(()=>{document.body.innerHTML='<main><div data-testid="subject-card" id="pathway-subject-cards-math" role="button"><h2 data-testid="subject-title">Math Grade 7</h2></div></main>';});
  const scan=await h.send({type:'ALEF_SCAN'});assert.equal(scan.subjects[0].name,'Math Grade 7');
  await h.page.evaluate(()=>{document.querySelector('main').innerHTML='<div data-testid="levels-container"><div data-testid="level-card-container-level1"><h2 data-testid="level-title">الكسور</h2></div><div data-testid="level-card-container-level2"><h2 data-testid="level-title">النسب</h2></div></div>';});
  const levels=await h.send({type:'ALEF_INSPECT'});assert.equal(levels.stage,'lessons');assert.equal(levels.lessons.length,2);assert.equal(levels.lessons[0].kind,'level');
});
test('actual Alef hidden radio controls use selected choice cards and submit the visible answer',async t=>{
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(()=>{
    document.body.innerHTML='<main><div data-testid="question-renderer"><div data-testid="question-renderer-Q1"><div data-testid="multiple-choice-question-prompt">ما ناتج 6 × 7؟</div><div data-testid="choice-item"><div class="choice"><input type="radio" id="a" style="display:none">36</div></div><div data-testid="choice-item"><div class="choice"><input type="radio" id="b" style="display:none">42</div></div></div></div><button id="submit">Submit answer</button></main>';
    document.querySelectorAll('[data-testid="choice-item"]').forEach(node=>node.onclick=()=>{document.querySelectorAll('.choice').forEach(choice=>choice.classList.remove('selected'));node.querySelector('.choice').classList.add('selected');});
    window.sent=0;document.querySelector('#submit').onclick=()=>window.sent++;
  });
  const q=await currentQuestion(h);assert.equal(q.type,'single');assert.equal(q.options.length,2);
  const applied=await apply(h,q,answer(['b']));assert.equal(applied.submitted,true,JSON.stringify(applied));assert.equal(await h.page.evaluate(()=>window.sent),1);
});
test('native dropdown options are read and applied with real change events',async t=>{
  const h=await openMath(t);
  await h.page.evaluate(()=>{document.querySelector('main').innerHTML='<section data-alef-question="dropdown"><h2>اختر عاصمة فرنسا.</h2><select><option value="" disabled>اختر</option><option value="paris">باريس</option><option value="rome">روما</option></select><button data-alef-submit>Submit answer</button></section>';window.changes=0;document.querySelector('select').onchange=()=>window.changes++;});
  const q=await currentQuestion(h);assert.equal(q.type,'single');assert.equal(q.options.length,2);
  assert.equal((await apply(h,q,answer(['paris']))).submitted,true);assert.equal(await h.page.locator('select').inputValue(),'paris');assert.equal(await h.page.evaluate(()=>window.changes),1);
});
test('custom dropdown expands hidden choices and confirms selected label before submit',async t=>{
  const h=await openMath(t);
  await h.page.evaluate(()=>{
    document.querySelector('main').innerHTML='<section data-alef-question="custom-dropdown"><h2>اختر العدد الزوجي.</h2><div data-testid="selectableChoice"><input role="combobox" aria-label="blankField"><span id="selected-label"></span></div><button data-alef-submit>Submit answer</button></section>';
    const combo=document.querySelector('[role="combobox"]');combo.onkeydown=e=>{
      if(e.key==='Escape'){document.querySelector('[role="listbox"]')?.remove();return;}
      if(e.key!=='ArrowDown'||document.querySelector('[role="listbox"]'))return;
      const menu=document.createElement('div');menu.setAttribute('role','listbox');for(const text of ['3','4']){const option=document.createElement('div');option.setAttribute('role','option');option.textContent=text;option.onclick=()=>{document.querySelector('#selected-label').textContent=text;menu.remove();};menu.append(option);}document.body.append(menu);
    };
  });
  let inspected=await h.send({type:'ALEF_INSPECT'});assert.equal(inspected.needsPreparation,true);
  const prepared=await h.send({type:'ALEF_PREPARE_QUESTION'});assert.equal(prepared.ok,true,JSON.stringify(prepared));
  const q=await currentQuestion(h),correct=q.options.find(option=>option.text==='4');assert.ok(correct);
  const result=await apply(h,q,answer([correct.id]));assert.equal(result.submitted,true,JSON.stringify(result));assert.equal(await h.page.locator('#selected-label').textContent(),'4');
});
test('matching pairs use actual Alef click controls and require UI acknowledgement',async t=>{
  const h=await openMath(t);
  await h.page.evaluate(()=>{
    document.querySelector('main').innerHTML='<section data-alef-question="matching"><h2>صل كل عدد باسمه.</h2><div data-testid="matching-choice-i1"><div>1</div></div><div data-testid="matching-choice-i2"><div>2</div></div><div data-testid="matching-answer-t1"><div>واحد</div></div><div data-testid="matching-answer-t2"><div>اثنان</div></div><button data-alef-submit>Submit answer</button></section>';
    window.pairs=[];let current;
    document.querySelectorAll('[data-testid^="matching-choice-"]').forEach(node=>node.firstElementChild.onclick=()=>{current=node;});
    document.querySelectorAll('[data-testid^="matching-answer-"]').forEach(node=>node.firstElementChild.onclick=()=>{if(current){current.classList.add('selected');node.classList.add('selected');window.pairs.push([current.dataset.testid,node.dataset.testid]);current=null;}});
  });
  const q=await currentQuestion(h);assert.equal(q.type,'matching');
  const result=await apply(h,q,{...answer(),matches:[{itemId:'i1',targetId:'t1'},{itemId:'i2',targetId:'t2'}]});
  assert.equal(result.submitted,true,JSON.stringify(result));assert.equal((await h.page.evaluate(()=>window.pairs)).length,2);
});
test('text token drag/drop only submits when the target confirms the dropped token',async t=>{
  const h=await openMath(t);
  await h.page.evaluate(()=>{
    document.querySelector('main').innerHTML='<section data-alef-question="drag"><h2>ضع الإجابة في المكان الصحيح.</h2><div data-alef-item="item1" draggable="true">مثلث</div><div data-alef-target="target1" data-target-label="شكل له ثلاثة أضلاع">شكل له ثلاثة أضلاع</div><button data-alef-submit>Submit answer</button></section>';
    document.querySelector('[data-alef-target]').ondrop=e=>{e.preventDefault();e.currentTarget.dataset.selectedItem=e.dataTransfer.getData('text/plain');};
  });
  const q=await currentQuestion(h);const result=await apply(h,q,{...answer(),matches:[{itemId:'item1',targetId:'target1'}]});assert.equal(result.submitted,true,JSON.stringify(result));
});
test('intro skip labels and actual practice shortcut are available navigation controls',async t=>{
  const h=await openMath(t);
  await h.page.evaluate(()=>{document.querySelector('main').innerHTML='<section data-testid="content-page"><div data-testid="content-page-body-player">شرح</div><button>I’ll try later</button><li id="skill-player-practice">Ready for questions?</li></section>';});
  const snapshot=await h.send({type:'ALEF_INSPECT'});assert.equal(snapshot.stage,'instruction');assert.ok(snapshot.navigation.some(action=>action.kind==='skip'));assert.ok(snapshot.navigation.some(action=>action.id==='skill-player-practice'));
});

test('Arabic passages retain diacritics and are combined with their comprehension question',async t=>{
  const h=await openMath(t);
  await h.page.evaluate(()=>{
    document.querySelector('main').innerHTML='<section data-alef-question="arabic"><div data-testid="question-passage-content">نَامَتِ القِطَّةُ تَحْتَ الشَّجَرَةِ.</div><h2 data-alef-question-text>أَيْنَ نَامَتِ القِطَّةُ؟</h2><label data-alef-option="tree"><input type="radio" name="arabic">تَحْتَ الشَّجَرَةِ</label><label data-alef-option="house"><input type="radio" name="arabic">فِي البَيْتِ</label><button data-alef-submit>إرسال الإجابة</button></section>';
  });
  const q=await currentQuestion(h);assert.ok(q.text.includes('نَامَتِ القِطَّةُ تَحْتَ الشَّجَرَةِ.'));assert.ok(q.text.includes('أَيْنَ نَامَتِ القِطَّةُ؟'));assert.equal(q.options[0].text,'تَحْتَ الشَّجَرَةِ');assert.equal((await apply(h,q,answer(['tree']))).submitted,true);
});
test('collapsed Arabic reading passage is opened before the model receives a question',async t=>{
  const h=await openMath(t);
  await h.page.evaluate(()=>{
    document.querySelector('main').innerHTML='<section data-alef-question="arabic-passage"><button data-alef-passage-toggle aria-expanded="false">اقرأ النص</button><div data-testid="question-passage-content" hidden>زَرَعَ سَالِمٌ شَجَرَةً.</div><h2>مَاذَا زَرَعَ سَالِمٌ؟</h2><label><input type="radio" name="ar" value="tree">شَجَرَةً</label><label><input type="radio" name="ar" value="flower">وَرْدَةً</label></section>';
    document.querySelector('[data-alef-passage-toggle]').onclick=e=>{e.currentTarget.setAttribute('aria-expanded','true');document.querySelector('[data-testid="question-passage-content"]').hidden=false;};
  });
  const before=await h.send({type:'ALEF_INSPECT'});assert.equal(before.needsPreparation,true);assert.equal(before.question,null);
  const prepared=await h.send({type:'ALEF_PREPARE_QUESTION'});assert.equal(prepared.ok,true,JSON.stringify(prepared));assert.ok(prepared.question.text.includes('زَرَعَ سَالِمٌ شَجَرَةً.'));
});

test('actual Alef drag-word blanks use their supported click placement and preserve the question fingerprint',async t=>{
 const h=await openMath(t);
 await h.page.evaluate(()=>{
   document.querySelector('main').innerHTML='<section data-alef-question="fill-drag"><h2>ضع الكلمة المناسبة.</h2><p>النبات يحتاج <span data-testid="fill-blank-dd-blank1"></span>.</p><div data-testid="draggableChoice">ماء</div><div data-testid="draggableChoice">حديد</div><button data-alef-submit>Submit answer</button></section>';
   let selected;document.querySelectorAll('[data-testid="draggableChoice"]').forEach(node=>node.onclick=()=>{selected=node;});
   document.querySelector('[data-testid^="fill-blank-dd-"]').onclick=e=>{if(selected){e.currentTarget.textContent=selected.textContent;selected.remove();selected=null;}};
 });
 const q=await currentQuestion(h);assert.equal(q.type,'matching');const target=q.targets.find(item=>item.text==='ماء');
 const result=await apply(h,q,{...answer(),matches:[{itemId:q.items[0].id,targetId:target.id}]});assert.equal(result.submitted,true,JSON.stringify(result));
});

test('real choice feedback with disabled inputs advances once and does not solve the same question again',async t=>{
 const h=await createBrowserHarness();t.after(()=>h.close());
 await h.page.evaluate(()=>{
  document.body.innerHTML='<button data-alef-subject="math">الرياضيات</button><main></main>';
  document.querySelector('button').onclick=()=>{
   document.querySelector('main').innerHTML='<div data-testid="question-renderer"><div data-testid="question-renderer-realQ"><div data-testid="multiple-choice-question-prompt">ما ناتج 6 × 7؟</div><div data-testid="choice-item"><div class="choice"><input type="radio" id="a" style="display:none">36</div></div><div data-testid="choice-item"><div class="choice"><input type="radio" id="b" style="display:none">42</div></div></div></div><button id="submit-real">Submit answer</button>';
   document.querySelectorAll('[data-testid="choice-item"]').forEach(node=>node.onclick=()=>{document.querySelectorAll('.choice').forEach(choice=>choice.classList.remove('selected'));node.querySelector('.choice').classList.add('selected');});
   document.querySelector('#submit-real').onclick=e=>{e.currentTarget.disabled=true;document.querySelectorAll('input').forEach(input=>{input.disabled=true;});const feedback=document.createElement('p');feedback.textContent='إجابة صحيحة';document.querySelector('[data-testid="question-renderer"]').append(feedback);const next=document.createElement('button');next.textContent='Next';next.onclick=()=>{document.querySelector('main').innerHTML='<section data-alef-completed>Lesson completed</section>';};document.querySelector('main').append(next);};
  };
 });
 let calls=0;const worker=await workerBridge(h,(url,options)=>{calls++;return fixtureProvider(url,options);});
 assert.equal((await worker.send({type:'CONNECT'})).ok,true);assert.equal((await worker.send({type:'START',subjectId:'math',config:runConfig()})).ok,true);
 await waitUntil(()=>worker.events.some(item=>item.event.kind==='complete'),()=>JSON.stringify(worker.events));assert.equal(calls,1);
});
test('STOP message interrupts asynchronous matching before submit',async t=>{
 const h=await openMath(t);
 await h.page.evaluate(()=>{
  document.querySelector('main').innerHTML='<section data-alef-question="cancel-matching"><h2>صل العدد باسمه.</h2><div data-testid="matching-choice-i1"><div>1</div></div><div data-testid="matching-answer-t1"><div>واحد</div></div><button data-alef-submit>Submit answer</button></section>';
  window.matchStarted=false;window.matchSubmitted=0;document.querySelector('[data-testid="matching-choice-i1"]').firstElementChild.onclick=()=>{window.matchStarted=true;};document.querySelector('[data-alef-submit]').onclick=()=>window.matchSubmitted++;
 });
 const q=await currentQuestion(h);const pending=apply(h,q,{...answer(),matches:[{itemId:'i1',targetId:'t1'}]});
 await h.page.waitForFunction(()=>window.matchStarted);await h.send({type:'ALEF_CANCEL'});
 const result=await pending;assert.equal(result.ok,false);assert.equal(await h.page.evaluate(()=>window.matchSubmitted),0);
});
