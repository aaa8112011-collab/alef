import test from 'node:test';
import assert from 'node:assert/strict';
import {solveQuestion} from '../server/solver.mjs';

const options=[{id:'equal',text:'They are equal.'},{id:'proportional',text:'They are proportional.'}];
const input=text=>({subject:'Math',question:{id:'stem-evidence',text,type:'single',options},verify:true});
const modelAnswer={optionIds:['proportional'],text:'',explanation:'مزود اختبار فقط',confidence:.98};
const config=fetchImpl=>({provider:'ollama',model:'qwen3:8b',visionModel:'qwen3-vl:8b',baseUrl:'http://127.0.0.1:11434',fetchImpl});
const response=()=>Response.json({message:{content:JSON.stringify(modelAnswer)}});

for(const text of ['Select the correct answer.','Choose the correct answer!','اختر الإجابة الصحيحة.','اِخْتَرِ الإِجَابَةَ الصَّحِيحَةَ','Select the correct answer. اختر الإجابة الصحيحة.','حدد الإجابات الصحيحة:']) {
  test(`an instruction without a problem skips inference and reports missing evidence: ${text}`,async()=>{
    let calls=0;
    const result=await solveQuestion(input(text),config(async()=>{calls++;return response();}));
    assert.equal(calls,0);assert.equal(result.reason,'missing_question_text');
    assert.equal(result.needsReview,true);assert.equal(result.answer.confidence,0);
    assert.deepEqual(result.answer.optionIds,[]);assert.match(result.answer.explanation,/نص المسألة/);
  });
}

for(const text of [
  'If two triangles are similar by AA, what can be concluded about their corresponding side lengths? Select the correct answer.',
  'إذا تشابه مثلثان بزاويتين، فماذا نستنتج عن أطوال أضلاعهما المتناظرة؟ اختر الإجابة الصحيحة.'
])test('a complete problem with a choice instruction retains its full evidence in both inference requests: '+text,async()=>{
  const requests=[];
  const result=await solveQuestion(input(text),config(async(_url,request)=>{
    const body=JSON.parse(request.body);requests.push(body);
    assert.equal(JSON.parse(body.messages[1].content).question.text,text);
    return response();
  }));
  assert.equal(requests.length,2);assert.equal(result.verified,true);assert.equal(result.needsReview,false);
  assert.deepEqual(result.answer.optionIds,['proportional']);
});

test('an image-authored problem with a short instruction still reaches the vision model',async()=>{
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZVhIAAAAASUVORK5CYII=';
  const requests=[];
  const result=await solveQuestion({...input('Select the correct answer.'),verify:false,question:{...input('').question,text:'Select the correct answer.',images:[png]}},config(async(url,request)=>{
    if(url.endsWith('/api/show'))return Response.json({capabilities:['vision']});
    const body=JSON.parse(request.body);requests.push(body);return response();
  }));
  assert.equal(result.needsReview,false);assert.equal(requests.length,1);
  assert.equal(requests[0].model,'qwen3-vl:8b');assert.deepEqual(requests[0].messages[1].images,[png]);
});
