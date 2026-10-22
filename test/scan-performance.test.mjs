import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

// Operation counts keep this regression independent of machine/CI speed. These
// ordinary HTML catalogs model a long subject list; they are not a signed-in
// Alef page or evidence that a particular website rendering failure is fixed.
test('a 56-lesson catalog reuses subtree/style reads without dropping lessons or changing the page',async t=>{
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(()=>{
    document.body.innerHTML='<main>'+Array.from({length:56},(_,i)=>
      `<article class="lesson-card" data-alef-lesson="lesson-${i}" data-lesson-name="Lesson ${i}"><h2>Lesson ${i}</h2><div><div><div><button>Start</button><span>Open lesson</span></div></div></div></article>`).join('')+'</main>';
    window.scanMetrics={styles:0,subtreeWalks:0};
    const style=window.getComputedStyle,elementQuery=Element.prototype.querySelectorAll,documentQuery=Document.prototype.querySelectorAll;
    window.getComputedStyle=function(...args){window.scanMetrics.styles++;return style.apply(this,args);};
    Element.prototype.querySelectorAll=function(...args){if(args[0]==='*')window.scanMetrics.subtreeWalks++;return elementQuery.apply(this,args);};
    Document.prototype.querySelectorAll=function(...args){if(args[0]==='*')window.scanMetrics.subtreeWalks++;return documentQuery.apply(this,args);};
    window.scanHTML=document.body.innerHTML;
    window.scanMutations=new MutationObserver(()=>{});
    window.scanMutations.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
  });
  const snapshot=await h.send({type:'ALEF_INSPECT'});
  assert.equal(snapshot.stage,'lessons');assert.equal(snapshot.lessons.length,56);
  assert.deepEqual(snapshot.lessons.map(lesson=>lesson.id),Array.from({length:56},(_,i)=>`lesson-${i}`));
  const result=await h.page.evaluate(()=>({...window.scanMetrics,unchanged:window.scanHTML===document.body.innerHTML,mutations:window.scanMutations.takeRecords().length}));
  assert.ok(result.styles<500,`Repeated style reads: ${JSON.stringify(result)}`);
  assert.ok(result.subtreeWalks<=60,`Repeated subtree walks: ${JSON.stringify(result)}`);
  assert.equal(result.unchanged,true);assert.equal(result.mutations,0);
});

test('read caches expire between scans when a lesson becomes hidden or a login form appears',async t=>{
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(()=>{document.body.innerHTML='<main><article data-alef-lesson="one" data-lesson-name="One"><h2>One</h2></article><article data-alef-lesson="two" data-lesson-name="Two"><h2>Two</h2></article></main>';});
  assert.equal((await h.send({type:'ALEF_INSPECT'})).lessons.length,2);
  await h.page.locator('[data-alef-lesson="one"]').evaluate(node=>node.style.display='none');
  assert.deepEqual((await h.send({type:'ALEF_INSPECT'})).lessons.map(lesson=>lesson.id),['two']);
  await h.page.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<form><input type="password" value="PRIVATE_LOGIN"></form>'));
  const login=await h.send({type:'ALEF_INSPECT'});
  assert.equal(login.stage,'unknown');assert.equal(login.lessons.length,0);assert.equal(login.question,null);
  await h.page.locator('form').evaluate(node=>node.remove());
  assert.deepEqual((await h.send({type:'ALEF_INSPECT'})).lessons.map(lesson=>lesson.id),['two']);
});

test('read caches discover newly mounted shadow-root lessons on the next scan',async t=>{
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(()=>{document.body.innerHTML='<main id="shell"></main>';});
  assert.equal((await h.send({type:'ALEF_INSPECT'})).lessons.length,0);
  await h.page.evaluate(()=>{
    document.querySelector('#shell').attachShadow({mode:'open'}).innerHTML='<article data-alef-lesson="mounted" data-lesson-name="Mounted"><h2>Mounted</h2></article>';
  });
  assert.deepEqual((await h.send({type:'ALEF_INSPECT'})).lessons.map(lesson=>lesson.id),['mounted']);
});
