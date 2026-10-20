import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import vm from 'node:vm';
import {chromium} from 'playwright';

const root=new URL('../',import.meta.url);
const config=()=>({serverUrl:'http://127.0.0.1:4318',token:'test-only-local-token',verify:true,autoSubmit:true,minConfidence:.85});

async function harness(t,scenario='normal',fixtureName='course'){
  const fixture=await readFile(new URL(`test/fixtures/${fixtureName}.html`,root));
  const script=await readFile(new URL('extension/content.js',root),'utf8');
  const server=createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(fixture);});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  let browser;
  try{
    browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH||existsSync('/usr/bin/chromium')?{executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'}:{}),args:['--no-sandbox','--disable-dev-shm-usage']});
    const page=await browser.newPage({locale:'ar-AE'});
    await page.addInitScript(()=>{
      window.__contentListeners=[];
      window.chrome={runtime:{id:'course-test-extension',onMessage:{addListener(listener){window.__contentListeners.push(listener);}}}};
      window.__sendContent=message=>new Promise((resolve,reject)=>{
        for(const listener of window.__contentListeners){
          let answered=false;
          listener(message,{id:'course-test-extension'},value=>{answered=true;resolve(value);});
          if(answered)return;
        }
        reject(new Error('No content handler for '+message.type));
      });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/?scenario=${scenario}`);
    const inject=()=>page.addScriptTag({content:script});
    await inject();
    const result={page,inject,cleanups:[],send:message=>page.evaluate(value=>window.__sendContent(value),message)};
    t.after(async()=>{
      for(const cleanup of result.cleanups)await cleanup();
      await browser.close();await new Promise(resolve=>server.close(resolve));
    });
    return result;
  }catch(error){await browser?.close();await new Promise(resolve=>server.close(resolve));throw error;}
}

async function bridge(h,fetchImpl){
  const source=await readFile(new URL('extension/background.js',root),'utf8');
  const events=[];const storage={};let handler;
  const chrome={
    runtime:{id:'course-test-extension',getURL:path=>'chrome-extension://course-test-extension/'+path,getPlatformInfo:async()=>({}),onMessage:{addListener(listener){handler=listener;}},sendMessage:async message=>{events.push(structuredClone(message));}},
    storage:{session:{get:async key=>({[key]:storage[key]}),set:async items=>Object.assign(storage,structuredClone(items)),remove:async key=>{delete storage[key];}}},
    tabs:{get:async()=>({id:1,url:h.page.url()}),sendMessage:async(_id,message)=>h.send(message),create:async()=>{},onRemoved:{addListener(){}},update:async(_id,update)=>{await h.page.goto(update.url);await h.inject();return{id:1,url:h.page.url()};}},
    scripting:{executeScript:async()=>{await h.inject();}},action:{onClicked:{addListener(){}}},
  };
  vm.runInNewContext(source,{chrome,URL,AbortController,AbortSignal,DOMException,setTimeout,clearTimeout,setInterval,clearInterval,fetch:fetchImpl},{filename:'background-course-test.js'});
  const worker={events,send:message=>new Promise((resolve,reject)=>{
    const accepted=handler({tabId:1,...message},{id:'course-test-extension',url:'chrome-extension://course-test-extension/dashboard.html'},resolve);
    if(!accepted)reject(new Error('Worker refused '+message.type));
  })};
  h.cleanups.push(()=>worker.send({type:'STOP'}));
  return worker;
}

function provider(_url,options){
  const question=JSON.parse(options.body).question;
  return Promise.resolve(Response.json({answer:{optionIds:question.type==='text'?[]:['b'],text:question.type==='text'?'مثلث':'42',explanation:'إجابة مزود الاختبار المحلي فقط',confidence:.99},verified:true,needsReview:false}));
}
async function waitFor(predicate,message,timeout=25000){
  const start=Date.now();while(!predicate()){
    if(Date.now()-start>timeout)assert.fail(typeof message==='function'?message():message);
    await new Promise(resolve=>setTimeout(resolve,35));
  }
}
async function runCourse(h,fetchImpl=provider){
  const worker=await bridge(h,fetchImpl);
  const connection=await worker.send({type:'CONNECT'});
  assert.equal(connection.ok,true,JSON.stringify(connection));
  const subject=connection.subjects.find(item=>item.name.includes('رياضيات'));
  assert.ok(subject,'Actual subjects must be scanned from the page');
  const start=await worker.send({type:'START',subjectId:subject.id,config:config()});
  assert.equal(start.ok,true,JSON.stringify(start));
  return worker;
}
const complete=worker=>worker.events.some(item=>item.event?.kind==='complete');

test('course catalog discovers lessons with explicit locked and previously-completed status',async t=>{
  const h=await harness(t);
  const scan=await h.send({type:'ALEF_SCAN'});
  assert.equal(scan.ok,true);assert.equal(scan.subjects.length,2);
  assert.equal((await h.send({type:'ALEF_SELECT_SUBJECT',subjectId:'math'})).ok,true);
  const snapshot=await h.send({type:'ALEF_INSPECT'});
  assert.equal(snapshot.ok,true,JSON.stringify(snapshot));assert.equal(snapshot.stage,'lessons');
  assert.equal(snapshot.lessons.length,5);
  assert.equal(snapshot.lessons.find(item=>item.id==='lesson-locked').locked,true);
  assert.equal(snapshot.lessons.find(item=>item.id==='lesson-done').completed,true);
});

test('automatic course workflow skips available introductions and completes all three open lessons',async t=>{
  const h=await harness(t);let calls=0;
  const worker=await runCourse(h,(_url,options)=>{calls++;return provider(_url,options);});
  await waitFor(()=>complete(worker),()=>JSON.stringify(worker.events));
  const state=(await worker.send({type:'GET_STATE'})).state;
  const actual=await h.page.evaluate(()=>window.courseFixture.state);
  assert.equal(calls,6);assert.equal(actual.submissions.length,6);assert.ok(actual.submissions.every(item=>item.correct));
  assert.deepEqual(actual.completed,['lesson-1','lesson-2','lesson-3']);
  assert.deepEqual(actual.actions.filter(item=>item.kind==='lesson').map(item=>item.id),['lesson-1','lesson-2','lesson-3']);
  assert.equal(actual.actions.filter(item=>item.kind==='instruction').length,9);
  assert.equal(state.stats.lessonsCompleted,3);assert.equal(state.stats.lessonsTotal,3);assert.equal(state.stats.solved,6);
  assert.equal(state.queue.find(item=>item.id==='lesson-locked').status,'locked');
  assert.equal(state.queue.find(item=>item.id==='lesson-done').status,'alreadycompleted');
});

test('one uncertain lesson is held for review while later lessons continue without a wrong submission',async t=>{
  const h=await harness(t);
  const worker=await runCourse(h,(url,options)=>{
    const question=JSON.parse(options.body).question;
    if(question.id.startsWith('lesson-2'))return Promise.resolve(Response.json({answer:{optionIds:['a'],text:'36',explanation:'نتيجة اختبار منخفضة الثقة',confidence:.4},verified:false,needsReview:true,reason:'low_confidence'}));
    return provider(url,options);
  });
  await waitFor(()=>complete(worker),()=>JSON.stringify(worker.events));
  const state=(await worker.send({type:'GET_STATE'})).state;
  const actual=await h.page.evaluate(()=>window.courseFixture.state);
  assert.deepEqual(actual.completed,['lesson-1','lesson-3']);
  assert.equal(actual.submissions.some(item=>item.lesson==='lesson-2'),false);
  assert.equal(state.queue.find(item=>item.id==='lesson-2').status,'review');
  assert.equal(state.stats.lessonsCompleted,2);assert.equal(state.stats.lessonsReview,1);
  assert.ok(worker.events.some(item=>item.event?.kind==='review'&&item.event.blocking===false));
});

test('mandatory introduction without an enabled skip is reviewed while unlocked later lessons continue',async t=>{
  const h=await harness(t,'mandatory');const worker=await runCourse(h);
  await waitFor(()=>complete(worker),()=>JSON.stringify(worker.events));
  const actual=await h.page.evaluate(()=>window.courseFixture.state);
  const state=(await worker.send({type:'GET_STATE'})).state;
  assert.equal(actual.actions.some(item=>item.kind==='instruction'&&item.lesson==='lesson-1'),false,'Disabled controls and mandatory progress must not be bypassed');
  assert.deepEqual(actual.completed,['lesson-2','lesson-3']);
  assert.equal(state.queue.find(item=>item.id==='lesson-1').status,'review');
});

test('STOP during a pending answer prevents submission and automatic opening of another lesson',async t=>{
  const h=await harness(t);let requested=false;let release;
  const worker=await runCourse(h,(_url,options)=>{
    requested=true;return new Promise(resolve=>{release=()=>resolve(Response.json({answer:{optionIds:['b'],text:'42',explanation:'إجابة متأخرة للاختبار',confidence:.99},verified:true,needsReview:false}));});
  });
  await waitFor(()=>requested,'Worker should reach one real question');
  assert.equal((await worker.send({type:'STOP'})).ok,true);release();
  await new Promise(resolve=>setTimeout(resolve,700));
  const actual=await h.page.evaluate(()=>window.courseFixture.state);
  assert.equal(actual.submissions.length,0);
  assert.deepEqual(actual.actions.filter(item=>item.kind==='lesson').map(item=>item.id),['lesson-1']);
  assert.equal((await worker.send({type:'GET_STATE'})).state.running,false);
});

test('unknown login page yields no fabricated subject or runnable course',async t=>{
  const h=await harness(t,'unknown');
  const scan=await h.send({type:'ALEF_SCAN'});
  assert.equal(scan.ok,true);assert.deepEqual(scan.subjects,[]);
  const snapshot=await h.send({type:'ALEF_INSPECT'});
  assert.equal(snapshot.stage,'unknown');
});

test('instruction navigation rejects a stale fingerprint before clicking',async t=>{
  const h=await harness(t);
  await h.send({type:'ALEF_SCAN'});await h.send({type:'ALEF_SELECT_SUBJECT',subjectId:'math'});
  assert.equal((await h.send({type:'ALEF_OPEN_LESSON',lessonId:'lesson-1'})).ok,true);
  const before=await h.send({type:'ALEF_INSPECT'});
  assert.equal(before.stage,'instruction');
  const next=before.navigation.find(item=>['skip','assessment','next'].includes(item.kind));assert.ok(next);
  await h.page.evaluate(()=>window.courseFixture.mutateInstruction());
  const result=await h.send({type:'ALEF_NAVIGATE',actionId:next.id,fingerprint:before.fingerprint});
  assert.equal(result.ok,false);
  assert.equal((await h.page.evaluate(()=>window.courseFixture.state)).actions.filter(item=>item.kind==='instruction').length,0);
});

test('nested semantic subject cards are discovered without fixture-only attributes',async t=>{
  const h=await harness(t,'semantic');const scan=await h.send({type:'ALEF_SCAN'});
  assert.equal(scan.ok,true);assert.equal(scan.subjects.length,2,JSON.stringify(scan));
  assert.ok(scan.subjects.some(item=>item.name.includes('رياضيات')));
  assert.ok(scan.subjects.some(item=>item.name.includes('علوم')));
  assert.notEqual(scan.subjects[0].id,scan.subjects[1].id);
});

test('different course destinations retain distinct stable IDs even when their names match',async t=>{
  const h=await harness(t,'semantic');
  await h.page.evaluate(()=>{
    document.querySelector('nav').replaceChildren();
    for(const grade of ['grade-7','grade-8']){
      const link=document.createElement('a');link.className='subject-card';link.href='/courses/'+grade;
      const heading=document.createElement('h2');heading.textContent='الرياضيات';link.append(heading);document.querySelector('nav').append(link);
    }
  });
  const first=await h.send({type:'ALEF_SCAN'});
  const second=await h.send({type:'ALEF_SCAN'});
  assert.equal(first.subjects.length,2,JSON.stringify(first));
  assert.notEqual(first.subjects[0].id,first.subjects[1].id);
  assert.deepEqual(first.subjects,second.subjects,'A repeat scan must not change destination identity');
});

test('diagnostics never export password or input values from an unknown page',async t=>{
  const h=await harness(t,'unknown');
  await h.page.locator('input[type="password"]').fill('PRIVATE_TEST_PASSWORD_DO_NOT_EXPORT');
  const report=await h.send({type:'ALEF_DIAGNOSTICS'});
  assert.equal(report.ok,true,JSON.stringify(report));
  assert.equal(JSON.stringify(report).includes('PRIVATE_TEST_PASSWORD_DO_NOT_EXPORT'),false);
});

test('locked lessons cannot be opened directly and an external lesson destination is refused',async t=>{
  const h=await harness(t);await h.send({type:'ALEF_SCAN'});await h.send({type:'ALEF_SELECT_SUBJECT',subjectId:'math'});
  const result=await h.send({type:'ALEF_OPEN_LESSON',lessonId:'lesson-locked'});
  assert.equal(result.ok,false);
  assert.equal((await h.page.evaluate(()=>window.courseFixture.state)).actions.filter(item=>item.kind==='lesson').length,0);
  await h.page.evaluate(()=>{
    const link=document.createElement('a');link.href='https://example.org/lessons/external';link.dataset.alefLesson='external';link.textContent='درس خارجي';document.querySelector('[data-alef-lessons]').append(link);
  });
  const scan=await h.send({type:'ALEF_INSPECT'});const external=scan.lessons.find(item=>item.id==='external');
  if(external){assert.equal((await h.send({type:'ALEF_OPEN_LESSON',lessonId:external.id})).ok,false);}
  assert.match(h.page.url(),/^http:\/\/127\.0\.0\.1:/);
});

test('actual Pathways hierarchy runs each level practice once rather than repeating it for every skill',async t=>{
 const h=await harness(t);
 await h.page.evaluate(()=>{
  const main=document.querySelector('main');let level='';window.pathwayState={levels:[],skills:[],practice:[],sent:[]};
  const button=(label,attrs,fn)=>{const node=document.createElement('button');node.textContent=label;for(const[key,value]of Object.entries(attrs||{}))node.setAttribute(key,value);node.onclick=fn;return node;};
  const catalog=()=>{history.replaceState(null,'','/pathways/classes/math');main.innerHTML='<h1>المستويات المفتوحة</h1><div data-testid="levels-container"></div>';for(const id of ['level1','level2']){const card=document.createElement('div');card.dataset.testid='level-card-container-'+id;card.innerHTML='<h2 data-testid="level-title">مستوى '+id+'</h2>';card.onclick=()=>{level=id;window.pathwayState.levels.push(id);skills();};main.lastElementChild.append(card);}};
  const skills=()=>{history.replaceState(null,'','/pathways/classes/math/levels/'+level);main.innerHTML='<ul aria-label="SkillList"></ul>';for(const id of ['skill1','skill2']){const wrapper=document.createElement('div');wrapper.innerHTML='<li aria-label="Skill"><h2>'+id+'</h2></li>';wrapper.onclick=()=>{window.pathwayState.skills.push(level+'-'+id);content();};main.firstElementChild.append(wrapper);}};
  const content=()=>{history.replaceState(null,'','/pathways/classes/math/levels/'+level+'/level-access-content/activity1');main.innerHTML='<section data-testid="content-page"><article data-testid="content-page-body-player">شرح الدرس</article><li id="skill-player-practice">Ready for questions?</li></section>';document.querySelector('#skill-player-practice').onclick=()=>{window.pathwayState.practice.push(level);quiz();};};
  const quiz=()=>{history.replaceState(null,'','/pathways/adaptive-practice/math/levels/'+level);main.innerHTML='<section data-alef-question="'+level+'-q"><h2>ما ناتج 6 × 7؟</h2><label data-alef-option="a"><input type="radio" name="q">36</label><label data-alef-option="b"><input type="radio" name="q">42</label></section>';main.firstElementChild.append(button('Submit answer',{'data-alef-submit':''},()=>{window.pathwayState.sent.push(level);main.innerHTML='<h2>مكتمل</h2><button data-testid="go-super-pro-btn">Go Super PRO!</button>';main.append(button('العودة للدروس',{'data-alef-back':''},catalog));}));};
  main.innerHTML='<div data-testid="subject-card" id="pathway-subject-cards-math" role="button"><h2 data-testid="subject-title">الرياضيات</h2></div>';main.firstElementChild.onclick=catalog;
 });
 const worker=await runCourse(h);await waitFor(()=>complete(worker),()=>JSON.stringify(worker.events));
 const actual=await h.page.evaluate(()=>window.pathwayState);assert.deepEqual(actual.levels,['level1','level2']);assert.equal(actual.skills.length,2);assert.deepEqual(actual.practice,['level1','level2']);assert.equal(actual.sent.length,2);
 assert.equal((await worker.send({type:'GET_STATE'})).state.stats.lessonsCompleted,2);
});

test('wrong-answer feedback uses a bounded explicit retry and never resubmits the same rejected choice',async t=>{
 const h=await harness(t);
 await h.page.evaluate(()=>{
  const main=document.querySelector('main');window.retryState={submitted:[],retryClicks:0};
  const question=()=>{main.innerHTML='<section data-alef-question="retry-q"><h2>ما ناتج 6 × 7؟</h2><label data-alef-option="a"><input type="radio" name="retry">36</label><label data-alef-option="b"><input type="radio" name="retry">42</label><button data-alef-submit>Submit answer</button></section>';document.querySelector('[data-alef-submit]').onclick=()=>{const selected=document.querySelector('input:checked')?.parentElement.dataset.alefOption;window.retryState.submitted.push(selected);if(selected==='b'){main.innerHTML='<section data-alef-completed>Lesson completed</section>';return;}const retry=document.createElement('button');retry.textContent='Try again';retry.onclick=()=>{window.retryState.retryClicks++;question();};main.firstElementChild.append(retry);};};
  main.innerHTML='<button data-alef-subject="math">الرياضيات</button>';main.firstElementChild.onclick=question;
 });
 let calls=0;const worker=await runCourse(h,(_url,options)=>{const body=JSON.parse(options.body);calls++;if(calls===2)assert.ok(body.question.text.includes('previous answers'));return Promise.resolve(Response.json({answer:{optionIds:[calls===1?'a':'b'],text:calls===1?'36':'42',explanation:'مزود اختبار',confidence:.99},verified:true,needsReview:false}));});
 await waitFor(()=>complete(worker),()=>JSON.stringify(worker.events));const actual=await h.page.evaluate(()=>window.retryState);assert.deepEqual(actual.submitted,['a','b']);assert.equal(actual.retryClicks,1);assert.equal(calls,2);
});

for(const scenario of ['normal','empty-home']){
  test(`classic hash-route coursework opens assigned lessons, includes overdue work and expands lazy pages (${scenario})`,async t=>{
    const h=await harness(t,scenario,'classic');let calls=0;
    const worker=await runCourse(h,(url,options)=>{calls++;return provider(url,options);});
    await waitFor(()=>complete(worker),()=>JSON.stringify(worker.events));
    const state=(await worker.send({type:'GET_STATE'})).state;
    const actual=await h.page.evaluate(()=>window.classicFixture.state);
    assert.deepEqual(actual.completed,['polynomials','dilations','arabic']);
    assert.deepEqual(actual.actions.filter(item=>item.kind==='lesson').map(item=>[item.id,item.target]),[
      ['polynomials','button'],['dilations','button'],['arabic','button'],
    ],'Only the child Start/Continue controls for unfinished work should be clicked');
    assert.equal(calls,3);assert.equal(actual.submissions.length,3);
    assert.ok(actual.submissions.every(item=>item.selected==='b'));
    assert.ok(actual.actions.some(item=>item.kind==='tab'&&item.tab==='assigned'));
    assert.ok(actual.actions.some(item=>item.kind==='filter'&&item.filter==='all'),'ALL must include overdue tasks that TODO omits');
    assert.ok(actual.actions.filter(item=>item.kind==='expand'&&item.tab==='assigned').length>=2);
    assert.equal(actual.actions.filter(item=>item.kind==='instruction').length,9);
    assert.equal(actual.actions.filter(item=>item.kind==='instruction'&&item.label==='سأحاول لاحقًا').length,3);
    assert.equal(state.stats.lessonsCompleted,3);assert.equal(state.stats.lessonsTotal,3);
    assert.equal(state.queue.filter(item=>item.status==='alreadycompleted').length,1);
    assert.match(state.catalogURL,/#\/classes\/test-class\?tab=assigned$/);
  });
}

test('classic responsive duplicates retain one lesson identity before and after a rescan',async t=>{
  const h=await harness(t,'duplicates','classic');
  await h.page.evaluate(()=>window.classicFixture.showAssigned());
  const first=await h.send({type:'ALEF_SCAN'});
  const second=await h.send({type:'ALEF_INSPECT'});
  assert.equal(first.stage,'lessons');
  assert.equal(first.lessons.length,4,JSON.stringify(first.lessons));
  assert.equal(first.lessons.filter(item=>item.name==='2. Adding and Subtracting Polynomials').length,1);
  assert.deepEqual(second.lessons,first.lessons);
  const done=first.lessons.find(item=>item.name.includes('مكتمل سابقًا'));
  assert.ok(done?.completed,'The real Review action indicates previously completed work');
  const result=await h.send({type:'ALEF_OPEN_LESSON',lessonId:done.id,fingerprint:second.fingerprint});
  assert.equal(result.ok,false);
  assert.deepEqual((await h.page.evaluate(()=>window.classicFixture.state)).actions,[]);
});

test('classic all-lessons cards preserve source lock and review states without opening unavailable content',async t=>{
  const h=await harness(t,'normal','classic');
  await h.page.evaluate(()=>window.classicFixture.showAllLessons());
  const snapshot=await h.send({type:'ALEF_SCAN'});
  assert.equal(snapshot.stage,'lessons');assert.equal(snapshot.lessons.length,3,JSON.stringify(snapshot));
  const locked=snapshot.lessons.find(item=>item.name.includes('لم يُنشر'));
  const done=snapshot.lessons.find(item=>item.name.includes('مكتمل سابقًا'));
  const open=snapshot.lessons.find(item=>item.name.includes('Polynomials'));
  assert.ok(locked?.locked,'The public all-lessons card lock-icon prevents opening');
  assert.ok(done?.completed,'A visible Review action is completed, not pending');
  for(const lesson of [locked,done])assert.equal((await h.send({type:'ALEF_OPEN_LESSON',lessonId:lesson.id})).ok,false);
  assert.deepEqual((await h.page.evaluate(()=>window.classicFixture.state)).actions,[]);
  assert.equal((await h.send({type:'ALEF_OPEN_LESSON',lessonId:open.id})).ok,true);
  assert.deepEqual((await h.page.evaluate(()=>window.classicFixture.state)).actions,[{kind:'lesson',id:'polynomials',target:'allLessonsCard'}]);
});

test('generic Start and Continue outside a recognized hash-route lesson are never catalog or player actions',async t=>{
  const h=await harness(t,'normal','classic');
  await h.page.evaluate(()=>window.classicFixture.showUnknown());
  const snapshot=await h.send({type:'ALEF_SCAN'});
  assert.equal(snapshot.stage,'unknown');assert.deepEqual(snapshot.subjects,[]);assert.deepEqual(snapshot.lessons,[]);
  assert.equal(snapshot.navigation.some(item=>['next','catalog','expand','assessment','skip'].includes(item.kind)),false);
  assert.deepEqual((await h.page.evaluate(()=>window.classicFixture.state)).actions,[]);
});

test('classic NCLE workflow skips only accessible teaching sections and finishes after component results',async t=>{
  const h=await harness(t,'ncle','classic');
  const worker=await runCourse(h);
  await waitFor(()=>complete(worker),()=>JSON.stringify(worker.events));
  const actual=await h.page.evaluate(()=>window.classicFixture.state);
  assert.deepEqual(actual.completed,['polynomials','dilations','arabic']);
  assert.equal(actual.submissions.length,3);
  assert.equal(actual.actions.filter(item=>item.kind==='sectionResult').length,3);
  assert.equal(actual.actions.filter(item=>item.kind==='finish').length,3,'An assessment section result must not prematurely finish its lesson');
  assert.deepEqual(actual.actions.filter(item=>item.kind==='instruction').map(item=>item.step),[
    'component','confirmSkip','component','confirmSkip','component','confirmSkip',
  ]);
  assert.equal(actual.actions.some(item=>item.kind==='unexpected'),false,'Current, locked and already selected assessment components must remain untouched');
  assert.equal((await worker.send({type:'GET_STATE'})).state.stats.lessonsCompleted,3);
});

test('NCLE navigation recognizes named component next, div skip confirmation and lockscreen restrictions',async t=>{
  const h=await harness(t);
  await h.page.evaluate(()=>{
    history.replaceState(null,'','#/progress/lesson-activity');
    document.querySelector('main').innerHTML='<section data-testid="ncle-activity-page"><nav data-testid="ncle-main-contents"><button data-testid="ncle-component-item" aria-current="step" class="text-subject-color-160"><span dir="ltr">Learn</span></button><button data-testid="ncle-component-item" class="text-primary-60"><span dir="ltr">Exit Ticket</span></button><button data-testid="ncle-component-item" class="text-primary-100"><span dir="ltr">Check My Understanding</span></button></nav><button data-testid="activity-navigation-bar__next-button">Go to Vocabulary</button><div data-testid="skip-content-modal-leave-button">مغادرة</div><button data-testid="ncle-sidebar-back">المادة</button></section>';
  });
  let snapshot=await h.send({type:'ALEF_SCAN'});
  assert.equal(snapshot.stage,'instruction');
  assert.equal(snapshot.navigation.filter(item=>item.kind==='assessment').length,1);
  assert.equal(snapshot.navigation.find(item=>item.kind==='assessment')?.label,'Check My Understanding');
  assert.equal(snapshot.navigation.some(item=>item.kind==='assessment'&&item.label==='Exit Ticket'),false);
  assert.equal(snapshot.navigation.find(item=>item.id==='activity-navigation-bar__next-button')?.kind,'next');
  assert.equal(snapshot.navigation.find(item=>item.id==='skip-content-modal-leave-button')?.kind,'skip');
  await h.page.evaluate(()=>{
    const locked=document.createElement('div');locked.dataset.testid='ncle-lock-screen';locked.textContent='هذا المحتوى غير متاح';document.querySelector('main').append(locked);
  });
  snapshot=await h.send({type:'ALEF_INSPECT'});
  assert.ok(snapshot.navigation.length>0);
  assert.ok(snapshot.navigation.every(item=>item.kind==='back'),'A lockscreen must never expose next/skip/assessment actions');
});

test('final regression: expired login on a stale classic class route exposes no subject or navigation',async t=>{
  const h=await harness(t,'normal','classic');
  await h.page.evaluate(()=>{
    history.replaceState(null,'','#/classes/test-class?tab=assigned');
    document.querySelector('main').innerHTML='<form><h1>تسجيل الدخول</h1><input type="password" aria-label="كلمة المرور"><button>دخول</button></form><button data-testid="core-coursework-assigned-tab-select">المهام المسندة</button>';
  });
  const snapshot=await h.send({type:'ALEF_SCAN'});
  assert.equal(snapshot.stage,'unknown');
  assert.deepEqual(snapshot.subjects,[]);assert.deepEqual(snapshot.lessons,[]);assert.deepEqual(snapshot.navigation,[]);
  assert.ok(snapshot.diagnostics.some(item=>item.includes('تسجيل الدخول')));
});

test('final regression: a Learn teaching question skips only to an available assessment and never overrides Arabic current or locked states',async t=>{
  const h=await harness(t);
  await h.page.evaluate(()=>{
    history.replaceState(null,'','#/progress/ncle/class/test-class/activity/test-activity');
    document.querySelector('main').innerHTML='<section data-testid="ncle-activity-page"><nav data-testid="ncle-main-contents"><button id="learn" data-testid="ncle-component-item" aria-current="step" class="text-primary-100"><span dir="ltr">Learn</span></button><button id="locked" data-testid="ncle-component-item" class="text-primary-60"><span dir="ltr">اختبر فهمك</span></button><button id="available" data-testid="ncle-component-item" class="text-primary-100"><span dir="ltr">تحقق من فهمك</span></button></nav><article data-testid="ncle-activity-page-player"><section data-alef-question="teaching-question"><h2>ما ناتج 6 × 7؟</h2><label data-alef-option="a"><input type="radio" name="q">36</label><label data-alef-option="b"><input type="radio" name="q">42</label><button>إرسال الإجابة</button></section></article></section>';
  });
  let snapshot=await h.send({type:'ALEF_SCAN'});
  assert.equal(snapshot.stage,'instruction','A supported teaching question must not block the available skip to the main assessment');
  assert.deepEqual(snapshot.navigation.filter(item=>item.kind==='assessment').map(item=>item.id),['available']);
  await h.page.evaluate(()=>{
    document.querySelector('#learn').removeAttribute('aria-current');document.querySelector('#available').setAttribute('aria-current','step');
  });
  snapshot=await h.send({type:'ALEF_INSPECT'});
  assert.equal(snapshot.stage,'question','Once the assessment is selected, solve it instead of navigating away');
  assert.equal(snapshot.navigation.some(item=>item.kind==='assessment'),false,'The current Arabic title and locked exact-label match must not fall through generic assessment recognition');
  await h.page.evaluate(()=>{
    document.querySelector('#available').removeAttribute('aria-current');document.querySelector('#available').className='text-primary-60';document.querySelector('#learn').setAttribute('aria-current','step');
  });
  snapshot=await h.send({type:'ALEF_INSPECT'});
  assert.equal(snapshot.stage,'question');assert.equal(snapshot.navigation.some(item=>item.kind==='assessment'),false);
});

test('final regression: changing classic class during a pending model response stops before any answer or next lesson',async t=>{
  const h=await harness(t,'normal','classic');let requested=false;let release;
  const worker=await runCourse(h,(url,options)=>{
    requested=true;return new Promise(resolve=>{release=()=>resolve(provider(url,options));});
  });
  await waitFor(()=>requested,'The selected class must reach a pending model request');
  const opened=(await h.page.evaluate(()=>window.classicFixture.state)).actions.filter(item=>item.kind==='lesson');
  assert.equal(opened.length,1);
  await h.page.evaluate(()=>history.replaceState(null,'','#/classes/other-class?tab=assigned'));
  release();
  await waitFor(()=>worker.events.some(item=>item.event?.kind==='error'),()=>JSON.stringify(worker.events));
  const actual=await h.page.evaluate(()=>window.classicFixture.state);
  assert.deepEqual(actual.submissions,[]);assert.deepEqual(actual.completed,[]);
  assert.deepEqual(actual.actions.filter(item=>item.kind==='lesson'),opened);
  const state=(await worker.send({type:'GET_STATE'})).state;
  assert.equal(state.running,false);assert.equal(state.stats.solved,0);
  assert.match(worker.events.findLast(item=>item.event?.kind==='error').event.message,/مادة أخرى|تغيرت المادة/);
});

test('final regression: starting on All Lessons still chooses Assigned ALL and includes overdue tasks',async t=>{
  const h=await harness(t,'normal','classic');
  await h.page.evaluate(()=>window.classicFixture.showAllLessons());
  const worker=await bridge(h,provider);
  const connection=await worker.send({type:'CONNECT'});
  assert.equal(connection.ok,true,JSON.stringify(connection));assert.ok(connection.subjects.length);
  const start=await worker.send({type:'START',subjectId:connection.subjects[0].id,config:config()});
  assert.equal(start.ok,true,JSON.stringify(start));
  await waitFor(()=>complete(worker),()=>JSON.stringify(worker.events));
  const actual=await h.page.evaluate(()=>window.classicFixture.state);
  assert.deepEqual(actual.completed,['polynomials','dilations','arabic']);
  assert.ok(actual.actions.some(item=>item.kind==='tab'&&item.tab==='assigned'));
  assert.ok(actual.actions.some(item=>item.kind==='filter'&&item.filter==='all'));
  assert.equal(actual.actions.some(item=>item.kind==='lesson'&&item.target==='allLessonsCard'),false,'All Lessons can be restricted to the current term; it must not become the incomplete homework queue');
  assert.equal((await worker.send({type:'GET_STATE'})).state.stats.lessonsCompleted,3);
});
