import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import vm from 'node:vm';
import {chromium} from 'playwright';

const root=new URL('../',import.meta.url);

// A deliberately rejecting interaction fixture, not an answer-accuracy benchmark.
// The first answer is rejected even when it is mathematically correct, so the
// test can prove that every later submission follows an explicit Try Again.
function fixture(language){return `<!doctype html><html lang="${language}"><meta charset="utf-8"><style>
body{font:16px/1.5 system-ui;max-width:980px;margin:20px auto}button{padding:12px;margin:8px}
.question-widget{padding:20px;border:1px solid #ddd}.dropdown-input-field-container{display:inline-block;border:1px solid #aaa;padding:10px}
[role=option],.dnd-options-draggable,.dnd-droppable{padding:14px;border:1px solid #bbb;margin:8px;min-width:110px;min-height:28px}
.dnd-options-draggable,.dnd-droppable{display:inline-block}.is-selected{background:#dff1df}[hidden]{display:none!important}
</style><main></main><script>
(()=>{
 const ar=${language==='ar'},main=document.querySelector('main'),types=['dropdown','text','dnd'];
 const state={index:0,attempt:0,actions:[],submissions:[],completed:false};
 let body,q,submit,menu,answer=null;
 const record=(kind,extra={})=>state.actions.push({kind,type:types[state.index],attempt:state.attempt,...extra});
 const node=(tag,text='',attrs={})=>{const n=document.createElement(tag);n.textContent=text;for(const[k,v]of Object.entries(attrs))n.setAttribute(k,v);return n;};
 const button=(text,fn,id)=>{const n=node('button',text,{type:'button',...(id?{'data-testid':id}:{})});n.onclick=fn;return n;};
 const removeMenu=()=>{menu?.remove();menu=null;};
 function shell(){removeMenu();main.replaceChildren();const page=node('section','',{'data-testid':'ncle-activity-page'});body=node('div','',{'data-testid':'ncle-activity-page-player'});page.append(body);main.append(page);}
 function ready(value){answer=value;setTimeout(()=>{if(submit?.isConnected)submit.disabled=false;},75);}
 function question(){
  shell();answer=null;const type=types[state.index];
  q=node('section','',{'data-alef-question':'retry-'+type,class:(type==='text'?'open-ended':type)+'-container question-widget'});
  q.append(node('div',ar?'أكمل الإجابة.':'Complete the answer.',{id:'instruction'}));
  if(type==='dropdown'){
   q.append(node('div',ar?'اختر العدد الذي يكمل 2 + [قائمة] = 4.':'Choose the number completing 2 + [list] = 4.',{'data-testid':'question-statement-container'}));
   const blank=node('div','',{class:'dropdown-input-field-container','data-index':'blank'}),control=node('div','',{class:'react-select__control'});
   const selected=node('div','',{class:'dropdown-single-value-content'}),combo=node('input','',{role:'combobox',readonly:'',type:'text','aria-expanded':'false','aria-controls':'owned-options'});
   let opening=false;
   const open=()=>{if(menu||opening||combo.getAttribute('aria-disabled')==='true')return;opening=true;combo.setAttribute('aria-expanded','true');setTimeout(()=>{
    opening=false;if(!combo.isConnected||combo.getAttribute('aria-expanded')!=='true')return;
    menu=node('div','',{role:'listbox',id:'owned-options'});
    for(const value of ['2','3']){const option=node('div',value,{role:'option',id:'owned-'+value,'aria-selected':'false'});option.onclick=()=>{record('dropdown',{value});removeMenu();combo.setAttribute('aria-expanded','false');setTimeout(()=>{selected.textContent=value;ready(value);},110);};menu.append(option);}
    document.body.append(menu);
   },200);};
   combo.onkeydown=e=>{if(e.key==='ArrowDown')open();if(e.key==='Escape'){combo.setAttribute('aria-expanded','false');removeMenu();}};
   control.onmousedown=open;control.append(selected,combo);blank.append(control);q.append(blank);
  }else if(type==='text'){
   q.append(node('div',ar?'اكتب ناتج 3 + 4.':'Write the result of 3 + 4.',{'data-testid':'question-statement-container'}));
   const attach=input=>{input.oninput=()=>{const value=input.value;record('input',{value});setTimeout(()=>{if(!input.isConnected)return;const replacement=input.cloneNode();replacement.value=value;attach(replacement);input.replaceWith(replacement);ready(value);},110);};};
   const input=node('textarea','',{id:'open-ended-textarea','data-testid':'open-ended-textarea'});attach(input);q.append(input);
  }else{
   q.append(node('div',ar?'اسحب الكلمة لإكمال الجملة: يسقط المطر على هيئة فراغ.':'Drag the word to complete: rain falls as a blank.',{'data-testid':'question-statement-container'}));
   const blank=node('div','',{class:'dnd-droppable',id:'droppable-0','data-index':'0',tabindex:'0'});q.append(blank);
   for(const word of (ar?['ماء','هواء']:['water','air'])){
    const option=node('div',word,{class:'dnd-options-draggable',role:'button',tabindex:'0'});
    option.onmousedown=e=>{
     if(e.button!==0)return;const started=Date.now(),initial={x:e.clientX,y:e.clientY};let last=initial,cancelled=false;
     const activation=setTimeout(()=>{if(!cancelled){record('drag-active',{value:word});option.classList.add('is-dragging');option.setAttribute('aria-pressed','true');}},1000);
     const move=event=>{last={x:event.clientX,y:event.clientY};if(event.buttons!==1)cancelled=true;if(Date.now()-started<1000&&Math.hypot(last.x-initial.x,last.y-initial.y)>5)cancelled=true;const r=blank.getBoundingClientRect();if(!cancelled&&Date.now()-started>=1000&&last.x>=r.left&&last.x<=r.right&&last.y>=r.top&&last.y<=r.bottom)setTimeout(()=>blank.classList.add('is-about-to-drop'),25);};
     const up=()=>{clearTimeout(activation);option.classList.remove('is-dragging');option.setAttribute('aria-pressed','false');document.removeEventListener('mousemove',move);document.removeEventListener('mouseup',up);const r=blank.getBoundingClientRect(),held=Date.now()-started;record('release',{value:word,held,cancelled});if(cancelled||held<1000||last.x<r.left||last.x>r.right||last.y<r.top||last.y>r.bottom)return;setTimeout(()=>{blank.textContent=word;blank.classList.add('is-selected');option.remove();record('placed',{value:word});ready(word);},110);};
     document.addEventListener('mousemove',move);document.addEventListener('mouseup',up);
    };q.append(option);
   }
  }
  submit=button(ar?'إرسال الإجابة':'Submit answer',()=>{
   const valid=type==='dropdown'?['2','3'].includes(answer):type==='text'?answer==='7':answer===(ar?'ماء':'water');
   state.submissions.push({type,attempt:state.attempt,answer,valid});record('submit',{value:answer,valid});
   if(!valid)throw new Error('Unsupported value or premature submission');
   removeMenu();submit.remove();
   for(const c of q.querySelectorAll('input,textarea,.dnd-options-draggable')){c.setAttribute('aria-disabled','true');if(c.matches('input,textarea'))c.disabled=true;}
   const required=type==='dropdown'?3:1;
   if(state.attempt<required){body.append(node('p',ar?'إجابة غير صحيحة':'Incorrect answer',{'data-testid':'wrong-answer-feedback'}),button(ar?'حاول مرة أخرى':'Try again',()=>{record('retry');state.attempt++;question();},'navigation-next-button'));}
   else{body.append(node('p',ar?'إجابة صحيحة':'Correct answer',{'data-testid':'correct-answer-feedback'}),button(ar?'التالي':'Next',()=>{record('next');state.index++;state.attempt=0;state.index===types.length?finish():question();},'navigation-next-button'));}
  },'navigation-next-button');submit.disabled=true;body.append(q,submit);
 }
 function finish(){shell();body.append(node('div','Section result',{'data-testid':'ncle-assessment-result'}),button('Finish',()=>{record('finish');state.completed=true;main.innerHTML='<section data-alef-completed>Lesson completed</section>';},'activity-navigation-bar__finish-button'));}
 const start=button(ar?'الرياضيات':'Math',()=>{history.replaceState(null,'','#/progress/ncle/class/retry-class/lesson/one/material/intro');question();});start.setAttribute('data-alef-subject','math');main.append(start);
 window.retryInteractionFixture={get state(){return structuredClone(state);}};
})();
</script></html>`;}

async function harness(t,language){
 const source=await readFile(new URL('extension/content.js',root),'utf8');
 const server=createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(fixture(language));});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 let browser;
 try{
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH||existsSync('/usr/bin/chromium')?{executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'}:{}),args:['--no-sandbox','--disable-dev-shm-usage']});
  const page=await browser.newPage({locale:'ar-AE'});
  await page.addInitScript(()=>{window.__handlers=[];window.chrome={runtime:{id:'retry-interaction-test',onMessage:{addListener(fn){window.__handlers.push(fn);}}}};window.__sendContent=message=>new Promise((resolve,reject)=>{for(const handler of window.__handlers){let answered=false;const accepted=handler(message,{id:'retry-interaction-test'},value=>{answered=true;resolve(value);});if(answered||accepted===true)return;}reject(new Error('No content handler accepted '+message.type));});});
  await page.goto('http://127.0.0.1:'+server.address().port+'/');
  const inject=()=>page.addScriptTag({content:source});await inject();
  const h={page,inject,cleanups:[],send:message=>page.evaluate(value=>window.__sendContent(value),message)};
  t.after(async()=>{for(const cleanup of h.cleanups)await cleanup();await browser.close();await new Promise(resolve=>server.close(resolve));});return h;
 }catch(error){await browser?.close();await new Promise(resolve=>server.close(resolve));throw error;}
}

async function workerBridge(h,language){
 const source=await readFile(new URL('extension/background.js',root),'utf8'),events=[],requests=[],storage={};let handler;
 const chrome={runtime:{id:'retry-interaction-test',getURL:path=>'chrome-extension://retry-interaction-test/'+path,getPlatformInfo:async()=>({}),onMessage:{addListener(fn){handler=fn;}},sendMessage:async message=>events.push(structuredClone(message))},
  storage:{session:{get:async key=>({[key]:storage[key]}),set:async values=>Object.assign(storage,structuredClone(values)),remove:async key=>{delete storage[key];}}},
  tabs:{get:async()=>({id:1,url:h.page.url()}),sendMessage:async(_id,message)=>h.send(message),create:async()=>{},onRemoved:{addListener(){}},update:async(_id,update)=>{await h.page.goto(update.url);await h.inject();return{id:1,url:h.page.url()};}},
  scripting:{executeScript:async()=>{await h.inject();}},action:{onClicked:{addListener(){}}}};
 vm.runInNewContext(source,{chrome,URL,AbortController,AbortSignal,DOMException,setTimeout,clearTimeout,setInterval,clearInterval,fetch:async(url,options)=>{
  if(url.endsWith('/api/health'))return Response.json({ok:true,configured:true,provider:'ollama',modelReady:true,protocolVersion:3,visionReady:true});
  const {question}=JSON.parse(options.body);requests.push(question);const answer={optionIds:[],text:'',explanation:'Deterministic interaction fixture answer, not an accuracy benchmark.',confidence:.99};
  if(question.type==='matching')answer.matches=question.items.map(item=>({itemId:item.id,targetId:question.targets.find(target=>target.text===(language==='ar'?'ماء':'water')).id}));
  else if(question.type==='text')answer.text='7';else answer.optionIds=[question.options.find(option=>option.text.trim()==='2').id];
  return Response.json({answer,verified:false,needsReview:false});
 }},{filename:'retry-interactions-background.js'});
 const send=message=>new Promise((resolve,reject)=>{const accepted=handler({tabId:1,...message},{id:'retry-interaction-test',url:'chrome-extension://retry-interaction-test/dashboard.html'},resolve);if(!accepted)reject(new Error('Worker refused request.'));});
 h.cleanups.push(()=>send({type:'STOP'}));return{events,requests,send};
}

for(const language of ['ar','en'])test('three interaction types keep retries on the same question and bypass extra solving ('+language+')',async t=>{
 const h=await harness(t,language),worker=await workerBridge(h,language);
 const connected=await worker.send({type:'CONNECT'});assert.equal(connected.ok,true,JSON.stringify(connected));assert.equal(connected.subjects.length,1);
 const started=await worker.send({type:'START',subjectId:connected.subjects[0].id,config:{serverUrl:'http://127.0.0.1:4318',token:'fixture-only',verify:false,autoSubmit:true,skipInstruction:true,minConfidence:.85}});assert.equal(started.ok,true,JSON.stringify(started));
 const start=Date.now();while(!worker.events.some(item=>['complete','error','review'].includes(item.event?.kind))){if(Date.now()-start>35000)assert.fail(JSON.stringify(worker.events));await new Promise(resolve=>setTimeout(resolve,35));}
 const terminal=worker.events.find(item=>['complete','error','review'].includes(item.event?.kind)).event;
 assert.equal(terminal.kind,'complete',JSON.stringify({terminal,events:worker.events.map(item=>item.event),requests:worker.requests}));
 const actual=await h.page.evaluate(()=>window.retryInteractionFixture.state);assert.equal(actual.completed,true);assert.equal(actual.submissions.length,8);assert.ok(actual.submissions.every(item=>item.valid));
 assert.deepEqual(actual.submissions.map(item=>[item.type,item.attempt]),[['dropdown',0],['dropdown',1],['dropdown',2],['dropdown',3],['text',0],['text',1],['dnd',0],['dnd',1]]);
 assert.deepEqual(actual.submissions.filter(item=>item.type==='dropdown').map(item=>item.answer),['2','3','2','3'],'Two current valid choices must remain usable through more retry cycles than there are choices.');
 assert.equal(worker.requests.length,3,'Each new question uses exactly one normal model request; five retry submissions use local valid values.');
 assert.deepEqual(worker.requests.map(question=>question.type),['single','text','matching']);
 const retries=actual.actions.filter(item=>item.kind==='retry');assert.equal(retries.length,5);
 for(const submission of actual.actions.filter(item=>item.kind==='submit'&&item.attempt>0)){
  const index=actual.actions.indexOf(submission),retry=actual.actions.slice(0,index).findLast(item=>item.kind==='retry');assert.ok(retry&&retry.type===submission.type&&retry.attempt===submission.attempt-1,'Every quick submission must follow the matching visible Try Again.');
 }
 assert.equal(actual.actions.filter(item=>item.kind==='next').length,3,'No next action is allowed before that question finishes its retries.');
 const releases=actual.actions.filter(item=>item.kind==='release');assert.equal(releases.length,2);assert.ok(releases.every(item=>item.held>=1000&&!item.cancelled),'Each drag must hold the mouse button for actual one-second sensor activation.');
 assert.equal(actual.actions.filter(item=>item.kind==='placed').length,2);
 const retryEvents=worker.events.filter(item=>item.event?.kind==='submitted'&&item.event.retryAttempt).map(item=>item.event);assert.equal(retryEvents.length,5);assert.deepEqual(retryEvents.map(item=>item.retryNumber),[1,2,3,1,1]);assert.ok(retryEvents.every(item=>item.answer.confidence===undefined));
 const state=(await worker.send({type:'GET_STATE'})).state;assert.equal(state.stats.solved,8);assert.equal(state.stats.total,3);assert.equal(state.stats.lessonsCompleted,1);
});
