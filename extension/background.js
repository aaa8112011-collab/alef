'use strict';

// The optional guard also keeps the isolated protocol test harness explicit:
// real extension workers load the packaged bridge through importScripts.
if(typeof importScripts==='function')importScripts('visual-bridge.js');

// Pairing settings belong to extension pages and the worker, never content scripts.
async function restrictLocalSettings() {
  try { await chrome.storage.local?.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'}); }
  catch { /* Older Chrome builds can omit this optional storage API. */ }
}
void restrictLocalSettings();

const runs = new Map();
const pendingStarts = new Map();
const states = new Map();
const frameRoutes = new Map();
const reviewMessages = {
  missing_question_text:'لم يصل نص المسألة؛ وصلت تعليمات اختيار الإجابة فقط. أعد فحص السؤال بالقارئ المحدّث.',
  low_confidence:'تقدير الثقة منخفض؛ راجع الإجابة قبل إرسالها.',
  verification_disagreement:'لم تتفق عمليتا الحل والتحقق؛ راجع السؤال.',
  invalid_selection:'خيارات الإجابة لا تطابق السؤال؛ لم تُطبّق الإجابة.',
  invalid_text_answer:'لم يُعد النموذج قيمة نصية صالحة للحقل بعد تصحيح الصيغة؛ لم تُكتب إجابة.',
  missing_visual_evidence:'الرسم أو الصورة المطلوبة غير مقروءة؛ لم تُرسل إجابة تخمينية.',
  visual_evidence_unreadable:'لم تتضح بيانات الرسم للنموذج؛ توقف الحل في هذا السؤال.',
};
const allowedOrigin = url => {
  try {
    const parsed = new URL(url);
    return parsed.origin === 'https://moe.alefed.com' ||
      (parsed.protocol === 'http:' && ['localhost','127.0.0.1'].includes(parsed.hostname));
  } catch { return false; }
};
const freshStats = () => ({solved:0,review:0,total:0,lessonsCompleted:0,lessonsTotal:0,lessonsReview:0});
const freshState = () => ({running:false,status:'idle',page:null,subjects:[],subjectId:null,
  queue:[],currentLesson:null,catalogURL:null,catalogClass:null,blockedFrames:[],stats:freshStats(),events:[],lastEvent:null,eventSequence:0});
const key = tabId => `alef:run:${tabId}`;
const aborted = () => new DOMException('تم إيقاف التشغيل.','AbortError');
function assertActive(signal) { if (signal.aborted) throw aborted(); }
function pause(ms,signal) {
  return new Promise((resolve,reject) => {
    assertActive(signal);
    const timer = setTimeout(() => {signal.removeEventListener('abort',cancel);resolve();},ms);
    const cancel = () => {clearTimeout(timer);reject(aborted());};
    signal.addEventListener('abort',cancel,{once:true});
  });
}
async function getState(tabId) {
  if (!states.has(tabId)) {
    const stored = (await chrome.storage.session.get(key(tabId)))[key(tabId)] || freshState();
    stored.stats = {...freshStats(),...stored.stats};
    stored.queue ||= [];
    stored.currentLesson ||= null;
    stored.blockedFrames ||= [];
    stored.eventSequence=Number.isSafeInteger(stored.eventSequence)?stored.eventSequence:0;
    if (stored.running && !runs.has(tabId)) {
      stored.running = false;
      stored.status = 'interrupted';
      stored.lastEvent = {kind:'stopped',message:'انقطعت جلسة الإضافة. افحص الصفحة ثم ابدأ مجددًا.',timestamp:Date.now(),sequence:++stored.eventSequence,stats:stored.stats};
      (stored.events ||= []).push(stored.lastEvent);
    }
    states.set(tabId,stored);
  }
  return states.get(tabId);
}
async function saveState(tabId) {
  await chrome.storage.session.set({[key(tabId)]:states.get(tabId)});
}
async function emit(tabId,kind,message,details={}) {
  const state = await getState(tabId);
  const event = {kind,message,...details,stats:{...state.stats},timestamp:Date.now(),sequence:++state.eventSequence};
  if (state.currentLesson) event.currentLesson = {...state.currentLesson};
  const subject = state.subjects.find(item=>item.id===state.subjectId);
  if (subject) event.currentSubject = {id:subject.id,name:subject.name};
  event.blockedFrames=(state.blockedFrames||[]).map(item=>({...item}));
  if (['queue','lesson','complete','review','error','stopped'].includes(kind)) {
    event.queue = state.queue.map(item=>({...item}));
  }
  state.lastEvent = event;
  state.events = [...state.events,event].slice(-100);
  if (['complete','error','stopped'].includes(kind) || (kind === 'review' && details.blocking !== false)) {
    state.status = kind;
    state.running = false;
  }
  event.running=state.running;event.status=state.status;
  await saveState(tabId);
  try { await chrome.runtime.sendMessage({type:'RUN_EVENT',tabId,event}); } catch { /* Dashboard may be closed. */ }
}
function checkedTabId(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('افتح صفحة ألف ثم افتح الإضافة من تبويبها.');
  return value;
}
function observedCoreClass(value) {
  try {
    const url=new URL(value);
    const route=url.hash.startsWith('#/')?new URL(url.hash.slice(1),url.origin):url;
    const match=route.pathname.match(/^\/classes\/([^/]+)\/?$/)||route.pathname.match(/^\/progress\/ncle\/(?:class|result)\/([^/]+)(?:\/|$)/);
    return match?`${url.origin}/classes/${match[1]}`:null;
  } catch { return null; }
}
async function checkedTab(tabId,origin) {
  const tab = await chrome.tabs.get(tabId);
  if (!allowedOrigin(tab.url)) throw Object.assign(new Error('افتح https://moe.alefed.com/ أولًا؛ الربط متاح لموقع ألف فقط.'),{fatal:true});
  if (origin && new URL(tab.url).origin !== origin) throw Object.assign(new Error('انتقلت الصفحة خارج الموقع المرتبط. أوقف التشغيل وأعد الربط.'),{fatal:true});
  const expected=states.get(tabId)?.catalogClass;
  const actual=observedCoreClass(tab.url);
  if(runs.has(tabId)&&expected&&actual&&actual!==expected) {
    throw Object.assign(new Error('انتقلت الصفحة إلى مادة أخرى. أوقف التشغيل وأعد فحص المادة المطلوبة.'),{fatal:true});
  }
  return tab;
}
function routeState(tabId) {
  if(!frameRoutes.has(tabId))frameRoutes.set(tabId,{active:0,begun:new Set(),controller:null,injected:new Set([0]),documents:new Set(),permissions:new Map()});
  return frameRoutes.get(tabId);
}
function frameOrigin(value,topOrigin) {
  try {
    const url=new URL(value);
    if(url.protocol==='https:'&&!url.port&&!url.username&&!url.password&&
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*alefed\.com$/i.test(url.hostname))return url.origin;
    const top=new URL(topOrigin);
    if(top.protocol==='http:'&&['localhost','127.0.0.1'].includes(top.hostname)&&
      url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname))return url.origin;
  }catch{}
  return null;
}
function bridgeSenderMatchesURL(sender,expectedURL){
  if(typeof sender?.url!=='string'||typeof expectedURL!=='string')return false;
  try{
    const source=new URL(sender.url),current=new URL(expectedURL);
    if(!['https:','http:'].includes(source.protocol)||source.origin!==current.origin||
      source.username||source.password||current.username||current.password)return false;
    // Chrome caches MessageSender.url when a content-script context is created.
    // Alef changes hash/history routes in the same document. A stale route is
    // allowed only with a document ID; live frame URL and DOM checks below
    // remain exact and must still agree before any read or mutation.
    return sender.url===expectedURL||typeof sender.documentId==='string'&&!!sender.documentId;
  }catch{return false;}
}
function cleanFrameURL(value) {
  try {const url=new URL(value);return /^https?:$/.test(url.protocol)?url.origin+url.pathname:url.protocol==='about:'?'about:'+url.pathname:url.protocol;}catch{return '';}
}
function lessonPageKey(value) {
  try {const url=new URL(value);return url.origin+url.pathname+url.hash.split('?')[0];}catch{return '';}
}
async function framePermission(origin,topOrigin) {
  if(origin===topOrigin)return true;
  if(!chrome.permissions?.contains)return false;
  try{return await chrome.permissions.contains({origins:[`${origin}/*`]});}catch{return false;}
}
async function inject(tabId,origin,frameId=0) {
  await checkedTab(tabId,origin);
  await chrome.scripting.executeScript({target:{tabId,...(frameId?{frameIds:[frameId]}:{frameIds:[0]})},files:['content.js']});
  routeState(tabId).injected.add(frameId);
}
// Chrome isolates the reader from page-defined custom-element methods. This
// fixed function runs in MAIN only for the marked MathLive field; no settings,
// pairing token, selectors or executable source cross into the page world.
function mathFieldMain(operation,target,value,expectedURL) {
  try {
    if(location.href!==expectedURL||!['read','write'].includes(operation)||
      typeof target!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target))throw Error('تغير مستند محرر المعادلات.');
    const matches=[];
    const visit=root=>{
      for(const node of root.querySelectorAll('math-field'))if(node.getAttribute('data-alef-math-target')===target)matches.push(node);
      for(const node of root.querySelectorAll('*'))if(node.shadowRoot)visit(node.shadowRoot);
    };
    visit(document);
    if(matches.length!==1)throw Error('لم يعد محرر المعادلات المحدد ظاهرًا.');
    const node=matches[0],definition=customElements.get('math-field');
    if(!definition||!(node instanceof definition)||typeof node.setValue!=='function'||typeof node.getValue!=='function')throw Error('لم يكتمل تجهيز محرر المعادلات.');
    const roots='.lib-fib-container.lib-question-widget,.fib-container.question-widget,.lib-open-ended-container.lib-question-widget,.open-ended-container.question-widget,[data-alef-question],[data-question-id],[data-testid="question-renderer"],[data-testid="new-question-renderer"]';
    let question=null;
    for(let owner=node.parentElement||node.getRootNode()?.host;owner;owner=owner.parentElement||owner.getRootNode()?.host)if(owner.matches(roots)){question=owner;break;}
    if(!question||node.closest('form')&&!node.closest('main#player-container,[data-testid="assessment-content-player"],[data-testid="ncle-activity-page-player"]'))throw Error('المحرر ليس داخل سؤال مدعوم.');
    const rendered=el=>{
      if(!el.isConnected||!el.getClientRects().length)return false;
      for(let owner=el;owner;owner=owner.parentElement||owner.getRootNode()?.host){
        const style=getComputedStyle(owner);
        if(owner.matches('[hidden],[inert],[aria-hidden="true"]')||style.display==='none'||['hidden','collapse'].includes(style.visibility))return false;
      }
      return true;
    };
    if(!rendered(node))throw Error('حقل المعادلات لم يعد ظاهرًا.');
    const disabled=node.disabled===true||node.matches('[disabled],[aria-disabled="true"]')||!!node.closest('[inert],fieldset[disabled]');
    const readOnly=node.readOnly===true||node.matches('[readonly],[read-only],[aria-readonly="true"]');
    if(operation==='write'){
      if(disabled||readOnly)throw Error('حقل المعادلات معطل أو غير قابل للكتابة.');
      if(typeof value!=='string'||!value.trim()||value.length>4096)throw Error('صيغة إجابة المعادلات غير صالحة.');
      node.setValue(value,{silenceNotifications:true});
    }
    // Capture canonical LaTeX before notifying React. A rejecting onInput may
    // immediately restore its previous value, which later reads must expose.
    const actual=node.getValue('latex');
    if(typeof actual!=='string'||actual.length>4096)throw Error('تعذرت قراءة قيمة محرر المعادلات.');
    const valid=!!actual.trim()&&Array.isArray(node.errors)&&node.errors.length===0;
    if(operation==='write')node.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'insertText',data:null}));
    return {ok:true,value:actual,valid,disabled,readOnly};
  }catch(error){return {ok:false,error:error.message||'تعذر التفاعل مع محرر المعادلات.'};}
}
async function mathFieldMessage(message,sender) {
  const tabId=checkedTabId(sender.tab?.id),frameId=sender.frameId;
  if(sender.id!==chrome.runtime.id||!Number.isSafeInteger(frameId)||frameId<0||
    !['read','write'].includes(message.operation)||typeof message.target!=='string'||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(message.target)||
    !bridgeSenderMatchesURL(sender,message.expectedURL)||
    message.operation==='write'&&(typeof message.value!=='string'||!message.value.trim()||message.value.length>4096))throw Error('طلب محرر المعادلات غير صالح.');
  const controller=runs.get(tabId),routes=frameRoutes.get(tabId),state=states.get(tabId);
  const bound=()=>{
    if(!controller||controller.signal.aborted||runs.get(tabId)!==controller||!routes||routes.active!==frameId||
      !routes.injected.has(frameId)||!state?.page?.url)throw Error('توقف تشغيل محرر المعادلات أو تغير إطار السؤال.');
  };
  bound();
  const topOrigin=new URL(state.page.url).origin;
  await checkedTab(tabId,topOrigin);bound();
  const host=frameOrigin(sender.url,topOrigin);
  if(!host||!await framePermission(host,topOrigin))throw Error('لا يوجد إذن لإطار محرر المعادلات.');
  bound();
  if(!chrome.webNavigation?.getAllFrames)throw Error('تعذر التحقق من مستند محرر المعادلات.');
  const records=await chrome.webNavigation.getAllFrames({tabId});bound();
  const record=records?.find(entry=>entry.frameId===frameId);
  if(!record||record.errorOccurred||record.url!==message.expectedURL||
    sender.documentId&&record.documentId!==sender.documentId)throw Error('تغير مستند محرر المعادلات قبل إدخال الإجابة.');
  const target={tabId,...(sender.documentId?{documentIds:[sender.documentId]}:{frameIds:[frameId]})};
  const results=await chrome.scripting.executeScript({world:'MAIN',target,func:mathFieldMain,
    args:[message.operation,message.target,message.operation==='write'?message.value:null,message.expectedURL]});
  bound();await checkedTab(tabId,topOrigin);bound();
  if(!Array.isArray(results)||results.length!==1||results[0].frameId!==frameId||
    sender.documentId&&results[0].documentId!==sender.documentId)throw Error('تغير إطار محرر المعادلات أثناء الإدخال.');
  const result=results[0].result;
  if(!result||result.ok!==true)throw Error(typeof result?.error==='string'?result.error:'لم يؤكد محرر المعادلات التفاعل.');
  if(typeof result.value!=='string'||result.value.length>4096||typeof result.valid!=='boolean'||
    typeof result.disabled!=='boolean'||typeof result.readOnly!=='boolean')throw Error('رد محرر المعادلات غير صالح.');
  return {ok:true,value:result.value,valid:result.valid,disabled:result.disabled,readOnly:result.readOnly};
}
async function pageMessage(tabId,message,origin,signal,frameOverride,documentId) {
  if (signal) assertActive(signal);
  await checkedTab(tabId,origin);
  if (signal) assertActive(signal);
  const pageOnly=['ALEF_SCAN','ALEF_SELECT_SUBJECT','ALEF_OPEN_LESSON','ALEF_DIAGNOSTICS'].includes(message.type);
  const frameId=frameOverride??(pageOnly?0:routeState(tabId).active);
  const request={...message,...(frameId?{topCourseContext:true}:{})};
  let result;
  const target={frameId,...(documentId?{documentId}:{})};
  try { result = await chrome.tabs.sendMessage(tabId,request,target); }
  catch (error) {
    if (signal) assertActive(signal);
    if (['ALEF_APPLY','ALEF_SELECT_SUBJECT','ALEF_NEXT','ALEF_OPEN_LESSON','ALEF_NAVIGATE'].includes(message.type)) {
      // A navigation can close the response channel after a click already happened.
      // Never replay a mutation: doing so could submit an answer twice.
      await checkedTab(tabId,origin);
      if (message.type === 'ALEF_SELECT_SUBJECT') return {ok:true,selected:true};
      if (['ALEF_NEXT','ALEF_OPEN_LESSON','ALEF_NAVIGATE'].includes(message.type)) return {ok:true,clicked:true,uncertain:true};
      throw Object.assign(new Error('انقطع الاتصال أثناء تطبيق الإجابة. تحقق من آخر إرسال في ألف قبل إعادة البدء.'),{fatal:true});
    }
    await inject(tabId,origin,frameId);
    result = await chrome.tabs.sendMessage(tabId,request,target);
  }
  if (signal) assertActive(signal);
  if (!result || !result.ok) throw new Error(result?.error || 'تعذر الاتصال بصفحة ألف. أعد تحميل الصفحة والربط.');
  return result;
}
function checkedConfig(input) {
  if (!input || typeof input.token !== 'string' || !input.token.trim() || input.token.length > 4096) {
    throw new Error('أدخل رمز الربط المحلي في الإعدادات. ينسخه تشغيل START-WINDOWS.cmd إلى الحافظة.');
  }
  let url;
  try { url = new URL(input.serverUrl || 'http://127.0.0.1:4318'); }
  catch { throw new Error('عنوان الخادم المحلي غير صالح.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1','localhost'].includes(url.hostname) ||
    url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('عنوان الخادم يجب أن يكون محليًا مثل http://127.0.0.1:4318.');
  }
  const selectors = {};
  for (const name of ['subject','lesson','question','option','submit','next','completed','skip','assessment','nextLesson','back','finish']) {
    if (input.selectors?.[name] !== undefined) {
      if (typeof input.selectors[name] !== 'string' || input.selectors[name].length > 600) throw new Error('محدد الصفحة غير صالح.');
      selectors[name] = input.selectors[name];
    }
  }
  const confidence = Number(input.minConfidence ?? 0.85);
  if (!Number.isFinite(confidence) || confidence < 0.85 || confidence > 1) throw new Error('حد الثقة يجب أن يكون بين 0.85 و1.');
  if (input.qualityMode !== undefined && typeof input.qualityMode !== 'boolean') throw new Error('إعداد وضع الدقة غير صالح.');
  if (input.allowUncertain !== undefined && typeof input.allowUncertain !== 'boolean') throw new Error('إعداد المتابعة عند انخفاض الثقة غير صالح.');
  const qualityMode=input.qualityMode===true;
  return {serverUrl:url.origin,token:input.token.trim(),selectors,qualityMode,verify:qualityMode||input.verify !== false,allowUncertain:input.allowUncertain===true,
    autoSubmit:input.autoSubmit !== false,skipInstruction:input.skipInstruction !== false,minConfidence:confidence};
}
async function connect(tabId,selectors) {
  if (runs.has(tabId)||pendingStarts.has(tabId)) throw new Error('أوقف التشغيل قبل إعادة ربط الصفحة.');
  const tab = await checkedTab(tabId);
  await inject(tabId);
  const snapshot = await pageMessage(tabId,{type:'ALEF_SCAN',selectors},new URL(tab.url).origin);
  const state = await getState(tabId);
  state.page = snapshot.page;
  state.subjects = snapshot.subjects;
  await saveState(tabId);
  return {...snapshot,state};
}
async function inspect(tabId,config,origin,signal) {
  const top=await pageMessage(tabId,{type:'ALEF_INSPECT',selectors:config.selectors},origin,signal,0);
  const routes=routeState(tabId);
  // Inline dropdowns already belong to this document even before their menus
  // are inspected. Do not replace that preparation step with a loading child.
  if(top.question||top.needsPreparation||top.completed||['lessons','subjects'].includes(top.stage)||!chrome.webNavigation?.getAllFrames) {
    routes.active=0;return top;
  }
  const initial=(top.frames||[]).filter(frame=>frame.required===true);
  if(!initial.length){routes.active=0;return top;}
  let records;
  try {records=await chrome.webNavigation.getAllFrames({tabId});}catch{return top;}
  if(signal)assertActive(signal);
  if(!Array.isArray(records))return top;
  const pending=initial.map(frame=>({frame,parentId:null,depth:0})),seen=new Set(),candidates=[],inspected=[],blocked=[],issues=[];
  const depthOf=record=>{
    let depth=0,current=record;
    while(current&&current.frameId!==0&&depth<=6){depth++;current=records.find(item=>item.frameId===current.parentFrameId);}
    return current?.frameId===0?depth:Infinity;
  };
  let examined=0,unresolved=false;
  while(pending.length&&examined++<16) {
    const {frame,parentId,depth}=pending.shift();
    if(depth>5){unresolved=true;continue;}
    const source=records.filter(record=>record.frameId!==0&&depthOf(record)<=6&&
      (parentId===null||record.parentFrameId===parentId)&&
      (!frame.parentURL||cleanFrameURL(records.find(item=>item.frameId===record.parentFrameId)?.url)===frame.parentURL)&&
      (cleanFrameURL(record.url)===frame.url||['about','srcdoc','blob','data'].includes(frame.kind)&&
        record.url.startsWith(frame.kind==='srcdoc'?'about:srcdoc':`${frame.kind}:`)));
    if(!source.length)unresolved=true;
    // Frame IDs are not DOM indexes. A repeated URL cannot safely identify
    // which visible material owns an answer, so never pick an arbitrary match.
    if(source.length>1)throw new Error('تكرر عنوان إطار الدرس في أكثر من موضع. تعذّر تحديد السؤال الحالي بأمان.');
    for(const record of source) {
      if(seen.has(record.frameId))continue;seen.add(record.frameId);
      const related=/^(?:about:|blob:|data:)/i.test(record.url)&&['about','srcdoc','blob','data'].includes(frame.kind);
      const effectiveOrigin=frameOrigin(record.url,origin)||(related?frameOrigin(frame.initiatorOrigin||frame.origin,origin):null);
      if(!effectiveOrigin){unresolved=true;continue;}
      let permitted=routes.permissions.get(effectiveOrigin);
      if(permitted===undefined){permitted=await framePermission(effectiveOrigin,origin);routes.permissions.set(effectiveOrigin,permitted);}
      if(!permitted){if(!blocked.some(item=>item.origin===effectiveOrigin))blocked.push({origin:effectiveOrigin});continue;}
      const documentKey=`${record.frameId}:${record.documentId||cleanFrameURL(record.url)}`;
      try {
        if(!routes.documents.has(documentKey)) {
          await inject(tabId,origin,record.frameId);routes.documents.add(documentKey);
        }
        const controller=runs.get(tabId);
        if(controller&&routes.controller!==controller){routes.controller=controller;routes.begun.clear();}
        if(controller&&!routes.begun.has(documentKey)) {
          if(signal)assertActive(signal);
          await pageMessage(tabId,{type:'ALEF_BEGIN'},origin,signal,record.frameId);
          routes.begun.add(documentKey);
        }
        const child=await pageMessage(tabId,{type:'ALEF_INSPECT',selectors:config.selectors},origin,signal,record.frameId);
        inspected.push(child);
        const nested=(child.frames||[]).filter(item=>item.required===true);
        for(const inner of nested)pending.push({frame:inner,parentId:record.frameId,depth:depth+1});
        if(child.question||child.needsPreparation||child.completed||['complete','question'].includes(child.stage)||
          child.stage==='instruction'&&((child.navigation||[]).some(action=>action.kind!=='back')||child.loading)) {
          candidates.push({frameId:record.frameId,snapshot:child});
        }
      }catch(error) {
        if(signal?.aborted)throw aborted();
        if(error.fatal)throw error;
        issues.push('تعذّر الوصول إلى إطار الدرس بعد السماح له. قد يكون ما زال يحمّل أو يستخدم إطارًا معزولًا؛ أعد فحص الدرس.');
      }
    }
  }
  const state=await getState(tabId);
  if(blocked.length) {
    routes.active=0;state.blockedFrames=blocked;
    state.frameBlockedPage=lessonPageKey(top.page?.url);
    return {...top,permissionRequired:true,blockedFrames:blocked,
      diagnostics:[`يحتاج محتوى الدرس إذن Chrome للمصدر: ${blocked.map(item=>item.origin).join('، ')}. اضغط «السماح بمحتوى الدرس» في مُعين.`,...(top.diagnostics||[])]};
  }
  const questions=candidates.filter(item=>item.snapshot.question||item.snapshot.needsPreparation);
  if(questions.length>1)throw new Error('ظهر أكثر من سؤال في إطارات مختلفة. توقف الحل للحفاظ على تطابق الدرس والسؤال.');
  const selected=questions[0]||candidates.find(item=>item.snapshot.completed||item.snapshot.stage==='complete')||candidates[0];
  if(!selected) {
    routes.active=0;
    // Static instructional HTML can publish progress through the platform SDK
    // without exposing its own Next or completion marker. Once every required
    // document is readable and loaded, the parent's enabled ordinary controls
    // remain authoritative. An unread, loading or unsupported question never
    // uses this path.
    const parentNavigation=(top.navigation||[]).filter(action=>['next','finish','back'].includes(action.kind));
    if(!unresolved&&!pending.length&&!issues.length&&inspected.length&&
      inspected.every(child=>!child.loading&&['instruction','unknown'].includes(child.stage))&&
      parentNavigation.some(action=>['next','finish'].includes(action.kind))) {
      state.blockedFrames=[];
      return {...top,stage:'instruction',loading:false,framePending:false,navigation:parentNavigation,
        ...(top.transitionFingerprint&&inspected.every(child=>child.transitionFingerprint)?
          {transitionFingerprint:JSON.stringify([top.transitionFingerprint,...inspected.map(child=>child.transitionFingerprint)])}:{})};
    }
    // A material frame can mount as about:blank before its actual document is
    // visible to webNavigation. Let the bounded player-readiness wait handle it.
    return {...top,loading:true,framePending:true,
      diagnostics:issues.length?[...issues,...(top.diagnostics||[])]:top.diagnostics};
  }
  state.blockedFrames=[];
  const child=selected.snapshot;
  if(child.completed||child.stage==='complete') {
    // Completion inside an embedded material is only a component result. The
    // parent lesson's ordinary Next/Finish must still publish its progress.
    routes.active=0;
    const navigation=(top.navigation||[]).filter(action=>['next','finish','back'].includes(action.kind));
    return {...top,stage:'instruction',question:null,completed:false,
      loading:top.loading||!navigation.some(action=>['next','finish'].includes(action.kind)),
      frameResult:true,navigation,
      ...(top.transitionFingerprint&&child.transitionFingerprint?
        {transitionFingerprint:JSON.stringify([top.transitionFingerprint,selected.frameId,child.transitionFingerprint])}:{})};
  }
  routes.active=selected.frameId;
  const navigation=(child.navigation||[]).map(action=>({...action,frameId:selected.frameId,frameFingerprint:child.fingerprint}));
  navigation.push(...(top.navigation||[]).filter(action=>action.kind==='back').map(action=>({...action,frameId:0,frameFingerprint:top.fingerprint})));
  const selectedRecord=records.find(record=>record.frameId===selected.frameId);
  return {...child,page:top.page,subjects:top.subjects,lessons:[],completed:false,navigation,
    frameContext:{frameId:selected.frameId,origin:frameOrigin(selectedRecord?.url,origin),
      documentId:selectedRecord?.documentId||null,url:lessonPageKey(child.page?.url||selectedRecord?.url),
      topPageKey:lessonPageKey(top.page?.url)},
    fingerprint:`frame:${selected.frameId}:${child.fingerprint}`,
    ...(top.transitionFingerprint&&child.transitionFingerprint?
      {transitionFingerprint:JSON.stringify([top.transitionFingerprint,selected.frameId,child.transitionFingerprint])}:{}),
    diagnostics:child.diagnostics||[]};
}
const snapshotKey = snapshot => snapshot?.fingerprint || JSON.stringify([
  snapshot?.stage,snapshot?.question?.id,snapshot?.question?.fingerprint,snapshot?.completed,
  snapshot?.lessons?.map(item=>[item.id,item.locked,item.completed]),snapshot?.navigation?.map(item=>[item.id,item.kind]),snapshot?.catalog,
]);
// A spinner, disabled button or frame readyState can change before a click has
// advanced any actual content. Those changes must not authorize another Next.
const transitionKey = snapshot => snapshot?.transitionFingerprint || snapshotKey(snapshot);
const forwardAction = action => ['skip','next','finish','assessment'].includes(action.kind);
const actionKey = action => `${action.frameId||0}:${action.id}:${action.kind}`;
const newForwardAction = (snapshot,previous) => (snapshot?.navigation||[]).some(action=>forwardAction(action)&&
  !(previous.navigation||[]).some(before=>actionKey(before)===actionKey(action)));
const coreCatalog = snapshot => snapshot?.stage === 'lessons' && snapshot.catalog?.type === 'core-coursework';

async function prepareCatalog(tabId,initial,config,origin,signal,{expandAll=false,targetId}={}) {
  let snapshot=initial;
  const clicked=new Set();
  const expected=(await getState(tabId)).catalogClass;
  for(let step=0;step<100;step++) {
    assertActive(signal);
    if(!coreCatalog(snapshot))return snapshot;
    if(expected&&observedCoreClass(snapshot.page?.url)!==expected) {
      throw Object.assign(new Error('تغيرت المادة المرتبطة. أعد فحص المادة المطلوبة قبل المتابعة.'),{fatal:true});
    }
    if(snapshot.catalog.error)throw new Error(diagnostic(snapshot,'تعذّر تحميل قائمة المهام في ألف. أعد تحميل صفحة المادة ثم افحصها.'));
    const navigation=snapshot.navigation||[];
    // For You contains only recent items. Assigned + All includes unfinished
    // overdue work as well; the To Do filter alone would silently omit it.
    const tab=snapshot.catalog.tab;
    let action=tab!=='assigned'
      ? navigation.find(item=>item.kind==='catalog'&&item.catalogTab==='assigned') ||
        navigation.find(item=>item.kind==='catalog'&&item.catalogTab==='alllessons') : null;
    if(!action && tab==='assigned')action=navigation.find(item=>item.kind==='catalog'&&item.filter==='all');
    if(!action && (snapshot.catalog.loading || (!snapshot.lessons?.length && !snapshot.catalog.empty))) {
      snapshot=await waitSnapshot(tabId,config,origin,signal,item=>!coreCatalog(item)||
        (!item.catalog.loading && (!!item.lessons?.length||item.catalog.empty)));
      if(coreCatalog(snapshot) && (snapshot.catalog.loading || (!snapshot.lessons?.length&&!snapshot.catalog.empty))) {
        throw new Error('لم تكتمل قائمة المهام في ألف. انتظر ظهور الدروس ثم أعد البدء.');
      }
      continue;
    }
    if(!action && (expandAll || (targetId&&!snapshot.lessons?.some(item=>item.id===targetId)))) {
      action=navigation.find(item=>item.kind==='expand');
    }
    if(!action)return snapshot;
    const before=snapshotKey(snapshot);
    const identity=`${before}:${action.id}`;
    if(clicked.has(identity))throw new Error('لم تتغير قائمة المهام بعد الضغط. أوقف تكرار المحاولة؛ أعد فحص الصفحة.');
    clicked.add(identity);
    await emit(tabId,'status',action.kind==='expand'?'إظهار بقية المهام المتاحة…':
      action.filter==='all'?'عرض المهام المفتوحة والمتأخرة معًا…':'فتح قائمة المهام المسندة…');
    await navigate(tabId,snapshot,action,config,origin,signal);
    snapshot=await waitSnapshot(tabId,config,origin,signal,item=>snapshotKey(item)!==before&&item.stage!=='unknown'&&
      (!coreCatalog(item)||!item.catalog.loading));
    if(snapshotKey(snapshot)===before)throw new Error('لم تستجب قائمة المهام للانتقال. أعد فحص الصفحة بعد اكتمال تحميلها.');
  }
  throw new Error('وصل تحميل قائمة المهام إلى الحد المتاح. راجع القائمة قبل بدء جلسة جديدة.');
}
const sameQuestion = (snapshot,question) => snapshot?.question?.id === question.id &&
  snapshot.question.fingerprint === question.fingerprint;
const retryAction = snapshot => snapshot?.navigation?.find(action=>action.kind==='retry');
const retryRequired = snapshot => !!retryAction(snapshot)||snapshot?.feedback==='wrong'&&
  !snapshot.navigation?.some(action=>['next','finish'].includes(action.kind));
const retryAnswerKey = answer => answer.optionIds?.length?JSON.stringify([...answer.optionIds].sort()):answer.selections?.length?
  JSON.stringify(answer.selections.map(({fieldId,optionId})=>({fieldId,optionId})).sort((a,b)=>a.fieldId.localeCompare(b.fieldId))):answer.matches?
  JSON.stringify([...answer.matches].sort((a,b)=>a.itemId.localeCompare(b.itemId))):(answer.text||'').normalize('NFKC').trim();
function dropdownSelections(question,answer) {
  const fields=question.fields,selections=answer?.selections;
  if(!Array.isArray(fields)||fields.length<2||fields.length>20||new Set(fields.map(field=>field?.id)).size!==fields.length||
    fields.some(field=>typeof field?.id!=='string'||!field.id||!Array.isArray(field.options)||!field.options.length)||
    !Array.isArray(selections)||selections.length!==fields.length||
    new Set(selections.map(row=>row?.fieldId)).size!==selections.length)return null;
  const byField=new Map(selections.map(row=>[row?.fieldId,row]));
  const ordered=fields.map(field=>byField.get(field.id));
  return ordered.every((row,index)=>row&&fields[index].options.some(option=>option.id===row.optionId))?ordered:null;
}
function usableUncertainAnswer(question,answer){
  if(!answer||!Number.isFinite(answer.confidence)||answer.confidence<0||answer.confidence>1||
    !Array.isArray(answer.optionIds)||new Set(answer.optionIds).size!==answer.optionIds.length||
    typeof answer.text!=='string'||answer.text.length>8000)return false;
  if(['single','multiple'].includes(question.type))return answer.optionIds.length>0&&
    (question.type!=='single'||answer.optionIds.length===1)&&answer.optionIds.every(id=>question.options?.some(option=>option.id===id));
  if(answer.optionIds.length)return false;
  if(question.type==='text')return !!answer.text.trim();
  if(question.type==='dropdowns')return !!dropdownSelections(question,answer);
  if(question.type==='matching')return Array.isArray(answer.matches)&&answer.matches.length===question.items?.length&&
    answer.matches.length>0&&new Set(answer.matches.map(pair=>pair?.itemId)).size===answer.matches.length&&
    new Set(answer.matches.map(pair=>pair?.targetId)).size===answer.matches.length&&answer.matches.every(pair=>
      question.items.some(item=>item.id===pair?.itemId)&&question.targets?.some(target=>target.id===pair?.targetId));
  return false;
}
function fastRetryAnswer(question,previous,tried,retryNumber) {
  const base={optionIds:[],text:'',explanation:'محاولة سريعة بعد رفض الإجابة الأولى؛ لا تمثل حلًا جديدًا أو استعادة درجة السؤال.'};
  if(['single','multiple'].includes(question.type)) {
    const options=question.options||[];
    if(!options.length)return null;
    // Exhaust untried valid IDs first, then cycle them if the platform keeps
    // offering Try Again. Never generate a label or position as an option ID.
    const candidates=options.map(option=>({...base,optionIds:[option.id]}));
    const previousIndex=candidates.findIndex(answer=>retryAnswerKey(answer)===retryAnswerKey(previous));
    return candidates.find(answer=>!tried.has(retryAnswerKey(answer)))||candidates[
      previousIndex<0?(retryNumber-1)%candidates.length:(previousIndex+1)%candidates.length];
  }
  if(question.type==='dropdowns') {
    const ordered=dropdownSelections(question,previous);if(!ordered)return null;
    const indices=question.fields.map((field,index)=>field.options.findIndex(option=>option.id===ordered[index].optionId));
    let first;
    // Traverse complete combinations, not a global pool of option IDs. Two
    // fields may legitimately choose the same value, each from its own menu.
    for(let candidateIndex=0;candidateIndex<=tried.size;candidateIndex++) {
      for(let index=indices.length-1;index>=0;index--) {
        indices[index]=(indices[index]+1)%question.fields[index].options.length;
        if(indices[index])break;
      }
      const candidate={...base,selections:question.fields.map((field,index)=>({fieldId:field.id,optionId:field.options[indices[index]].id}))};
      first ||= candidate;
      if(!tried.has(retryAnswerKey(candidate)))return candidate;
    }
    return first;
  }
  if(question.type==='text')return typeof previous.text==='string'&&previous.text.trim()?{...base,text:previous.text}:null;
  if(question.type==='matching') {
    const pairs=previous.matches;
    if(!Array.isArray(pairs)||pairs.length!==question.items?.length||new Set(pairs.map(pair=>pair.itemId)).size!==pairs.length||
      new Set(pairs.map(pair=>pair.targetId)).size!==pairs.length||pairs.some(pair=>!question.items.some(item=>item.id===pair.itemId)||
        !question.targets?.some(target=>target.id===pair.targetId)))return null;
    return {...base,matches:pairs.map(({itemId,targetId})=>({itemId,targetId}))};
  }
  return null;
}
function questionContext(snapshot) {
  return {...(snapshot.frameContext||{}),frameId:snapshot.frameContext?.frameId||0,
    topPageKey:lessonPageKey(snapshot.page?.url)};
}
async function validateFrameLocation(tabId,context,origin,signal) {
  assertActive(signal);
  const tab=await checkedTab(tabId,origin);
  if(lessonPageKey(tab.url)!==context.topPageKey)throw Object.assign(new Error('تغير الدرس أثناء الحل. لم تُطبّق الإجابة على الصفحة الجديدة.'),{fatal:true});
  if(context.frameId&&chrome.webNavigation?.getAllFrames) {
    const frames=await chrome.webNavigation.getAllFrames({tabId});
    assertActive(signal);
    const current=frames?.find(frame=>frame.frameId===context.frameId);
    if(!current||(context.documentId&&current.documentId!==context.documentId)||
      context.url&&lessonPageKey(current.url)!==context.url) {
      throw Object.assign(new Error('تغير مستند إطار الدرس أثناء الحل. لم تُطبّق إجابة قديمة.'),{fatal:true});
    }
  }
}
async function validateQuestionContext(tabId,question,context,config,origin,signal) {
  await validateFrameLocation(tabId,context,origin,signal);
  const current=await inspect(tabId,config,origin,signal);
  if(!sameQuestion(current,question)||(current.frameContext?.frameId||0)!==context.frameId||
    context.documentId&&current.frameContext?.documentId!==context.documentId) {
    throw Object.assign(new Error('تغير السؤال الظاهر أثناء الحل. لم تُطبّق الإجابة السابقة.'),{fatal:true});
  }
}
async function waitSnapshot(tabId,config,origin,signal,predicate=()=>true,timeout=12000,{loadingTimeout=timeout}={}) {
  const started = Date.now();
  let last,budget=timeout;
  while (Date.now()-started < budget) {
    assertActive(signal);
    try {
      last = await inspect(tabId,config,origin,signal);
      // A player may mount its loading frame after an initially empty shell.
      // Promote the original deadline once; never restart it on later changes.
      if(last.loading===true||last.framePending===true)budget=Math.max(budget,loadingTimeout);
      if (predicate(last)) return last;
    } catch (error) {
      if (signal.aborted) throw aborted();
      if (error.fatal || !/Receiving end does not exist|Could not establish connection|Frame.*removed|Cannot access contents|No frame with id/i.test(error.message)) throw error;
    }
    await pause(250,signal);
  }
  return last || {stage:'unknown',question:null,completed:false,navigation:[],lessons:[]};
}
function pendingLessonPlayer(snapshot,config) {
  if(snapshot?.permissionRequired||snapshot?.completed||snapshot?.stage==='complete')return false;
  // Rejected answers can unmount or disable their inputs while keeping the
  // explicit retry control. That is feedback to handle, not a loading player.
  if(retryAction(snapshot)||snapshot?.feedback==='wrong')return false;
  // A real question can coexist with a persistent progress bar. That bar must
  // not turn a ready exercise into an endless loading state.
  if(snapshot?.stage==='question'&&snapshot.question||snapshot?.needsPreparation)return false;
  if(snapshot?.framePending)return true;
  const forward=(snapshot?.navigation||[]).some(action=>
    ['next','finish'].includes(action.kind)||config.skipInstruction&&action.kind==='skip'||
    action.kind==='assessment'&&action.sequential===true);
  if(forward)return false;
  // NCLE mounts its shell before the embedded question and may omit a spinner
  // during that gap. An empty instruction snapshot is not evidence that the
  // student must watch a video or interact manually.
  return snapshot?.loading===true||snapshot?.stage==='instruction';
}
function blockedLessonMessage(snapshot) {
  return snapshot?.diagnostics?.find(message=>typeof message==='string'&&
    /غير مسند|مقفل|not assigned|(?:^|\W)locked(?:\W|$)/i.test(message));
}
function diagnostic(snapshot,fallback) {
  return snapshot?.diagnostics?.find(item=>typeof item === 'string' && item.trim()) || fallback;
}
async function navigate(tabId,snapshot,action,config,origin,signal) {
  const context=snapshot.frameContext?.frameId===action.frameId?snapshot.frameContext:null;
  if(action.frameId>0) {
    await validateFrameLocation(tabId,{...context,frameId:action.frameId,
      topPageKey:lessonPageKey(snapshot.page?.url)},origin,signal);
  }
  return pageMessage(tabId,{type:'ALEF_NAVIGATE',actionId:action.id,
    fingerprint:action.frameFingerprint||snapshot.fingerprint,selectors:config.selectors},origin,signal,action.frameId,context?.documentId);
}
async function afterSubmission(tabId,question,config,origin,signal) {
  const started = Date.now();
  const clicked = new Set();
  let last,lastNavigation;
  while (Date.now()-started < 15000) {
    assertActive(signal);
    last = await inspect(tabId,config,origin,signal);
    if (retryRequired(last))return last;
    const terminal=last.permissionRequired||blockedLessonMessage(last)||last.completed||last.stage==='complete'||last.stage==='lessons';
    const accepted=last.feedback==='correct';
    const ready=terminal||last.question&&!sameQuestion(last,question)||last.needsPreparation;
    // A question may unmount before its Next transition finishes. Do not hand
    // that busy instruction shell to runLesson, whose own click history starts
    // before submission. A new ready question or a new forward control can
    // proceed immediately, even alongside a persistent progress indicator.
    if(lastNavigation&&!ready&&(last.loading||last.framePending)&&!newForwardAction(last,lastNavigation)) {
      await pause(250,signal);continue;
    }
    if(terminal||!accepted&&(ready||last.stage==='instruction'))return last;
    const action = last.navigation?.find(item=>['next','finish'].includes(item.kind));
    if (action) {
      const identity = `${transitionKey(last)}:${actionKey(action)}`;
      if (!clicked.has(identity)) {
        clicked.add(identity);
        lastNavigation=last;
        await navigate(tabId,last,action,config,origin,signal);
      }
    }
    await pause(250,signal);
  }
  return last ? {...last,...(lastNavigation||last.feedback==='correct'?{navigationPending:true}:{})} : {stage:'unknown',question:null,completed:false};
}
async function solve(question,subject,config,signal) {
  // Local models can take minutes on a CPU. Stop still aborts immediately.
  const timeout = AbortSignal.timeout(610000);
  let response;
  try {
    response = await fetch(`${config.serverUrl}/api/solve`,{
      method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${config.token}`},
      body:JSON.stringify({subject,question:{id:question.id,text:question.text,type:question.type,options:question.options,
        ...(question.answerFormat?{answerFormat:question.answerFormat}:{}),
        ...(question.requiresVision?{requiresVision:true,images:question.images||[]}:{}),
        ...(question.type==='dropdowns'?{fields:question.fields}:{}),
        ...(question.type==='matching'?{items:question.items,targets:question.targets}:{})},verify:config.verify,qualityMode:config.qualityMode,
        ...(config.allowUncertain?{allowUncertain:true}:{})}),
      signal:AbortSignal.any([signal,timeout]),
    });
  } catch (error) {
    if (signal.aborted) throw aborted();
    if (error.name === 'TimeoutError') throw error;
    throw new Error('تعذر الاتصال بالخادم المحلي. تأكد من تشغيله ومطابقة العنوان في الإعدادات.');
  }
  let result;
  try { result = await response.json(); } catch { throw new Error('رد الخادم المحلي غير صالح.'); }
  if (!response.ok) throw new Error(typeof result?.error?.message === 'string' ? result.error.message :
    typeof result?.error === 'string' ? result.error : 'تعذر حل السؤال. تحقق من إعدادات الخادم.');
  if (!result || typeof result !== 'object') throw new Error('الخادم لم يُرجع إجابة قابلة للقراءة.');
  return result;
}
async function checkLocalService(config,signal) {
  let response;
  try {
    response=await fetch(`${config.serverUrl}/api/health`,{
      signal:AbortSignal.any([signal,AbortSignal.timeout(7000)]),redirect:'error',
    });
  } catch {
    if(signal.aborted)throw aborted();
    throw Object.assign(new Error('تعذر الوصول إلى خادم مُعين المحلي. شغّل START-WINDOWS.cmd من مجلد مُعين على D واترك نافذته مفتوحة، ثم أعد فحص الاتصال. رمز الربط وحده لا يشغّل الخادم.'),{code:'local_server_unreachable'});
  }
  assertActive(signal);
  let health;
  try {health=await response.json();}catch{
    if(signal.aborted)throw aborted();
    throw new Error('العنوان المحلي لم يُرجع حالة خادم مُعين. شغّل START-WINDOWS.cmd وتأكد من عنوان الخادم في الإعدادات.');
  }
  assertActive(signal);
  if(!response.ok||health?.ok!==true||!['ollama','openai'].includes(health.provider)) {
    throw new Error('العنوان المحلي لا يخص خادم مُعين جاهزًا. شغّل START-WINDOWS.cmd ثم أعد فحص الاتصال.');
  }
  if(!(Number(health.protocolVersion)>=3)) {
    throw new Error('ملفات الخادم قديمة ولا تدعم إصلاح مطابقة الخيارات. أغلق نافذة START القديمة، وحدّث المشروع كاملًا بما فيه مجلد server، ثم شغّل START-WINDOWS.cmd من المشروع المحدّث.');
  }
  if(health.configured!==true||health.provider==='ollama'&&health.modelReady!==true) {
    throw new Error(typeof health.message==='string'&&health.message.trim()?health.message:
      'الخادم يعمل لكن النموذج غير جاهز. شغّل START-WINDOWS.cmd واتركه حتى يكتمل التجهيز ثم أعد فحص الاتصال.');
  }
}
async function checkAccuracyBackend(config,signal,requiresVision) {
  if (!config.backendHealth) {
    let response,health;
    try {
      response=await fetch(`${config.serverUrl}/api/health`,{signal:AbortSignal.any([signal,AbortSignal.timeout(7000)])});
      if(response.ok)health=await response.json();
    } catch(error) {
      if(signal.aborted)throw aborted();
      throw new Error('تعذر فحص خادم الدقة. شغّل START-WINDOWS.cmd من النسخة الجديدة ثم أعد البدء.');
    }
    if(!health?.ok || !(health.protocolVersion>=3)) {
      throw new Error('الخادم يعمل بنسخة قديمة لا تدعم إصلاح الخيارات الحالي. أغلق نافذة التشغيل القديمة وحدّث المشروع كاملًا ثم شغّل START-WINDOWS.cmd من النسخة الجديدة.');
    }
    config.backendHealth=health;
  }
  if(requiresVision&&config.backendHealth.visionReady!==true) {
    throw new Error(config.backendHealth.visionMessage||'النموذج البصري غير جاهز. شغّل START-WINDOWS.cmd من النسخة الجديدة لتجهيزه؛ لم يُرسل السؤال إلى نموذج نصّي.');
  }
}
async function checkDropdownBackend(config,signal,requiresVision) {
  await checkAccuracyBackend(config,signal,requiresVision);
  assertActive(signal);
  if(config.backendHealth.capabilities?.multiDropdown!==true) {
    throw new Error('الخادم الحالي لا يدعم السؤال الذي يحتوي على عدة قوائم. أغلق نافذة START القديمة، وحدّث المشروع كاملًا بما فيه مجلد server، ثم شغّل START-WINDOWS.cmd من النسخة الجديدة. لم تُرسل إجابة ناقصة.');
  }
}
async function checkMathFieldBackend(config,signal,requiresVision) {
  await checkAccuracyBackend(config,signal,requiresVision);
  assertActive(signal);
  if(config.backendHealth.capabilities?.mathField!==true) {
    throw new Error('الخادم الحالي لا يدعم إدخال المعادلات. أغلق نافذة START القديمة، وحدّث المشروع كاملًا بما فيه مجلد server، ثم شغّل START-WINDOWS.cmd من النسخة الجديدة.');
  }
}
async function checkUncertainBackend(config,signal,requiresVision){
  await checkAccuracyBackend(config,signal,requiresVision);
  assertActive(signal);
  if(config.backendHealth.capabilities?.uncertainAnswers!==true)throw new Error('الخادم الحالي لا يدعم المتابعة عند انخفاض الثقة. حدّث المشروع كاملًا وأعد تشغيل START-WINDOWS.cmd من النسخة الجديدة.');
}
async function captureQuestionImages(tabId,question,config,origin,signal,context) {
  await validateQuestionContext(tabId,question,context,config,origin,signal);
  const capture=await pageMessage(tabId,{type:'ALEF_GET_VISUALS',questionId:question.id,
    questionFingerprint:question.fingerprint,selectors:config.selectors},origin,signal,context.frameId,context.documentId);
  if(capture.questionId!==question.id||capture.questionFingerprint!==question.fingerprint ||
    !Array.isArray(capture.images)||!capture.images.length||capture.images.length>3 ||
    capture.images.some(image=>!image||typeof image.data!=='string'||!image.data.length||image.data.length>1_398_104)) {
    throw new Error('لم تُلتقط جميع صور السؤال بوضوح. توقف الحل بدل إرسال نص ناقص.');
  }
  const labels=capture.images.map((image,index)=>({image:index+1,description:String(image.alt||'').slice(0,600),
    ...(image.optionId?{optionId:image.optionId}: {})}));
  // Pixel data only lives in this request. Never persist it in run events or
  // the dashboard's current question, including while retrying an answer.
  return {...question,requiresVision:true,images:capture.images.map(image=>image.data),
    text:question.text+'\n\nAttached visual evidence (image order and optional option IDs):\n'+JSON.stringify(labels)};
}
function updateQueue(state,snapshot) {
  for (const lesson of snapshot.lessons || []) {
    if (!lesson?.id || !lesson.name) continue;
    let item = state.queue.find(row=>row.id===lesson.id);
    const available = lesson.locked ? 'locked' : lesson.completed ? 'alreadycompleted' : 'pending';
    if (!item) {
      if (state.queue.length >= 250) continue;
      item = {id:lesson.id,name:lesson.name,status:available};
      state.queue.push(item);
    } else if (['pending','locked','alreadycompleted'].includes(item.status)) {
      item.status = available;
      item.name = lesson.name;
    }
    if (lesson.href) item.href = lesson.href;
    // Core coursework and Pathways have different loading/navigation rules.
    // Preserve the adapter's observed kind instead of treating every catalog
    // left on screen during a route transition as a nested Pathways activity.
    if (lesson.kind) item.kind = lesson.kind;
  }
  state.stats.lessonsTotal = state.queue.filter(item=>!['locked','alreadycompleted'].includes(item.status)).length;
}
async function runLesson(tabId,subject,initial,lesson,config,origin,signal,state) {
  let snapshot = initial;
  let introActions = 0;
  const seenQuestions = new Set();
  const clicked = new Set();
  let lastSubmitted = null;
  let retryState = null;
  while (true) {
    assertActive(signal);
    if(snapshot.navigationPending)return {review:true,snapshot,
      message:'لم يكتمل الانتقال بعد إرسال الإجابة. توقف التشغيل في الدرس الحالي دون تكرار زر التالي.'};
    if(snapshot.permissionRequired)return {review:true,blocking:true,snapshot,cause:'frame_permission_required',
      message:diagnostic(snapshot,'يحتاج محتوى الدرس إذن Chrome. اضغط «السماح بمحتوى الدرس» في مُعين ثم تابع الدرس الحالي.')};
    const blocked=blockedLessonMessage(snapshot);
    if(blocked)return {review:true,blocking:true,snapshot,cause:'lesson_locked',message:blocked};
    if(pendingLessonPlayer(snapshot,config)) {
      let explicitLoading=snapshot.loading===true||snapshot.framePending===true;
      const timeout=explicitLoading?30000:12000;
      await emit(tabId,'status',explicitLoading?'انتظار اكتمال تحميل محتوى الدرس…':
        'انتظار ظهور السؤال أو أدوات متابعة الدرس…',{phase:explicitLoading?'loading':'waiting_controls'});
      snapshot=await waitSnapshot(tabId,config,origin,signal,item=>{
        explicitLoading ||= item.loading===true||item.framePending===true;
        return item.permissionRequired||blockedLessonMessage(item)||
          !pendingLessonPlayer(item,config)&&!['unknown','subjects'].includes(item.stage);
      },timeout,{loadingTimeout:30000});
      if(snapshot.permissionRequired||blockedLessonMessage(snapshot))continue;
      if(pendingLessonPlayer(snapshot,config)||['unknown','subjects'].includes(snapshot.stage)) {
        const timeoutMessage=explicitLoading?'لم يكتمل تحميل محتوى الدرس خلال 30 ثانية. توقف التشغيل في الدرس الحالي؛ انتظر ظهوره ثم أعد المحاولة.':
          'تعذّرت قراءة السؤال أو العثور على زر متابعة مفعّل خلال 12 ثانية. بقي التشغيل على الدرس الحالي؛ صدّر فحص الصفحة لتحديد عناصره.';
        const issue=diagnostic(snapshot,'');
        return {review:true,blocking:true,snapshot,
          message:issue?`${issue} ${timeoutMessage}`:timeoutMessage};
      }
      continue;
    }
    if (snapshot.completed || snapshot.stage === 'complete' ||
      (snapshot.stage === 'lessons' && snapshot.lessons?.some(item=>item.id===lesson.id && item.completed))) {
      return {completed:true,snapshot};
    }
    if(snapshot.stage==='lessons') {
      if (lesson.kind==='core-lesson' || coreCatalog(snapshot)) {
        return {review:true,snapshot,message:'عاد الموقع إلى قائمة الدروس قبل تأكيد اكتمال الدرس الحالي. توقّف الحل في هذا الدرس ولم يفتح درسًا آخر.'};
      }
      // A Pathways level contains several learning activities sharing one level
      // assessment. Enter one available activity, then use the visible Practice
      // control. The outer queue advances to the next level after completion.
      const child=snapshot.lessons?.find(item=>!item.locked&&!item.completed);
      if(!child)return {review:true,snapshot,message:'لا يوجد نشاط مفتوح يوصل إلى تدريب هذا المستوى.'};
      const step=`child:${snapshot.fingerprint}:${child.id}`;
      if(clicked.has(step))return {review:true,snapshot,message:'لم يفتح نشاط المستوى؛ أوقف تكرار الضغط.'};
      clicked.add(step);
      await pageMessage(tabId,{type:'ALEF_OPEN_LESSON',lessonId:child.id,fingerprint:snapshot.fingerprint,selectors:config.selectors},origin,signal);
      const before=snapshotKey(snapshot);
      snapshot=await waitSnapshot(tabId,config,origin,signal,item=>snapshotKey(item)!==before&&item.stage!=='unknown');
      continue;
    }
    if(retryRequired(snapshot)) {
      const retry=retryAction(snapshot);
      if(!retry||!lastSubmitted||snapshot.question&&!sameQuestion(snapshot,lastSubmitted.question))return {review:true,snapshot,
        message:'لم يظهر زر إعادة محاولة مرتبط بآخر إجابة مُرسلة؛ توقف التشغيل في السؤال الحالي.'};
      const context=lastSubmitted.context;
      await validateFrameLocation(tabId,context,origin,signal);
      if((snapshot.frameContext?.frameId||0)!==context.frameId||context.documentId&&snapshot.frameContext?.documentId!==context.documentId)
        return {review:true,snapshot,message:'تغير إطار السؤال قبل إعادة المحاولة؛ لم تُطبّق إجابة على إطار آخر.'};
      if(!retryState||!sameQuestion({question:retryState.question},lastSubmitted.question))retryState={question:lastSubmitted.question,
        retries:0,tried:new Set([retryAnswerKey(lastSubmitted.answer)])};
      if(retryState.retries>=20)return {review:true,snapshot,cause:'retry_limit',message:'وصل السؤال إلى حد 20 محاولة سريعة دون انتقال. توقف التشغيل في السؤال الحالي.'};
      const retryNumber=retryState.retries+1;
      await emit(tabId,'status',`المحاولة السريعة ${retryNumber}: ضغط إعادة المحاولة قبل الإجابة…`,{phase:'retrying',retryAttempt:true,retryNumber});
      await navigate(tabId,snapshot,retry,config,origin,signal);
      snapshot=await waitSnapshot(tabId,config,origin,signal,item=>item.permissionRequired||blockedLessonMessage(item)||item.completed||item.stage==='complete'||
        !retryAction(item)&&item.feedback!=='wrong'&&(item.question||item.needsPreparation),6000);
      if(snapshot.permissionRequired||blockedLessonMessage(snapshot)||snapshot.completed||snapshot.stage==='complete')continue;
      if(retryAction(snapshot)||snapshot.feedback==='wrong')return {review:true,snapshot,message:'لم يستجب زر إعادة المحاولة؛ لم تُكرر النقرة أو تُرسل إجابة قبل فتح السؤال.'};
      if(snapshot.needsPreparation) {
        await pageMessage(tabId,{type:'ALEF_PREPARE_QUESTION',selectors:config.selectors},origin,signal);
        snapshot=await inspect(tabId,config,origin,signal);
      }
      if(!snapshot.question||!sameQuestion(snapshot,retryState.question))return {review:true,snapshot,
        message:'تغير السؤال بعد إعادة المحاولة؛ لم تُرسل محاولة سريعة إلى سؤال مختلف.'};
      if((snapshot.frameContext?.frameId||0)!==context.frameId||context.documentId&&snapshot.frameContext?.documentId!==context.documentId)
        return {review:true,snapshot,message:'تغير إطار السؤال بعد إعادة المحاولة؛ لم تُطبّق إجابة على إطار آخر.'};
      const question=snapshot.question,answer=fastRetryAnswer(question,lastSubmitted.answer,retryState.tried,retryNumber);
      if(!answer)return {review:true,snapshot,message:'تعذرت مطابقة المحاولة السريعة مع أدوات السؤال الحالية. بقي التشغيل في السؤال الحالي.'};
      const currentContext=questionContext(snapshot);
      await validateFrameLocation(tabId,context,origin,signal);
      await validateQuestionContext(tabId,question,currentContext,config,origin,signal);
      await emit(tabId,'answer',`تطبيق محاولة سريعة بعد الرفض (${retryNumber})…`,{question,answer,retryAttempt:true,retryNumber});
      const applied=await pageMessage(tabId,{type:'ALEF_APPLY',questionId:question.id,questionFingerprint:question.fingerprint,
        answer,selectors:config.selectors,autoSubmit:config.autoSubmit},origin,signal,currentContext.frameId,currentContext.documentId);
      if(!applied.submitted)return {review:true,blocking:true,snapshot,question,answer,applied:applied.applied===true,
        message:applied.reason||'تم اختيار المحاولة السريعة دون إرسال مؤكد. توقف التشغيل في السؤال الحالي.'};
      retryState.retries++;retryState.tried.add(retryAnswerKey(answer));state.stats.solved++;
      lastSubmitted={question,answer,context:currentContext};
      await emit(tabId,'submitted',`أُرسلت محاولة سريعة بعد الرفض (${retryNumber})؛ انتظار نتيجة ألف…`,
        {question,answer,applied:true,submitted:true,retryAttempt:true,retryNumber});
      snapshot=await afterSubmission(tabId,question,config,origin,signal);
      continue;
    }
    if(snapshot.needsPreparation) {
      await pageMessage(tabId,{type:'ALEF_PREPARE_QUESTION',selectors:config.selectors},origin,signal);
      snapshot=await inspect(tabId,config,origin,signal);
      if(snapshot.needsPreparation)return {review:true,snapshot,message:'لم تظهر خيارات القائمة المنسدلة بوضوح.'};
      continue;
    }
    if(snapshot.feedback==='correct'&&snapshot.question){
      // An accepted field can remain on screen when resuming a lesson. Its
      // feedback is navigation state, never another request to solve it.
      await emit(tabId,'status','قُبلت الإجابة؛ الانتقال إلى السؤال التالي…',{phase:'advancing'});
      snapshot=await afterSubmission(tabId,snapshot.question,config,origin,signal);
      continue;
    }
    if (snapshot.stage === 'question' && snapshot.question) {
      const question = snapshot.question;
      const context=questionContext(snapshot);
      const identity = `${question.id}:${question.fingerprint}`;
      if (seenQuestions.has(identity)) return {review:true,snapshot,message:'لم ينتقل الموقع إلى سؤال جديد. راجع نتيجة آخر إرسال.'};
      if (state.stats.total >= 1000) return {review:true,blocking:true,snapshot,message:'وصل التشغيل إلى حد 1000 سؤال. افحص التقدم ثم ابدأ جلسة جديدة.'};
      seenQuestions.add(identity);
      state.stats.total++;
      await emit(tabId,'question',question.requiresVision?'قراءة الرسم أو الصورة ثم حل السؤال ومراجعة النتيجة…':
        config.qualityMode?'جارٍ حل السؤال بوضع الدقة الأعلى…':config.verify?'جارٍ حل السؤال ثم التحقق بحل ثانٍ…':'جارٍ حل السؤال بالوضع السريع…',{question});
      let result;
      let requestQuestion=question;
      if(question.answerFormat==='latex')await checkMathFieldBackend(config,signal,question.requiresVision);
      else if(question.type==='dropdowns')await checkDropdownBackend(config,signal,question.requiresVision);
      else if(config.qualityMode||question.requiresVision)await checkAccuracyBackend(config,signal,question.requiresVision);
      if(config.allowUncertain)await checkUncertainBackend(config,signal,question.requiresVision);
      if(question.requiresVision)requestQuestion=await captureQuestionImages(tabId,requestQuestion,config,origin,signal,context);
      const solveStarted=Date.now();
      try { result = await solve(requestQuestion,subject.name,config,signal); }
      catch (error) { error.fatal = true;throw error; }
      assertActive(signal);
      const answer = result.answer;
      const uncertaintyReason=['low_confidence','verification_disagreement'].includes(result.reason)?result.reason:
        !result.needsReview&&Number.isFinite(answer?.confidence)&&answer.confidence<config.minConfidence?'low_confidence':null;
      const uncertainAnswer=config.allowUncertain&&!!uncertaintyReason&&usableUncertainAnswer(question,answer);
      const uncertainty=uncertainAnswer?{uncertainAnswer:true,uncertaintyReason,verified:result.verified===true}:{};
      if(config.allowUncertain&&uncertaintyReason&&!uncertainAnswer)return {review:true,snapshot,question,answer,cause:'invalid_selection',
        message:'لم يُرجع النموذج إجابة كاملة قابلة للإدخال؛ تعذّر إرسال جواب فارغ أو خيارات لا تنتمي إلى السؤال.'};
      if (!uncertainAnswer&&(result.needsReview || !answer || !Number.isFinite(answer.confidence) || answer.confidence < config.minConfidence || (config.verify && result.verified !== true))) {
        return {review:true,snapshot,question,answer,cause:result.reason||'answer_requires_review',message:reviewMessages[result.reason] ||
          'الإجابة تحتاج مراجعة: الثقة منخفضة أو لم تتفق عمليتا الحل والتحقق.'};
      }
      if(question.type==='dropdowns'&&!dropdownSelections(question,answer))return {review:true,snapshot,question,answer,
        cause:'invalid_selection',message:'إجابات القوائم لا تطابق فراغات السؤال؛ لم تُطبّق إجابة على قائمة أخرى.'};
      const solveDurationMs=Date.now()-solveStarted;
      await emit(tabId,'answer',uncertainAnswer?'تطبيق أفضل إجابة متاحة رغم عدم التأكد، حسب إعداد المتابعة…':
        `وصلت الإجابة خلال ${(solveDurationMs/1000).toFixed(1)} ثانية؛ جارٍ مطابقتها مع السؤال الظاهر.`,{question,answer,solveDurationMs,...uncertainty});
      assertActive(signal);
      await validateQuestionContext(tabId,question,context,config,origin,signal);
      const applied = await pageMessage(tabId,{type:'ALEF_APPLY',questionId:question.id,
        questionFingerprint:question.fingerprint,answer,selectors:config.selectors,autoSubmit:config.autoSubmit},origin,signal,context.frameId,context.documentId);
      if (!applied.submitted) {
        return {review:true,blocking:true,snapshot,question,answer,...uncertainty,applied:applied.applied===true,message:applied.reason ||
          'تم اختيار الإجابة. راجعها وأرسلها يدويًا؛ الإرسال التلقائي متوقف.'};
      }
      state.stats.solved++;
      retryState=null;
      lastSubmitted={question,answer,context};
      await emit(tabId,'submitted',uncertainAnswer?'أُرسلت إجابة غير مؤكدة حسب إعداد المتابعة. انتظار السؤال التالي…':
        'أُرسلت الإجابة. انتظار السؤال التالي…',{question,answer,applied:true,submitted:true,...uncertainty});
      await pause(300,signal);
      snapshot = await afterSubmission(tabId,question,config,origin,signal);
      continue;
    }
    if (snapshot.stage === 'instruction') {
      const kinds = config.skipInstruction ? ['skip','next','finish','assessment'] : ['next','finish','assessment'];
      const action = kinds.map(kind=>snapshot.navigation?.find(item=>item.kind===kind &&
        (kind!=='assessment'||item.sequential===true))).find(Boolean);
      if (!action) return {review:true,snapshot,message:diagnostic(snapshot,'لم يظهر سؤال مدعوم أو زر متابعة مفعّل. بقي التشغيل على الدرس الحالي ولم يُفتح درس آخر.')};
      const identity = `${transitionKey(snapshot)}:${actionKey(action)}`;
      if (clicked.has(identity)) return {review:true,snapshot,message:'لم يتغير الدرس بعد الانتقال. أوقف تكرار الضغط لمراجعة الصفحة.'};
      if (introActions >= 250) return {review:true,snapshot,message:'وصل الدرس إلى حد 250 خطوة في المحتوى. توقّف التشغيل في الدرس الحالي للمراجعة.'};
      clicked.add(identity);
      introActions++;
      await emit(tabId,'status',action.kind === 'skip' ? 'تجاوز المقدمة بالزر الظاهر في الدرس…' : 'الانتقال إلى نشاط الدرس…');
      const previous = snapshot;
      await navigate(tabId,snapshot,action,config,origin,signal);
      snapshot = await waitSnapshot(tabId,config,origin,signal,item=>item.stage!=='unknown'&&
        (transitionKey(item)!==transitionKey(previous)||newForwardAction(item,previous)),12000,{loadingTimeout:30000});
      continue;
    }
    return {review:true,snapshot,message:diagnostic(snapshot,
      snapshot.stage === 'question' ? 'السؤال الظاهر يحتاج تفاعلًا غير مدعوم. لم تُرسل إجابة.' :
        'لم أجد سؤالًا أو خطوة انتقال مدعومة في هذا الدرس. يحتاج مراجعة يدوية.')};
  }
}
async function returnToCatalog(tabId,config,origin,signal,state,previous) {
  let snapshot = previous || await inspect(tabId,config,origin,signal);
  const isCatalog=item=>(coreCatalog(item)&&(!state.catalogClass||observedCoreClass(item.page?.url)===state.catalogClass))||
    (!coreCatalog(item)&&item?.stage==='lessons'&&item.lessons?.some(lesson=>state.queue.some(row=>row.id===lesson.id)));
  if (isCatalog(snapshot)) return snapshot;
  const back = snapshot.navigation?.find(item=>item.kind==='back');
  if (back) {
    await emit(tabId,'status','العودة إلى قائمة دروس المادة…');
    await navigate(tabId,snapshot,back,config,origin,signal);
    snapshot = await waitSnapshot(tabId,config,origin,signal,item=>['lessons','subjects'].includes(item.stage),6000);
    if (isCatalog(snapshot)) return snapshot;
    if (snapshot.stage === 'subjects' && snapshot.subjects?.some(item=>item.id===state.subjectId)) {
      await pageMessage(tabId,{type:'ALEF_SELECT_SUBJECT',subjectId:state.subjectId,selectors:config.selectors},origin,signal);
      snapshot = await waitSnapshot(tabId,config,origin,signal,item=>item.stage==='lessons',6000);
      if (isCatalog(snapshot)) return snapshot;
    }
  }
  if (!state.catalogURL) return null;
  const tab = await checkedTab(tabId,origin);
  const destination = new URL(state.catalogURL);
  if (destination.origin !== origin || tab.url === destination.href) return null;
  // This URL was observed on this subject's actual catalog. Do not use history.back
  // or guess route names: either can leave the user's selected course.
  assertActive(signal);
  await chrome.tabs.update(tabId,{url:destination.href});
  assertActive(signal);
  snapshot = await waitSnapshot(tabId,config,origin,signal,isCatalog,12000);
  return isCatalog(snapshot) ? snapshot : null;
}
async function run(tabId,subjectId,config,controller,resumeLessonId=null) {
  const signal = controller.signal;
  const state = await getState(tabId);
  const origin = new URL(state.page.url).origin;
  const subject = state.subjects.find(item=>item.id===subjectId);
  const keepAlive = setInterval(()=>chrome.runtime.getPlatformInfo().catch(()=>{}),20000);
  try {
    let snapshot,catalogMode;
    if(resumeLessonId) {
      await emit(tabId,'status','متابعة الدرس الحالي بعد السماح بمحتواه…');
      snapshot=await waitSnapshot(tabId,config,origin,signal,item=>item.permissionRequired||!['unknown','subjects'].includes(item.stage));
      catalogMode=Boolean(state.catalogURL);
    } else {
      await emit(tabId,'status',`فتح ${subject.name} وجمع الدروس المفتوحة…`);
      await pageMessage(tabId,{type:'ALEF_SELECT_SUBJECT',subjectId,selectors:config.selectors},origin,signal);
      await pause(250,signal);
      snapshot = await waitSnapshot(tabId,config,origin,signal,item=>!['unknown','subjects'].includes(item.stage));
      state.catalogClass=coreCatalog(snapshot)?observedCoreClass(snapshot.page?.url):null;
      // Start with the available tasks instead of paging through a long catalog
      // before the first answer. Refill the queue before reporting completion.
      snapshot = await prepareCatalog(tabId,snapshot,config,origin,signal);
      catalogMode = snapshot.stage === 'lessons';
      if (catalogMode) {
        state.catalogURL = snapshot.page?.url || (await checkedTab(tabId,origin)).url;
        updateQueue(state,snapshot);
      } else if (['question','instruction','complete'].includes(snapshot.stage)||snapshot.permissionRequired) {
        state.queue = [{id:'current-exercise',name:subject.name,status:'pending',implicit:true}];
        state.stats.lessonsTotal = 1;
      } else {
        state.stats.review++;
        await emit(tabId,'review',diagnostic(snapshot,'لم أجد قائمة دروس أو نشاطًا مدعومًا. افتح صفحة المادة ثم أعد الربط.'),{blocking:true});
        return;
      }
      await emit(tabId,'queue',`عُثر على ${state.stats.lessonsTotal} درس مفتوح غير مكتمل.`);
    }
    for (let lessonLimit=0;lessonLimit<250;lessonLimit++) {
      assertActive(signal);
      let lesson = resumeLessonId?state.queue.find(item=>item.id===resumeLessonId):state.queue.find(item=>item.status==='pending');
      if(!lesson&&catalogMode&&coreCatalog(snapshot)&&snapshot.navigation?.some(item=>item.kind==='expand')) {
        state.currentLesson=null;
        snapshot=await prepareCatalog(tabId,snapshot,config,origin,signal,{expandAll:true});
        updateQueue(state,snapshot);
        await emit(tabId,'queue','إضافة بقية المهام المتاحة إلى قائمة الحل…');
        lesson=state.queue.find(item=>item.status==='pending');
      }
      if (!lesson) {
        state.currentLesson = null;
        await emit(tabId,'complete',state.stats.lessonsReview
          ? `انتهت معالجة الدروس المتاحة. اكتمل ${state.stats.lessonsCompleted} درس، ويحتاج ${state.stats.lessonsReview} إلى مراجعة.`
          : state.stats.lessonsCompleted ? `اكتملت الدروس المفتوحة التي أمكن الوصول إليها (${state.stats.lessonsCompleted}).`
            : 'لا توجد دروس مفتوحة غير مكتملة في القائمة الظاهرة. الدروس المقفلة تبقى دون تغيير.');
        return;
      }
      lesson.status = 'running';
      state.currentLesson = lesson;
      const resuming=lesson.id===resumeLessonId;
      resumeLessonId=null;
      await emit(tabId,'lesson',`${resuming?'متابعة':'بدء'} درس: ${lesson.name}`);
      let outcome;
      try {
        if (catalogMode&&!resuming) {
          if (snapshot.stage !== 'lessons') snapshot = await returnToCatalog(tabId,config,origin,signal,state,snapshot);
          if (!snapshot) throw Object.assign(new Error('تعذرت العودة الآمنة إلى قائمة الدروس. افتح قائمة المادة ثم أعد البدء.'),{fatal:true});
          snapshot = await prepareCatalog(tabId,snapshot,config,origin,signal,{targetId:lesson.id});
          await pageMessage(tabId,{type:'ALEF_OPEN_LESSON',lessonId:lesson.id,
            fingerprint:snapshot.fingerprint,selectors:config.selectors},origin,signal);
          const previous = snapshotKey(snapshot);
          snapshot = await waitSnapshot(tabId,config,origin,signal,item=>snapshotKey(item)!==previous && item.stage!=='unknown'&&
            (lesson.kind!=='core-lesson'||item.stage!=='lessons'));
          if(lesson.kind==='core-lesson'&&snapshot.stage==='lessons')throw new Error('لم يفتح محتوى الدرس بعد. انتظر اكتمال تحميله ثم أعد البدء.');
        }
        outcome = await runLesson(tabId,subject,snapshot,lesson,config,origin,signal,state);
      } catch (error) {
        if (signal.aborted || error.name === 'AbortError') throw error;
        if (error.fatal) throw error;
        outcome = {review:true,message:error.message,snapshot:await inspect(tabId,config,origin,signal)};
      }
      snapshot = outcome.snapshot;
      if (outcome.completed) {
        lesson.status = 'completed';
        state.stats.lessonsCompleted++;
        await emit(tabId,'lesson',`اكتمل درس: ${lesson.name}`);
      } else {
        lesson.status = 'review';lesson.reason = outcome.message;
        if(outcome.cause)lesson.reviewCause=outcome.cause;else delete lesson.reviewCause;
        state.stats.review++;state.stats.lessonsReview++;
        // An unresolved lesson is not a successful queue item. Keep the page
        // and all later pending lessons intact so a failed control, loading
        // issue or uncertain answer cannot cause a rapid tour of the course.
        await emit(tabId,'review',outcome.message,{blocking:true,...(outcome.cause?{cause:outcome.cause}:{}),
          question:outcome.question||snapshot?.question,answer:outcome.answer,
          ...(outcome.uncertainAnswer?{uncertainAnswer:true,uncertaintyReason:outcome.uncertaintyReason,verified:outcome.verified===true}:{}),
          ...(outcome.applied!==undefined?{applied:outcome.applied,submitted:false}:{})});return;
      }
      if (!catalogMode) {
        state.currentLesson = null;
        await emit(tabId,'complete','اكتملت الأسئلة الظاهرة لهذا النشاط.');return;
      }
      let catalog = await returnToCatalog(tabId,config,origin,signal,state,snapshot);
      if (!catalog) {
        if (state.queue.some(item=>item.status==='pending') || !outcome.completed) {
          await emit(tabId,'review',outcome.message || 'اكتمل الدرس الحالي، لكن تعذرت العودة الآمنة إلى بقية دروس المادة.',{blocking:true});return;
        }
      } else {
        catalog = await prepareCatalog(tabId,catalog,config,origin,signal);
        snapshot = catalog;
        state.catalogURL = snapshot.page?.url || state.catalogURL;
        updateQueue(state,snapshot);
        await emit(tabId,'queue','تحديث قائمة الدروس ومتابعة الدرس التالي…');
      }
    }
    await emit(tabId,'review','وصل التشغيل إلى حد 250 درسًا. افحص التقدم ثم ابدأ جلسة جديدة.',{blocking:true});
  } catch (error) {
    if (signal.aborted || error.name === 'AbortError') {
      if (state.status !== 'stopped') await emit(tabId,'stopped','تم إيقاف الحل.');
    } else {
      state.stats.review++;
      if (state.currentLesson?.status === 'running') {
        state.currentLesson.status = 'review';state.currentLesson.reason = error.message;
        state.stats.lessonsReview++;
      }
      await emit(tabId,'error',error.name === 'TimeoutError' ? 'انتهت مهلة الحل. تحقق من الخادم ثم أعد المحاولة.' : error.message || 'تعذر متابعة التشغيل.');
    }
  } finally {
    clearInterval(keepAlive);
    if(runs.get(tabId)===controller){runs.delete(tabId);state.running=false;}
    await saveState(tabId);
  }
}
async function handle(message) {
  const tabId = checkedTabId(message.tabId);
  switch(message.type) {
    case 'CONNECT':
    case 'SCAN': return connect(tabId,message.selectors);
    case 'GET_STATE': return {ok:true,state:await getState(tabId)};
    case 'DIAGNOSTICS': {
      const tab=await checkedTab(tabId);
      const origin=new URL(tab.url).origin;
      const result=await pageMessage(tabId,{type:'ALEF_DIAGNOSTICS'},origin,undefined,0);
      const injected=frameRoutes.get(tabId)?.injected;
      const embedded=[];
      if(injected?.size>1&&chrome.webNavigation?.getAllFrames) {
        const records=await chrome.webNavigation.getAllFrames({tabId});
        for(const record of records||[]) {
          if(!record.frameId||!injected.has(record.frameId)||embedded.length>=8)continue;
          const host=frameOrigin(record.url,origin);
          if(!host||!await framePermission(host,origin))continue;
          try {
            const child=await pageMessage(tabId,{type:'ALEF_DIAGNOSTICS'},origin,undefined,record.frameId,record.documentId);
            embedded.push({frameId:record.frameId,diagnostics:child.diagnostics});
          } catch {embedded.push({frameId:record.frameId,issue:'تعذرت قراءة أدوات إطار الدرس وقت الفحص.'});}
        }
      }
      const state=await getState(tabId);
      const questionEvent=[...state.events].reverse().find(event=>event.question?.text);
      const reviewEvent=[...state.events].reverse().find(event=>['review','error'].includes(event.kind));
      const lessonInfo=lesson=>lesson?{id:lesson.id,name:lesson.name,status:lesson.status}:null;
      const question=questionEvent?.question;
      const runResult={status:state.status,currentLesson:lessonInfo(state.currentLesson),stats:{...state.stats},
        lastQuestion:question?{source:'last-run-event',lesson:lessonInfo(questionEvent.currentLesson),
          subject:questionEvent.currentSubject?.name||null,
          question:{id:question.id,type:question.type,text:question.text,
            options:(question.options||[]).map(({id,text})=>({id,text})),requiresVision:question.requiresVision===true,
            ...(question.items?{items:question.items.map(({id,text})=>({id,text}))}:{}),
            ...(question.fields?{fields:question.fields.map(({id,text,options})=>({id,text,options:options.map(({id,text})=>({id,text}))}))}:{}),
            ...(question.targets?{targets:question.targets.map(({id,text})=>({id,text}))}:{})}}:null,
        lastReview:reviewEvent?{message:reviewEvent.message,cause:reviewEvent.cause||null,lesson:lessonInfo(reviewEvent.currentLesson),
          ...(reviewEvent.answer?{answer:{optionIds:reviewEvent.answer.optionIds||[],text:reviewEvent.answer.text||'',
            ...(reviewEvent.answer.selections?{selections:reviewEvent.answer.selections.map(({fieldId,optionId})=>({fieldId,optionId}))}:{}),
            explanation:reviewEvent.answer.explanation||'',confidence:reviewEvent.answer.confidence}}:{})}:null};
      let workerVersion=null;
      try{workerVersion=chrome.runtime.getManifest?.().version||null;}catch{}
      const contentVersion=typeof result.diagnostics?.version==='string'?result.diagnostics.version:null;
      const versions={worker:workerVersion,content:contentVersion,
        consistent:workerVersion&&contentVersion?workerVersion===contentVersion:null,
        embedded:embedded.filter(item=>item.diagnostics).map(item=>({frameId:item.frameId,content:item.diagnostics.version||null,
          consistent:workerVersion&&item.diagnostics.version?workerVersion===item.diagnostics.version:null}))};
      return {...result,diagnostics:{...result.diagnostics,versions,embedded,runResult}};
    }
    case 'START': {
      if (runs.has(tabId)||pendingStarts.has(tabId)) throw new Error('الحل يعمل أو يجري فحص تشغيله بالفعل لهذا التبويب.');
      const config = checkedConfig(message.config);
      const controller = new AbortController();
      pendingStarts.set(tabId,controller);
      try {
        const state = await getState(tabId);
        if (!state.page || !state.subjects.some(item=>item.id===message.subjectId)) throw new Error('اربط صفحة ألف واختر مادة أولًا.');
        const startTab=await checkedTab(tabId,new URL(state.page.url).origin);
        await checkLocalService(config,controller.signal);
        assertActive(controller.signal);
        const currentTab=await checkedTab(tabId,new URL(state.page.url).origin);
        assertActive(controller.signal);
        if(lessonPageKey(startTab.url)!==lessonPageKey(currentTab.url))throw new Error('تغيرت صفحة ألف أثناء فحص الخادم. أعد فحص المادة المطلوبة ثم ابدأ الحل.');
        state.running = true;state.status='running';state.subjectId=message.subjectId;
        state.stats=freshStats();state.queue=[];state.currentLesson=null;state.catalogURL=null;state.catalogClass=null;state.events=[];state.lastEvent=null;
        state.blockedFrames=[];delete state.frameBlockedPage;frameRoutes.delete(tabId);
        runs.set(tabId,controller);
        pendingStarts.delete(tabId);
        await saveState(tabId);
        void run(tabId,message.subjectId,config,controller);
        return {ok:true,state};
      } finally {if(pendingStarts.get(tabId)===controller)pendingStarts.delete(tabId);}
    }
    case 'RESUME_FRAMES': {
      if(runs.has(tabId)||pendingStarts.has(tabId))throw new Error('الحل يعمل أو يجري فحص تشغيله بالفعل لهذا التبويب.');
      const config=checkedConfig(message.config),controller=new AbortController();
      pendingStarts.set(tabId,controller);
      try {
        const state=await getState(tabId);
        const lesson=state.queue.find(item=>item.id===state.currentLesson?.id);
        if(!state.page||!lesson||lesson.status!=='review'||lesson.reviewCause!=='frame_permission_required'||!state.blockedFrames.length) {
          throw new Error('لا يوجد درس متوقف ينتظر إذن المحتوى. أعد فحص صفحة ألف ثم ابدأ الحل.');
        }
        const origin=new URL(state.page.url).origin,tab=await checkedTab(tabId,origin);
        if(state.frameBlockedPage!==lessonPageKey(tab.url))throw new Error('تغيرت صفحة الدرس المتوقف. ارجع إليه قبل السماح بالمتابعة.');
        for(const entry of state.blockedFrames) {
          if(frameOrigin(entry.origin,origin)!==entry.origin||!await framePermission(entry.origin,origin)) {
            throw new Error('لم يُمنح إذن محتوى الدرس بعد. اضغط «السماح بمحتوى الدرس» ووافق في نافذة Chrome.');
          }
        }
        await checkLocalService(config,controller.signal);
        assertActive(controller.signal);
        const current=await checkedTab(tabId,origin);
        assertActive(controller.signal);
        if(state.frameBlockedPage!==lessonPageKey(current.url))throw new Error('تغيرت صفحة الدرس المتوقف أثناء فحص الخادم. ارجع إليه قبل المتابعة.');
        frameRoutes.delete(tabId);
        lesson.status='pending';delete lesson.reason;delete lesson.reviewCause;
        state.currentLesson=lesson;state.running=true;state.status='running';state.blockedFrames=[];delete state.frameBlockedPage;
        state.stats.review=Math.max(0,state.stats.review-1);
        state.stats.lessonsReview=Math.max(0,state.stats.lessonsReview-1);
        runs.set(tabId,controller);pendingStarts.delete(tabId);
        await saveState(tabId);
        void run(tabId,state.subjectId,config,controller,lesson.id);
        return {ok:true,state};
      } finally {if(pendingStarts.get(tabId)===controller)pendingStarts.delete(tabId);}
    }
    case 'STOP': {
      const controller = runs.get(tabId);
      if (controller) controller.abort();
      pendingStarts.get(tabId)?.abort();
      await Promise.allSettled([...routeState(tabId).injected].map(frameId=>chrome.tabs.sendMessage(tabId,{type:'ALEF_CANCEL'},{frameId})));
      await emit(tabId,'stopped','تم إيقاف الحل. راجع صفحة ألف لمعرفة حالة آخر إرسال.');
      return {ok:true,state:await getState(tabId)};
    }
    default: throw new Error('طلب غير مدعوم.');
  }
}
chrome.runtime.onMessage.addListener((message,sender,respond) => {
  if(message?.type==='ALEF_CAPTURE_VISUAL'){
    if(sender.id!==chrome.runtime.id||!sender.tab||sender.url?.startsWith(chrome.runtime.getURL(''))||typeof handleVisualCapture!=='function')return false;
    handleVisualCapture(message,sender).then(respond,error=>respond({ok:false,error:error.message||'تعذر التقاط رسم السؤال.'}));
    return true;
  }
  if(message?.type==='ALEF_MATH_FIELD') {
    if(sender.id!==chrome.runtime.id||!sender.tab||sender.url?.startsWith(chrome.runtime.getURL('')))return false;
    mathFieldMessage(message,sender).then(respond,error=>respond({ok:false,error:error.message||'تعذر التفاعل مع محرر المعادلات.'}));
    return true;
  }
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('')) || message?.type === 'RUN_EVENT') return false;
  if (!['CONNECT','SCAN','GET_STATE','START','STOP','RESUME_FRAMES','DIAGNOSTICS'].includes(message?.type)) return false;
  handle(message).then(respond,error=>respond({ok:false,error:error.message || 'تعذر تنفيذ الطلب.'}));
  return true;
});
chrome.action.onClicked.addListener(tab => {
  void chrome.tabs.create({url:chrome.runtime.getURL(`dashboard.html?tabId=${tab.id}`)});
});
chrome.tabs.onRemoved.addListener(tabId => {
  runs.get(tabId)?.abort();
  pendingStarts.get(tabId)?.abort();pendingStarts.delete(tabId);
  states.delete(tabId);
  frameRoutes.delete(tabId);
  void chrome.storage.session.remove(key(tabId));
});
