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
    if (Date.now() >= deadline) assert.fail(message);
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
