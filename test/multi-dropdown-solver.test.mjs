import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {solveQuestion,validateSolveInput} from '../server/solver.mjs';
import {createAppServer} from '../server/index.mjs';

// These tests verify transport, original-ID constraints and independent
// verification, with explicit fake provider replies rather than model accuracy.
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZVhIAAAAASUVORK5CYII=';
const fields=[
  {id:'angle-D',text:'قياس الزاوية د [dropdown:angle-D]',options:[{id:'angle-70',text:'70°'},{id:'shared',text:'غير محدد'}]},
  {id:'triangles',text:'العلاقة بين المثلثين [dropdown:triangles]',options:[{id:'similar',text:'متشابهان'},{id:'shared',text:'المعطيات غير كافية'}]},
];
const question={id:'two-inline-dropdowns',type:'dropdowns',options:[],fields,
  text:'قياس الزاوية د هو [dropdown:angle-D] والمثلثان [dropdown:triangles].'};
const input={subject:'الرياضيات',question,verify:true};
const answer={optionIds:[],text:'',explanation:'إجابة مزود اختبار لتأكيد ربط القوائم فقط.',confidence:.97,
  selections:[{fieldId:'angle-D',optionId:'angle-70'},{fieldId:'triangles',optionId:'similar'}]};
const externalConfig=fetchImpl=>({provider:'openai',apiKey:'fixture-only',model:'fake-text',baseUrl:'https://provider.example/v1',fetchImpl});
const localConfig=fetchImpl=>({provider:'ollama',model:'qwen3:8b',visionModel:'qwen3-vl:8b',baseUrl:'http://127.0.0.1:11434',fetchImpl});
const external=value=>Response.json({choices:[{message:{content:JSON.stringify(value)}}]});
const local=value=>Response.json({message:{content:JSON.stringify(value)},done:true});

test('dropdown fields preserve each original ID and permit repeated IDs or labels across different fields',()=>{
  const q=structuredClone(question);q.fields[1].options[1].text='غير محدد';
  const result=validateSolveInput({...input,question:q});
  assert.deepEqual(result.question,q);
  assert.notEqual(result.question.fields,q.fields,'Validation creates a normalized request rather than reusing mutable arrays');
});

test('mathematical superscripts remain distinct from baseline digits in dropdown labels',()=>{
  const q=structuredClone(question);q.fields[0].options=[{id:'squared',text:'x²'},{id:'baseline',text:'x2'}];
  assert.deepEqual(validateSolveInput({...input,question:q}).question.fields[0].options,q.fields[0].options);
});

for(const [name,mutate] of [
  ['one field',q=>q.fields.pop()],
  ['too many fields',q=>q.fields=Array.from({length:21},(_,i)=>({...q.fields[0],id:'field-'+i}))],
  ['duplicate field IDs',q=>q.fields[1].id=q.fields[0].id],
  ['empty field label',q=>q.fields[0].text=' '],
  ['missing options',q=>delete q.fields[0].options],
  ['empty options',q=>q.fields[0].options=[]],
  ['too many options',q=>q.fields[0].options=Array.from({length:21},(_,i)=>({id:'id-'+i,text:'option '+i}))],
  ['duplicate option IDs in one field',q=>q.fields[0].options[1].id=q.fields[0].options[0].id],
  ['duplicate option labels in one field',q=>q.fields[0].options[1].text=q.fields[0].options[0].text],
  ['global choices on a field-scoped question',q=>q.options=[{id:'a',text:'a'}]],
])test(`invalid dropdown request is rejected before calling a model: ${name}`,async()=>{
  const q=structuredClone(question);mutate(q);
  await assert.rejects(solveQuestion({...input,question:q},externalConfig(()=>assert.fail('Invalid request reached provider'))),{code:'invalid_request',status:400});
});

for(const language of ['ar','en'])test(`${language}: both independent requests retain full field mapping and verification is order-independent`,async()=>{
  const requests=[];
  const q=structuredClone(question);
  if(language==='en')q.text='The measure of angle D is [dropdown:angle-D] and the triangles [dropdown:triangles].';
  const result=await solveQuestion({...input,question:q},externalConfig(async(_url,request)=>{
    const body=JSON.parse(request.body);requests.push(body);
    return external({...answer,selections:requests.length===1?answer.selections:[...answer.selections].reverse()});
  }));
  assert.equal(requests.length,2);assert.equal(result.verified,true);assert.equal(result.needsReview,false);
  for(const request of requests){
    assert.deepEqual(JSON.parse(request.messages[1].content).question,q);
    assert.match(request.messages[0].content,/field's OWN options/);
    assert.match(request.messages[0].content,/not one-to-one matching/);
  }
  assert.equal(requests[1].messages.length,2,'Verifier receives original evidence rather than the first response');
});

test('the same option ID can be selected independently in both fields without one-to-one matching restrictions',async()=>{
  const selections=fields.map(field=>({fieldId:field.id,optionId:'shared'}));
  const result=await solveQuestion(input,externalConfig(async()=>external({...answer,selections})));
  assert.equal(result.verified,true);assert.equal(result.needsReview,false);assert.deepEqual(result.answer.selections,selections);
});

test('a complete valid dropdown mapping normalizes incidental provider text to the empty application contract',async()=>{
  let calls=0;
  const result=await solveQuestion(input,externalConfig(async()=>external({...answer,
    text:++calls===1?'70°, متشابهان':'an incidental text copy in a different language'})));
  assert.equal(calls,2);assert.equal(result.verified,true);assert.equal(result.needsReview,false);
  assert.equal(result.answer.text,'');assert.deepEqual(result.answer.selections,answer.selections);
});

for(const [name,selections] of [
  ['a missing field',[answer.selections[0]]],
  ['an empty mapping',[]],
  ['a duplicate field',[answer.selections[0],answer.selections[0]]],
  ['a nonexistent field',[answer.selections[0],{fieldId:'other',optionId:'similar'}]],
  ['an answer borrowed from the other field',[{fieldId:'angle-D',optionId:'similar'},answer.selections[1]]],
  ['a visible label instead of an original ID',[{fieldId:'angle-D',optionId:'70°'},answer.selections[1]]],
])test(`invalid dropdown answer cannot be applied or independently verified: ${name}`,async()=>{
  let calls=0;
  const result=await solveQuestion(input,externalConfig(async()=>{calls++;return external({...answer,selections});}));
  assert.equal(calls,1);assert.equal(result.reason,'invalid_selection');assert.equal(result.needsReview,true);
  assert.deepEqual(result.answer.selections,[]);assert.deepEqual(result.answer.optionIds,[]);
});

test('malformed dropdown selections fail with a provider format error',async()=>{
  for(const selections of [undefined,null,[{fieldId:'angle-D'}],['angle-D']]){
    await assert.rejects(solveQuestion(input,externalConfig(async()=>external({...answer,selections}))),{code:'invalid_provider_response'});
  }
});

test('a disagreement on one field rejects the entire combined answer',async()=>{
  let calls=0;
  const result=await solveQuestion(input,externalConfig(async()=>external(++calls===1?answer:{...answer,
    selections:[{fieldId:'angle-D',optionId:'shared'},answer.selections[1]]})));
  assert.equal(calls,2);assert.equal(result.verified,false);assert.equal(result.needsReview,true);
  assert.equal(result.reason,'verification_disagreement');
});

test('low confidence keeps a complete dropdown answer for review without a second request',async()=>{
  let calls=0;
  const result=await solveQuestion(input,externalConfig(async()=>{calls++;return external({...answer,confidence:.4});}));
  assert.equal(calls,1);assert.equal(result.reason,'low_confidence');assert.equal(result.needsReview,true);
  assert.deepEqual(result.answer.selections,answer.selections);
});

test('local structured output constrains every option to its own field for text and vision',async()=>{
  for(const visual of [false,true]){
    const requests=[];
    const q={...question,...(visual?{requiresVision:true,images:[png]}:{})};
    const result=await solveQuestion({...input,question:q},localConfig(async(url,request)=>{
      if(url.endsWith('/api/show'))return Response.json({capabilities:['completion','vision']});
      const body=JSON.parse(request.body);requests.push(body);return local(answer);
    }));
    assert.equal(result.verified,true);assert.equal(requests.length,2);
    for(const request of requests){
      assert.equal(request.model,visual?'qwen3-vl:8b':'qwen3:8b');
      assert.equal(request.format.properties.optionIds.maxItems,0);
      assert.deepEqual(request.format.properties.text,{type:'string',enum:['']},'The local schema disallows unused free-text dropdown answers');
      assert.deepEqual(request.format.properties.selections.items.anyOf,fields.map(field=>({type:'object',
        properties:{fieldId:{type:'string',enum:[field.id]},optionId:{type:'string',enum:field.options.map(option=>option.id)}},
        required:['fieldId','optionId'],additionalProperties:false})));
      assert.deepEqual(JSON.parse(request.messages[1].content).question,{...question,...(visual?{requiresVision:true}:{})});
      if(visual)assert.deepEqual(request.messages[1].images,[png]);
      assert.ok(request.options.num_predict>=2048,'Complete field mappings need a suitable output budget');
    }
  }
});

test('visual dropdown questions with missing pixels stop before model requests',async()=>{
  const result=await solveQuestion({...input,question:{...question,requiresVision:true}},localConfig(()=>assert.fail('Missing image reached provider')));
  assert.equal(result.reason,'missing_visual_evidence');assert.deepEqual(result.answer.selections,[]);assert.equal(result.needsReview,true);
});

test('local HTTP health advertises field-scoped dropdowns and a paired request solves them without a paid key',async t=>{
  const bodies=[];
  const app=createAppServer({provider:'ollama',pairingToken:'multi-dropdown-fixture-only',model:'qwen3:8b',fetchImpl:async(url,request)=>{
    if(url.endsWith('/api/tags'))return Response.json({models:[{name:'qwen3:8b'}]});
    bodies.push(JSON.parse(request.body));return local(answer);
  }});
  app.listen(0,'127.0.0.1');await once(app,'listening');
  t.after(()=>new Promise(resolve=>{app.close(resolve);app.closeAllConnections();}));
  const url=`http://127.0.0.1:${app.address().port}`;
  const health=await(await fetch(url+'/api/health')).json();
  assert.equal(health.capabilities.multiDropdown,true);assert.equal(health.protocolVersion,3);assert.equal(health.configured,true);
  const response=await fetch(url+'/api/solve',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer multi-dropdown-fixture-only'},body:JSON.stringify(input)});
  assert.equal(response.status,200);const result=await response.json();
  assert.equal(result.verified,true);assert.equal(bodies.length,2);assert.deepEqual(result.answer.selections,answer.selections);
});
