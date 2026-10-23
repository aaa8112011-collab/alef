import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

test('published MCQ root reads a separate lib- statement, preserves math source and excludes authored selection icons from vision',async t=>{
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(()=>{
    document.body.innerHTML=`<main id="player-container"><div data-testid="ncle-activity-page-player">
      <div role="progressbar" style="height:8px;width:500px">2/5</div>
      <section class="lib-mcq-container lib-question-widget"><p>Select the correct answer.</p>
        <div data-testid="mcq-option-container" role="radio" aria-checked="false" data-option-id="proportional">
          <div class="lib-mcq-option-content-container">They are proportional.</div>
          <div class="lib-mcq-icon-container"><svg role="img" width="50" height="50"><circle r="10"/></svg></div>
        </div>
        <div data-testid="mcq-option-container" role="radio" aria-checked="false" data-option-id="equal"><div class="lib-mcq-option-content-container">They are equal.</div></div>
      </section>
      <div class="lib-question-statement-container">For similar triangles with scale factor <span class="katex"><annotation encoding="application/x-tex">3/2</annotation></span>, how do the corresponding side lengths compare?</div>
      <button>Submit Answer</button>
    </div></main>`;
  });
  const read=await h.send({type:'ALEF_INSPECT'});
  assert.equal(read.stage,'question',JSON.stringify(read));assert.equal(read.loading,false);
  assert.equal(read.question.type,'single');assert.match(read.question.text,/similar triangles with scale factor/);
  assert.match(read.question.text,/\$3\/2\$/,'The unrelated KaTeX selector remains unchanged');
  assert.deepEqual(read.question.options.map(option=>option.text),['They are proportional.','They are equal.']);
  assert.equal(read.question.requiresVision,undefined,'The lib- selection icon is not a question diagram');
});

test('unsupported published image matching is an actionable reader error, never a progress-bar loading timeout',async t=>{
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(()=>{
    document.body.innerHTML=`<main id="player-container"><div data-testid="ncle-activity-page-player">
      <div role="progressbar" style="width:500px;height:8px">2/5</div>
      <section class="lib-dnd-container lib-question-widget lib-text-on-image"><h2>Drag the word to the image.</h2>
        <span class="lib-dnd-droppable" id="droppable-0" data-index="0" style="display:block;width:100px;height:50px"></span>
        <span class="lib-dnd-options-draggable">water</span>
      </section><button disabled>Submit Answer</button>
    </div></main>`;
  });
  const read=await h.send({type:'ALEF_INSPECT'});
  assert.equal(read.question,null);assert.equal(read.stage,'question',JSON.stringify(read));
  assert.equal(read.loading,false,'Visible lib- blanks preserve the actual reader error instead of waiting thirty seconds');
  assert.ok(read.diagnostics.some(message=>/صورة أو ترتيب خاص/.test(message)),JSON.stringify(read));
});

test('published aliases apply only to built-in roots and never rewrite an explicit user selector',async t=>{
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(()=>{
    document.body.innerHTML='<main id="player-container"><section class="lib-dropdown-container lib-question-widget"><h2>Write the number two.</h2><textarea></textarea><button>Submit Answer</button></section></main>';
  });
  const defaultRead=await h.send({type:'ALEF_GET_QUESTION'});assert.equal(defaultRead.question.type,'text');
  const exact=await h.send({type:'ALEF_GET_QUESTION',selectors:{question:'.dropdown-container'}});
  assert.equal(exact.question,null,'The exact unprefixed custom selector must not expand to .lib-dropdown-container');
  const explicit=await h.send({type:'ALEF_GET_QUESTION',selectors:{question:'.lib-dropdown-container'}});
  assert.equal(explicit.question.type,'text');
  await h.page.evaluate(()=>{document.body.innerHTML='<main><form><div class="lib-dropdown-container"><input role="combobox" value="PRIVATE_ACCOUNT_DATA"></div></form></main>';});
  const unknown=await h.send({type:'ALEF_GET_QUESTION'});assert.equal(unknown.question,null,'An account combobox without a question widget is never inferred from the lib- prefix');
});

test('published dropdown diagnostics count authored options and Cancel while retaining only bounded structural classes',async t=>{
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(()=>{
    document.body.innerHTML=`<main id="player-container"><section class="lib-dropdown-container lib-question-widget">
      <h2>Choose the number two.</h2><div class="lib-dropdown-input-field-container PRIVATE_ACCOUNT_CLASS">
        <input role="combobox" readonly class="lib-is-focused PRIVATE_INPUT_CLASS" aria-expanded="true" aria-controls="PRIVATE_MENU_ID" value="PRIVATE_SEARCH_VALUE">
      </div><button disabled>Submit Answer</button>
    </section></main><div id="PRIVATE_MENU_ID" role="listbox"><div role="option" class="lib-dropdown-item">PRIVATE_OPTION</div><div role="option" class="lib-dropdown-item lib-dropdown-item-cancel">Cancel</div></div>`;
  });
  const report=await h.send({type:'ALEF_DIAGNOSTICS'}),structure=report.diagnostics.interactionStructure;
  assert.equal(structure.questionVisible,true);assert.equal(structure.dropdowns.length,1);
  assert.deepEqual(structure.dropdowns[0].classes,['lib-is-focused']);
  assert.deepEqual(structure.dropdowns[0].ancestors[0].classes,['lib-dropdown-input-field-container']);
  assert.equal(structure.menus[0].weaverOptions,1);assert.equal(structure.menus[0].cancelOptions,1);
  assert.deepEqual(structure.menus[0].ownerFields,[1]);assert.doesNotMatch(JSON.stringify(structure),/PRIVATE_/);
});
