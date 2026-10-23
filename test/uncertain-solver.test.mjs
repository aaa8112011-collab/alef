import test from 'node:test';
import assert from 'node:assert/strict';
import {solveQuestion,validateSolveInput} from '../server/solver.mjs';

// Deterministic provider replies exercise the user's uncertainty preference,
// not model accuracy. Confidence and review evidence must remain truthful.
const textQuestion={id:'uncertain-expression',type:'text',answerFormat:'latex',options:[],text:'Write the ratio of the given lengths as an exact fraction.'};
const input={subject:'Math',question:textQuestion,verify:true,qualityMode:true};
const fraction=String.raw`\frac{7}{4}`;
const candidate={optionIds:[],text:fraction,explanation:'إجابة اختبار غير مؤكدة.',confidence:.62};
const config=fetchImpl=>({provider:'ollama',model:'qwen3:8b',visionModel:'qwen3-vl:8b',baseUrl:'http://127.0.0.1:11434',fetchImpl});
const reply=answer=>Response.json({message:{content:JSON.stringify(answer)}});
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZVhIAAAAASUVORK5CYII=';
const choice={id:'uncertain-choice',type:'single',text:'Read the graph and choose its indicated value.',options:[{id:'original-a',text:'first'},{id:'original-b',text:'second'}]};

test('uncertainty preference is explicit, defaults false and is retained when enabled',()=>{
  assert.equal(validateSolveInput(input).allowUncertain,false);
  assert.equal(validateSolveInput({...input,allowUncertain:false}).allowUncertain,false);
  assert.equal(validateSolveInput({...input,allowUncertain:true}).allowUncertain,true);
});

for(const value of [null,'yes',0,1,{}])test(`invalid uncertainty preference is rejected before inference: ${JSON.stringify(value)}`,async()=>{
  await assert.rejects(solveQuestion({...input,allowUncertain:value},config(()=>assert.fail('Invalid preference reached provider'))),
    {code:'invalid_request',status:400});
});

for(const language of ['ar','en'])test(`${language}: enabled uncertainty keeps an exact-expression candidate and its honest confidence`,async()=>{
  const requests=[],question={...textQuestion,text:language==='ar'?'اكتب نسبة الطولين المعطيين على صورة كسر دقيق.':textQuestion.text};
  const result=await solveQuestion({...input,question,allowUncertain:true},config(async(_url,options)=>{
    requests.push(JSON.parse(options.body));return reply(candidate);
  }));
  assert.equal(requests.length,1,'A low-confidence first answer does not trigger a hidden repair or verification loop');
  assert.equal(result.answer.text,fraction);assert.equal(result.answer.confidence,.62);
  assert.equal(result.verified,false);assert.equal(result.needsReview,true);assert.equal(result.reason,'low_confidence');
  const system=requests[0].messages[0].content;
  assert.match(system,/user explicitly enabled answering despite uncertainty/);
  assert.match(system,/best-supported complete candidate answer/);
  assert.match(system,/Keep your actual confidence unchanged/);
  assert.match(system,/Missing essential question text or images/);
  assert.match(system,/ONLY the requested mathematical expression/,'MathLive format rules still apply');
  assert.equal(requests[0].think,true,'The preference does not switch off selected quality mode');
});

test('ordinary requests keep the conservative prompt and low-confidence review unchanged',async()=>{
  let body;
  const result=await solveQuestion(input,config(async(_url,options)=>{body=JSON.parse(options.body);return reply(candidate);}));
  assert.doesNotMatch(body.messages[0].content,/user explicitly enabled answering despite uncertainty/);
  assert.match(body.messages[0].content,/return optionIds: \[\] and confidence below 0\.85/);
  assert.equal(result.answer.confidence,.62);assert.equal(result.needsReview,true);assert.equal(result.reason,'low_confidence');
});

test('uncertainty instructions travel with real image bytes without weakening vision capability or option IDs',async()=>{
  const requests=[];
  const result=await solveQuestion({...input,allowUncertain:true,question:{...choice,requiresVision:true,images:[png]}},config(async(url,options)=>{
    if(url.endsWith('/api/show'))return Response.json({capabilities:['completion','vision']});
    const request=JSON.parse(options.body);requests.push(request);
    return reply({optionIds:['original-b'],text:'',explanation:'اختبار نقل صورة فقط.',confidence:.5});
  }));
  assert.equal(requests.length,1);assert.equal(requests[0].model,'qwen3-vl:8b');
  assert.deepEqual(requests[0].messages[1].images,[png]);
  assert.deepEqual(requests[0].format.properties.optionIds.items.enum,['original-a','original-b']);
  assert.match(requests[0].messages[0].content,/user explicitly enabled answering despite uncertainty/);
  assert.equal(result.answer.confidence,.5);assert.equal(result.verified,false);assert.equal(result.needsReview,true);
});

test('independent disagreement retains the original complete candidate and truthful unverified status',async()=>{
  const requests=[];
  const result=await solveQuestion({...input,allowUncertain:true},config(async(_url,options)=>{
    requests.push(JSON.parse(options.body));return reply({...candidate,text:requests.length===1?fraction:'2',confidence:.96});
  }));
  assert.equal(requests.length,2);assert.equal(result.answer.text,fraction);assert.equal(result.answer.confidence,.96);
  assert.equal(result.verified,false);assert.equal(result.needsReview,true);assert.equal(result.reason,'verification_disagreement');
  for(const request of requests)assert.match(request.messages[0].content,/user explicitly enabled answering despite uncertainty/);
  assert.match(requests[1].messages[0].content,/Solve independently/);
});

for(const [name,question,answer] of [
  ['nonexistent choice ID',choice,{...candidate,optionIds:['invented'],text:''}],
  ['incomplete dropdown mapping',{id:'fields',type:'dropdowns',text:'Complete both blanks.',options:[],fields:[
    {id:'first',text:'first blank',options:[{id:'a',text:'first value'}]},
    {id:'second',text:'second blank',options:[{id:'b',text:'second value'}]},
  ]},{...candidate,text:'',selections:[{fieldId:'first',optionId:'a'}]}],
])test(`uncertainty preference cannot accept a ${name}`,async()=>{
  let calls=0;
  const result=await solveQuestion({...input,question,allowUncertain:true},config(async()=>{calls++;return reply(answer);}));
  assert.equal(calls,1);assert.equal(result.needsReview,true);assert.equal(result.reason,'invalid_selection');
  assert.equal(result.answer.confidence,0);assert.deepEqual(result.answer.optionIds,[]);
});

test('an abstained provider answer remains empty rather than inventing a candidate or inflating confidence',async()=>{
  const result=await solveQuestion({...input,question:choice,allowUncertain:true},config(async()=>reply({...candidate,optionIds:[],text:'',confidence:.2})));
  assert.deepEqual(result.answer.optionIds,[]);assert.equal(result.answer.confidence,.2);
  assert.equal(result.verified,false);assert.equal(result.needsReview,true);assert.equal(result.reason,'low_confidence');
});

for(const [name,question,reason] of [
  ['missing required image',{...choice,requiresVision:true},'missing_visual_evidence'],
  ['missing question statement',{...choice,text:'Select the correct answer.'},'missing_question_text'],
])test(`${name} still stops before inference when uncertainty is enabled`,async()=>{
  const result=await solveQuestion({...input,question,allowUncertain:true},config(()=>assert.fail('Missing evidence reached provider')));
  assert.equal(result.needsReview,true);assert.equal(result.verified,false);assert.equal(result.reason,reason);
  assert.equal(result.answer.confidence,0);assert.deepEqual(result.answer.optionIds,[]);
});
