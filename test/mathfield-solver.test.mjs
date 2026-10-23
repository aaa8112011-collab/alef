import test from 'node:test';
import assert from 'node:assert/strict';
import {solveQuestion,validateSolveInput} from '../server/solver.mjs';

// Explicit provider replies verify format transport and independent checking;
// these tests do not evaluate a real model or hard-code a live lesson answer.
const fraction=String.raw`\frac{7}{4}`;
const answer={optionIds:[],text:fraction,explanation:'رد اختبار نقل صيغة رياضية فقط.',confidence:.98};
const config=fetchImpl=>({provider:'ollama',model:'qwen3:8b',baseUrl:'http://127.0.0.1:11434',fetchImpl});
const reply=value=>Response.json({message:{content:JSON.stringify(value)},done:true});
const question={id:'math-field-fixture',type:'text',answerFormat:'latex',options:[],
  text:'Write the ratio of the two given lengths as an exact fraction.'};
const input={subject:'Math',question,qualityMode:true,verify:true};

test('LaTeX answer format is retained only for a supported text answer field',()=>{
  assert.deepEqual(validateSolveInput(input).question,question);
  const ordinary={id:'ordinary',type:'text',text:'Write the requested city name.',options:[]};
  assert.deepEqual(validateSolveInput({...input,question:ordinary}).question,ordinary);
});

for(const format of [null,'math','LATEX','',{},1])test(`unsupported answer format is rejected before inference: ${JSON.stringify(format)}`,async()=>{
  await assert.rejects(solveQuestion({...input,question:{...question,answerFormat:format}},
    config(()=>assert.fail('Invalid editor format reached provider'))),{code:'invalid_request',status:400});
});

test('a choice question cannot carry math-editor formatting',async()=>{
  const q={...question,type:'single',options:[{id:'a',text:'first'},{id:'b',text:'second'}]};
  await assert.rejects(solveQuestion({...input,question:q},config(()=>assert.fail('Choice formatting reached provider'))),
    {code:'invalid_request',status:400});
});

for(const language of ['ar','en'])test(`${language}: both independent requests receive the exact-expression contract and the fraction survives unchanged`,async()=>{
  const requests=[],q={...question,text:language==='ar'?'اكتب نسبة الطولين المعطيين على صورة كسر دقيق.':question.text};
  const result=await solveQuestion({...input,question:q},config(async(url,request)=>{
    assert.ok(url.endsWith('/api/chat'));
    const body=JSON.parse(request.body);requests.push(body);
    return reply({...answer,confidence:requests.length===2?.95:.98});
  }));
  assert.equal(requests.length,2);assert.equal(result.verified,true);assert.equal(result.needsReview,false);
  assert.equal(result.answer.text,fraction);assert.equal(result.answer.confidence,.95);
  for(const request of requests){
    assert.deepEqual(JSON.parse(request.messages[1].content).question,q);
    assert.match(request.messages[0].content,/ONLY the requested mathematical expression/);
    assert.match(request.messages[0].content,/do not replace it with an equivalent decimal/);
    assert.equal(request.messages.length,2,'The verifier gets original evidence without a first-answer hint');
    assert.equal(request.format.properties.text.type,'string');
    assert.equal(request.think,true,'Math-field formatting does not disable the selected accuracy mode');
  }
  assert.match(requests[1].messages[0].content,/Solve independently/);
});

for(const [name,other] of [['equivalent decimal','1.75'],['different variable case','X']])test(`math-field verification does not treat ${name} as agreement`,async()=>{
  let calls=0;
  const first=name==='different variable case'?'x':fraction;
  const result=await solveQuestion(input,config(async()=>reply({...answer,text:++calls===1?first:other})));
  assert.equal(calls,2);assert.equal(result.verified,false);assert.equal(result.needsReview,true);
  assert.equal(result.reason,'verification_disagreement');assert.equal(result.answer.text,first);
});

test('low confidence still stops a math-field answer before an independent request',async()=>{
  let calls=0;
  const result=await solveQuestion(input,config(async()=>{calls++;return reply({...answer,confidence:.7});}));
  assert.equal(calls,1);assert.equal(result.needsReview,true);assert.equal(result.reason,'low_confidence');
});
