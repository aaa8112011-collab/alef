import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

test('diagnostics distinguish an empty app mount from populated unsupported content without exporting account text',async t=>{
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(()=>{document.body.innerHTML='<div id="root"></div>';});
  const empty=await h.send({type:'ALEF_DIAGNOSTICS'});
  assert.equal(empty.ok,true);assert.equal(empty.diagnostics.stage,'unknown');
  assert.equal(empty.diagnostics.rendering.readyState,'complete');
  assert.equal(empty.diagnostics.rendering.appRoots[0].kind,'root');
  assert.equal(empty.diagnostics.rendering.appRoots[0].children,0);
  assert.ok(Number.isFinite(empty.diagnostics.rendering.inspectionDurationMs));
  await h.page.evaluate(()=>{
    document.querySelector('#root').innerHTML='<main><p>private-account-text-do-not-export</p><input type="text" value="private-form-value-do-not-export"></main>';
  });
  const populated=await h.send({type:'ALEF_DIAGNOSTICS'});
  assert.equal(populated.diagnostics.stage,'unknown');
  assert.equal(populated.diagnostics.rendering.appRoots[0].children,1);
  assert.ok(populated.diagnostics.rendering.appRoots.some(root=>root.kind==='main'&&root.children===2));
  assert.doesNotMatch(JSON.stringify(populated.diagnostics),/private-account-text|private-form-value/);
});
