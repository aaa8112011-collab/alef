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
async function dashboardHarness({connected=false,savedConfig=null,savedToken,sessionToken='ui-test-pairing-token-not-a-real-secret',failTokenWrites=false,initialEventRace=false,initialTerminalRace=false}={}) {
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
    const context=await browser.newContext({locale:'ar-AE',viewport:{width:1440,height:1100}});
    const errors=[];
    const stores={local:{...(savedConfig?{alefConfig:savedConfig}:{}),...(savedToken===undefined?{}:{alefPairingToken:savedToken})},
      session:sessionToken==null?{}:{alefPairingToken:sessionToken}};
    await context.exposeFunction('__readUIStorage',(area,keys)=>{
      const store=stores[area];const result={};
      for(const key of Array.isArray(keys)?keys:[keys])if(Object.hasOwn(store,key))result[key]=store[key];
      return structuredClone(result);
    });
    await context.exposeFunction('__writeUIStorage',(area,value)=>{
      if(failTokenWrites&&area==='local'&&Object.hasOwn(value,'alefPairingToken'))throw new Error('Storage unavailable');
      Object.assign(stores[area],structuredClone(value));
    });
    await context.exposeFunction('__removeUIStorage',(area,key)=>{delete stores[area][key];});
    await context.addInitScript(({connected,initialEventRace,initialTerminalRace})=>{
      const state={running:false,status:'idle',page:connected?{title:'صفحة اختبار محلية — الرياضيات',url:'http://127.0.0.1/fixture'}:null,
        subjects:connected?[{id:'math',name:'الرياضيات'},{id:'science',name:'العلوم'},{id:'arabic',name:'اللغة العربية'}]:[],
        subjectId:null,stats:{solved:0,review:0,total:0},events:[],lastEvent:null};
      const listeners=[];
      const local={},session={};
      globalThis.__uiTest={state,local,session,messages:[],permissions:[],listeners,storageAccess:[],
        emit(event){listeners.forEach(listener=>listener({type:'RUN_EVENT',tabId:1,event}));}};
      const storage=(area,store)=>({
        async get(keys){const result=await __readUIStorage(area,keys);Object.assign(store,result);return result;},
        async set(value){await __writeUIStorage(area,value);Object.assign(store,value);},
        async remove(key){await __removeUIStorage(area,key);delete store[key];},
        async setAccessLevel(value){__uiTest.storageAccess.push({area,...value});},
      });
      globalThis.chrome={runtime:{id:'ui-test-extension',onMessage:{addListener(listener){listeners.push(listener);}},
        async sendMessage(message){
          globalThis.__uiTest.messages.push(structuredClone(message));
          if(message.type==='GET_STATE'){
            const snapshot=structuredClone(state);
            if(initialTerminalRace){
              const timestamp=Date.now();
              const question={kind:'question',sequence:10,running:true,status:'running',message:'جارٍ حل السؤال السابق.',question:{id:'older-question',text:'السؤال السابق'},timestamp};
              const terminal={kind:'review',sequence:11,running:false,status:'review',blocking:true,cause:'frame_permission_required',message:'توقف الدرس لانتظار السماح بمحتواه.',blockedFrames:[{origin:'https://learn.alefed.com'}],timestamp};
              // The old progress broadcast is delivered while GET_STATE is
              // preparing a snapshot that already contains its later halt.
              globalThis.__uiTest.emit(question);
              Object.assign(state,{running:false,status:'review',eventSequence:11,subjectId:'arabic',blockedFrames:terminal.blockedFrames,events:[question,terminal],lastEvent:terminal});
              return {ok:true,state:structuredClone(state)};
            }
            if(initialEventRace){snapshot.eventSequence=4;state.running=true;state.status='running';state.subjectId='math';state.eventSequence=5;globalThis.__uiTest.emit({kind:'status',sequence:5,running:true,status:'running',message:'جارٍ متابعة الدرس من نافذة أخرى.',timestamp:Date.now()});}
            return {ok:true,state:snapshot};
          }
          if(message.type==='START'||message.type==='RESUME_FRAMES'){
            state.running=true;state.status='running';state.subjectId=message.subjectId;state.blockedFrames=[];
            return {ok:true,state:structuredClone(state)};
          }
          if(message.type==='STOP'){
            state.running=false;state.status='stopped';
            globalThis.__uiTest.emit({kind:'stopped',message:'تم إيقاف الحل.',stats:state.stats,timestamp:Date.now()});
            return {ok:true,state:structuredClone(state)};
          }
          return {ok:true,page:state.page,subjects:state.subjects,state:structuredClone(state)};
        }},
        storage:{local:storage('local',local),session:storage('session',session)},
        permissions:{async request(value){globalThis.__uiTest.permissions.push(value);return true;}},
        tabs:{async get(){return {id:1,url:'https://moe.alefed.com/'};},async query(){return [{id:1,url:'https://moe.alefed.com/'}];},async create(){return {id:1};}},
      };
    },{connected,initialEventRace,initialTerminalRace});
    const openPage=async()=>{
      const page=await context.newPage();page.setDefaultTimeout(7000);
      page.on('pageerror',error=>errors.push(error.message));
      page.on('console',entry=>{if(entry.type()==='error'&&/content security policy|refused to/i.test(entry.text()))errors.push(entry.text());});
      await page.goto(`http://127.0.0.1:${server.address().port}/dashboard.html?tabId=1`);
      await page.waitForFunction(()=>globalThis.__uiTest.listeners.length>0);
      return page;
    };
    const page=await openPage();
    return {page,errors,stores,async reopen({clearSession=false}={}){
      await this.page.close();if(clearSession)stores.session={};this.page=await openPage();return this.page;
    },async close(){await browser.close();await new Promise(resolve=>server.close(resolve));}};
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

test('Arabic dashboard renders under extension CSP and saves pairing token separately in trusted local storage',async()=>{
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
    assert.equal(stored.session.alefPairingToken,undefined);
    assert.equal(stored.local.alefPairingToken,'another-local-ui-test-token');
    assert.equal(JSON.stringify(stored.local.alefConfig).includes('another-local-ui-test-token'),false);
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
    assert.equal(await page.locator('#verify').isChecked(),true);
    assert.ok((await page.locator('#solve-mode').textContent()).includes('حلّان مستقلان'));
    await page.locator('label').filter({has:page.locator('#verify')}).click();
    assert.ok((await page.locator('#solve-mode').textContent()).includes('الوضع السريع'));
    await page.locator('label').filter({has:page.locator('#verify')}).click();
    assert.ok((await page.locator('#solve-mode').textContent()).includes('حلّان مستقلان'));
    await page.locator('#start').click();
    await page.waitForFunction(()=>__uiTest.messages.some(message=>message.type==='START'));
    assert.equal(await page.locator('#stop').isEnabled(),true);
    assert.equal(await page.locator('#start').isDisabled(),true);
    assert.equal(await page.locator('#connect').isDisabled(),true);
    const start=await page.evaluate(()=>__uiTest.messages.find(message=>message.type==='START'));
    assert.equal(start.subjectId,'math');assert.equal(start.config.verify,true);assert.equal(start.config.qualityMode,true);assert.equal(start.config.autoSubmit,true);
    await page.waitForFunction(()=>__uiTest.local.alefConfig?.verify===true);
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
    assert.deepEqual(await page.evaluate(()=>__uiTest.permissions[0]),{origins:['https://moe.alefed.com/*','https://content.alefed.com/*']});
    assert.deepEqual(harness.errors,[]);
  }finally{await harness.close();}
});

test('a late START response never overwrites an already received terminal event or erases its reason',async()=>{
  const h=await dashboardHarness({connected:true});
  try{
    const {page}=h;
    await page.locator('#subjects button').first().click();
    await page.evaluate(()=>{
      const original=chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage=message=>{
        if(message.type!=='START')return original(message);
        __uiTest.messages.push(structuredClone(message));
        const stale={...structuredClone(__uiTest.state),running:true,status:'running',subjectId:'math'};
        return new Promise(resolve=>{__uiTest.releaseStart=()=>resolve({ok:true,state:stale});});
      };
    });
    await page.locator('#start').click();
    await page.waitForFunction(()=>typeof __uiTest.releaseStart==='function');
    assert.equal(await page.locator('#start-label').textContent(),'جارٍ البدء…');
    await page.evaluate(()=>__uiTest.emit({kind:'review',blocking:true,message:'توقف الدرس لأن محتواه داخل إطار غير مقروء.',stats:{solved:0,review:1,total:0},timestamp:Date.now()}));
    await page.evaluate(()=>__uiTest.releaseStart());
    await page.waitForFunction(()=>!document.querySelector('#start').disabled);
    assert.equal(await page.locator('#start-label').textContent(),'ابدأ الحل');
    assert.equal(await page.locator('#stop').isDisabled(),true);
    assert.equal(await page.locator('#run-status').textContent(),'تحتاج مراجعتك');
    assert.match(await page.locator('#run-phase').textContent(),/إطار غير مقروء/);
    assert.match(await page.locator('#notice').textContent(),/إطار غير مقروء/);
    assert.equal(await page.locator('#event-log li').count(),1,'The actual review event cannot be cleared by the stale START snapshot');
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

test('a terminal state returned directly by START keeps the controls stopped',async()=>{
  const h=await dashboardHarness({connected:true});
  try{
    const {page}=h;await page.locator('#subjects button').first().click();
    await page.evaluate(()=>{
      const original=chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage=async message=>{
        if(message.type!=='START')return original(message);
        const event={kind:'error',message:'تعذر فتح محتوى الدرس.',timestamp:Date.now()};
        return {ok:true,state:{...structuredClone(__uiTest.state),running:false,status:'error',subjectId:'math',events:[event],lastEvent:event}};
      };
    });
    await page.locator('#start').click();
    await page.waitForFunction(()=>document.querySelector('#run-status').textContent==='تعذّر المتابعة');
    assert.equal(await page.locator('#start').isEnabled(),true);
    assert.equal(await page.locator('#stop').isDisabled(),true);
    assert.equal(await page.locator('#start-label').textContent(),'ابدأ الحل');
    assert.equal(await page.locator('#run-phase').textContent(),'تعذر فتح محتوى الدرس.');
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

test('progress from another dashboard marks this run active and shows the current phase instead of a disabled idle start label',async()=>{
  const h=await dashboardHarness({connected:true});
  try{
    const {page}=h;
    assert.equal(await page.locator('#stop').isDisabled(),true);
    await page.evaluate(()=>__uiTest.emit({kind:'status',message:'جارٍ قراءة محتوى الدرس المفتوح…',timestamp:Date.now()}));
    assert.equal(await page.locator('#start-label').textContent(),'جارٍ الحل…');
    assert.equal(await page.locator('#stop').isEnabled(),true);
    assert.equal(await page.locator('#run-status').textContent(),'جارٍ التنفيذ');
    assert.equal(await page.locator('#run-phase').textContent(),'جارٍ قراءة محتوى الدرس المفتوح…');
    await page.evaluate(()=>__uiTest.emit({kind:'question',message:'جارٍ حل السؤال العربي داخل الإطار…',question:{id:'frame-q',text:'أين تقع مدينة أبوظبي؟',options:[]},timestamp:Date.now()}));
    assert.equal(await page.locator('#run-status').textContent(),'حل السؤال');
    assert.match(await page.locator('#run-phase').textContent(),/السؤال العربي/);
    await page.evaluate(()=>__uiTest.emit({kind:'stopped',message:'تم إيقاف الحل.',timestamp:Date.now()}));
    assert.equal(await page.locator('#start-label').textContent(),'ابدأ الحل');
    assert.equal(await page.locator('#stop').isDisabled(),true);
    assert.equal(await page.locator('#run-status').textContent(),'متوقف');
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

test('an event delivered during initial state loading is not lost or overwritten by the older GET_STATE snapshot',async()=>{
  const h=await dashboardHarness({connected:true,initialEventRace:true});
  try{
    assert.equal(await h.page.locator('#stop').isEnabled(),true);
    assert.equal(await h.page.locator('#start-label').textContent(),'جارٍ الحل…');
    assert.equal(await h.page.locator('#run-phase').textContent(),'جارٍ متابعة الدرس من نافذة أخرى.');
    assert.equal(await h.page.locator('#subjects button').count(),3,'The initial page and subjects still restore while newer run events take priority');
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

test('initial buffered progress cannot revive a newer terminal snapshot even when both events share a timestamp',async()=>{
  const h=await dashboardHarness({connected:true,initialTerminalRace:true});
  try{
    const {page}=h;
    assert.equal(await page.locator('#start').isEnabled(),true);
    assert.equal(await page.locator('#start-label').textContent(),'ابدأ الحل');
    assert.equal(await page.locator('#stop').isDisabled(),true);
    assert.equal(await page.locator('#run-status').textContent(),'تحتاج مراجعتك');
    assert.equal(await page.locator('#run-phase').textContent(),'توقف الدرس لانتظار السماح بمحتواه.');
    assert.equal(await page.locator('#frame-permission-panel').isVisible(),true);
    assert.equal(await page.locator('#event-log li').count(),2,'The snapshot already contains the buffered question; do not replay it');
    assert.equal(await page.locator('#answer-state').getAttribute('data-state'),'review');
    // A delayed broadcast for that older state must not overwrite the halt.
    await page.evaluate(()=>__uiTest.emit({kind:'question',sequence:10,running:true,status:'running',message:'إعادة بث قديمة.',question:{id:'old',text:'سؤال قديم'},timestamp:Date.now()}));
    assert.equal(await page.locator('#run-status').textContent(),'تحتاج مراجعتك');
    assert.equal(await page.locator('#event-log li').count(),2);
    // A genuinely newer run still activates without reopening the dashboard.
    await page.evaluate(()=>__uiTest.emit({kind:'question',sequence:12,running:true,status:'running',message:'جارٍ حل السؤال الجديد.',blockedFrames:[],question:{id:'new',text:'السؤال الجديد'},timestamp:Date.now()}));
    assert.equal(await page.locator('#stop').isEnabled(),true);
    assert.equal(await page.locator('#start-label').textContent(),'جارٍ الحل…');
    assert.equal(await page.locator('#question-text').textContent(),'السؤال الجديد');
    assert.equal(await page.locator('#frame-permission-panel').isHidden(),true);
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

test('progress carrying explicit stopped worker state does not show a running session',async()=>{
  const h=await dashboardHarness({connected:true});
  try{
    const {page}=h;
    await page.evaluate(()=>__uiTest.emit({kind:'status',sequence:1,running:false,status:'stopped',message:'التشغيل متوقف بعد إلغاء القراءة.',timestamp:Date.now()}));
    assert.equal(await page.locator('#stop').isDisabled(),true);
    assert.equal(await page.locator('#start-label').textContent(),'ابدأ الحل');
    assert.equal(await page.locator('#run-status').textContent(),'متوقف');
    assert.equal(await page.locator('#run-phase').textContent(),'التشغيل متوقف بعد إلغاء القراءة.');
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

test('a resumed running snapshot does not present its previous terminal event as the current phase',async()=>{
  const h=await dashboardHarness({connected:true});
  try{
    const {page}=h;
    await page.evaluate(()=>{
      const previous={kind:'review',sequence:20,running:false,status:'review',message:'توقف قديم لانتظار السماح.',timestamp:Date.now()};
      restoreState({...structuredClone(__uiTest.state),running:true,status:'running',subjectId:'arabic',eventSequence:20,events:[previous],lastEvent:previous,blockedFrames:[]});
    });
    assert.equal(await page.locator('#stop').isEnabled(),true);
    assert.equal(await page.locator('#start-label').textContent(),'جارٍ الحل…');
    assert.equal(await page.locator('#run-phase').textContent(),'جارٍ متابعة الدرس…');
    assert.equal(await page.locator('#event-log li').count(),1,'Previous terminal details remain available as history');
    assert.match(await page.locator('#event-log').textContent(),/توقف قديم/);
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

test('observed Alef frame access is requested from an explicit click and resumes the same lesson without restarting its course',async()=>{
  const h=await dashboardHarness({connected:true});
  try{
    const {page}=h;
    await page.locator('#subjects button').filter({hasText:'اللغة العربية'}).click();
    await page.evaluate(()=>{
      const event={kind:'review',cause:'frame_permission_required',blocking:true,message:'يحتاج محتوى الدرس سماحًا إضافيًا.',
        blockedFrames:[{origin:'https://learn.alefed.com'},{origin:'https://content.alefed.com'},{origin:'https://learn.alefed.com'}],
        currentLesson:{id:'metaphor',name:'50. الاستعارة'},queue:[{id:'metaphor',name:'50. الاستعارة',status:'review'},{id:'next-lesson',name:'الدرس التالي',status:'pending'}],timestamp:Date.now()};
      Object.assign(__uiTest.state,{subjectId:'arabic',status:'review',currentLesson:event.currentLesson,queue:event.queue,blockedFrames:event.blockedFrames,events:[event],lastEvent:event});
      __uiTest.emit(event);
      // Permission requests must begin synchronously in the click handler,
      // before this pending token write can resolve.
      pendingPairingSave=new Promise(resolve=>{__uiTest.releasePairing=resolve;});
    });
    assert.equal(await page.locator('#frame-permission-panel').isVisible(),true);
    assert.equal(await page.locator('#grant-frame-access').textContent(),'السماح بمحتوى الدرس');
    assert.ok((await page.locator('#frame-origins').textContent()).includes('https://learn.alefed.com'));
    await page.locator('#grant-frame-access').click();
    assert.deepEqual(await page.evaluate(()=>__uiTest.permissions),[{origins:['https://learn.alefed.com/*','https://content.alefed.com/*']}]);
    assert.equal(await page.evaluate(()=>__uiTest.messages.some(message=>message.type==='RESUME_FRAMES')),false);
    await page.evaluate(()=>__uiTest.releasePairing());
    await page.waitForFunction(()=>__uiTest.messages.some(message=>message.type==='RESUME_FRAMES'));
    const resume=await page.evaluate(()=>__uiTest.messages.find(message=>message.type==='RESUME_FRAMES'));
    assert.equal(resume.subjectId,'arabic');
    assert.equal(resume.config.qualityMode,true);assert.equal(resume.config.verify,true);assert.equal(resume.config.minConfidence,.85);
    assert.equal(await page.evaluate(()=>__uiTest.messages.some(message=>message.type==='START')),false);
    assert.match(await page.locator('#current-lesson').textContent(),/الاستعارة/);
    assert.equal(await page.locator('#lesson-queue li').count(),2);
    assert.equal(await page.locator('#event-log li').count(),1,'Resuming preserves the prior lesson reason and activity history');
    assert.equal(await page.locator('#frame-permission-panel').isHidden(),true);
    assert.equal(await page.locator('#stop').isEnabled(),true);
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

test('denied frame permission keeps the recovery action available without resuming or navigating',async()=>{
  const h=await dashboardHarness({connected:true});
  try{
    const {page}=h;
    await page.evaluate(()=>{
      chrome.permissions.request=async value=>{__uiTest.permissions.push(value);return false;};
      __uiTest.emit({kind:'review',cause:'frame_permission_required',blocking:true,message:'يلزم السماح بمحتوى الدرس.',blockedFrames:[{origin:'https://learn.alefed.com'}],timestamp:Date.now()});
    });
    await page.locator('#grant-frame-access').click();
    await page.waitForFunction(()=>!document.querySelector('#grant-frame-access').disabled);
    assert.equal(await page.locator('#frame-permission-panel').isVisible(),true);
    assert.match(await page.locator('#notice').textContent(),/لم يُمنح السماح/);
    assert.equal(await page.evaluate(()=>__uiTest.messages.some(message=>['START','RESUME_FRAMES'].includes(message.type))),false);
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

test('frame recovery ignores foreign, non-HTTPS and non-origin targets and renders only exact observed Alef origins',async()=>{
  const h=await dashboardHarness({connected:true});
  try{
    const {page}=h;
    const unsafe=['https://evil.invalid','https://alefed.com.evil.invalid','http://learn.alefed.com','https://learn.alefed.com/path','https://learn.alefed.com?secret=1','https://user@learn.alefed.com','https://*.alefed.com','null'];
    await page.evaluate(unsafe=>__uiTest.emit({kind:'review',blocking:true,message:'تعذر الوصول.',blockedFrames:unsafe.map(origin=>({origin})),timestamp:Date.now()}),unsafe);
    assert.equal(await page.locator('#frame-permission-panel').isHidden(),true);
    await page.evaluate(()=>grantFrameAccess());
    assert.deepEqual(await page.evaluate(()=>__uiTest.permissions),[]);
    await page.evaluate(unsafe=>__uiTest.emit({kind:'review',cause:'frame_permission_required',blocking:true,message:'يلزم السماح بمحتوى ألف.',blockedFrames:[...unsafe.map(origin=>({origin})),{origin:'https://learn.alefed.com'}],timestamp:Date.now()}),unsafe);
    assert.equal(await page.locator('#frame-origins').textContent(),'https://learn.alefed.com');
    await page.locator('#grant-frame-access').click();
    await page.waitForFunction(()=>__uiTest.permissions.length===1);
    assert.deepEqual(await page.evaluate(()=>__uiTest.permissions[0]),{origins:['https://learn.alefed.com/*']});
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

test('a late frame-resume response does not overwrite a new blocking event or hide its permission action',async()=>{
  const h=await dashboardHarness({connected:true});
  try{
    const {page}=h;await page.locator('#subjects button').first().click();
    await page.evaluate(()=>{
      __uiTest.emit({kind:'review',cause:'frame_permission_required',blocking:true,message:'اسمح بالمحتوى الأول.',blockedFrames:[{origin:'https://learn.alefed.com'}],timestamp:Date.now()});
      const original=chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage=message=>{
        if(message.type!=='RESUME_FRAMES')return original(message);
        __uiTest.messages.push(structuredClone(message));
        const stale={...structuredClone(__uiTest.state),running:true,status:'running',subjectId:'math',blockedFrames:[]};
        return new Promise(resolve=>{__uiTest.releaseResume=()=>resolve({ok:true,state:stale});});
      };
    });
    await page.locator('#grant-frame-access').click();
    await page.waitForFunction(()=>typeof __uiTest.releaseResume==='function');
    await page.evaluate(()=>{
      __uiTest.emit({kind:'review',cause:'frame_permission_required',blocking:true,message:'يوجد محتوى إضافي يحتاج سماحًا.',blockedFrames:[{origin:'https://activities.alefed.com'}],timestamp:Date.now()});
      __uiTest.releaseResume();
    });
    await page.waitForFunction(()=>!document.querySelector('#grant-frame-access').disabled);
    assert.equal(await page.locator('#start').isEnabled(),true);
    assert.equal(await page.locator('#stop').isDisabled(),true);
    assert.equal(await page.locator('#frame-permission-panel').isVisible(),true);
    assert.equal(await page.locator('#frame-origins').textContent(),'https://activities.alefed.com');
    assert.match(await page.locator('#run-phase').textContent(),/محتوى إضافي/);
    assert.equal(await page.locator('#event-log li').count(),2);
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

test('restoring a blocked lesson exposes its permission action and active progress clears it',async()=>{
  const h=await dashboardHarness({connected:true});
  try{
    const {page}=h;
    await page.evaluate(()=>restoreState({...structuredClone(__uiTest.state),status:'review',subjectId:'arabic',blockedFrames:[{origin:'https://learn.alefed.com'}],
      lastEvent:{kind:'review',blocking:true,message:'يلزم السماح بمحتوى الدرس المحفوظ.'}}));
    assert.equal(await page.locator('#frame-permission-panel').isVisible(),true);
    assert.match(await page.locator('#run-phase').textContent(),/الدرس المحفوظ/);
    await page.evaluate(()=>__uiTest.emit({kind:'status',message:'جارٍ متابعة الدرس نفسه.',blockedFrames:[],timestamp:Date.now()}));
    assert.equal(await page.locator('#frame-permission-panel').isHidden(),true);
    assert.equal(await page.locator('#frame-origins').textContent(),'');
    assert.equal(await page.locator('#start-label').textContent(),'جارٍ الحل…');
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

test('unreachable local server check explains the Windows launcher without changing the saved pairing token',async()=>{
  const token='saved-local-pairing-token-for-connectivity-test';
  const h=await dashboardHarness({savedToken:token,sessionToken:null});
  try{
    const {page}=h;
    await page.route('http://127.0.0.1:4318/api/health',route=>route.abort('connectionrefused'));
    await page.locator('.settings-trigger').first().click();
    await page.locator('#check-server').click();
    await page.waitForFunction(()=>document.querySelector('#server-status').textContent.includes('START-WINDOWS.cmd'));
    const status=await page.locator('#server-status').textContent();
    assert.match(status,/اترك نافذته مفتوحة/);assert.match(status,/رمز الربط وحده لا يشغّل الخادم/);
    assert.doesNotMatch(status,/Failed to fetch|npm start|API key|SOLVER_API_KEY/);
    assert.equal(await page.locator('#pairing-token').inputValue(),token);
    assert.equal(h.stores.local.alefPairingToken,token);
    assert.equal(await page.locator('#check-server').isEnabled(),true);
    assert.equal((await page.evaluate(()=>__uiTest.messages)).some(message=>message.type==='START'),false);
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

test('local health timeout gives the same actionable launcher path without requesting a new token',async()=>{
  const h=await dashboardHarness({savedToken:'saved-timeout-pairing-token',sessionToken:null});
  try{
    const {page}=h;
    await page.evaluate(()=>{const original=globalThis.fetch;globalThis.fetch=async(...args)=>{
      if(String(args[0]).endsWith('/api/health'))throw new DOMException('The operation timed out.','TimeoutError');
      return original(...args);
    }});
    await page.locator('.settings-trigger').first().click();await page.locator('#check-server').click();
    await page.waitForFunction(()=>document.querySelector('#server-status').textContent.includes('انتهت مهلة'));
    assert.match(await page.locator('#server-status').textContent(),/START-WINDOWS.cmd.*اترك نافذته مفتوحة/);
    assert.equal(await page.locator('#pairing-token').inputValue(),'saved-timeout-pairing-token');
    assert.equal(await page.locator('#check-server').isEnabled(),true);
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

test('offline worker preflight refusal preserves the previous lesson, history and saved token without showing a running session',async()=>{
  const token='saved-worker-preflight-pairing-token';
  const h=await dashboardHarness({connected:true,savedToken:token,sessionToken:null});
  try{
    const {page}=h;
    let healthRequests=0;
    await page.route('http://127.0.0.1:4318/api/health',route=>{healthRequests++;return route.abort('connectionrefused')});
    await page.evaluate(()=>{
      const old={kind:'review',sequence:7,running:false,status:'review',message:'الدرس السابق يحتاج مراجعة.',currentLesson:{id:'one',name:'الدرس السابق'},timestamp:Date.now()};
      Object.assign(__uiTest.state,{subjectId:'math',status:'review',running:false,eventSequence:7,events:[old],lastEvent:old,
        queue:[{id:'one',name:'الدرس السابق',status:'review'},{id:'two',name:'درس لاحق',status:'pending'}],currentLesson:{id:'one',name:'الدرس السابق'},
        stats:{solved:0,review:1,total:0,lessonsTotal:2,lessonsCompleted:0,lessonsReview:1}});
      restoreState(structuredClone(__uiTest.state));
      const original=chrome.runtime.sendMessage;
      chrome.runtime.sendMessage=async message=>{
        if(message.type==='START'){
          __uiTest.messages.push(structuredClone(message));
          return {ok:false,error:'تعذر الوصول إلى خادم مُعين المحلي. شغّل START-WINDOWS.cmd من مجلد مُعين واترك نافذته مفتوحة، ثم أعد فحص الاتصال.'};
        }
        return original(message);
      };
    });
    await page.locator('#start').click();
    await page.waitForFunction(()=>document.querySelector('#run-status').textContent==='تعذّر البدء');
    assert.match(await page.locator('#run-phase').textContent(),/START-WINDOWS.cmd/);
    assert.equal(await page.locator('#start-label').textContent(),'ابدأ الحل');
    assert.equal(await page.locator('#start').isEnabled(),true);assert.equal(await page.locator('#stop').isDisabled(),true);
    assert.equal(await page.locator('#lesson-queue li').count(),2);
    assert.match(await page.locator('#event-log').textContent(),/الدرس السابق يحتاج مراجعة/);
    assert.equal(h.stores.local.alefPairingToken,token);
    const messages=await page.evaluate(()=>__uiTest.messages);
    assert.equal(messages.filter(message=>message.type==='START').length,1);
    assert.equal(messages.find(message=>message.type==='START').config.token,token);
    assert.equal(messages.filter(message=>message.type==='GET_STATE').length,2,'Initial state plus refusal recovery');
    assert.equal(healthRequests,0,'The worker owns preflight; the dashboard does not duplicate its network probe');
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

test('server check shows local model readiness without paid credentials and precise missing-runtime/model messages',async()=>{
  const harness=await dashboardHarness();
  try{
    const {page}=harness;
    let health={ok:true,protocolVersion:3,configured:true,provider:'ollama',model:'qwen3:8b',modelReady:true,visionModel:'qwen3-vl:8b',visionInstalled:true,visionReady:true};
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
    assert.ok((await page.locator('#server-status').textContent()).includes('الصور: qwen3-vl:8b'));
    assert.ok((await page.locator('#server-status').textContent()).includes('دون مفتاح API'));
    health={...health,protocolVersion:2};
    await page.locator('#check-server').click();
    await page.waitForFunction(()=>document.querySelector('#server-status').textContent.includes('حدّث المشروع كاملًا'));
    const oldStatus=await page.locator('#server-status').textContent();
    assert.match(oldStatus,/الخادم والإضافة/);assert.match(oldStatus,/أغلق نافذة التشغيل القديمة/);assert.match(oldStatus,/START-WINDOWS.cmd من النسخة الجديدة/);
    assert.doesNotMatch(oldStatus,/متصل/,'A protocol 2 server cannot be presented as connected or ready for the fixed choice mapping');
    health={ok:true,protocolVersion:3,configured:true,provider:'ollama',model:'qwen3:8b',modelReady:true,visionModel:'qwen3-vl:8b',visionInstalled:false,visionReady:false,visionIssue:'vision_model_not_found',visionMessage:'النموذج البصري غير مثبت.'};
    await page.locator('#check-server').click();
    await page.waitForFunction(()=>document.querySelector('#server-status').textContent.includes('الصور غير جاهزة'));
    assert.ok((await page.locator('#server-status').textContent()).includes('متصل للنصوص'));
    assert.ok((await page.locator('#server-status').textContent()).includes('START-WINDOWS.cmd'));
    assert.ok((await page.locator('#server-status').textContent()).includes(health.visionMessage));
    health={...health,visionInstalled:true,visionIssue:'vision_not_supported',visionMessage:'النموذج المثبت لا يدعم الصور.'};
    await page.locator('#check-server').click();
    await page.waitForFunction(()=>document.querySelector('#server-status').textContent.includes('لا يدعم الصور'));
    assert.equal((await page.locator('#server-status').textContent()).includes('متصل محليًا'),false,'Text readiness alone cannot imply image readiness');
    health={ok:true,configured:true,provider:'ollama',model:'qwen3:8b',modelReady:true};
    await page.locator('#check-server').click();
    await page.waitForFunction(()=>document.querySelector('#server-status').textContent.includes('حدّث المشروع كاملًا'));
    health={ok:true,protocolVersion:3,configured:false,provider:'ollama',model:'qwen3:8b',modelReady:false,issue:'model_missing',message:'النموذج qwen3:8b غير موجود. حمّله باستخدام ollama pull qwen3:8b.'};
    await page.locator('#check-server').click();
    await page.waitForFunction(()=>document.querySelector('#server-status').textContent.includes('غير موجود'));
    assert.equal(await page.locator('#server-status').textContent(),health.message);
    health={ok:true,protocolVersion:3,configured:false,provider:'ollama',model:'qwen3:8b',modelReady:false,issue:'runtime_unavailable',message:'تعذر الاتصال بـ Ollama. افتح Ollama ثم أعد الفحص.'};
    await page.locator('#check-server').click();
    await page.waitForFunction(()=>document.querySelector('#server-status').textContent.includes('افتح Ollama'));
    assert.equal(await page.locator('#server-status').textContent(),health.message);
    assert.equal((await page.locator('#server-status').textContent()).includes('SOLVER_API_KEY'),false);
    assert.equal(requests,7);
    assert.deepEqual(harness.errors,[]);
  }finally{await harness.close();}
});

test('course queue and nonblocking lesson review retain automatic run controls',async()=>{
 const harness=await dashboardHarness({connected:true});
 try{
  const {page}=harness;await page.locator('#subjects button').first().click();await page.locator('#start').click();
  await page.evaluate(()=>__uiTest.emit({kind:'queue',message:'فحص الدروس',stats:{solved:0,review:0,total:0,lessonsTotal:2,lessonsCompleted:0,lessonsReview:0},queue:[{id:'one',name:'القراءة',status:'running'},{id:'two',name:'القواعد',status:'pending'},{id:'locked',name:'درس مقفل',status:'locked'}],currentLesson:{name:'القراءة'},timestamp:Date.now()}));
  assert.equal(await page.locator('#course-progress').isVisible(),true);assert.equal(await page.locator('#lesson-queue li').count(),3);assert.equal(await page.locator('#lesson-count').textContent(),'اكتمل 0 من 2');await capture(page,'dashboard-course');
  await page.evaluate(()=>__uiTest.emit({kind:'review',blocking:false,message:'درس يحتاج مراجعة؛ متابعة التالي',stats:{solved:0,review:1,total:1,lessonsTotal:2,lessonsCompleted:0,lessonsReview:1},queue:[{id:'one',name:'القراءة',status:'review'},{id:'two',name:'القواعد',status:'running'}],timestamp:Date.now()}));
  assert.equal(await page.locator('.course-progress-track').getAttribute('aria-valuenow'),'0');
  assert.equal(await page.locator('#lesson-count').textContent(),'اكتمل 0 من 2');
  assert.equal(await page.locator('#stop').isEnabled(),true);assert.equal(await page.locator('#start').isDisabled(),true);assert.equal(await page.locator('#skip-instruction').isDisabled(),true);
  assert.deepEqual(harness.errors,[]);
 }finally{await harness.close();}
});

test('answers identify their subject and lesson, distinguish submission, and clear on a new question or lesson',async()=>{
 const harness=await dashboardHarness({connected:true});
 try{
  const {page}=harness;await page.locator('#subjects button').first().click();await page.locator('#start').click();
  await page.evaluate(()=>{
   const lesson={id:'polynomials',name:'Adding Polynomials'};
   const question={id:'q1',fingerprint:'first',text:'Select the correct answer.',options:[{id:'a',text:'3c² + 2c − 1'}]};
   __uiTest.emit({kind:'lesson',message:'بدء درس',currentLesson:lesson,currentSubject:{id:'math',name:'الرياضيات'}});
   __uiTest.emit({kind:'question',message:'جارٍ الحل',currentLesson:lesson,question});
   __uiTest.emit({kind:'answer',message:'وصلت الإجابة',currentLesson:lesson,question,answer:{optionIds:['a'],explanation:'نجمع الحدود المتشابهة.',confidence:.95}});
  });
  assert.equal(await page.locator('#answer-subject').textContent(),'الرياضيات');
  assert.equal(await page.locator('#answer-lesson').textContent(),'Adding Polynomials');
  assert.equal(await page.locator('#answer-text').textContent(),'3c² + 2c − 1');
  assert.equal(await page.locator('#answer-label').textContent(),'الإجابة المقترحة');
  assert.ok((await page.locator('#answer-state').textContent()).includes('جارٍ تطبيقها'));
  await page.evaluate(()=>__uiTest.emit({kind:'submitted',message:'أُرسلت الإجابة',currentLesson:{id:'polynomials',name:'Adding Polynomials'},applied:true,submitted:true}));
  assert.equal(await page.locator('#answer-label').textContent(),'الإجابة المُرسلة');
  assert.ok((await page.locator('#answer-state').textContent()).includes('أُرسلت الإجابة إلى ألف'));
  assert.ok((await page.locator('#event-log').textContent()).includes('Adding Polynomials — أُرسلت الإجابة'));
  await page.evaluate(()=>__uiTest.emit({kind:'question',message:'السؤال التالي',currentLesson:{id:'polynomials',name:'Adding Polynomials'},question:{id:'q2',fingerprint:'second',text:'What is 2 + 2?',options:[]}}));
  assert.equal(await page.locator('#question-text').textContent(),'What is 2 + 2?');
  assert.equal(await page.locator('#answer-box').isVisible(),false);
  assert.equal(await page.locator('#answer-text').textContent(),'');
  assert.equal(await page.locator('#explanation').textContent(),'');
  assert.ok((await page.locator('#answer-state').textContent()).includes('جارٍ حل هذا السؤال'));
  await page.evaluate(()=>__uiTest.emit({kind:'lesson',message:'بدء درس جديد',currentLesson:{id:'dilations',name:'Dilations - Exit Ticket'}}));
  assert.equal(await page.locator('#answer-lesson').textContent(),'Dilations - Exit Ticket');
  assert.equal(await page.locator('#question-text').textContent(),'');
  assert.equal(await page.locator('#answer-content').isVisible(),false);
  assert.equal(await page.locator('#answer-empty').isVisible(),true);
  assert.deepEqual(harness.errors,[]);
 }finally{await harness.close();}
});

test('blocking review keeps lesson context and leaves later lessons pending without showing review as completion',async()=>{
 const harness=await dashboardHarness({connected:true});
 try{
  const {page}=harness;await page.locator('#subjects button').first().click();await page.locator('#start').click();
  await page.evaluate(()=>__uiTest.emit({kind:'review',blocking:true,message:'لم يستجب خيار الإجابة.',currentSubject:{id:'math',name:'الرياضيات'},currentLesson:{id:'one',name:'الدرس الأول'},
   question:{id:'q1',text:'Select the correct answer.',options:[{id:'a',text:'42'}]},answer:{optionIds:['a'],confidence:.95},
   stats:{solved:0,review:1,total:1,lessonsTotal:2,lessonsCompleted:0,lessonsReview:1},queue:[{id:'one',name:'الدرس الأول',status:'review'},{id:'two',name:'الدرس الثاني',status:'pending'}]}));
  assert.equal(await page.locator('#answer-lesson').textContent(),'الدرس الأول');
  assert.ok((await page.locator('#answer-state').textContent()).includes('توقف التشغيل في هذا الدرس'));
  assert.equal(await page.locator('#answer-label').textContent(),'الإجابة المقترحة');
  assert.equal(await page.locator('#solved-count').textContent(),'0');
  assert.equal(await page.locator('#lesson-count').textContent(),'اكتمل 0 من 2');
  assert.equal(await page.locator('.course-progress-track').getAttribute('aria-valuenow'),'0');
  assert.ok((await page.locator('#lesson-queue .lesson-pending').textContent()).includes('الدرس الثاني'));
  assert.equal(await page.locator('#stop').isEnabled(),false);
  assert.equal(await page.locator('#start').isEnabled(),true);
  assert.deepEqual(harness.errors,[]);
 }finally{await harness.close();}
});

test('session completion replaces waiting-for-next status and restores the final answer as the last question',async()=>{
 const harness=await dashboardHarness({connected:true});
 try{
  const {page}=harness;await page.locator('#subjects button').first().click();await page.locator('#start').click();
  await page.evaluate(()=>{
   const lesson={id:'final',name:'الدرس الأخير',status:'completed'};
   const context={currentLesson:lesson,currentSubject:{id:'math',name:'الرياضيات'}};
   const question={id:'last',fingerprint:'last',text:'ما ناتج 6 × 7؟',options:[{id:'b',text:'42'}]};
   const answer={optionIds:['b'],text:'',confidence:.97};
   const events=[
    {kind:'lesson',message:'بدء الدرس',...context},
    {kind:'question',message:'جارٍ الحل',...context,question},
    {kind:'answer',message:'وصلت الإجابة',...context,question,answer},
    {kind:'submitted',message:'أُرسلت الإجابة',...context,question,answer,applied:true,submitted:true},
    {kind:'complete',message:'اكتملت الدروس المفتوحة.',stats:{solved:1,review:0,total:1,lessonsCompleted:1,lessonsTotal:1,lessonsReview:0}},
   ];
   events.forEach(event=>__uiTest.emit(event));
   Object.assign(__uiTest.state,{running:false,status:'complete',subjectId:'math',currentLesson:null,events,stats:events.at(-1).stats,queue:[lesson]});
  });
  assert.equal(await page.locator('#question-label').textContent(),'آخر سؤال في الجلسة');
  assert.ok((await page.locator('#answer-state').textContent()).includes('اكتملت الجلسة'));
  assert.equal((await page.locator('#answer-state').textContent()).includes('انتظار'),false);
  assert.equal(await page.locator('#answer-label').textContent(),'الإجابة المُرسلة');
  assert.equal(await page.locator('#answer-text').textContent(),'42');
  await page.evaluate(()=>restoreState(__uiTest.state));
  assert.equal(await page.locator('#question-label').textContent(),'آخر سؤال في الجلسة');
  assert.equal(await page.locator('#answer-lesson').textContent(),'الدرس الأخير');
  assert.equal(await page.locator('#answer-subject').textContent(),'الرياضيات');
  assert.ok((await page.locator('#answer-state').textContent()).includes('اكتملت الجلسة'));
  assert.equal((await page.locator('#answer-state').textContent()).includes('انتظار'),false);
  assert.equal(await page.locator('#answer-text').textContent(),'42');
  assert.equal(await page.locator('#solved-count').textContent(),'1');
  assert.equal(await page.locator('#lesson-count').textContent(),'اكتمل 1 من 1');
  assert.equal(await page.locator('#stop').isEnabled(),false);
  assert.deepEqual(harness.errors,[]);
 }finally{await harness.close();}
});


test('fresh dashboard starts in higher accuracy mode and persists reasoning plus independent review without credentials',async()=>{
  const harness=await dashboardHarness({connected:true});
  try{
    const {page}=harness;
    assert.equal(await page.locator('#verify').isChecked(),true);
    assert.ok((await page.locator('#solve-mode').textContent()).includes('تفكير متأنٍّ'));
    await page.locator('#subjects button').first().click();
    await page.locator('#start').click();
    await page.waitForFunction(()=>__uiTest.local.alefConfig?.verify===true);
    const state=await page.evaluate(()=>({start:__uiTest.messages.find(message=>message.type==='START'),stored:__uiTest.local.alefConfig}));
    assert.equal(state.start.config.verify,true);
    assert.equal(state.start.config.qualityMode,true);
    assert.equal(state.stored.verify,true);
    assert.equal(state.stored.qualityMode,true);
    assert.equal('token' in state.stored,false);
    assert.equal(await page.locator('#verify').isDisabled(),true);
    assert.deepEqual(harness.errors,[]);
  }finally{await harness.close();}
});

for(const verify of [true,false]) {
  test(`saved verification preference ${verify} survives reopening and starts unchanged`,async()=>{
    const harness=await dashboardHarness({connected:true,savedConfig:{verify,qualityMode:verify,autoSubmit:true,skipInstruction:true}});
    try{
      const {page}=harness;
      assert.equal(await page.locator('#verify').isChecked(),verify);
      assert.ok((await page.locator('#solve-mode').textContent()).includes(verify?'حلّان مستقلان':'الوضع السريع'));
      await page.locator('#subjects button').first().click();
      await page.locator('#start').click();
      await page.waitForFunction(()=>__uiTest.messages.some(message=>message.type==='START'));
      assert.equal(await page.evaluate(()=>__uiTest.messages.find(message=>message.type==='START').config.verify),verify);
      assert.equal(await page.evaluate(()=>__uiTest.messages.find(message=>message.type==='START').config.qualityMode),verify);
      assert.deepEqual(harness.errors,[]);
    }finally{await harness.close();}
  });
}


test('existing verified mode can be switched to fast mode and persists the new selection',async()=>{
  const harness=await dashboardHarness({connected:true,savedConfig:{verify:true}});
  try{
    const {page}=harness;
    assert.equal(await page.locator('#verify').isChecked(),true);
    await page.locator('label').filter({has:page.locator('#verify')}).click();
    assert.equal(await page.locator('#verify').isChecked(),false);
    assert.ok((await page.locator('#solve-mode').textContent()).includes('الوضع السريع'));
    await page.locator('#subjects button').first().click();
    await page.locator('#start').click();
    await page.waitForFunction(()=>__uiTest.local.alefConfig?.verify===false);
    assert.equal(await page.evaluate(()=>__uiTest.messages.find(message=>message.type==='START').config.verify),false);
    assert.equal(await page.evaluate(()=>__uiTest.messages.find(message=>message.type==='START').config.qualityMode),false);
    await page.locator('#stop').click();
    const reopened=await harness.reopen();
    assert.equal(await reopened.locator('#verify').isChecked(),false,'The one-time migration cannot override an explicit fast-mode choice');
    assert.deepEqual(harness.errors,[]);
  }finally{await harness.close();}
});

test('upgrading legacy fast settings enables higher accuracy once while preserving pairing and other settings',async()=>{
  const harness=await dashboardHarness({connected:true,savedConfig:{verify:false,autoSubmit:false,skipInstruction:false},savedToken:'upgrade-ui-pairing-token-not-a-real-secret'});
  try{
    assert.equal(await harness.page.locator('#verify').isChecked(),true);
    assert.equal(await harness.page.locator('#auto-submit').isChecked(),false);
    assert.equal(await harness.page.locator('#skip-instruction').isChecked(),false);
    assert.equal(harness.stores.local.alefConfig.qualityMode,true);
    assert.equal(harness.stores.local.alefConfig.verify,true);
    assert.equal(harness.stores.local.alefConfig.autoSubmit,false);
    assert.equal(harness.stores.local.alefPairingToken,'upgrade-ui-pairing-token-not-a-real-secret');
    assert.equal(Object.hasOwn(harness.stores.local.alefConfig,'token'),false);
    const reopened=await harness.reopen({clearSession:true});
    assert.equal(await reopened.locator('#verify').isChecked(),true);
    await reopened.locator('.settings-trigger').first().click();
    assert.equal(await reopened.locator('#pairing-token').inputValue(),'upgrade-ui-pairing-token-not-a-real-secret');
    assert.deepEqual(harness.errors,[]);
  }finally{await harness.close();}
});

test('saving an explicit fast-mode opt-out before starting preserves both quality and review flags after reopening',async()=>{
  const harness=await dashboardHarness();
  try{
    const {page}=harness;
    await page.locator('label').filter({has:page.locator('#verify')}).click();
    await page.locator('.settings-trigger').first().click();
    await page.locator('#settings-form button[type="submit"]').click();
    await page.waitForFunction(()=>!document.querySelector('#settings-dialog').open);
    assert.equal(harness.stores.local.alefConfig.qualityMode,false);
    assert.equal(harness.stores.local.alefConfig.verify,false);
    assert.equal(Object.hasOwn(harness.stores.local.alefConfig,'token'),false);
    const reopened=await harness.reopen({clearSession:true});
    assert.equal(await reopened.locator('#verify').isChecked(),false);
    assert.ok((await reopened.locator('#solve-mode').textContent()).includes('الوضع السريع'));
    assert.deepEqual(harness.errors,[]);
  }finally{await harness.close();}
});

for(const text of ['ما معامل التمدد في الرسم؟','What is the scale factor shown in the figure?']) {
  test(`a visual question keeps its image requirement visible until the next text question: ${text}`,async()=>{
    const harness=await dashboardHarness({connected:true});
    try{
      const {page}=harness;
      await page.evaluate(text=>__uiTest.emit({kind:'question',message:'جارٍ الحل',question:{id:'visual',fingerprint:'visual',text,requiresVision:true,options:[]}}),text);
      assert.equal(await page.locator('#question-text').textContent(),text);
      assert.equal(await page.locator('#question-media-note').isVisible(),true);
      assert.ok((await page.locator('#answer-state').textContent()).includes('الرسم أو الصورة'));
      assert.equal(await page.locator('#answer-box').isVisible(),false);
      await page.evaluate(()=>__uiTest.emit({kind:'question',message:'السؤال التالي',question:{id:'text',fingerprint:'text',text:'2 + 2 = ?',requiresVision:false,options:[]}}));
      assert.equal(await page.locator('#question-media-note').isVisible(),false);
      assert.ok((await page.locator('#answer-state').textContent()).includes('جارٍ حل هذا السؤال'));
      assert.deepEqual(harness.errors,[]);
    }finally{await harness.close();}
  });
}

test('pasted pairing token saves without submitting and survives closing the dashboard with an empty new session',async()=>{
  const harness=await dashboardHarness({sessionToken:null});
  try{
    let page=harness.page;
    await page.locator('.settings-trigger').first().click();
    await page.locator('#pairing-token').fill('persistent-ui-token-not-a-real-secret');
    await page.waitForFunction(()=>document.querySelector('#pairing-save-status').textContent.includes('حُفظ رمز الربط'));
    assert.equal(harness.stores.local.alefPairingToken,'persistent-ui-token-not-a-real-secret');
    assert.ok((await page.locator('#settings-dialog').evaluate(el=>el.open)),'No Save or close click is needed to persist the pasted token');
    assert.equal((await page.locator('body').innerText()).includes('persistent-ui-token-not-a-real-secret'),false);
    assert.equal(await page.locator('#pairing-token').getAttribute('type'),'password');
    assert.deepEqual(await page.evaluate(()=>__uiTest.storageAccess),[{area:'local',accessLevel:'TRUSTED_CONTEXTS'}]);
    page=await harness.reopen({clearSession:true});
    await page.locator('.settings-trigger').first().click();
    assert.equal(await page.locator('#pairing-token').inputValue(),'persistent-ui-token-not-a-real-secret');
    assert.equal(Object.hasOwn(harness.stores.local.alefConfig||{},'token'),false);
    assert.deepEqual(harness.errors,[]);
  }finally{await harness.close();}
});

test('legacy session pairing token migrates to local storage and survives a later browser session',async()=>{
  const harness=await dashboardHarness({sessionToken:'legacy-ui-token-not-a-real-secret'});
  try{
    assert.equal(harness.stores.local.alefPairingToken,'legacy-ui-token-not-a-real-secret');
    assert.equal(Object.hasOwn(harness.stores.session,'alefPairingToken'),false);
    const page=await harness.reopen({clearSession:true});
    await page.locator('.settings-trigger').first().click();
    assert.equal(await page.locator('#pairing-token').inputValue(),'legacy-ui-token-not-a-real-secret');
    assert.deepEqual(harness.errors,[]);
  }finally{await harness.close();}
});

test('clearing a saved pairing token stays cleared after reopening even when an obsolete session token exists',async()=>{
  const harness=await dashboardHarness({savedToken:'saved-ui-token-not-a-real-secret',sessionToken:'obsolete-ui-token-not-a-real-secret'});
  try{
    let page=harness.page;
    await page.locator('.settings-trigger').first().click();
    assert.equal(await page.locator('#pairing-token').inputValue(),'saved-ui-token-not-a-real-secret');
    await page.locator('#pairing-token').fill('');
    await page.waitForFunction(()=>document.querySelector('#pairing-save-status').textContent.includes('حُذف رمز الربط'));
    assert.equal(harness.stores.local.alefPairingToken,'');
    harness.stores.session.alefPairingToken='obsolete-ui-token-not-a-real-secret';
    page=await harness.reopen();
    await page.locator('.settings-trigger').first().click();
    assert.equal(await page.locator('#pairing-token').inputValue(),'');
    assert.equal(harness.stores.local.alefPairingToken,'');
    assert.equal(Object.hasOwn(harness.stores.session,'alefPairingToken'),false);
    assert.deepEqual(harness.errors,[]);
  }finally{await harness.close();}
});

test('a pairing-token write failure is reported instead of claiming the token was saved',async()=>{
  const harness=await dashboardHarness({savedToken:'original-ui-token-not-a-real-secret',sessionToken:null,failTokenWrites:true});
  try{
    const {page}=harness;
    await page.locator('.settings-trigger').first().click();
    await page.locator('#pairing-token').fill('replacement-ui-token-not-a-real-secret');
    await page.waitForFunction(()=>document.querySelector('#pairing-save-status').textContent.includes('تعذّر حفظ'));
    assert.equal(harness.stores.local.alefPairingToken,'original-ui-token-not-a-real-secret');
    assert.equal((await page.locator('body').innerText()).includes('replacement-ui-token-not-a-real-secret'),false);
    assert.deepEqual(harness.errors,[]);
  }finally{await harness.close();}
});
