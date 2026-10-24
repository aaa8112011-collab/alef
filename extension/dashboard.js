'use strict';

const $ = id => document.getElementById(id);
const DEFAULT_URL = 'http://127.0.0.1:4318';
const WEBSITE = 'https://moe.alefed.com/';
let tabId = Number(new URLSearchParams(location.search).get('tabId')) || null;
let selectedSubject = null;
let subjects = [];
let running = false;
let starting = false;
let grantingFrames = false;
let blockedFrames = [];
let runEventRevision = 0;
let lastRunSequence = 0;
let connected = false;
let config = {serverUrl:DEFAULT_URL,token:'',verify:true,qualityMode:true,allowUncertain:true,autoSubmit:true,skipInstruction:true,selectors:{}};
let startedAt = null;
let eventCount = 0;
let lessonQueue = [];
let lessonStats = {};
let answerLessonKey = null;
let displayedQuestion = null;
let displayedRetryAttempt = false;
let displayedUncertainAnswer = false;
let pairingSaveRevision = 0;
let pendingPairingSave = Promise.resolve();
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
function updateSolveMode() {
  $('solve-mode').textContent = $('verify').checked
    ? $('allow-uncertain').checked
      ? 'الدقة الأعلى مفعّلة: تفكير متأنٍّ ومراجعة مستقلة عند توفرها؛ قد تُرسل أفضل إجابة متاحة قبل اكتمال التحقق عند انخفاض الثقة. يحتاج وقتًا إضافيًا، ولا يضمن صحة كل إجابة.'
      : 'الدقة الأعلى مفعّلة: تفكير متأنٍّ وحلّان مستقلان للمراجعة؛ يحتاج وقتًا إضافيًا، ولا يضمن صحة كل إجابة.'
    : 'الوضع السريع مفعّل: حل واحد دون المراجعة المستقلة؛ قد يزيد احتمال الخطأ.';
}
function updateUncertaintyMode() {
  const allowed=$('allow-uncertain').checked;
  $('uncertainty-mode').textContent=allowed
    ? 'تُرسل أفضل إجابة متاحة حتى عند انخفاض الثقة أو اختلاف المراجعة؛ قد تكون خاطئة. يتوقف عند تعذّر قراءة السؤال أو تطبيق الإجابة.'
    : 'يتوقف عند انخفاض الثقة أو اختلاف المراجعة لتراجع الإجابة قبل إرسالها.';
  $('run-policy').textContent=allowed
    ? 'راقب الإجابات وشرحها، وتوقّف في أي وقت. المتابعة مفعّلة للإجابات غير المؤكدة؛ قد تكون خاطئة.'
    : 'راقب الإجابات وشرحها، وتوقّف في أي وقت. الأسئلة غير المؤكدة تنتظر مراجعتك.';
  $('review-policy').textContent=allowed?'تعذّر التنفيذ':'بلا تخمين';
}
function readRunOptions() {
  config.verify=$('verify').checked;config.qualityMode=config.verify;
  config.allowUncertain=$('allow-uncertain').checked;
  config.autoSubmit=$('auto-submit').checked;config.skipInstruction=$('skip-instruction').checked;
}
function updateButtons() {
  $('start').disabled = !connected || !selectedSubject || running || starting || grantingFrames;
  $('start-label').textContent = starting ? 'جارٍ البدء…' : running ? 'جارٍ الحل…' : 'ابدأ الحل';
  $('start').setAttribute('aria-busy',String(starting||running));
  $('stop').disabled = !running;
  $('connect').disabled = running||starting||grantingFrames;
  $('refresh').disabled = !connected || running||starting||grantingFrames;
  $('verify').disabled = running||starting||grantingFrames;
  $('allow-uncertain').disabled = running||starting||grantingFrames;
  $('auto-submit').disabled = running||starting||grantingFrames;
  $('skip-instruction').disabled = running||starting||grantingFrames;
  $('diagnostics').disabled = !connected || running||starting||grantingFrames;
  $('subjects').querySelectorAll('button').forEach(button => {button.disabled = running||starting||grantingFrames;});
  $('selection-label').textContent = subjects.find(subject=>subject.id===selectedSubject)?.name || 'لم تُحدّد مادة بعد';
  renderFramePermission();
}
function observedAlefFrames(items) {
  const origins=new Set();
  for(const item of Array.isArray(items)?items:[]) {
    try {
      const origin=item?.origin;
      if(typeof origin!=='string')continue;
      const url=new URL(origin);
      const validHost=url.hostname.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
      if(url.protocol==='https:'&&validHost&&url.hostname.endsWith('.alefed.com')&&url.origin===origin&&!url.port&&!url.username&&!url.password)origins.add(origin);
    }catch{}
  }
  return [...origins].map(origin=>({origin}));
}
function renderFramePermission() {
  $('frame-permission-panel').hidden=!blockedFrames.length||running||starting;
  $('frame-origins').textContent=blockedFrames.map(item=>item.origin).join('، ');
  $('grant-frame-access').disabled=grantingFrames||running||starting;
  $('grant-frame-access').textContent=grantingFrames?'جارٍ طلب السماح…':'السماح بمحتوى الدرس';
}
function showRunPhase(event) {
  const phase=$('run-phase');
  phase.textContent=typeof event?.message==='string'?event.message:'';
  phase.hidden=!phase.textContent;
  if(running) {
    $('run-status').textContent={status:'جارٍ التنفيذ',queue:'تجهيز الدروس',lesson:'متابعة الدرس',question:'حل السؤال',answer:'تطبيق الإجابة',submitted:'انتظار التالي'}[event?.kind]||'جارٍ الحل';
  }
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
  $('lesson-count').textContent=`اكتمل ${completed} من ${total}`;
  const progress=total?Math.min(100,Math.round(completed*100/total)):0;
  $('lesson-progress-fill').style.width=`${progress}%`;
  document.querySelector('.course-progress-track').setAttribute('aria-valuenow',String(progress));
  document.querySelector('.course-progress-track').setAttribute('aria-valuetext',`اكتمل ${completed} من ${total} درس؛ ${reviews} يحتاج مراجعة`);
  const active=typeof currentLesson==='string'?currentLesson:currentLesson?.name;
  $('current-lesson').textContent=active?`الدرس الحالي: ${active}`:`أُكمل ${completed} درس · ${reviews} يحتاج مراجعة`;
}
function clearAnswer({resetLesson=false}={}) {
  displayedQuestion=null;
  displayedRetryAttempt=false;
  displayedUncertainAnswer=false;
  if(resetLesson) {
    answerLessonKey=null;
    $('answer-subject').textContent='';$('answer-lesson').textContent='';
    $('answer-context').hidden=true;
  }
  $('answer-empty').hidden=false;$('answer-content').hidden=true;
  $('question-text').textContent='';$('answer-box').hidden=true;
  $('question-media-note').hidden=true;
  $('answer-text').textContent='';$('explanation').textContent='';$('confidence').textContent='';
  $('answer-state').textContent='';$('answer-state').dataset.state='';
  $('question-label').textContent='السؤال الحالي';
  $('answer-label').textContent='الإجابة المقترحة';
}
function dropdownLabel(field) {
  return (field?.text||'').replace(/\[dropdown:[^\]\r\n]+\]/g,'').trim()||'قائمة الإجابة';
}
function showAnswer(event) {
  const lesson=typeof event.currentLesson==='string'?{name:event.currentLesson}:event.currentLesson;
  const lessonKey=lesson&&(lesson.id||lesson.name);
  if(lessonKey&&lessonKey!==answerLessonKey) {
    clearAnswer();answerLessonKey=lessonKey;
  }
  const subject=event.currentSubject?.name||subjects.find(item=>item.id===selectedSubject)?.name;
  if(subject)$('answer-subject').textContent=subject;
  if(lesson?.name)$('answer-lesson').textContent=lesson.name;
  $('answer-context').hidden=!$('answer-subject').textContent&&!$('answer-lesson').textContent;
  if(event.question) {
    const changed=displayedQuestion&&(event.question.id!==displayedQuestion.id||event.question.fingerprint!==displayedQuestion.fingerprint||event.question.text!==displayedQuestion.text);
    if(event.kind==='question'||changed)clearAnswer();
    displayedQuestion=event.question;
    $('question-text').textContent=(event.question.text||'').replace(/\[dropdown:([^\]\r\n]+)\]/g,(_marker,id)=>
      `[${dropdownLabel(event.question.fields?.find(field=>field.id===id))}]`);
    $('question-media-note').hidden=event.question.requiresVision!==true;
    $('answer-empty').hidden=true;$('answer-content').hidden=false;
  }
  if(event.kind==='question') {
    $('answer-state').textContent=event.question?.requiresVision
      ? 'جارٍ حل هذا السؤال مع الرسم أو الصورة…' : 'جارٍ حل هذا السؤال…';
    $('answer-state').dataset.state='working';
  }
  if (event.answer) {
    displayedRetryAttempt=event.retryAttempt===true;
    displayedUncertainAnswer=!displayedRetryAttempt&&event.uncertainAnswer===true;
    $('answer-empty').hidden=true;$('answer-content').hidden=false;
    $('answer-box').hidden = false;
    const question=event.question||displayedQuestion;
    const selected = question?.options?.filter(option=>event.answer.optionIds?.includes(option.id)).map(option=>option.text) || [];
    const pairs=event.answer.matches?.map(pair=>`${question?.items?.find(item=>item.id===pair.itemId)?.text||pair.itemId} ← ${question?.targets?.find(item=>item.id===pair.targetId)?.text||pair.targetId}`)||[];
    const fields=event.answer.selections?.map(selection=>{
      const field=question?.fields?.find(field=>field.id===selection.fieldId);
      return `${dropdownLabel(field)} ← ${field?.options?.find(option=>option.id===selection.optionId)?.text||selection.optionId}`;
    })||[];
    const answerText=fields.length?fields.join('\n'):pairs.length?pairs.join('\n'):selected.length?selected.join('، '):(event.answer.text||'').trim();
    $('answer-label').textContent=answerText?(displayedRetryAttempt?'محاولة سريعة بعد الرفض':displayedUncertainAnswer?'إجابة غير مؤكدة':'الإجابة المقترحة'):'تعذّر إكمال الحل';
    $('answer-text').textContent=answerText||'لم تُحدَّد إجابة من البيانات المقروءة';
    $('explanation').textContent = event.answer.explanation || '';
    const confidence = Number(event.answer.confidence);
    $('confidence').textContent = !displayedRetryAttempt&&Number.isFinite(confidence) ? `تقدير ثقة النموذج: ${Math.round(confidence*100)}٪` : '';
    $('answer-state').textContent=displayedRetryAttempt?'جارٍ تطبيق محاولة سريعة بعد رفض الإجابة الأولى…':displayedUncertainAnswer?'جارٍ تطبيق أفضل إجابة متاحة رغم عدم التأكد منها…':'وصلت الإجابة؛ جارٍ تطبيقها على السؤال في ألف…';$('answer-state').dataset.state='working';
  }
  if(event.kind==='submitted'&&event.submitted===true) {
    displayedRetryAttempt=event.retryAttempt===true||displayedRetryAttempt;
    displayedUncertainAnswer=!displayedRetryAttempt&&(event.uncertainAnswer===true||displayedUncertainAnswer);
    $('answer-label').textContent=displayedRetryAttempt?'محاولة سريعة مُرسلة':displayedUncertainAnswer?'إجابة غير مؤكدة مُرسلة':'الإجابة المُرسلة';
    $('answer-state').textContent=displayedRetryAttempt?'أُرسلت محاولة سريعة بعد الرفض؛ لا تعني استعادة درجة المحاولة الأولى.':displayedUncertainAnswer?'أُرسلت أفضل إجابة متاحة رغم عدم التأكد؛ جارٍ انتظار نتيجة ألف.':'أُرسلت الإجابة إلى ألف؛ جارٍ انتظار النتيجة أو السؤال التالي.';
    $('answer-state').dataset.state='submitted';
  } else if(['review','error'].includes(event.kind)&&event.blocking!==false) {
    $('answer-state').textContent=event.applied===true
      ? 'تم اختيار الإجابة، لكن لم يُؤكَّد إرسالها. توقف التشغيل في هذا الدرس.'
      : 'توقف التشغيل في هذا الدرس. راجع سبب التوقف في سجل النشاط.';
    $('answer-state').dataset.state='review';
  } else if(event.kind==='complete') {
    if(displayedQuestion)$('question-label').textContent='آخر سؤال في الجلسة';
    $('answer-state').textContent='اكتملت الجلسة. يمكنك مراجعة الإجابات وخطوات التنفيذ في سجل النشاط.';
    $('answer-state').dataset.state='complete';
  } else if(event.kind==='stopped') {
    $('answer-state').textContent='التشغيل متوقف.';$('answer-state').dataset.state='stopped';
  }
}
function appendEvent(event) {
  const log = $('event-log');
  log.querySelector('.log-placeholder')?.remove();
  const row = document.createElement('li');
  const icon = document.createElement('span');icon.className=`event-icon ${['error','review'].includes(event.kind)?event.kind:''}`;icon.textContent={complete:'✓',error:'!',review:'◈',stopped:'Ⅱ',question:'?',answer:'✧',submitted:'✓'}[event.kind] || '·';icon.setAttribute('aria-hidden','true');
  const label = document.createElement('span');label.className='event-message';
  label.textContent=(event.currentLesson?.name?`${event.currentLesson.name} — `:'')+(reviewReasons[event.message] || event.message);
  const time = document.createElement('time');time.className='event-time';time.textContent=new Date(event.timestamp || Date.now()).toLocaleTimeString('ar-AE',{hour:'2-digit',minute:'2-digit'});
  row.append(icon,label,time);log.prepend(row);
  while(log.children.length>100) log.lastChild.remove();
  $('activity-count').textContent=`${++eventCount} أحداث`;
}
function applyEvent(event, log = true) {
  if(Number.isSafeInteger(event.sequence)&&event.sequence>0) {
    // A state reply can already include events still queued for delivery.
    // Sequence numbers also reject out-of-order runtime broadcasts.
    if(event.sequence<=lastRunSequence)return;
    lastRunSequence=event.sequence;
  }
  runEventRevision++;
  if(Array.isArray(event.blockedFrames))blockedFrames=observedAlefFrames(event.blockedFrames);
  else if(['complete','review','error','stopped'].includes(event.kind)&&event.blocking!==false)blockedFrames=[];
  if (event.stats) {
    $('solved-count').textContent = event.stats.solved || 0;
    $('review-count').textContent = event.stats.review || 0;
  }
  renderLessonQueue(event.queue,event.stats,event.currentLesson);
  if (log) appendEvent(event);
  showAnswer(event);
  if (['complete','review','error','stopped'].includes(event.kind) && event.blocking !== false) {
    running=false;$('run-status').textContent=statusNames[event.status]||statusNames[event.kind];
    setBadge(event.kind==='complete'?'اكتملت الجلسة':event.kind==='error'?'تعذّر المتابعة':'متصل',event.kind==='error'?'error':'success');
    if(event.kind==='review' || event.kind==='error') notice(reviewReasons[event.message]||event.message,event.kind==='error');
  } else if(typeof event.running==='boolean'||['status','queue','lesson','question','answer','submitted'].includes(event.kind)) {
    // Another dashboard can start this tab's run. Progress events are current
    // worker state too, even when this page did not send the START request.
    running=typeof event.running==='boolean'?event.running:true;
    $('run-status').textContent=statusNames[event.status]||statusNames[running?'running':'idle'];
    setBadge(running?'جارٍ الحل':connected?'متصل':'غير متصل',running?'running':connected?'success':'neutral');
  }
  showRunPhase(event);
  if(event.kind==='review'&&event.blocking===false)notice(event.message);
  updateButtons();
}
function restoreState(state) {
  if (!state) return;
  const sequence=Number.isSafeInteger(state.eventSequence)?state.eventSequence:
    Number.isSafeInteger(state.lastEvent?.sequence)?state.lastEvent.sequence:null;
  if(sequence!==null) {
    if(sequence<lastRunSequence)return;
    lastRunSequence=sequence;
  }
  clearAnswer({resetLesson:true});
  connected=Boolean(state.page);running=Boolean(state.running);
  blockedFrames=observedAlefFrames(state.blockedFrames);
  if (state.subjectId) selectedSubject=state.subjectId;
  renderSubjects(state.subjects);
  if(state.page) $('page-name').textContent=state.page.title || 'صفحة ألف مرتبطة';
  $('run-status').textContent = statusNames[state.status] || 'متصل';
  $('solved-count').textContent = state.stats?.solved || 0;
  $('review-count').textContent = state.stats?.review || 0;
  renderLessonQueue(state.queue,state.stats,state.currentLesson);
  const events=state.events || [];
  if(events.length) {$('event-log').replaceChildren();eventCount=0;events.forEach(event=>{appendEvent(event);showAnswer(event);});startedAt=events[0].timestamp;}
  showAnswer({currentLesson:state.currentLesson,currentSubject:state.subjects?.find(item=>item.id===state.subjectId)});
  const lastEvent=state.lastEvent||events.at(-1);
  showRunPhase(typeof lastEvent?.running==='boolean'&&lastEvent.running!==running
    ? {message:running?'جارٍ متابعة الدرس…':statusNames[state.status]||'التشغيل متوقف.'}
    : lastEvent);
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
    // Lesson embeds and the public file-service configuration confirm these
    // exact origins. Asset access lets the worker read a displayed diagram
    // when the image host does not allow a content-script canvas read.
    const granted = !requestPermission || await chrome.permissions.request({origins:['https://moe.alefed.com/*','https://content.alefed.com/*','https://file-delivery.alefed.com/*']});
    if(!granted) throw new Error('يلزم السماح للإضافة بقراءة صفحة ألف لربطها.');
    const tab=await targetTab();if(tabId!==tab.id)lastRunSequence=0;tabId=tab.id;
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
    notice('حُفظ فحص الصفحة محليًا، ويشمل نص آخر سؤال وخياراته وسبب التوقف. راجعه قبل مشاركته؛ لا يتضمن رمز الربط أو صور الأسئلة.');
  }catch(error){notice(error.message,true);}
}
function checkedUrl(value) {
  let url;
  try {url=new URL(value);}catch{throw new Error('استخدم عنوان خادم محلي مثل http://127.0.0.1:4318.');}
  if(url.protocol!=='http:' || !['127.0.0.1','localhost'].includes(url.hostname) || url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw new Error('استخدم عنوان خادم محلي مثل http://127.0.0.1:4318.');
  return url.origin;
}
async function checkServer() {
  try {
    $('check-server').disabled=true;$('server-status').textContent='جارٍ الفحص…';
    const url=checkedUrl($('server-url').value);
    let response;
    try {response=await fetch(`${url}/api/health`,{signal:AbortSignal.timeout(6000)});}
    catch(error){throw new Error(error.name==='TimeoutError'
      ? 'انتهت مهلة فحص الخادم المحلي. شغّل START-WINDOWS.cmd من مجلد مُعين واترك نافذته مفتوحة، ثم أعد فحص الاتصال.'
      : 'تعذّر الوصول إلى خادم مُعين المحلي. شغّل START-WINDOWS.cmd من مجلد مُعين واترك نافذته مفتوحة، ثم أعد فحص الاتصال. رمز الربط وحده لا يشغّل الخادم.');}
    if(!response.ok) throw new Error('الخادم رفض الاتصال.');
    const health=await response.json();
    if(health.ok!==true) throw new Error('هذا العنوان لا يخص خادم مُعين.');
    if(!Number.isFinite(Number(health.protocolVersion))||Number(health.protocolVersion)<3) {
      throw new Error('الخادم المحلي يعمل بنسخة قديمة. حدّث المشروع كاملًا (الخادم والإضافة)، ثم أغلق نافذة التشغيل القديمة وشغّل START-WINDOWS.cmd من النسخة الجديدة وأعد فحص الاتصال.');
    }
    const local = health.provider === 'ollama';
    const ready = health.configured === true && (!local || health.modelReady === true);
    $('server-status').textContent=ready
      ? local ? health.visionReady===true
        ? `متصل محليًا · النصوص: ${health.model} · الصور: ${health.visionModel} · دون مفتاح API`
        : health.visionReady===false
          ? `متصل للنصوص عبر ${health.model}؛ الصور غير جاهزة. ${health.visionMessage||`النموذج البصري ${health.visionModel||''} يحتاج تجهيزًا.`} شغّل START-WINDOWS.cmd من النسخة الجديدة ثم أعد الفحص.`
          : `متصل للنصوص عبر ${health.model}؛ حدّث ملفات الخادم وشغّل START-WINDOWS.cmd من النسخة الجديدة لتجهيز قراءة الصور.`
        : `متصل · المزوّد الخارجي · النموذج: ${health.model}`
      : typeof health.message === 'string' && health.message.trim()
        ? health.message
        : local
          ? `الخادم يعمل؛ شغّل Ollama وحمّل النموذج ${health.model}، ثم أعد الفحص.`
          : 'الخادم يعمل؛ إعداد الحل غير مكتمل. راجع رسالة التشغيل.';
    return health;
  }catch(error){$('server-status').textContent=error.message;return null;}finally{$('check-server').disabled=false;}
}
function openSettings() {
  $('server-url').value=config.serverUrl;
  $('pairing-token').value=config.token;
  document.querySelectorAll('[data-selector]').forEach(input=>{input.value=config.selectors[input.dataset.selector] || '';});
  $('settings-error').hidden=true;
  if(!$('settings-dialog').open)$('settings-dialog').showModal();
}
function persistPairingToken(value) {
  const token=String(value||'').trim();
  config.token=token;
  const revision=++pairingSaveRevision;
  const status=$('pairing-save-status');
  status.textContent='جارٍ حفظ رمز الربط على هذا الجهاز…';
  // Send the write immediately on input, rather than waiting for a debounce or
  // for the settings form: the extension page may be closed right after paste.
  const operation=Promise.resolve(chrome.storage.local.set({alefPairingToken:token})).then(()=>{
    if(revision===pairingSaveRevision)status.textContent=token
      ? 'حُفظ رمز الربط تلقائيًا على هذا الجهاز، ويبقى بعد إغلاق المتصفح. امسح الحقل لحذفه.'
      : 'حُذف رمز الربط المحفوظ. الصق رمزًا جديدًا للربط.';
  }).catch(()=>{
    const message='تعذّر حفظ رمز الربط. أعد المحاولة وانتظر ظهور تأكيد الحفظ.';
    if(revision===pairingSaveRevision)status.textContent=message;
    throw new Error(message);
  });
  pendingPairingSave=operation;
  return operation;
}
async function saveSettings(event) {
  event.preventDefault();
  try {
    config.serverUrl=checkedUrl($('server-url').value);
    config.token=$('pairing-token').value.trim();
    readRunOptions();
    const selectors={};document.querySelectorAll('[data-selector]').forEach(input=>{selectors[input.dataset.selector]=input.value.trim();});
    config.selectors=selectors;
    const {token,...persistent}=config;
    await chrome.storage.local.set({alefConfig:persistent});
    await persistPairingToken(token);
    $('settings-dialog').close();notice('حُفظت الإعدادات ورمز الربط على هذا الجهاز.');
  }catch(error){$('settings-error').hidden=false;$('settings-error').textContent=error.message;}
}
async function start(type='START') {
  // Event handlers pass a MouseEvent; explicit frame resume passes its type.
  const resume=type==='RESUME_FRAMES';
  const requestRevision=runEventRevision;
  let attemptedStart=false,startRevision=requestRevision;
  try {
    notice('');
    await pendingPairingSave;
    if(!config.token){openSettings();throw new Error('الصق رمز الربط المحلي في الإعدادات أولًا. ينسخه تشغيل START-WINDOWS.cmd إلى الحافظة.');}
    starting=true;
    readRunOptions();
    // Reset before sending: real progress/error events may arrive before the
    // START response. Never erase those events or force an ended run active.
    if(!resume) {
      $('event-log').replaceChildren();eventCount=0;$('activity-count').textContent='0 أحداث';
      clearAnswer({resetLesson:true});
      blockedFrames=[];
    }
    $('run-status').textContent='جارٍ البدء';
    showRunPhase({message:resume?'فحص الخادم المحلي قبل متابعة الدرس الحالي…':'فحص الخادم المحلي قبل بدء الدرس…'});
    updateButtons();
    const revision=runEventRevision;
    startRevision=revision;attemptedStart=true;
    const result=await message(resume?'RESUME_FRAMES':'START',{subjectId:selectedSubject,config:{...config,minConfidence:.85}});
    if(runEventRevision===revision)restoreState(result.state);
    startedAt=Date.now();
    const {token,...persistent}=config;
    await chrome.storage.local.set({alefConfig:persistent});
  }catch(error){
    // A preflight refusal leaves worker state untouched. Restore the prior
    // queue/history cleared for START, while never replacing newer run events.
    if(attemptedStart&&runEventRevision===startRevision){
      try{const result=await message('GET_STATE');if(runEventRevision===startRevision)restoreState(result.state);}catch{}
    }
    notice(error.message,true);
    if(starting&&runEventRevision===requestRevision&&!running){$('run-status').textContent='تعذّر البدء';showRunPhase({message:error.message});}
  }finally{starting=false;updateButtons();}
}
async function grantFrameAccess() {
  const frames=observedAlefFrames(blockedFrames);
  if(!frames.length||running||starting||grantingFrames)return;
  grantingFrames=true;
  try {
    // Keep the request in this click's user gesture, before awaiting storage or
    // messages. Request exact observed HTTPS Alef origins only.
    const permission=chrome.permissions.request({origins:frames.map(item=>`${item.origin}/*`)});
    updateButtons();
    const granted=await permission;
    if(!granted){notice('لم يُمنح السماح بمحتوى الدرس. اضغط الزر واسمح بالوصول لمتابعة الدرس الحالي.');return;}
    if(running||starting||!blockedFrames.length)return;
    await start('RESUME_FRAMES');
  }catch(error){notice(error.message,true);}
  finally{grantingFrames=false;updateButtons();}
}
async function init() {
  if(typeof chrome==='undefined'||!chrome.runtime?.id){notice('هذه واجهة إضافة Chrome. ثبّت مجلد extension، ثم افتح مُعين من شريط الإضافات.',true);return;}
  await chrome.storage.local.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'});
  const [local,session]=await Promise.all([chrome.storage.local.get(['alefConfig','alefPairingToken']),chrome.storage.session.get('alefPairingToken')]);
  const hasSavedToken=Object.hasOwn(local,'alefPairingToken');
  config={...config,...local.alefConfig,token:hasSavedToken
    ? typeof local.alefPairingToken==='string'?local.alefPairingToken.trim():''
    : typeof session.alefPairingToken==='string'?session.alefPairingToken.trim():''};
  // The accuracy release upgrades old fast-only preferences once. A later
  // explicit qualityMode:false remains the user's choice on every reopening.
  const upgraded=typeof local.alefConfig?.qualityMode!=='boolean';
  const uncertaintyUpgraded=typeof local.alefConfig?.allowUncertain!=='boolean';
  config.qualityMode=upgraded?true:local.alefConfig.qualityMode;
  config.allowUncertain=uncertaintyUpgraded?true:local.alefConfig.allowUncertain;
  config.verify=config.qualityMode;
  if(upgraded||uncertaintyUpgraded){const {token,...persistent}=config;await chrome.storage.local.set({alefConfig:persistent});}
  if(!hasSavedToken&&Object.hasOwn(session,'alefPairingToken'))await persistPairingToken(config.token);
  await chrome.storage.session.remove?.('alefPairingToken');
  $('verify').checked=config.verify===true;$('auto-submit').checked=config.autoSubmit!==false;
  $('allow-uncertain').checked=config.allowUncertain===true;
  updateSolveMode();
  updateUncertaintyMode();
  $('skip-instruction').checked=config.skipInstruction!==false;
  const initialEvents=[];let loadingState=tabId!==null;
  chrome.runtime.onMessage.addListener(message=>{
    if(message.type!=='RUN_EVENT'||message.tabId!==tabId)return;
    if(loadingState)initialEvents.push(message.event);
    else applyEvent(message.event);
  });
  if(tabId!==null){try{const result=await message('GET_STATE');restoreState(result.state);}catch{}}
  loadingState=false;
  initialEvents.forEach(event=>applyEvent(event));
  $('connect').addEventListener('click',()=>connect());$('refresh').addEventListener('click',()=>connect(true));
  $('diagnostics').addEventListener('click',exportDiagnostics);
  $('open-alef').addEventListener('click',async()=>{const tab=await chrome.tabs.create({url:WEBSITE});if(tabId!==tab.id)lastRunSequence=0;tabId=tab.id;});
  $('start').addEventListener('click',start);
  $('grant-frame-access').addEventListener('click',grantFrameAccess);
  $('verify').addEventListener('change',()=>{readRunOptions();updateSolveMode();});
  $('allow-uncertain').addEventListener('change',async()=>{
    readRunOptions();updateUncertaintyMode();updateSolveMode();
    try{const {token,...persistent}=config;await chrome.storage.local.set({alefConfig:persistent});}
    catch{notice('تعذّر حفظ خيار المتابعة عند انخفاض الثقة. أعد المحاولة.',true);}
  });
  $('stop').addEventListener('click',async()=>{try{await message('STOP');}catch(error){notice(error.message,true);}});
  document.querySelectorAll('.settings-trigger').forEach(button=>button.addEventListener('click',openSettings));
  $('close-settings').addEventListener('click',()=>$('settings-dialog').close());
  $('settings-form').addEventListener('submit',saveSettings);$('check-server').addEventListener('click',checkServer);
  const saveTokenInput=()=>{void persistPairingToken($('pairing-token').value).catch(()=>{});};
  $('pairing-token').addEventListener('input',saveTokenInput);
  $('pairing-token').addEventListener('change',saveTokenInput);
  window.addEventListener('pagehide',()=>{
    if($('settings-dialog').open&&$('pairing-token').value.trim()!==config.token)saveTokenInput();
  });
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
