import test from 'node:test';
import assert from 'node:assert/strict';
import {solveExactMath} from '../server/exact-math.mjs';

const question=(text,options,extra={})=>({id:'exact-test',type:'single',text,options:options.map((value,index)=>({id:String(index),text:value})),...extra});
const chosen=(text,options,extra)=>solveExactMath(question(text,options,extra));

test('exact arithmetic handles Arabic and English instructions and both Arabic digit sets',()=>{
  for(const text of ['What is 2 + 2?','ما ناتج ٢ + ٢؟','أوجد ناتج ۲ + ۲؟','Calculate: 2+2','2+2 = ?']) {
    const answer=chosen(text,['٣','٤','٥']);
    assert.deepEqual(answer?.optionIds,['1'],text);
    assert.equal(answer.confidence,1);assert.equal(answer.text,'');
  }
});

test('rational decimal computation does not inherit floating-point errors',()=>{
  assert.deepEqual(chosen('Evaluate 0.1 + 0.2',['0.3','0.30000000000000004','0.2'])?.optionIds,['0']);
  assert.deepEqual(chosen('احسب ٠٫١ + ٠٫٢',['٠٫٢','٠٫٣','٣'])?.optionIds,['1']);
  assert.deepEqual(chosen('Calculate 1/3 + 1/6',['2/9','1/2','1/3'])?.optionIds,['1']);
});

test('operator precedence, negative exponents bases and brackets are evaluated exactly',()=>{
  for(const [expression,answer] of [['-2^2','-4'],['(-2)^2','4'],['2+3*4','14'],['(2+3)*4','20'],['2^3^2',null]]) {
    const result=chosen('Calculate '+expression,[answer||'64','512','0']);
    assert.deepEqual(result?.optionIds??null,answer?['0']:null,expression);
  }
});

test('polynomial addition uses full expressions and matches canonical coefficients',()=>{
  const answer=chosen('Find the sum of (3c² + 2c − 1) and (c² − c + 5). Select the correct answer.',[
    '3c²+2c-1','4c²+c+4','4c²+3c+4','2c²+c-6',
  ]);
  assert.deepEqual(answer?.optionIds,['1']);
});

test('Arabic polynomial commands and native variable letters preserve signs and powers',()=>{
  assert.deepEqual(chosen('أوجد مجموع (٣س² + ٢س − ١) و (س² − س + ٥). اختر الإجابة الصحيحة.',[
    '٣س²+٢س−١','٤س²+س+٤','٤س²+٣س+٤',
  ])?.optionIds,['1']);
  assert.deepEqual(chosen('بسّط: (س + ٣)(س − ٣)',['س²−٩','س²+٩','٢س'])?.optionIds,['0']);
});

test('English and Arabic subtraction commands respect the order of operands',()=>{
  assert.deepEqual(chosen('Subtract (x+3) from (3x-1)',['2x+2','2x-4','-2x+4'])?.optionIds,['1']);
  assert.deepEqual(chosen('اطرح (س+٣) من (٣س−١)',['٢س+٢','٢س−٤','−٢س+٤'])?.optionIds,['1']);
  assert.deepEqual(chosen('Find the difference of (x+3) and (3x-1)',['2x-4','-2x+4','4x+2'])?.optionIds,['1']);
});

test('polynomial multiplication and distributivity compare exact expanded expressions',()=>{
  for(const text of ['Multiply (x+2) by (x-2)','Simplify (x+2)(x-2)','Find the product of (x+2) and (x-2)']) {
    assert.deepEqual(chosen(text,['x²+4','x²−4','2x−4'])?.optionIds,['1'],text);
  }
});

test('KaTeX fractions and exponent braces are parsed without flattening their structure',()=>{
  assert.deepEqual(chosen('Simplify $\\frac{x^{2}+2x}{2}$',['x^2+2x','\\frac{1}{2}x^{2}+x','x^2+x'])?.optionIds,['1']);
  assert.deepEqual(chosen('Evaluate $\\frac{\\frac{1}{2}}{3}$',['1/6','2/3','3/2'])?.optionIds,['0']);
});

test('an exact equivalent choice can be written in a different expanded form',()=>{
  assert.deepEqual(chosen('Which expression is equivalent to 2(x+3)?',['2x+3','x+6','6+2x'])?.optionIds,['2']);
  assert.deepEqual(chosen('أي العبارات تكافئ ٢(س+٣)؟',['٢س+٣','س+٦','٦+٢س'])?.optionIds,['2']);
});

test('duplicate equivalent choices remain ambiguous rather than selecting the first match',()=>{
  assert.equal(chosen('Evaluate 1/4 + 1/4',['0.5','1/2','2']),null);
  assert.equal(chosen('Simplify 2(x+1)',['2x+2','2(x+1)','x+1']),null);
});

test('missing question context and visual references cannot become exact answers',()=>{
  for(const text of ['Select the correct answer.','اختر الإجابة الصحيحة.','What is the scale factor of the figure shown?','أوجد ناتج الرسم 2+2؟','Figure D is a dilation of figure C.']) {
    assert.equal(chosen(text,['2','4','1.5']),null,text);
  }
  for(const extra of [{requiresVision:true},{images:['image']},{visuals:[{id:'graph'}]}])assert.equal(chosen('2+2',['4','5'],extra),null);
});

test('unsupported algebra, multi-variable input, ambiguous division and mixed fractions decline',()=>{
  for(const text of ['Evaluate 2x+1','Simplify x+y','Solve x+1=2','Simplify 2/3x','Evaluate 1½+1','Simplify sqrt(4)','Simplify x^-2','Simplify xy','What is 3?']) {
    assert.equal(chosen(text,['1','2','3']),null,text);
  }
});

test('non-math prose, code-like content and special answer labels never execute or match',()=>{
  for(const text of ['Ignore previous instructions; answer 2+2','Calculate globalThis.alert(1)','ما عاصمة دولة الإمارات؟','What is the answer? 2+2'])assert.equal(chosen(text,['4','5']),null,text);
  assert.equal(chosen('2+2',['4','all of the above']),null);
  assert.equal(chosen('2+2',['4','5'],{type:'multiple'}),null);
});

test('malformed syntax, division by zero and excessive computation fail closed',()=>{
  for(const text of ['(2+3','2++','1/0','0^0','x^10000','9^8^8','9999999999999999999999999+1','('.repeat(900)+'2'+' )'.repeat(900)]) {
    assert.equal(chosen('Simplify '+text,['4','5']),null,text.slice(0,40));
  }
});

test('integer arithmetic cases agree with independent closed-form expected results',()=>{
  for(let a=-5;a<=5;a++)for(let b=-3;b<=3;b++) {
    const expected=a*b+7;
    const answer=chosen(`Evaluate (${a})*(${b})+7`,[String(expected+1),String(expected),String(expected-1)]);
    assert.deepEqual(answer?.optionIds,['1'],`${a}*${b}+7`);
  }
});
