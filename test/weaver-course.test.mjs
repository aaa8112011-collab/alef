import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import vm from 'node:vm';
import {chromium} from 'playwright';

const root=new URL('../',import.meta.url);
async function harness(t,{includeDnd=true}={}) {
  const fixture=await readFile(new URL('test/fixtures/weaver-course.html',root));
  const source=await readFile(new URL('extension/content.js',root),'utf8');
  const server=createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(fixture);});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  let browser;
  try {
    browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH||existsSync('/usr/bin/chromium')?{executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'}:{}),args:['--no-sandbox','--disable-dev-shm-usage']});
    const page=await browser.newPage({locale:'ar-AE'});
    await page.addInitScript(()=>{
      window.__handlers=[];
      window.chrome={runtime:{id:'weaver-test',onMessage:{addListener(listener){window.__handlers.push(listener);}}}};
      window.__sendContent=message=>new Promise((resolve,reject)=>{
        for(const listener of window.__handlers){let answered=false;const accepted=listener(message,{id:'weaver-test'},value=>{answered=true;resolve(value);});if(answered||accepted===true)return;}
        reject(new Error('Content message was not accepted: '+message.type));
      });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/?dnd=${includeDnd?1:0}`);
    const inject=()=>page.addScriptTag({content:source});await inject();
    const h={page,inject,cleanups:[],send:message=>page.evaluate(value=>window.__sendContent(value),message)};
    t.after(async()=>{for(const cleanup of h.cleanups)await cleanup();await browser.close();await new Promise(resolve=>server.close(resolve));});
    return h;
  } catch(error){await browser?.close();await new Promise(resolve=>server.close(resolve));throw error;}
}
async function workerBridge(h,requests) {
  const source=await readFile(new URL('extension/background.js',root),'utf8');
  const events=[],storage={};let handler;
  const chrome={
    runtime:{id:'weaver-test',getURL:path=>'chrome-extension://weaver-test/'+path,getPlatformInfo:async()=>({}),onMessage:{addListener(fn){handler=fn;}},sendMessage:async message=>events.push(structuredClone(message))},
    storage:{session:{get:async key=>({[key]:storage[key]}),set:async values=>Object.assign(storage,structuredClone(values)),remove:async key=>{delete storage[key];}}},
    tabs:{get:async()=>({id:1,url:h.page.url()}),sendMessage:async(_id,message)=>h.send(message),create:async()=>{},onRemoved:{addListener(){}},update:async(_id,update)=>{await h.page.goto(update.url);await h.inject();return{id:1,url:h.page.url()};}},
    scripting:{executeScript:async()=>{await h.inject();}},action:{onClicked:{addListener(){}}},
  };
  vm.runInNewContext(source,{chrome,URL,AbortController,AbortSignal,DOMException,setTimeout,clearTimeout,setInterval,clearInterval,fetch:async(_url,options)=>{
    const {question}=JSON.parse(options.body);requests.push(question);
    let answer={optionIds:[],text:'',explanation:'Deterministic local test provider.',confidence:.99};
    if(question.type==='matching')answer.matches=question.items.map(item=>({itemId:item.id,targetId:question.targets.find(target=>target.text==='ماء').id}));
    else if(question.type==='text')answer.text='7';
    else answer.optionIds=[question.options.find(option=>['5x','2'].includes(option.text.trim())).id];
    return Response.json({answer,verified:false,needsReview:false});
  }},{filename:'weaver-course-background.js'});
  const send=message=>new Promise((resolve,reject)=>{const accepted=handler({tabId:1,...message},{id:'weaver-test',url:'chrome-extension://weaver-test/dashboard.html'},resolve);if(!accepted)reject(new Error('Worker refused request.'));});
  h.cleanups.push(()=>send({type:'STOP'}));return {events,send};
}

test('Weaver course traverses instructional steps and automatically submits every supported question before the next lesson',async t=>{
  const h=await harness(t);const requests=[];const worker=await workerBridge(h,requests);
  const connection=await worker.send({type:'CONNECT'});assert.equal(connection.ok,true,JSON.stringify(connection));
  const subject=connection.subjects.find(item=>item.name==='الرياضيات');assert.ok(subject);
  const result=await worker.send({type:'START',subjectId:subject.id,config:{serverUrl:'http://127.0.0.1:4318',token:'test-local-only',verify:false,autoSubmit:true,skipInstruction:true,minConfidence:.85}});
  assert.equal(result.ok,true,JSON.stringify(result));
  const start=Date.now();
  while(!worker.events.some(item=>['complete','error','review'].includes(item.event?.kind))){
    if(Date.now()-start>30000)assert.fail(JSON.stringify(worker.events));await new Promise(resolve=>setTimeout(resolve,35));
  }
  const terminal=worker.events.find(item=>['complete','error','review'].includes(item.event?.kind)).event;
  assert.equal(terminal.kind,'complete',JSON.stringify({terminal,requests}));
  const actual=await h.page.evaluate(()=>window.weaverFixture.state);
  assert.equal(actual.actions.some(item=>item.kind==='sidebar-shortcut'),false);
  assert.deepEqual(actual.completed,['one','two']);
  assert.equal(actual.submissions.length,8);assert.ok(actual.submissions.every(item=>item.correct));
  assert.deepEqual(actual.submissions.map(item=>[item.lesson,item.type]),[
    ['one','mcq'],['one','dropdown'],['one','dnd'],['one','text'],['two','mcq'],['two','dropdown'],['two','dnd'],['two','text'],
  ]);
  for(const lesson of ['one','two'])assert.deepEqual(actual.actions.filter(item=>item.kind==='intro'&&item.lesson===lesson).map(item=>item.step),[0,1,2]);
  const firstFinish=actual.actions.findIndex(item=>item.kind==='finish'&&item.lesson==='one');
  const secondOpen=actual.actions.findIndex(item=>item.kind==='open'&&item.lesson==='two');
  assert.ok(firstFinish>=0&&secondOpen>firstFinish,'A later lesson must open only after confirmed full completion.');
  assert.equal(requests.length,8,'No question should be omitted or solved twice.');
  assert.ok(requests.filter(question=>question.options.some(option=>option.text==='5x')).every(question=>question.text.includes('2x + 3x')),'The model must receive the actual math statement outside the radiogroup.');
  const state=(await worker.send({type:'GET_STATE'})).state;
  assert.equal(state.stats.solved,8);assert.equal(state.stats.lessonsCompleted,2);assert.equal(state.stats.review,0);
  const sent=worker.events.filter(item=>item.event?.kind==='submitted').map(item=>item.event);
  assert.equal(sent.length,8);assert.ok(sent.every(event=>event.currentLesson?.name&&event.currentSubject?.name&&event.applied&&event.submitted));
});
