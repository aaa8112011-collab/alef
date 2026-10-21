'use strict';

// Pairing settings belong to extension pages and the worker, never content scripts.
async function restrictLocalSettings() {
  try { await chrome.storage.local?.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'}); }
  catch { /* Older Chrome builds can omit this optional storage API. */ }
}
void restrictLocalSettings();

const runs = new Map();
const states = new Map();
const reviewMessages = {
  low_confidence:'تقدير الثقة منخفض؛ راجع الإجابة قبل إرسالها.',
  verification_disagreement:'لم تتفق عمليتا الحل والتحقق؛ راجع السؤال.',
  invalid_selection:'خيارات الإجابة لا تطابق السؤال؛ لم تُطبّق الإجابة.',
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
  queue:[],currentLesson:null,catalogURL:null,catalogClass:null,stats:freshStats(),events:[],lastEvent:null});
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
    if (stored.running && !runs.has(tabId)) {
      stored.running = false;
      stored.status = 'interrupted';
      stored.lastEvent = {kind:'stopped',message:'انقطعت جلسة الإضافة. افحص الصفحة ثم ابدأ مجددًا.',timestamp:Date.now(),stats:stored.stats};
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
  const event = {kind,message,...details,stats:{...state.stats},timestamp:Date.now()};
  if (state.currentLesson) event.currentLesson = {...state.currentLesson};
  const subject = state.subjects.find(item=>item.id===state.subjectId);
  if (subject) event.currentSubject = {id:subject.id,name:subject.name};
  if (['queue','lesson','complete','review','error','stopped'].includes(kind)) {
    event.queue = state.queue.map(item=>({...item}));
  }
  state.lastEvent = event;
  state.events = [...state.events,event].slice(-100);
  if (['complete','error','stopped'].includes(kind) || (kind === 'review' && details.blocking !== false)) {
    state.status = kind;
    state.running = false;
  }
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
async function inject(tabId,origin) {
  await checkedTab(tabId,origin);
  await chrome.scripting.executeScript({target:{tabId},files:['content.js']});
}
async function pageMessage(tabId,message,origin,signal) {
  if (signal) assertActive(signal);
  await checkedTab(tabId,origin);
  if (signal) assertActive(signal);
  let result;
  try { result = await chrome.tabs.sendMessage(tabId,message); }
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
    await inject(tabId,origin);
    result = await chrome.tabs.sendMessage(tabId,message);
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
  return {serverUrl:url.origin,token:input.token.trim(),selectors,verify:input.verify !== false,
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
  return pageMessage(tabId,{type:'ALEF_INSPECT',selectors:config.selectors},origin,signal);
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
function diagnostic(snapshot,fallback) {
  return snapshot?.diagnostics?.find(item=>typeof item === 'string' && item.trim()) || fallback;
}
async function navigate(tabId,snapshot,action,config,origin,signal) {
  return pageMessage(tabId,{type:'ALEF_NAVIGATE',actionId:action.id,
    fingerprint:snapshot.fingerprint,selectors:config.selectors},origin,signal);
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
      body:JSON.stringify({subject,question:{id:question.id,text:question.text,type:question.type,options:question.options,...(question.type==='matching'?{items:question.items,targets:question.targets}:{})},verify:config.verify}),
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
      if(!q||!lastSubmitted||lastSubmitted.question.id!==q.id||rejected.length>=2||!retry)return {review:true,snapshot,message:'لم يُقبل الحل بعد المحاولات المتاحة. سُجّل الدرس للمراجعة بدل تكرار الإجابة.'};
      rejected.push(lastSubmitted.answer);rejectedAnswers.set(identity,rejected);
      await emit(tabId,'status','رفض الموقع الإجابة؛ إعادة التحقق مع استبعاد الحل المرفوض…');
      await navigate(tabId,snapshot,retry,config,origin,signal);
      snapshot=await waitSnapshot(tabId,config,origin,signal,item=>item.stage==='question'&&item.feedback!=='wrong',6000);
      seenQuestions.delete(identity);
      continue;
    }
    if (snapshot.stage === 'question' && snapshot.question) {
      const question = snapshot.question;
      const identity = `${question.id}:${question.fingerprint}`;
      if (seenQuestions.has(identity)) return {review:true,snapshot,message:'لم ينتقل الموقع إلى سؤال جديد. راجع نتيجة آخر إرسال.'};
      if (state.stats.total >= 1000) return {review:true,blocking:true,snapshot,message:'وصل التشغيل إلى حد 1000 سؤال. افحص التقدم ثم ابدأ جلسة جديدة.'};
      seenQuestions.add(identity);
      state.stats.total++;
      await emit(tabId,'question',config.verify?'جارٍ حل السؤال ثم التحقق بحل ثانٍ…':'جارٍ حل السؤال بالوضع السريع…',{question});
      let result;
      const rejected=rejectedAnswers.get(identity)||[];
      const requestQuestion=rejected.length?{...question,text:question.text+'\n\nPlatform feedback: these previous answers were rejected. Re-evaluate the question carefully. Do not repeat a rejected answer; lower confidence if the question is unclear.\n'+JSON.stringify(rejected.map(answer=>({optionIds:answer.optionIds,text:answer.text,matches:answer.matches})))}:question;
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
      const applied = await pageMessage(tabId,{type:'ALEF_APPLY',questionId:question.id,
        questionFingerprint:question.fingerprint,answer,selectors:config.selectors,autoSubmit:config.autoSubmit},origin,signal);
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
async function run(tabId,subjectId,config,controller) {
  const signal = controller.signal;
  const state = await getState(tabId);
  const origin = new URL(state.page.url).origin;
  const subject = state.subjects.find(item=>item.id===subjectId);
  const keepAlive = setInterval(()=>chrome.runtime.getPlatformInfo().catch(()=>{}),20000);
  try {
    await emit(tabId,'status',`فتح ${subject.name} وجمع الدروس المفتوحة…`);
    await pageMessage(tabId,{type:'ALEF_SELECT_SUBJECT',subjectId,selectors:config.selectors},origin,signal);
    await pause(250,signal);
    let snapshot = await waitSnapshot(tabId,config,origin,signal,item=>!['unknown','subjects'].includes(item.stage));
    state.catalogClass=coreCatalog(snapshot)?observedCoreClass(snapshot.page?.url):null;
    // Start with the available tasks instead of paging through a long catalog
    // before the first answer. Refill the queue before reporting completion.
    snapshot = await prepareCatalog(tabId,snapshot,config,origin,signal);
    const catalogMode = snapshot.stage === 'lessons';
    if (catalogMode) {
      state.catalogURL = snapshot.page?.url || (await checkedTab(tabId,origin)).url;
      updateQueue(state,snapshot);
    } else if (['question','instruction','complete'].includes(snapshot.stage)) {
      state.queue = [{id:'current-exercise',name:subject.name,status:'pending',implicit:true}];
      state.stats.lessonsTotal = 1;
    } else {
      state.stats.review++;
      await emit(tabId,'review',diagnostic(snapshot,'لم أجد قائمة دروس أو نشاطًا مدعومًا. افتح صفحة المادة ثم أعد الربط.'),{blocking:true});
      return;
    }
    await emit(tabId,'queue',`عُثر على ${state.stats.lessonsTotal} درس مفتوح غير مكتمل.`);
    for (let lessonLimit=0;lessonLimit<250;lessonLimit++) {
      assertActive(signal);
      let lesson = state.queue.find(item=>item.status==='pending');
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
      await emit(tabId,'lesson',`بدء درس: ${lesson.name}`);
      let outcome;
      try {
        if (catalogMode) {
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
        state.stats.review++;state.stats.lessonsReview++;
        // An unresolved lesson is not a successful queue item. Keep the page
        // and all later pending lessons intact so a failed control, loading
        // issue or uncertain answer cannot cause a rapid tour of the course.
        await emit(tabId,'review',outcome.message,{blocking:true,
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
    runs.delete(tabId);
    state.running = false;
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
      const controller = new AbortController();
      runs.set(tabId,controller);
      await saveState(tabId);
      void run(tabId,message.subjectId,config,controller);
      return {ok:true,state};
    }
    case 'STOP': {
      const controller = runs.get(tabId);
      if (controller) controller.abort();
      try{await chrome.tabs.sendMessage(tabId,{type:'ALEF_CANCEL'});}catch{}
      await emit(tabId,'stopped','تم إيقاف الحل. راجع صفحة ألف لمعرفة حالة آخر إرسال.');
      return {ok:true,state:await getState(tabId)};
    }
    default: throw new Error('طلب غير مدعوم.');
  }
}
chrome.runtime.onMessage.addListener((message,sender,respond) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('')) || message?.type === 'RUN_EVENT') return false;
  if (!['CONNECT','SCAN','GET_STATE','START','STOP','DIAGNOSTICS'].includes(message?.type)) return false;
  handle(message).then(respond,error=>respond({ok:false,error:error.message || 'تعذر تنفيذ الطلب.'}));
  return true;
});
chrome.action.onClicked.addListener(tab => {
  void chrome.tabs.create({url:chrome.runtime.getURL(`dashboard.html?tabId=${tab.id}`)});
});
chrome.tabs.onRemoved.addListener(tabId => {
  runs.get(tabId)?.abort();
  states.delete(tabId);
  void chrome.storage.session.remove(key(tabId));
});
