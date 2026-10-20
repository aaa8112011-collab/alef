'use strict';

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
const freshState = () => ({running:false,status:'idle',page:null,subjects:[],subjectId:null,
  stats:{solved:0,review:0,total:0},events:[],lastEvent:null});
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
    if (stored.running && !runs.has(tabId)) {
      stored.running = false;
      stored.status = 'interrupted';
      stored.lastEvent = {kind:'stopped',message:'انقطعت جلسة الإضافة. افحص الصفحة ثم ابدأ مجددًا.',timestamp:Date.now(),stats:stored.stats};
      stored.events.push(stored.lastEvent);
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
  state.lastEvent = event;
  state.events = [...state.events,event].slice(-100);
  if (['complete','error','stopped','review'].includes(kind)) {
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
async function checkedTab(tabId,origin) {
  const tab = await chrome.tabs.get(tabId);
  if (!allowedOrigin(tab.url)) throw new Error('افتح https://moe.alefed.com/ أولًا؛ الربط متاح لموقع ألف فقط.');
  if (origin && new URL(tab.url).origin !== origin) throw new Error('انتقلت الصفحة خارج الموقع المرتبط. أوقف التشغيل وأعد الربط.');
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
    if (['ALEF_APPLY','ALEF_SELECT_SUBJECT','ALEF_NEXT'].includes(message.type)) {
      // A navigation can close the response channel after a click already happened.
      // Never replay a mutation: doing so could submit an answer twice.
      await checkedTab(tabId,origin);
      if (message.type === 'ALEF_SELECT_SUBJECT') return {ok:true,selected:true};
      if (message.type === 'ALEF_NEXT') return {ok:true,clicked:true};
      throw new Error('انقطع الاتصال أثناء تطبيق الإجابة. تحقق من آخر إرسال في ألف قبل إعادة البدء.');
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
  for (const name of ['subject','question','option','submit','next','completed']) {
    if (input.selectors?.[name] !== undefined) {
      if (typeof input.selectors[name] !== 'string' || input.selectors[name].length > 600) throw new Error('محدد الصفحة غير صالح.');
      selectors[name] = input.selectors[name];
    }
  }
  const confidence = Number(input.minConfidence ?? 0.85);
  if (!Number.isFinite(confidence) || confidence < 0.85 || confidence > 1) throw new Error('حد الثقة يجب أن يكون بين 0.85 و1.');
  return {serverUrl:url.origin,token:input.token.trim(),selectors,verify:input.verify !== false,
    autoSubmit:input.autoSubmit !== false,minConfidence:confidence};
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
async function read(tabId,config,origin,signal) {
  return pageMessage(tabId,{type:'ALEF_GET_QUESTION',selectors:config.selectors},origin,signal);
}
async function waitForChange(tabId,config,origin,signal,previous=null,timeout=15000) {
  const start = Date.now();
  let last;
  let nextClicked = false;
  while (Date.now()-start < timeout) {
    assertActive(signal);
    try {
      last = await read(tabId,config,origin,signal);
      if (last.completed || (last.question && (!previous || last.question.fingerprint !== previous.fingerprint || last.question.id !== previous.id))) return last;
      if (previous && last.canNext && !nextClicked) {
        await pageMessage(tabId,{type:'ALEF_NEXT',selectors:config.selectors},origin,signal);
        nextClicked = true;
        await pause(350,signal);
        const after = await read(tabId,config,origin,signal);
        if (after.completed || (after.question && (after.question.id !== previous.id || after.question.fingerprint !== previous.fingerprint))) return after;
        // Never click an unchanged Next button repeatedly.
        last = after;
      }
    } catch (error) {
      if (signal.aborted) throw aborted();
      // Loading/replaced documents can briefly have no message receiver.
      if (!/Receiving end does not exist|Could not establish connection|Frame.*removed|Cannot access contents|No frame with id/i.test(error.message)) throw error;
    }
    await pause(300,signal);
  }
  return last || {question:null,completed:false};
}
async function solve(question,subject,config,signal) {
  // Local models can take minutes on a CPU. Stop still aborts immediately.
  const timeout = AbortSignal.timeout(610000);
  let response;
  try {
    response = await fetch(`${config.serverUrl}/api/solve`,{
      method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${config.token}`},
      body:JSON.stringify({subject,question:{id:question.id,text:question.text,type:question.type,options:question.options},verify:config.verify}),
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
async function run(tabId,subjectId,config,controller) {
  const signal = controller.signal;
  const state = await getState(tabId);
  const origin = new URL(state.page.url).origin;
  const subject = state.subjects.find(item=>item.id===subjectId);
  const keepAlive = setInterval(()=>chrome.runtime.getPlatformInfo().catch(()=>{}),20000);
  try {
    await emit(tabId,'status',`فتح ${subject.name} وقراءة السؤال…`);
    await pageMessage(tabId,{type:'ALEF_SELECT_SUBJECT',subjectId,selectors:config.selectors},origin,signal);
    await pause(350,signal);
    let snapshot = await waitForChange(tabId,config,origin,signal);
    const seen = new Set();
    for (let limit=0;limit<100;limit++) {
      assertActive(signal);
      if (snapshot.completed) { await emit(tabId,'complete','اكتملت الأسئلة الظاهرة لهذه المادة.');return; }
      if (!snapshot.question) {
        state.stats.review++;
        await emit(tabId,'review','لم أجد سؤالًا مدعومًا. افتح الواجب المطلوب أو اضبط محددات الصفحة ثم أعد البدء.');return;
      }
      const question = snapshot.question;
      const identity = `${question.id}:${question.fingerprint}`;
      if (seen.has(identity)) {
        state.stats.review++;
        await emit(tabId,'review','لم ينتقل الموقع إلى سؤال جديد. راجع نتيجة الإرسال على صفحة ألف.',{question});return;
      }
      seen.add(identity);
      state.stats.total++;
      await emit(tabId,'question','جارٍ حل السؤال والتحقق من الإجابة…',{question});
      const result = await solve(question,subject.name,config,signal);
      assertActive(signal);
      const answer = result.answer;
      if (result.needsReview || !answer || !Number.isFinite(answer.confidence) || answer.confidence < config.minConfidence || (config.verify && result.verified !== true)) {
        state.stats.review++;
        await emit(tabId,'review',reviewMessages[result.reason] ||
          'الإجابة تحتاج مراجعة: الثقة منخفضة أو لم تتفق عمليتا الحل والتحقق.',{question,answer});return;
      }
      await emit(tabId,'answer','وصلت الإجابة؛ جارٍ مطابقتها مع السؤال الظاهر.',{question,answer});
      assertActive(signal);
      const applied = await pageMessage(tabId,{type:'ALEF_APPLY',questionId:question.id,
        questionFingerprint:question.fingerprint,answer,selectors:config.selectors,autoSubmit:config.autoSubmit},origin,signal);
      if (!applied.submitted) {
        state.stats.review++;
        await emit(tabId,'review',applied.reason || 'تم اختيار الإجابة. راجعها وأرسلها يدويًا؛ الإرسال التلقائي متوقف.',{question,answer});return;
      }
      state.stats.solved++;
      await emit(tabId,'status','أُرسلت الإجابة. انتظار السؤال التالي…');
      await pause(500,signal);
      snapshot = await waitForChange(tabId,config,origin,signal,question);
    }
    state.stats.review++;
    await emit(tabId,'review','وصل التشغيل إلى حد 100 سؤال. افحص التقدم ثم ابدأ جلسة جديدة.');
  } catch (error) {
    if (signal.aborted || error.name === 'AbortError') {
      if (state.status !== 'stopped') await emit(tabId,'stopped','تم إيقاف الحل.');
    } else {
      state.stats.review++;
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
    case 'START': {
      if (runs.has(tabId)) throw new Error('الحل يعمل بالفعل لهذا التبويب.');
      const config = checkedConfig(message.config);
      const state = await getState(tabId);
      if (!state.page || !state.subjects.some(item=>item.id===message.subjectId)) throw new Error('اربط صفحة ألف واختر مادة أولًا.');
      await checkedTab(tabId,new URL(state.page.url).origin);
      state.running = true;state.status='running';state.subjectId=message.subjectId;
      state.stats={solved:0,review:0,total:0};state.events=[];state.lastEvent=null;
      const controller = new AbortController();
      runs.set(tabId,controller);
      await saveState(tabId);
      void run(tabId,message.subjectId,config,controller);
      return {ok:true,state};
    }
    case 'STOP': {
      const controller = runs.get(tabId);
      if (controller) controller.abort();
      await emit(tabId,'stopped','تم إيقاف الحل. راجع صفحة ألف لمعرفة حالة آخر إرسال.');
      return {ok:true,state:await getState(tabId)};
    }
    default: throw new Error('طلب غير مدعوم.');
  }
}
chrome.runtime.onMessage.addListener((message,sender,respond) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('')) || message?.type === 'RUN_EVENT') return false;
  if (!['CONNECT','SCAN','GET_STATE','START','STOP'].includes(message?.type)) return false;
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
