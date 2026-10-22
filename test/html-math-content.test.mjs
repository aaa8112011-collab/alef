import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserHarness} from '../scripts/test-browser.mjs';
import {solveExactMath} from '../server/exact-math.mjs';

// Standard HTML scripts are deliberately separate from KaTeX/MathML. These
// fixtures verify extraction, rather than claiming a signed-in Alef layout.
async function mount(t,prompt,options) {
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(({prompt,options})=>{
    document.body.innerHTML='<section data-alef-question="html-script"><h2>'+prompt+'</h2>'+options.map((html,index)=>
      '<label data-alef-option="option-'+index+'"><input type="radio" name="question" value="option-'+index+'">'+html+'</label>').join('')+
      '<button data-alef-submit disabled>Submit Answer</button></section>';
    window.htmlMathFixture={submitted:[]};
    const submit=document.querySelector('button');
    document.querySelectorAll('input').forEach(input=>input.onchange=()=>{submit.disabled=false;});
    submit.onclick=()=>window.htmlMathFixture.submitted.push(document.querySelector('input:checked')?.value);
  },{prompt,options});
  const result=await h.send({type:'ALEF_INSPECT'});
  assert.equal(result.stage,'question',JSON.stringify(result));assert.ok(result.question);
  return {...h,question:result.question};
}

for(const language of ['en','ar'])test(`${language} HTML exponent retains its value and exact solving cannot choose the flattened number`,async t=>{
  const h=await mount(t,language==='ar'?'احسب ٢<sup>٣</sup> + ١':'Evaluate 2<sup>3</sup> + 1',language==='ar'?['٩','٢٤']:['9','24']);
  assert.match(h.question.text,language==='ar'?/٢\^\(٣\) \+ ١/:/2\^\(3\) \+ 1/);
  const answer=solveExactMath(h.question);assert.deepEqual(answer?.optionIds,['option-0']);
  const applied=await h.send({type:'ALEF_APPLY',questionId:h.question.id,questionFingerprint:h.question.fingerprint,answer,autoSubmit:true});
  assert.equal(applied.submitted,true,JSON.stringify(applied));
  assert.deepEqual(await h.page.evaluate(()=>window.htmlMathFixture.submitted),['option-0']);
});

test('an absent result stays unmatched after exponent extraction rather than selecting the concatenation distractor',async t=>{
  const h=await mount(t,'Evaluate 2<sup>3</sup> + 1',['8','24']);
  assert.equal(solveExactMath(h.question),null);
  assert.deepEqual(await h.page.evaluate(()=>window.htmlMathFixture.submitted),[]);
});

test('HTML exponents inside answer labels remain distinct algebraic choices',async t=>{
  const h=await mount(t,'Simplify (x+1)(x-1)',['x<sup>2</sup>−1','x<sup>2</sup>+1']);
  assert.deepEqual(h.question.options.map(option=>option.text),['x^(2)−1','x^(2)+1']);
  assert.deepEqual(solveExactMath(h.question)?.optionIds,['option-0']);
});

test('negative and nested exponents and subscripts keep their grouping and unsupported exact forms decline',async t=>{
  const h=await mount(t,'Simplify x<sub>n+1</sub><sup>−2</sup> + 2<sup>2<sup>3</sup></sup>',['1','2']);
  assert.match(h.question.text,/x_\(n\+1\)\^\(−2\)/);
  assert.match(h.question.text,/2\^\(2\^\(3\)\)/);
  assert.equal(solveExactMath(h.question),null);
});

test('prime labels, units, ordinals and explicit citations retain their meaning',async t=>{
  const h=await mount(t,'Compare D<sup>′</sup>E<sup>″</sup> at 20<sup>°</sup>C in the 2<sup>nd</sup> example<sup class="reference"><a href="#fn1">1</a></sup>; area 9 cm<sup>2</sup>; index x<sub>1</sub>.',['1','2']);
  assert.match(h.question.text,/D′E″/);assert.match(h.question.text,/20°C/);assert.match(h.question.text,/2nd/);
  assert.match(h.question.text,/example \[1\]/);assert.match(h.question.text,/9 cm\^\(2\)/);assert.match(h.question.text,/x_\(1\)/);
  assert.doesNotMatch(h.question.text,/\^\([′″]\)|example\^\(1\)|x1/);
});

test('hidden script nodes stay excluded and KaTeX source takes precedence over rendered HTML scripts',async t=>{
  const h=await mount(t,'Evaluate 2<sup hidden>99</sup><sup>3</sup> + 1 <span class="katex"><span class="katex-mathml"><math><semantics><mi>x</mi><annotation encoding="application/x-tex">x^{2}</annotation></semantics></math></span><span class="katex-html">duplicate x<sup>2</sup></span></span>',['2<sup style="display:none">999</sup><sup>3</sup>','9']);
  assert.match(h.question.text,/2\^\(3\) \+ 1/);assert.match(h.question.text,/\$x\^\{2\}\$/);
  assert.doesNotMatch(h.question.text,/99|duplicate|x\^\(2\)/);
  assert.equal(h.question.options[0].text,'2^(3)');
});


for(const visibility of ['hidden','collapse'])test(`HTML exponent traversal excludes visibility ${visibility} terms before exact solving`,async t=>{
  const h=await mount(t,'Evaluate 2<sup>3</sup> + 1 <span style="visibility:'+visibility+'">+ 100</span>',['9','109']);
  assert.match(h.question.text,/2\^\(3\) \+ 1/);
  assert.doesNotMatch(h.question.text,/100/);
  assert.deepEqual(solveExactMath(h.question)?.optionIds,['option-0']);
});

for(const rule of ['visibility:hidden','visibility:collapse','display:none'])test(`detached prompt preserves original stylesheet ${rule} without discarding semantic math`,async t=>{
  const h=await mount(t,'Evaluate 2<sup>3</sup> + 1 <style>.invisible-math-term{'+rule+'}</style><span class="invisible-math-term">+ 100</span>',['9','109']);
  assert.doesNotMatch(h.question.text,/100|invisible-math-term/);
  assert.deepEqual(solveExactMath(h.question)?.optionIds,['option-0']);
});
