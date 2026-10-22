import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

test('loading and a disabled Next do not count as an instruction step, while new content with the same Next does',async t=>{
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(()=>{
    document.body.innerHTML='<main data-alef-instruction><article>شرح الاستعارة</article><span data-testid="progress-bar-slide-count">1/3</span><button data-alef-next>التالي</button></main>';
  });
  const initial=await h.send({type:'ALEF_INSPECT'});
  assert.equal(initial.stage,'instruction');assert.ok(initial.transitionFingerprint);
  await h.page.evaluate(()=>{
    document.querySelector('article').setAttribute('aria-busy','true');
    document.querySelector('button').disabled=true;
  });
  const loading=await h.send({type:'ALEF_INSPECT'});
  assert.equal(loading.loading,true);assert.notEqual(loading.fingerprint,initial.fingerprint);
  assert.equal(loading.transitionFingerprint,initial.transitionFingerprint);
  await h.page.evaluate(()=>{
    document.querySelector('article').removeAttribute('aria-busy');
    document.querySelector('article').textContent='مثال جديد في الاستعارة';
    document.querySelector('[data-testid="progress-bar-slide-count"]').textContent='2/3';
    document.querySelector('button').disabled=false;
  });
  const advanced=await h.send({type:'ALEF_INSPECT'});
  assert.equal(advanced.navigation[0].id,initial.navigation[0].id);
  assert.notEqual(advanced.transitionFingerprint,initial.transitionFingerprint);
});
