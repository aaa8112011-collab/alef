import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const root = new URL('../',import.meta.url);

// Explicit UI-only Chrome API stub. Native unpacked MV3 loading is blocked by
// this cloud image's managed ExtensionInstallBlocklist; this harness does not
// change that policy or claim to exercise Chrome's native permission prompt.
async function dashboardHarness({connected=false}={}) {
  const resources = new Map(await Promise.all(['dashboard.html','dashboard.css','dashboard.js'].map(async name=>[name,await readFile(new URL(`extension/${name}`,root))])));
  const server=createServer((request,response)=>{
    const name=new URL(request.url,'http://127.0.0.1').pathname.slice(1);
    if(!resources.has(name)){response.writeHead(404);response.end();return;}
    response.writeHead(200,{'Content-Type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html; charset=utf-8',
      'Content-Security-Policy':"script-src 'self'; object-src 'none'; base-uri 'none';"});
    response.end(resources.get(name));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  let browser;
  try {
    browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH||existsSync('/usr/bin/chromium')?{executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'}:{}),args:['--no-sandbox','--disable-dev-shm-usage']});
    const page=await browser.newPage({locale:'ar-AE',viewport:{width:1440,height:1100}});
    page.setDefaultTimeout(7000);
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',entry=>{if(entry.type()==='error'&&/content security policy|refused to/i.test(entry.text()))errors.push(entry.text());});
    await page.addInitScript(({connected})=>{
      const state={running:false,status:'idle',page:connected?{title:'صفحة اختبار محلية — الرياضيات',url:'http://127.0.0.1/fixture'}:null,
        subjects:connected?[{id:'math',name:'الرياضيات'},{id:'science',name:'العلوم'},{id:'arabic',name:'اللغة العربية'}]:[],
        subjectId:null,stats:{solved:0,review:0,total:0},events:[],lastEvent:null};
      const listeners=[];
      const local={},session={alefPairingToken:'ui-test-pairing-token-not-a-real-secret'};
      globalThis.__uiTest={state,local,session,messages:[],permissions:[],listeners,
        emit(event){listeners.forEach(listener=>listener({type:'RUN_EVENT',tabId:1,event}));}};
      const storage=store=>({async get(key){return {[key]:store[key]};},async set(value){Object.assign(store,value);}});
      globalThis.chrome={runtime:{id:'ui-test-extension',onMessage:{addListener(listener){listeners.push(listener);}},
        async sendMessage(message){
          globalThis.__uiTest.messages.push(structuredClone(message));
          if(message.type==='GET_STATE')return {ok:true,state:structuredClone(state)};
          if(message.type==='START'){
            state.running=true;state.status='running';state.subjectId=message.subjectId;
            return {ok:true,state:structuredClone(state)};
          }
          if(message.type==='STOP'){
            state.running=false;state.status='stopped';
            globalThis.__uiTest.emit({kind:'stopped',message:'تم إيقاف الحل.',stats:state.stats,timestamp:Date.now()});
            return {ok:true,state:structuredClone(state)};
          }
          return {ok:true,page:state.page,subjects:state.subjects,state:structuredClone(state)};
        }},
        storage:{local:storage(local),session:storage(session)},
        permissions:{async request(value){globalThis.__uiTest.permissions.push(value);return true;}},
        tabs:{async get(){return {id:1,url:'https://moe.alefed.com/'};},async query(){return [{id:1,url:'https://moe.alefed.com/'}];},async create(){return {id:1};}},
      };
    },{connected});
    await page.goto(`http://127.0.0.1:${server.address().port}/dashboard.html?tabId=1`);
    await page.waitForFunction(()=>globalThis.__uiTest.listeners.length>0);
    return {page,errors,async close(){await browser.close();await new Promise(resolve=>server.close(resolve));}};
  }catch(error){await browser?.close();await new Promise(resolve=>server.close(resolve));throw error;}
}

async function capture(page,name) {
  if(process.env.CAPTURE_DASHBOARD!=='1')return;
  await mkdir(new URL('docs/',root),{recursive:true});
  await page.evaluate(()=>{
    const label=document.createElement('div');label.textContent='لقطة اختبار الواجهة — بيانات محلية تجريبية';
    Object.assign(label.style,{position:'fixed',bottom:'12px',left:'12px',background:'#182c49',color:'#fff',padding:'7px 12px',borderRadius:'8px',font:'12px system-ui',zIndex:9999});
    document.body.append(label);
  });
  await page.screenshot({path:new URL(`docs/${name}.png`,root).pathname,fullPage:true});
}

test('Arabic dashboard renders under extension CSP and saves pairing token only in session storage',async()=>{
  const harness=await dashboardHarness();
  try{
    const {page}=harness;
    assert.equal(await page.locator('html').getAttribute('dir'),'rtl');
    assert.equal(await page.locator('#start').isDisabled(),true);
    assert.equal(await page.locator('#stop').isDisabled(),true);
    assert.equal(await page.locator('#subjects button').count(),0);
    assert.ok((await page.locator('.page-footer').textContent()).includes('محليًا افتراضيًا'));
    assert.ok((await page.locator('.run-options').textContent()).includes('وقتًا إضافيًا'));
    assert.equal((await page.locator('.run-options').textContent()).includes('التكلفة'),false);
    await capture(page,'dashboard');
    await page.locator('.settings-trigger').first().click();
    assert.equal(await page.locator('#settings-dialog').evaluate(el=>el.open),true);
    const help=await page.locator('.settings-help').textContent();
    assert.ok(help.includes('START-WINDOWS.cmd'));
    assert.ok(help.includes('Ollama'));
    assert.ok(help.includes('دون مفتاح API'));
    assert.equal(help.includes('SOLVER_API_KEY'),false);
    assert.ok((await page.locator('label').filter({has:page.locator('#pairing-token')}).textContent()).includes('رمز الربط المحلي'));
    await page.locator('#server-url').fill('https://external.example.com');
    await page.locator('#settings-form button[type="submit"]').click();
    assert.equal(await page.locator('#settings-error').isVisible(),true);
    assert.equal(await page.locator('#settings-dialog').evaluate(el=>el.open),true);
    await page.locator('#server-url').fill('http://127.0.0.1:4318');
    await page.locator('#pairing-token').fill('another-local-ui-test-token');
    await page.locator('.advanced summary').click();
    await page.locator('[data-selector="question"]').fill('[data-alef-question]');
    await page.locator('#settings-form button[type="submit"]').click();
    assert.equal(await page.locator('#settings-dialog').evaluate(el=>el.open),false);
    const stored=await page.evaluate(()=>({local:__uiTest.local,session:__uiTest.session}));
    assert.equal(stored.session.alefPairingToken,'another-local-ui-test-token');
    assert.equal(JSON.stringify(stored.local).includes('another-local-ui-test-token'),false);
    assert.equal(stored.local.alefConfig.selectors.question,'[data-alef-question]');
    assert.deepEqual(harness.errors,[]);
  }finally{await harness.close();}
});

test('dashboard subject choice, start/stop, event rendering and permission request use the documented runtime contract',async()=>{
  const harness=await dashboardHarness({connected:true});
  try{
    const {page}=harness;
    assert.equal(await page.locator('#subjects button').count(),3);
    assert.equal(await page.locator('#start').isDisabled(),true);
    await page.locator('#subjects button').first().click();
    assert.equal(await page.locator('#start').isEnabled(),true);
    await capture(page,'dashboard-fixture');
    await page.locator('#start').click();
    await page.waitForFunction(()=>__uiTest.messages.some(message=>message.type==='START'));
    assert.equal(await page.locator('#stop').isEnabled(),true);
    assert.equal(await page.locator('#start').isDisabled(),true);
    assert.equal(await page.locator('#connect').isDisabled(),true);
    const start=await page.evaluate(()=>__uiTest.messages.find(message=>message.type==='START'));
    assert.equal(start.subjectId,'math');assert.equal(start.config.verify,true);assert.equal(start.config.autoSubmit,true);
    await page.evaluate(()=>__uiTest.emit({kind:'answer',message:'وصلت إجابة تجريبية.',timestamp:Date.now(),stats:{solved:1,review:0,total:1},
      question:{text:'ما ناتج 6 × 7؟',options:[{id:'b',text:'42'}]},answer:{optionIds:['b'],text:'42',explanation:'6 × 7 = 42',confidence:.97}}));
    assert.equal(await page.locator('#question-text').textContent(),'ما ناتج 6 × 7؟');
    assert.equal(await page.locator('#answer-text').textContent(),'42');
    assert.equal(await page.locator('#solved-count').textContent(),'1');
    await page.evaluate(()=>__uiTest.emit({kind:'status',message:'<img src=x onerror="alert(1)">',timestamp:Date.now()}));
    assert.equal(await page.locator('#event-log img').count(),0);
    assert.ok((await page.locator('#event-log').textContent()).includes('<img src=x'));
    await page.locator('#stop').click();
    await page.waitForFunction(()=>__uiTest.messages.some(message=>message.type==='STOP'));
    assert.equal(await page.locator('#stop').isDisabled(),true);
    assert.equal(await page.locator('#start').isEnabled(),true);
    await page.locator('#connect').click();
    await page.waitForFunction(()=>__uiTest.permissions.length===1);
    assert.deepEqual(await page.evaluate(()=>__uiTest.permissions[0]),{origins:['https://moe.alefed.com/*']});
    assert.deepEqual(harness.errors,[]);
  }finally{await harness.close();}
});

test('server check shows local model readiness without paid credentials and precise missing-runtime/model messages',async()=>{
  const harness=await dashboardHarness();
  try{
    const {page}=harness;
    let health={ok:true,configured:true,provider:'ollama',model:'qwen3:8b',modelReady:true};
    let requests=0;
    await page.route('http://127.0.0.1:4318/api/health',async route=>{
      requests++;
      assert.equal(route.request().headers().authorization,undefined);
      await route.fulfill({status:200,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify(health)});
    });
    await page.locator('.settings-trigger').first().click();
    await page.locator('#check-server').click();
    await page.waitForFunction(()=>document.querySelector('#server-status').textContent.includes('qwen3:8b'));
    assert.ok((await page.locator('#server-status').textContent()).includes('متصل محليًا'));
    assert.ok((await page.locator('#server-status').textContent()).includes('دون مفتاح API'));
    health={ok:true,configured:false,provider:'ollama',model:'qwen3:8b',modelReady:false,issue:'model_missing',message:'النموذج qwen3:8b غير موجود. حمّله باستخدام ollama pull qwen3:8b.'};
    await page.locator('#check-server').click();
    await page.waitForFunction(()=>document.querySelector('#server-status').textContent.includes('غير موجود'));
    assert.equal(await page.locator('#server-status').textContent(),health.message);
    health={ok:true,configured:false,provider:'ollama',model:'qwen3:8b',modelReady:false,issue:'runtime_unavailable',message:'تعذر الاتصال بـ Ollama. افتح Ollama ثم أعد الفحص.'};
    await page.locator('#check-server').click();
    await page.waitForFunction(()=>document.querySelector('#server-status').textContent.includes('افتح Ollama'));
    assert.equal(await page.locator('#server-status').textContent(),health.message);
    assert.equal((await page.locator('#server-status').textContent()).includes('SOLVER_API_KEY'),false);
    assert.equal(requests,3);
    assert.deepEqual(harness.errors,[]);
  }finally{await harness.close();}
});

test('course queue and nonblocking lesson review retain automatic run controls',async()=>{
 const harness=await dashboardHarness({connected:true});
 try{
  const {page}=harness;await page.locator('#subjects button').first().click();await page.locator('#start').click();
  await page.evaluate(()=>__uiTest.emit({kind:'queue',message:'فحص الدروس',stats:{solved:0,review:0,total:0,lessonsTotal:2,lessonsCompleted:0,lessonsReview:0},queue:[{id:'one',name:'القراءة',status:'running'},{id:'two',name:'القواعد',status:'pending'},{id:'locked',name:'درس مقفل',status:'locked'}],currentLesson:{name:'القراءة'},timestamp:Date.now()}));
  assert.equal(await page.locator('#course-progress').isVisible(),true);assert.equal(await page.locator('#lesson-queue li').count(),3);assert.equal(await page.locator('#lesson-count').textContent(),'0 / 2');await capture(page,'dashboard-course');
  await page.evaluate(()=>__uiTest.emit({kind:'review',blocking:false,message:'درس يحتاج مراجعة؛ متابعة التالي',stats:{solved:0,review:1,total:1,lessonsTotal:2,lessonsCompleted:0,lessonsReview:1},queue:[{id:'one',name:'القراءة',status:'review'},{id:'two',name:'القواعد',status:'running'}],timestamp:Date.now()}));
  assert.equal(await page.locator('#stop').isEnabled(),true);assert.equal(await page.locator('#start').isDisabled(),true);assert.equal(await page.locator('#skip-instruction').isDisabled(),true);
  assert.deepEqual(harness.errors,[]);
 }finally{await harness.close();}
});
