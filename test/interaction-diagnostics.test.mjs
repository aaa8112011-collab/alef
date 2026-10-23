import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

test('interaction diagnostics describe dropdown ownership and answer tools without exporting DOM identities, options or values',async t=>{
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(()=>{
    document.body.innerHTML=`<main data-testid="assessment-content-player"><section data-alef-question="diagnostic-question">
      <h2>Complete the two blanks.</h2>
      <div class="dropdown-input-field-container" id="PRIVATE_WRAPPER_ID"><span class="dropdown-single-value-content">Select</span>
        <input readonly role="combobox" id="PRIVATE_STUDENT_CONTROL_ID" class="PRIVATE_ACCOUNT_CLASS css-generated" aria-controls="PRIVATE_MENU_ID" aria-expanded="true" value="PRIVATE_SEARCH_VALUE">
      </div>
      <div class="dropdown-input-field-container"><input readonly role="combobox" aria-owns="PRIVATE_UNRESOLVED_REFERENCE" aria-expanded="false"></div>
      <input type="text" value="PRIVATE_TYPED_VALUE"><textarea>PRIVATE_TEXTAREA_VALUE</textarea>
      <div class="dnd-options-draggable">PRIVATE_DRAG_VALUE</div><span class="dnd-droppable"></span>
      <button data-alef-submit disabled>Submit Answer</button>
    </section></main>
    <div id="PRIVATE_MENU_ID" role="listbox"><div class="dropdown-item" role="option">PRIVATE_OPTION_ONE</div><div class="dropdown-item" role="option">PRIVATE_OPTION_TWO</div><div class="dropdown-item dropdown-item-cancel">Cancel</div></div>`;
  });
  const result=await h.send({type:'ALEF_DIAGNOSTICS'});assert.equal(result.ok,true,JSON.stringify(result));
  const structure=result.diagnostics.interactionStructure;
  assert.equal(structure.questionVisible,true);assert.equal(structure.dropdowns.length,2);
  assert.equal(structure.dropdowns[0].readOnly,true);assert.equal(structure.dropdowns[0].expanded,true);
  assert.equal(structure.dropdowns[0].linkedMenuCount,1);assert.equal(structure.dropdowns[1].unresolvedReferences,1);
  assert.deepEqual(structure.menus[0].ownerFields,[1]);
  assert.equal(structure.dropdowns[0].menuRefs[0],structure.menus[0].ref);
  assert.equal(structure.menus[0].semanticOptions,2);assert.equal(structure.menus[0].weaverOptions,2);
  assert.equal(structure.menus[0].cancelOptions,1);assert.equal(structure.textFields.length,2);
  assert.deepEqual(structure.drag,{sources:1,targets:1});
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_/);
});

test('interaction diagnostics remain empty on an unknown account form',async t=>{
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(()=>{document.body.innerHTML='<main><form><input type="email" value="PRIVATE_EMAIL"><input type="password" value="PRIVATE_PASSWORD"><input role="combobox" aria-controls="PRIVATE_ACCOUNT_ID"></form></main>';});
  const result=await h.send({type:'ALEF_DIAGNOSTICS'});
  assert.equal(result.diagnostics.interactionStructure.questionVisible,false);
  assert.deepEqual(result.diagnostics.interactionStructure.dropdowns,[]);
  assert.deepEqual(result.diagnostics.interactionStructure.textFields,[]);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_/);
});

test('failed application records only its operation and status and a fresh run clears the trace',async t=>{
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(()=>{document.body.innerHTML='<section data-alef-question="trace"><h2>What is two plus two?</h2><input type="text"><button data-alef-submit>Submit Answer</button></section>';});
  const result=await h.send({type:'ALEF_APPLY',questionId:'wrong-question',answer:{optionIds:[],text:'PRIVATE_ANSWER_PAYLOAD'}});
  assert.equal(result.ok,false);
  const report=await h.send({type:'ALEF_DIAGNOSTICS'});
  assert.equal(report.diagnostics.lastInteraction.operation,'apply-answer');
  assert.equal(report.diagnostics.lastInteraction.status,'failed');
  assert.ok(Number.isFinite(report.diagnostics.lastInteraction.durationMs));
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE_ANSWER_PAYLOAD/);
  await h.send({type:'ALEF_BEGIN'});
  assert.equal((await h.send({type:'ALEF_DIAGNOSTICS'})).diagnostics.lastInteraction,null);
});

test('a pending menu preparation and its cancellation are distinguishable without replaying the interaction',async t=>{
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(()=>{
    document.body.innerHTML='<section data-alef-question="pending-menu"><h2>Choose the number two.</h2><span class="dropdown-input-field-container"><input readonly role="combobox" aria-expanded="false"></span><button data-alef-submit disabled>Submit Answer</button></section>';
    window.preparationEvents=0;
    document.querySelector('input').onkeydown=event=>{if(event.key==='ArrowDown'){window.preparationEvents++;event.currentTarget.setAttribute('aria-expanded','true');}};
  });
  const pending=h.send({type:'ALEF_PREPARE_QUESTION'});
  await h.page.waitForFunction(()=>window.preparationEvents===1);
  const running=await h.send({type:'ALEF_DIAGNOSTICS'});
  assert.equal(running.diagnostics.lastInteraction.operation,'prepare-question');
  assert.equal(running.diagnostics.lastInteraction.status,'running');
  assert.equal(running.diagnostics.lastInteraction.cancelled,false);
  await h.send({type:'ALEF_CANCEL'});assert.equal((await pending).ok,false);
  const stopped=await h.send({type:'ALEF_DIAGNOSTICS'});
  assert.equal(stopped.diagnostics.lastInteraction.status,'failed');assert.equal(stopped.diagnostics.lastInteraction.cancelled,true);
  assert.equal(await h.page.evaluate(()=>window.preparationEvents),1);
});

const workerSource=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
async function workerReport({manifest='0.5.8',content='0.5.7',embedded=null,throwManifest=false}={}){
  let listener;
  const chrome={runtime:{id:'diagnostic-test',getURL:path=>'chrome-extension://diagnostic-test/'+path,
    ...(manifest===null?{}:{getManifest(){if(throwManifest)throw Error('unavailable');return {version:manifest};}}),
    onMessage:{addListener(fn){listener=fn;}},sendMessage:async()=>{}},
    storage:{session:{get:async()=>({}),set:async()=>{}}},
    tabs:{get:async()=>({id:1,url:'https://moe.alefed.com/'}),sendMessage:async(_tab,message,target)=>{
      assert.equal(message.type,'ALEF_DIAGNOSTICS');
      return {ok:true,diagnostics:{version:target.frameId?embedded:content,stage:'question'}};
    },onRemoved:{addListener(){}}},
    scripting:{executeScript:async()=>{}},action:{onClicked:{addListener(){}}},
    webNavigation:{getAllFrames:async()=>[{frameId:0,url:'https://moe.alefed.com/'},{frameId:7,documentId:'child',url:'https://moe.alefed.com/material'}]},
  };
  const context={chrome,URL,AbortController,AbortSignal,DOMException,setTimeout,clearTimeout,setInterval,clearInterval};
  // Explicit VM test instrumentation exposes only the fixture routing table.
  vm.runInNewContext(workerSource+'\nglobalThis.__diagnosticRoutes=frameRoutes;',context);
  if(embedded)context.__diagnosticRoutes.set(1,{injected:new Set([0,7])});
  return new Promise(resolve=>listener({type:'DIAGNOSTICS',tabId:1},{id:'diagnostic-test',url:'chrome-extension://diagnostic-test/dashboard.html'},value=>resolve(structuredClone(value))));
}

test('worker diagnostics identify a stale top reader and a separately stale lesson-frame reader',async()=>{
  const result=await workerReport({manifest:'0.5.8',content:'0.5.7',embedded:'0.5.6'});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.deepEqual(result.diagnostics.versions,{worker:'0.5.8',content:'0.5.7',consistent:false,
    embedded:[{frameId:7,content:'0.5.6',consistent:false}]});
});

for(const options of [{manifest:null},{throwManifest:true}])test(`diagnostics tolerate an unavailable manifest version (${JSON.stringify(options)})`,async()=>{
  const result=await workerReport(options);assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.diagnostics.versions.worker,null);assert.equal(result.diagnostics.versions.content,'0.5.7');
  assert.equal(result.diagnostics.versions.consistent,null);
});

test('matching worker and reader versions are reported as consistent',async()=>{
  const result=await workerReport({manifest:'0.5.7'});
  assert.equal(result.diagnostics.versions.consistent,true);
});
