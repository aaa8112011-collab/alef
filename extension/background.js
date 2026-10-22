'use strict';

// Pairing settings belong to extension pages and the worker, never content scripts.
async function restrictLocalSettings() {
  try { await chrome.storage.local?.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'}); }
  catch { /* Older Chrome builds can omit this optional storage API. */ }
}
void restrictLocalSettings();

const runs = new Map();
const states = new Map();
const frameRoutes = new Map();
const reviewMessages = {
  low_confidence:'تقدير الثقة منخفض؛ راجع الإجابة قبل إرسالها.',
  verification_disagreement:'لم تتفق عمليتا الحل والتحقق؛ راجع السؤال.',
  invalid_selection:'خيارات الإجابة لا تطابق السؤال؛ لم تُطبّق الإجابة.',
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
  const qualityMode=input.qualityMode===true;
  return {serverUrl:url.origin,token:input.token.trim(),selectors,qualityMode,verify:qualityMode||input.verify !== false,
    autoSubmit:input.autoSubmit !== false,skipInstruction:input.skipInstruction !== false,minConfidence:confidence};
}
async function connect(tabId,selectors) {
  if (runs.has(tabId)) throw new Error('أوقف التشغيل قبل إعادة ربط الصفحة.');
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
  if(top.question||top.completed||['lessons','subjects'].includes(top.stage)||!chrome.webNavigation?.getAllFrames) {
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
          child.stage==='instruction'&&((child.navigation||[]).length||child.loading)) {
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
      return {...top,stage:'instruction',loading:false,framePending:false,navigation:parentNavigation};
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
      frameResult:true,navigation};
  }
  routes.active=selected.frameId;
  const navigation=(child.navigation||[]).map(action=>({...action,frameId:selected.frameId,frameFingerprint:child.fingerprint}));
  navigation.push(...(top.navigation||[]).filter(action=>action.kind==='back').map(action=>({...action,frameId:0,frameFingerprint:top.fingerprint})));
  const selectedRecord=records.find(record=>record.frameId===selected.frameId);
  return {...child,page:top.page,subjects:top.subjects,lessons:[],completed:false,navigation,
    frameContext:{frameId:selected.frameId,origin:frameOrigin(selectedRecord?.url,origin),
      documentId:selectedRecord?.documentId||null,url:lessonPageKey(child.page?.url||selectedRecord?.url),
      topPageKey:lessonPageKey(top.page?.url)},
    fingerprint:`frame:${selected.frameId}:${child.fingerprint}`,diagnostics:child.diagnostics||[]};
}
const snapshotKey = snapshot => snapshot?.fingerprint || JSON.stringify([
  snapshot?.stage,snapshot?.question?.id,snapshot?.question?.fingerprint,snapshot?.completed,
  snapshot?.lessons?.map(item=>[item.id,item.locked,item.completed]),snapshot?.navigation?.map(item=>[item.id,item.kind]),snapshot?.catalog,
]);
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
async function waitSnapshot(tabId,config,origin,signal,predicate=()=>true,timeout=12000) {
  const started = Date.now();
  let last;
  while (Date.now()-started < timeout) {
    assertActive(signal);
    try {
      last = await inspect(tabId,config,origin,signal);
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
  // A real question can coexist with a persistent progress bar. That bar must
  // not turn a ready exercise into an endless loading state.
  if(snapshot?.stage==='question'&&snapshot.question||snapshot?.needsPreparation)return false;
  if(snapshot?.framePending)return true;
  const forward=(snapshot?.navigation||[]).some(action=>
    ['next','finish'].includes(action.kind)||config.skipInstruction&&action.kind==='skip'||
    action.kind==='assessment'&&action.sequential===true);
  if(forward)return false;
  return snapshot?.loading===true;
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
  let last;
  while (Date.now()-started < 15000) {
    assertActive(signal);
    last = await inspect(tabId,config,origin,signal);
    if (last.feedback==='wrong')return last;
    if (last.completed || last.stage === 'complete' || last.stage === 'lessons' ||
      (last.question&&!sameQuestion(last,question))||last.stage==='instruction'||last.needsPreparation) return last;
    const action = last.navigation?.find(item=>['next','finish'].includes(item.kind));
    if (action) {
      const identity = `${snapshotKey(last)}:${action.id}`;
      if (!clicked.has(identity)) {
        clicked.add(identity);
        await navigate(tabId,last,action,config,origin,signal);
      }
    }
    await pause(250,signal);
  }
  return last || {stage:'unknown',question:null,completed:false};
}
async function solve(question,subject,config,signal) {
  // Local models can take minutes on a CPU. Stop still aborts immediately.
  const timeout = AbortSignal.timeout(610000);
  let response;
  try {
    response = await fetch(`${config.serverUrl}/api/solve`,{
      method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${config.token}`},
      body:JSON.stringify({subject,question:{id:question.id,text:question.text,type:question.type,options:question.options,
        ...(question.requiresVision?{requiresVision:true,images:question.images||[]}:{}),
        ...(question.type==='matching'?{items:question.items,targets:question.targets}:{})},verify:config.verify,qualityMode:config.qualityMode}),
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
    if(!health?.ok || !(health.protocolVersion>=2)) {
      throw new Error('الخادم يعمل بنسخة قديمة لا تدعم الصور ووضع الدقة. أغلق نافذة التشغيل القديمة وشغّل START-WINDOWS.cmd من النسخة الجديدة.');
    }
    config.backendHealth=health;
  }
  if(requiresVision&&config.backendHealth.visionReady!==true) {
    throw new Error(config.backendHealth.visionMessage||'النموذج البصري غير جاهز. شغّل START-WINDOWS.cmd من النسخة الجديدة لتجهيزه؛ لم يُرسل السؤال إلى نموذج نصّي.');
  }
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
  const rejectedAnswers = new Map();
  let lastSubmitted = null;
  const answerKey=answer=>answer.optionIds?.length?JSON.stringify([...answer.optionIds].sort()):answer.matches?JSON.stringify([...answer.matches].sort((a,b)=>a.itemId.localeCompare(b.itemId))):(answer.text||'').normalize('NFKC').trim();
  while (true) {
    assertActive(signal);
    if(snapshot.permissionRequired)return {review:true,blocking:true,snapshot,cause:'frame_permission_required',
      message:diagnostic(snapshot,'يحتاج محتوى الدرس إذن Chrome. اضغط «السماح بمحتوى الدرس» في مُعين ثم تابع الدرس الحالي.')};
    if(pendingLessonPlayer(snapshot,config)) {
      await emit(tabId,'status','انتظار اكتمال تحميل محتوى الدرس…',{phase:'loading'});
      snapshot=await waitSnapshot(tabId,config,origin,signal,item=>item.permissionRequired||
        !pendingLessonPlayer(item,config)&&!['unknown','subjects'].includes(item.stage),30000);
      if(snapshot.permissionRequired)continue;
      if(pendingLessonPlayer(snapshot,config)||['unknown','subjects'].includes(snapshot.stage)) {
        return {review:true,blocking:true,snapshot,
          message:'لم يكتمل تحميل محتوى الدرس خلال 30 ثانية. توقف التشغيل في الدرس الحالي؛ انتظر ظهوره ثم أعد المحاولة.'};
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
    if(snapshot.needsPreparation) {
      await pageMessage(tabId,{type:'ALEF_PREPARE_QUESTION',selectors:config.selectors},origin,signal);
      snapshot=await inspect(tabId,config,origin,signal);
      if(snapshot.needsPreparation)return {review:true,snapshot,message:'لم تظهر خيارات القائمة المنسدلة بوضوح.'};
      continue;
    }
    if(snapshot.feedback==='wrong'){
      const q=snapshot.question;
      const identity=q&&`${q.id}:${q.fingerprint}`;
      const rejected=rejectedAnswers.get(identity)||[];
      const retry=snapshot.navigation?.find(action=>action.kind==='retry');
      if(!q||!lastSubmitted||!sameQuestion(snapshot,lastSubmitted.question)||rejected.length>=2||!retry)return {review:true,snapshot,message:'لم يُقبل الحل بعد المحاولات المتاحة. سُجّل الدرس للمراجعة بدل تكرار الإجابة.'};
      rejected.push(lastSubmitted.answer);rejectedAnswers.set(identity,rejected);
      await emit(tabId,'status','رفض الموقع الإجابة؛ إعادة التحقق مع استبعاد الحل المرفوض…');
      await navigate(tabId,snapshot,retry,config,origin,signal);
      snapshot=await waitSnapshot(tabId,config,origin,signal,item=>item.stage==='question'&&item.feedback!=='wrong',6000);
      seenQuestions.delete(identity);
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
      const rejected=rejectedAnswers.get(identity)||[];
      let requestQuestion=rejected.length?{...question,text:question.text+'\n\nPlatform feedback: these previous answers were rejected. Re-evaluate the question carefully. Do not repeat a rejected answer; lower confidence if the question is unclear.\n'+JSON.stringify(rejected.map(answer=>({optionIds:answer.optionIds,text:answer.text,matches:answer.matches})))}:question;
      if(config.qualityMode||question.requiresVision)await checkAccuracyBackend(config,signal,question.requiresVision);
      if(question.requiresVision)requestQuestion=await captureQuestionImages(tabId,requestQuestion,config,origin,signal,context);
      const solveStarted=Date.now();
      try { result = await solve(requestQuestion,subject.name,config,signal); }
      catch (error) { error.fatal = true;throw error; }
      assertActive(signal);
      const answer = result.answer;
      if(answer&&rejected.some(previous=>answerKey(previous)===answerKey(answer)))return {review:true,snapshot,question,answer,message:'عاد النموذج إلى إجابة سبق رفضها؛ لم تُرسل مرة أخرى.'};
      if (result.needsReview || !answer || !Number.isFinite(answer.confidence) || answer.confidence < config.minConfidence || (config.verify && result.verified !== true)) {
        return {review:true,snapshot,question,answer,message:reviewMessages[result.reason] ||
          'الإجابة تحتاج مراجعة: الثقة منخفضة أو لم تتفق عمليتا الحل والتحقق.'};
      }
      const solveDurationMs=Date.now()-solveStarted;
      await emit(tabId,'answer',`وصلت الإجابة خلال ${(solveDurationMs/1000).toFixed(1)} ثانية؛ جارٍ مطابقتها مع السؤال الظاهر.`,{question,answer,solveDurationMs});
      assertActive(signal);
      await validateQuestionContext(tabId,question,context,config,origin,signal);
      const applied = await pageMessage(tabId,{type:'ALEF_APPLY',questionId:question.id,
        questionFingerprint:question.fingerprint,answer,selectors:config.selectors,autoSubmit:config.autoSubmit},origin,signal,context.frameId,context.documentId);
      if (!applied.submitted) {
        return {review:true,blocking:true,snapshot,question,answer,applied:applied.applied===true,message:applied.reason ||
          'تم اختيار الإجابة. راجعها وأرسلها يدويًا؛ الإرسال التلقائي متوقف.'};
      }
      state.stats.solved++;
      lastSubmitted={question,answer};
      await emit(tabId,'submitted','أُرسلت الإجابة. انتظار السؤال التالي…',{question,answer,applied:true,submitted:true});
      await pause(300,signal);
      snapshot = await afterSubmission(tabId,question,config,origin,signal);
      continue;
    }
    if (snapshot.stage === 'instruction') {
      const kinds = config.skipInstruction ? ['skip','next','finish','assessment'] : ['next','finish','assessment'];
      const action = kinds.map(kind=>snapshot.navigation?.find(item=>item.kind===kind &&
        (kind!=='assessment'||item.sequential===true))).find(Boolean);
      if (!action) return {review:true,snapshot,message:diagnostic(snapshot,'يتطلب هذا الدرس مشاهدة أو تفاعلًا لا يمكن تجاوزه بزر ظاهر. يحتاج مراجعة يدوية.')};
      const identity = `${snapshotKey(snapshot)}:${action.id}`;
      if (clicked.has(identity)) return {review:true,snapshot,message:'لم يتغير الدرس بعد الانتقال. أوقف تكرار الضغط لمراجعة الصفحة.'};
      if (introActions >= 250) return {review:true,snapshot,message:'وصل الدرس إلى حد 250 خطوة في المحتوى. توقّف التشغيل في الدرس الحالي للمراجعة.'};
      clicked.add(identity);
      introActions++;
      await emit(tabId,'status',action.kind === 'skip' ? 'تجاوز المقدمة بالزر الظاهر في الدرس…' : 'الانتقال إلى نشاط الدرس…');
      const previous = snapshotKey(snapshot);
      await navigate(tabId,snapshot,action,config,origin,signal);
      snapshot = await waitSnapshot(tabId,config,origin,signal,item=>snapshotKey(item)!==previous && item.stage!=='unknown');
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
      return pageMessage(tabId,{type:'ALEF_DIAGNOSTICS'},new URL(tab.url).origin);
    }
    case 'START': {
      if (runs.has(tabId)) throw new Error('الحل يعمل بالفعل لهذا التبويب.');
      const config = checkedConfig(message.config);
      const state = await getState(tabId);
      if (!state.page || !state.subjects.some(item=>item.id===message.subjectId)) throw new Error('اربط صفحة ألف واختر مادة أولًا.');
      await checkedTab(tabId,new URL(state.page.url).origin);
      state.running = true;state.status='running';state.subjectId=message.subjectId;
      state.stats=freshStats();state.queue=[];state.currentLesson=null;state.catalogURL=null;state.catalogClass=null;state.events=[];state.lastEvent=null;
      state.blockedFrames=[];delete state.frameBlockedPage;frameRoutes.delete(tabId);
      const controller = new AbortController();
      runs.set(tabId,controller);
      await saveState(tabId);
      void run(tabId,message.subjectId,config,controller);
      return {ok:true,state};
    }
    case 'RESUME_FRAMES': {
      if(runs.has(tabId))throw new Error('الحل يعمل بالفعل لهذا التبويب.');
      const config=checkedConfig(message.config),state=await getState(tabId);
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
      frameRoutes.delete(tabId);
      lesson.status='pending';delete lesson.reason;delete lesson.reviewCause;
      state.currentLesson=lesson;state.running=true;state.status='running';state.blockedFrames=[];delete state.frameBlockedPage;
      state.stats.review=Math.max(0,state.stats.review-1);
      state.stats.lessonsReview=Math.max(0,state.stats.lessonsReview-1);
      const controller=new AbortController();runs.set(tabId,controller);
      await saveState(tabId);
      void run(tabId,state.subjectId,config,controller,lesson.id);
      return {ok:true,state};
    }
    case 'STOP': {
      const controller = runs.get(tabId);
      if (controller) controller.abort();
      await Promise.allSettled([...routeState(tabId).injected].map(frameId=>chrome.tabs.sendMessage(tabId,{type:'ALEF_CANCEL'},{frameId})));
      await emit(tabId,'stopped','تم إيقاف الحل. راجع صفحة ألف لمعرفة حالة آخر إرسال.');
      return {ok:true,state:await getState(tabId)};
    }
    default: throw new Error('طلب غير مدعوم.');
  }
}
chrome.runtime.onMessage.addListener((message,sender,respond) => {
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
  states.delete(tabId);
  frameRoutes.delete(tabId);
  void chrome.storage.session.remove(key(tabId));
});
