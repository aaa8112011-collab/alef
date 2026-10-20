'use strict';

const $ = id => document.getElementById(id);
const DEFAULT_URL = 'http://127.0.0.1:4318';
const WEBSITE = 'https://moe.alefed.com/';
let tabId = Number(new URLSearchParams(location.search).get('tabId')) || null;
let selectedSubject = null;
let subjects = [];
let running = false;
let connected = false;
let config = {serverUrl:DEFAULT_URL,token:'',verify:true,autoSubmit:true,skipInstruction:true,selectors:{}};
let startedAt = null;
let eventCount = 0;
let lessonQueue = [];
let lessonStats = {};
const lessonStatuses = {pending:'بانتظار البدء',running:'جارٍ العمل',completed:'مكتمل',review:'يحتاج مراجعة',locked:'مقفل',alreadycompleted:'مكتمل سابقًا'};

const statusNames = {idle:'بانتظار البدء',running:'جارٍ الحل',complete:'اكتملت الجلسة',review:'تحتاج مراجعتك',error:'تعذّر المتابعة',stopped:'متوقف',interrupted:'انقطعت الجلسة'};
const reviewReasons = {low_confidence:'تقدير الثقة منخفض؛ راجع الإجابة.',verification_disagreement:'لم تتفق عمليتا الحل والتحقق؛ راجع السؤال.',invalid_selection:'خيارات الإجابة لا تطابق السؤال.'};

function notice(message, isError = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error',isError);
  $('notice').hidden = !message;
}
function setBadge(text, kind = 'neutral') {
  const badge = $('connection-badge');
  badge.className = `badge ${kind}`;
  badge.replaceChildren(document.createElement('i'), document.createTextNode(text));
}
function updateButtons() {
  $('start').disabled = !connected || !selectedSubject || running;
  $('stop').disabled = !running;
  $('connect').disabled = running;
  $('refresh').disabled = !connected || running;
  $('verify').disabled = running;
  $('auto-submit').disabled = running;
  $('skip-instruction').disabled = running;
  $('diagnostics').disabled = !connected || running;
  $('subjects').querySelectorAll('button').forEach(button => {button.disabled = running;});
  $('selection-label').textContent = subjects.find(subject=>subject.id===selectedSubject)?.name || 'لم تُحدّد مادة بعد';
}
async function message(type, values = {}) {
  if (!chrome?.runtime?.id) throw new Error('افتح هذه الصفحة من إضافة Chrome المثبّتة.');
  const result = await chrome.runtime.sendMessage({type,tabId,...values});
  if (!result?.ok) throw new Error(result?.error || 'تعذر الاتصال بالإضافة. أعد فتحها.');
  return result;
}
function renderSubjects(items) {
  subjects = items || [];
  if (!subjects.some(subject=>subject.id===selectedSubject)) selectedSubject = null;
  if (subjects.length === 1) selectedSubject = subjects[0].id;
  const container = $('subjects');
  container.replaceChildren();
  if (!subjects.length) {
    const empty=document.createElement('div');empty.className='empty-state';
    const title=document.createElement('h3');title.textContent=connected?'لم أتعرف على المواد في هذه الصفحة':'افحص موادك للبدء';
    const hint=document.createElement('p');hint.textContent=connected?'انتقل إلى قائمة المواد في ألف ثم أعد الفحص. يمكنك تصدير فحص الصفحة إذا استمر التعذّر.':'افتح قائمة المواد في ألف ثم اضغط «افحص موادي».';
    empty.append(title,hint);container.append(empty);
  }
  const symbols = ['∑','⚗','أ','Aa','◈','⌁'];
  subjects.forEach((subject,index) => {
    const button = document.createElement('button');
    button.className = 'subject-card';
    button.type = 'button';
    button.setAttribute('aria-pressed',String(subject.id===selectedSubject));
    button.classList.toggle('selected',subject.id===selectedSubject);
    const symbol = document.createElement('span'); symbol.className = 'subject-symbol'; symbol.textContent = symbols[index%symbols.length]; symbol.setAttribute('aria-hidden','true');
    const labels = document.createElement('span');
    const title = document.createElement('strong'); title.textContent = subject.name;
    const subtitle = document.createElement('small'); subtitle.textContent = subject.id === 'current' ? 'متابعة الدرس المفتوح' : 'تشغيل الدروس المفتوحة بالتتابع';
    const circle = document.createElement('span');circle.className='selection-circle';circle.setAttribute('aria-hidden','true');
    labels.append(title,subtitle);button.append(symbol,labels,circle);
    button.addEventListener('click',()=>{selectedSubject=subject.id;renderSubjects(subjects);updateButtons();});
    container.append(button);
  });
  updateButtons();
}
function renderLessonQueue(queue, stats, currentLesson) {
  if(Array.isArray(queue))lessonQueue=queue;
  if(stats)lessonStats={...lessonStats,...stats};
  $('course-progress').hidden=!lessonQueue.length;
  if(!lessonQueue.length)return;
  const list=$('lesson-queue');list.replaceChildren();
  lessonQueue.forEach(lesson=>{
    const row=document.createElement('li');
    const status=Object.hasOwn(lessonStatuses,lesson.status)?lesson.status:'pending';
    row.className=`lesson-row lesson-${status}`;
    if(status==='running')row.setAttribute('aria-current','step');
    const icon=document.createElement('span');icon.className='lesson-icon';icon.textContent={pending:'○',running:'◷',completed:'✓',review:'!',locked:'⌑',alreadycompleted:'✓'}[status];icon.setAttribute('aria-hidden','true');
    const name=document.createElement('span');name.className='lesson-name';name.textContent=lesson.name;
    const label=document.createElement('span');label.className='lesson-status';label.textContent=lessonStatuses[status];
    if(lesson.reason)row.title=lesson.reason;
    row.append(icon,name,label);list.append(row);
  });
  const total=lessonStats.lessonsTotal??lessonQueue.filter(lesson=>!['locked','alreadycompleted'].includes(lesson.status)).length;
  const completed=lessonStats.lessonsCompleted??lessonQueue.filter(lesson=>lesson.status==='completed').length;
  const reviews=lessonStats.lessonsReview??lessonQueue.filter(lesson=>lesson.status==='review').length;
  $('lesson-count').textContent=`${completed} / ${total}`;
  const progress=total?Math.min(100,Math.round((completed+reviews)*100/total)):0;
  $('lesson-progress-fill').style.width=`${progress}%`;
  document.querySelector('.course-progress-track').setAttribute('aria-valuenow',String(progress));
  const active=typeof currentLesson==='string'?currentLesson:currentLesson?.name;
  $('current-lesson').textContent=active?`الدرس الحالي: ${active}`:`أُكمل ${completed} درس · ${reviews} يحتاج مراجعة`;
}
function showAnswer(event) {
  if (!event.question && !event.answer) return;
  $('answer-empty').hidden = true;
  $('answer-content').hidden = false;
  if (event.question) $('question-text').textContent = event.question.text;
  if (event.kind === 'question') $('answer-box').hidden = true;
  if (event.answer) {
    $('answer-box').hidden = false;
    const selected = event.question?.options?.filter(option=>event.answer.optionIds?.includes(option.id)).map(option=>option.text) || [];
    const pairs=event.answer.matches?.map(pair=>`${event.question?.items?.find(item=>item.id===pair.itemId)?.text||pair.itemId} ← ${event.question?.targets?.find(item=>item.id===pair.targetId)?.text||pair.targetId}`)||[];
    $('answer-text').textContent = pairs.length?pairs.join('\n'):selected.length ? selected.join('، ') : (event.answer.text || 'لا توجد إجابة قابلة للتطبيق');
    $('explanation').textContent = event.answer.explanation || '';
    const confidence = Number(event.answer.confidence);
    $('confidence').textContent = Number.isFinite(confidence) ? `تقدير ثقة النموذج: ${Math.round(confidence*100)}٪` : '';
  }
}
function appendEvent(event) {
  const log = $('event-log');
  log.querySelector('.log-placeholder')?.remove();
  const row = document.createElement('li');
  const icon = document.createElement('span');icon.className=`event-icon ${['error','review'].includes(event.kind)?event.kind:''}`;icon.textContent={complete:'✓',error:'!',review:'◈',stopped:'Ⅱ',question:'?',answer:'✧'}[event.kind] || '·';icon.setAttribute('aria-hidden','true');
  const label = document.createElement('span');label.className='event-message';label.textContent=reviewReasons[event.message] || event.message;
  const time = document.createElement('time');time.className='event-time';time.textContent=new Date(event.timestamp || Date.now()).toLocaleTimeString('ar-AE',{hour:'2-digit',minute:'2-digit'});
  row.append(icon,label,time);log.prepend(row);
  while(log.children.length>100) log.lastChild.remove();
  $('activity-count').textContent=`${++eventCount} أحداث`;
}
function applyEvent(event, log = true) {
  if (event.stats) {
    $('solved-count').textContent = event.stats.solved || 0;
    $('review-count').textContent = event.stats.review || 0;
  }
  renderLessonQueue(event.queue,event.stats,event.currentLesson);
  if (log) appendEvent(event);
  showAnswer(event);
  if (['complete','review','error','stopped'].includes(event.kind) && event.blocking !== false) {
    running=false;$('run-status').textContent=statusNames[event.kind];
    setBadge(event.kind==='complete'?'اكتملت الجلسة':event.kind==='error'?'تعذّر المتابعة':'متصل',event.kind==='error'?'error':'success');
    if(event.kind==='review' || event.kind==='error') notice(reviewReasons[event.message]||event.message,event.kind==='error');
  }
  if(event.kind==='review'&&event.blocking===false)notice(event.message);
  updateButtons();
}
function restoreState(state) {
  if (!state) return;
  connected=Boolean(state.page);running=Boolean(state.running);
  if (state.subjectId) selectedSubject=state.subjectId;
  renderSubjects(state.subjects);
  if(state.page) $('page-name').textContent=state.page.title || 'صفحة ألف مرتبطة';
  $('run-status').textContent = statusNames[state.status] || 'متصل';
  $('solved-count').textContent = state.stats?.solved || 0;
  $('review-count').textContent = state.stats?.review || 0;
  renderLessonQueue(state.queue,state.stats,state.currentLesson);
  const events=state.events || [];
  if(events.length) {$('event-log').replaceChildren();eventCount=0;events.forEach(event=>{appendEvent(event);showAnswer(event);});startedAt=events[0].timestamp;}
  setBadge(running?'جارٍ الحل':connected?'متصل':'غير متصل',running?'running':connected?'success':'neutral');
  updateButtons();
}
async function targetTab() {
  if(tabId!==null) {
    try {const tab=await chrome.tabs.get(tabId);if(tab.url?.startsWith(WEBSITE)) return tab;}catch{}
  }
  const tabs = await chrome.tabs.query({url:'https://moe.alefed.com/*'});
  const tab=tabs.find(item=>item.active)||tabs[0];
  if(!tab) throw new Error('افتح موقع ألف وسجّل الدخول، ثم ارجع واضغط «اربط صفحة ألف».');
  return tab;
}
async function connect(refresh = false, requestPermission = true) {
  try {
    notice('');$('connect').disabled=true;
    // Requested only by an explicit click and only for the Alef hostname.
    const granted = !requestPermission || await chrome.permissions.request({origins:['https://moe.alefed.com/*']});
    if(!granted) throw new Error('يلزم السماح للإضافة بقراءة صفحة ألف لربطها.');
    const tab=await targetTab();tabId=tab.id;
    const result=await message(refresh?'SCAN':'CONNECT',{selectors:config.selectors});
    restoreState(result.state);renderSubjects(result.subjects);connected=true;
    $('run-status').textContent=result.subjects?.length?'اختر مادة للبدء':'لم تُكتشف مواد';setBadge('متصل','success');
    $('page-name').textContent=result.page?.title || 'صفحة ألف مرتبطة';
    if(!result.subjects?.length)notice('لم يتعرّف الفحص على قائمة المواد. افتح الصفحة الرئيسية للمواد في ألف ثم أعد الفحص. زر «تصدير فحص الصفحة» يساعد في تشخيص نوع الصفحة.');
    else if(result.subjects.length===1 && result.subjects[0].id==='current') notice('تعرّفت على الدرس المفتوح. لفحص جميع المواد افتح قائمة المواد في ألف ثم أعد الفحص.');
    else notice(`اكتُشفت ${result.subjects.length} مواد. اختر مادة ثم اضغط «ابدأ الحل» لتشغيل دروسها المفتوحة.`);
  }catch(error){notice(error.message,true);}finally{updateButtons();}
}
async function exportDiagnostics() {
  try {
    const result=await message('DIAGNOSTICS');
    const report=result.diagnostics||result.report||result.snapshot||result;
    const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const link=document.createElement('a');link.href=url;link.download='alef-page-scan.json';
    document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),10000);
    notice('حُفظ ملف فحص الصفحة محليًا. راجع محتواه قبل مشاركته؛ لا يحتوي على رمز ربط الخادم.');
  }catch(error){notice(error.message,true);}
}
function checkedUrl(value) {
  const url = new URL(value);
  if(url.protocol!=='http:' || !['127.0.0.1','localhost'].includes(url.hostname) || url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw new Error('استخدم عنوان خادم محلي مثل http://127.0.0.1:4318.');
  return url.origin;
}
async function checkServer() {
  try {
    $('check-server').disabled=true;$('server-status').textContent='جارٍ الفحص…';
    const url=checkedUrl($('server-url').value);
    const response=await fetch(`${url}/api/health`,{signal:AbortSignal.timeout(6000)});
    if(!response.ok) throw new Error('الخادم رفض الاتصال.');
    const health=await response.json();
    if(health.ok!==true) throw new Error('هذا العنوان لا يخص خادم مُعين.');
    const local = health.provider === 'ollama';
    const ready = health.configured === true && (!local || health.modelReady === true);
    $('server-status').textContent=ready
      ? local ? `متصل محليًا · النموذج: ${health.model} · دون مفتاح API` : `متصل · المزوّد الخارجي · النموذج: ${health.model}`
      : typeof health.message === 'string' && health.message.trim()
        ? health.message
        : local
          ? `الخادم يعمل؛ شغّل Ollama وحمّل النموذج ${health.model}، ثم أعد الفحص.`
          : 'الخادم يعمل؛ إعداد الحل غير مكتمل. راجع رسالة التشغيل.';
    return health;
  }catch(error){$('server-status').textContent=error.name==='TimeoutError'?'انتهت المهلة؛ تأكد من تشغيل npm start.':`تعذر الاتصال: ${error.message}`;return null;}finally{$('check-server').disabled=false;}
}
function openSettings() {
  $('server-url').value=config.serverUrl;
  $('pairing-token').value=config.token;
  document.querySelectorAll('[data-selector]').forEach(input=>{input.value=config.selectors[input.dataset.selector] || '';});
  $('settings-error').hidden=true;
  if(!$('settings-dialog').open)$('settings-dialog').showModal();
}
async function saveSettings(event) {
  event.preventDefault();
  try {
    config.serverUrl=checkedUrl($('server-url').value);
    config.token=$('pairing-token').value.trim();
    const selectors={};document.querySelectorAll('[data-selector]').forEach(input=>{selectors[input.dataset.selector]=input.value.trim();});
    config.selectors=selectors;
    const {token,...persistent}=config;
    await chrome.storage.local.set({alefConfig:persistent});
    await chrome.storage.session.set({alefPairingToken:token});
    $('settings-dialog').close();notice('حُفظت الإعدادات. رمز الربط المحلي محفوظ لجلسة المتصفح الحالية فقط.');
  }catch(error){$('settings-error').hidden=false;$('settings-error').textContent=error.message;}
}
async function start() {
  try {
    notice('');
    if(!config.token){openSettings();throw new Error('الصق رمز الربط المحلي في الإعدادات أولًا. ينسخه تشغيل START-WINDOWS.cmd إلى الحافظة.');}
    $('start').disabled=true;
    config.verify=$('verify').checked;config.autoSubmit=$('auto-submit').checked;
    config.skipInstruction=$('skip-instruction').checked;
    const result=await message('START',{subjectId:selectedSubject,config:{...config,minConfidence:.85}});
    $('event-log').replaceChildren();eventCount=0;$('activity-count').textContent='0 أحداث';
    restoreState(result.state);running=true;startedAt=Date.now();
    $('run-status').textContent='جارٍ الحل';setBadge('جارٍ الحل','running');
    const {token,...persistent}=config;
    await chrome.storage.local.set({alefConfig:persistent});
  }catch(error){notice(error.message,true);}finally{updateButtons();}
}
async function init() {
  if(typeof chrome==='undefined'||!chrome.runtime?.id){notice('هذه واجهة إضافة Chrome. ثبّت مجلد extension، ثم افتح مُعين من شريط الإضافات.',true);return;}
  const [local,session]=await Promise.all([chrome.storage.local.get('alefConfig'),chrome.storage.session.get('alefPairingToken')]);
  config={...config,...local.alefConfig,token:session.alefPairingToken||''};
  $('verify').checked=config.verify!==false;$('auto-submit').checked=config.autoSubmit!==false;
  $('skip-instruction').checked=config.skipInstruction!==false;
  if(tabId!==null){try{const result=await message('GET_STATE');restoreState(result.state);}catch{}}
  chrome.runtime.onMessage.addListener(message=>{if(message.type==='RUN_EVENT'&&message.tabId===tabId)applyEvent(message.event);});
  $('connect').addEventListener('click',()=>connect());$('refresh').addEventListener('click',()=>connect(true));
  $('diagnostics').addEventListener('click',exportDiagnostics);
  $('open-alef').addEventListener('click',async()=>{const tab=await chrome.tabs.create({url:WEBSITE});tabId=tab.id;});
  $('start').addEventListener('click',start);
  $('stop').addEventListener('click',async()=>{try{await message('STOP');}catch(error){notice(error.message,true);}});
  document.querySelectorAll('.settings-trigger').forEach(button=>button.addEventListener('click',openSettings));
  $('close-settings').addEventListener('click',()=>$('settings-dialog').close());
  $('settings-form').addEventListener('submit',saveSettings);$('check-server').addEventListener('click',checkServer);
  setInterval(()=>{
    if(!startedAt || !running)return;
    const elapsed=Math.floor((Date.now()-startedAt)/1000);
    $('elapsed').textContent=`${String(Math.floor(elapsed/60)).padStart(2,'0')}:${String(elapsed%60).padStart(2,'0')}`;
  },1000);
  if(!running && tabId!==null && typeof chrome.permissions.contains==='function') {
    const granted=await chrome.permissions.contains({origins:['https://moe.alefed.com/*']});
    if(granted)await connect(false,false);
  }
}
init().catch(error=>notice(error.message,true));
