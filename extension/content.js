(() => {
  'use strict';
  if (globalThis.__alefAssistantInstalled==='0.4.1') return;
  globalThis.__alefAssistantInstalled = '0.4.1';

  let selectors = {};
  let subjects = new Map();
  let lessons = new Map();
  let actions = new Map();
  let dropdownCache = null;
  let fillCache = null;
  let cancelled = false;
  let rootsCache = null;
  let frameDiagnostics = [];
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const hash = text => {
    let n = 2166136261;
    for (const c of text) n = Math.imul(n ^ c.charCodeAt(0), 16777619);
    return (n >>> 0).toString(36);
  };
  const isElement = node => node?.nodeType === 1;
  const view = node => node.ownerDocument.defaultView;
  const norm = value => clean(value).toLowerCase().normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670\u0640]/g,'').replace(/[أإآ]/g,'ا').replace(/ى/g,'ي')
    .replace(/[\u200b-\u200f\u202a-\u202e]/g,'').replace(/[\s:!؟?.،,·•|]+/g,' ').trim();
  function visible(el) {
    if (!isElement(el) || !el.isConnected || !el.getClientRects().length) return false;
    for (let node=el;node;) {
      if (node.matches('[hidden],[aria-hidden="true"],[inert]')) return false;
      const style=view(node).getComputedStyle(node);
      if (style.display==='none' || style.visibility==='hidden' || style.visibility==='collapse') return false;
      node=node.parentElement || node.getRootNode()?.host;
    }
    try { const frame=view(el).frameElement; if(frame && !visible(frame))return false; } catch { return false; }
    return true;
  }
  function roots(scope=document) {
    if(scope===document && rootsCache)return rootsCache;
    const found=[],seen=new Set();
    function visit(root) {
      if(!root || seen.has(root))return;
      seen.add(root);found.push(root);
      for(const node of root.querySelectorAll('*')) {
        if(node.shadowRoot)visit(node.shadowRoot);
        if(node.tagName==='IFRAME' && visible(node)) {
          try {
            const doc=node.contentDocument;
            if(doc?.documentElement)visit(doc);
            else frameDiagnostics.push('يوجد إطار لا تسمح الصفحة بقراءته؛ يلزم فتح المحتوى في صفحة ألف القابلة للوصول.');
          }catch{frameDiagnostics.push('يوجد إطار من نطاق آخر؛ لم تُقرأ محتوياته.');}
        }
      }
    }
    visit(scope);
    if(scope===document)rootsCache=found;
    return found;
  }
  const all = (query,scope=document) => [...new Set(roots(scope).flatMap(root=>[...root.querySelectorAll(query)]))].filter(visible);
  const first = (query,scope=document) => all(query,scope)[0] || null;
  const disabled = el => !el || !!el.disabled || el.getAttribute('aria-disabled')==='true' ||
    !!el.closest('[inert],[data-locked="true"],[data-disabled="true"]');
  function safeHref(el) {
    const link=el.matches('a[href]')?el:first('a[href]',el);
    if(!link)return '';
    const raw=link.getAttribute('href');
    if(!raw || raw==='#' || /^javascript:/i.test(raw))return '';
    try {const url=new URL(raw,el.ownerDocument.location.href);return url.origin===location.origin?url.href:'';}catch{return '';}
  }
  function click(el) {
    if(!el?.isConnected || !visible(el) || disabled(el))throw new Error('العنصر غير متاح أو أصبح مقفلًا؛ أعد فحص الصفحة.');
    if(el.matches('a[href]') && !safeHref(el))throw new Error('رابط الوجهة خارج موقع ألف أو غير قابل للفتح.');
    if(el.matches('[role="tab"]')) {
      // Alef's Radix TabsTrigger selects on primary mousedown, not on click.
      // Limit the event sequence to tabs: choices/submits must still click once.
      const owner=view(el);
      const event={bubbles:true,cancelable:true,composed:true,view:owner,button:0,ctrlKey:false};
      el.dispatchEvent(new owner.MouseEvent('mousedown',{...event,buttons:1}));
      // React may replace the trigger when it switches the selected panel.
      if(!el.isConnected || !visible(el) || disabled(el))return;
      el.dispatchEvent(new owner.MouseEvent('mouseup',{...event,buttons:0}));
      if(!el.isConnected || !visible(el) || disabled(el))return;
    }
    el.click();
  }
  function text(el) {
    if (!el) return '';
    // Preserve fraction/exponent structure instead of flattening rendered math or
    // reading both KaTeX's visual and accessibility copies of the same formula.
    if (!el.matches?.('.katex,math,mjx-container') && !el.querySelector?.('.katex,math,mjx-container')) {
      return clean(el.innerText || el.textContent || el.getAttribute('aria-label'));
    }
    function read(node) {
      if (node.nodeType === 3) return node.textContent;
      if (!isElement(node)) return '';
      if (node.matches('.katex,math,mjx-container')) {
        const latex = node.querySelector('annotation[encoding="application/x-tex"]');
        if (latex?.textContent.trim()) return ` $${latex.textContent.trim()}$ `;
        const math = node.matches('math') ? node : node.querySelector('math');
        if (math) return ` ${math.outerHTML} `;
        const label = node.getAttribute('aria-label');
        if (label) return ` ${label} `;
        throw new Error('الصيغة الرياضية مرسومة دون نص قابل للقراءة؛ راجع السؤال يدويًا.');
      }
      if (node.matches('[hidden],[aria-hidden="true"],script,style') || view(node).getComputedStyle(node).display === 'none') return '';
      return [...node.childNodes].map(read).join('');
    }
    return clean(read(el));
  }
  function settings(next) {
    if (!next) return;
    for (const [name, value] of Object.entries(next)) {
      if (!['subject', 'lesson', 'question', 'option', 'submit', 'next', 'completed'].includes(name)) continue;
      if (typeof value !== 'string' || value.length > 600) throw new Error('محدد الصفحة غير صالح.');
      if (value) document.querySelector(value);
    }
    selectors = {...selectors, ...next};
  }
  const SUBJECT_CARDS = '[data-testid="subject-card"],[data-alef-subject],[data-subject-id],[data-testid*="subject-card" i],[data-testid*="course-card" i],[data-cy*="subject-card" i],.subject-card,.course-card,[class*="subjectCard"],[class*="courseCard"],app-subject-card';
  const CORE_LESSON_CARDS = '[data-testid="core-coursework-foryou-activity-card-navigate"],[data-testid="core-coursework-assigned-activity-card-navigate"],[data-testid="core-coursework-alllessons-activity-card-navigate"]';
  const CORE_LESSON_BUTTONS = '[data-testid="core-coursework-foryou-activity-btn-navigate"],[data-testid="core-coursework-assigned-activity-btn-navigate"]';
  const CORE_CATALOG_TABS = '[data-testid="core-coursework-foryou-tab-select"],[data-testid="core-coursework-assigned-tab-select"],[data-testid="core-coursework-alllessons-tab-select"]';
  const LESSON_CARDS = CORE_LESSON_CARDS+', [data-testid^="level-card-container-"],[data-alef-lesson],[data-lesson-id],[data-activity-id],[data-testid="lesson-card"],[data-testid="lesson-item"],[data-testid="activity-card"],[data-testid="assignment-card"],.lesson-card,.lesson-item,.activity-card,[class*="lessonCard"],[class*="lessonItem"],ul[aria-label="SkillList"] li[aria-label="Skill"]';
  const SUBJECT_NAMES = ['الرياضيات','رياضيات','العلوم','علوم','اللغة العربية','العربية','عربي','اللغة الانجليزية','اللغة الانكليزية','انجليزي','الدراسات الاجتماعية','الاجتماعيات','التربية الاسلامية','الدراسات الاسلامية','الفيزياء','الكيمياء','الاحياء','علوم الحاسوب','الحوسبة','اللغة الفرنسية','mathematics','math','maths','science','arabic','arabic language','english','english language','social studies','islamic education','islamic studies','physics','chemistry','biology','computer science','french'].map(norm);
  function loginPage() {return all('input[type="password"],form[data-testid*="login" i],form[id*="login" i]').length>0;}
  function catalogAncestor(node) {return !!node.closest(`${SUBJECT_CARDS},${LESSON_CARDS}`);}
  function coreCatalog() {
    if(loginPage())return null;
    const route=location.hash.startsWith('#/')?location.hash.slice(1):location.pathname+location.search;
    let url;try{url=new URL(route,location.origin);}catch{return null;}
    const markers=!!first(CORE_CATALOG_TABS+','+CORE_LESSON_CARDS);
    if(!markers&&!/^\/classes\/[^/?#]+\/?$/.test(url.pathname))return null;
    const routeTab=norm(url.searchParams.get('tab'));
    let tab=({foryou:'foryou',assigned:'assigned',alllessons:'alllessons'})[routeTab]||'unknown';
    for(const node of all(CORE_CATALOG_TABS)) {
      if(node.getAttribute('aria-selected')==='true'||node.getAttribute('aria-current')==='page'||node.getAttribute('data-state')==='active') {
        tab=node.getAttribute('data-testid').split('-')[2];break;
      }
    }
    if(tab==='unknown') {
      if(first('[data-testid="assigned-tab"],[data-testid="assigned-tab-loading"],[data-testid="assigned-tab-empty"],[data-testid="assigned-tab-filter-empty"],[data-testid="assigned-tab-error"],[data-testid="core-coursework-assigned-activity-card-navigate"]'))tab='assigned';
      else if(first('[data-testid="core-coursework-alllessons-activity-card-navigate"],#activities-container'))tab='alllessons';
      else if(first('[data-testid="core-coursework-foryou-activity-card-navigate"],[data-testid="core-coursework-foryou-viewall-btn-navigate"],[data-testid="core-coursework-foryou-alllessons-btn-navigate"]'))tab='foryou';
    }
    const selectedFilter=first('[data-testid^="core-coursework-assigned-"][data-testid$="-chip-filter"][aria-pressed="true"]');
    const filter=selectedFilter?.getAttribute('data-testid').match(/assigned-(all|todo|overdue|completed)-chip-filter$/)?.[1]||null;
    return {type:'core-coursework',tab,filter,
      loading:!!first('[data-testid="assigned-tab-loading"],[data-testid="all-tabs-loader"],[data-testid="assigned-task-loading"]'),
      empty:!!first('[data-testid="assigned-tab-empty"],[data-testid="assigned-tab-filter-empty"],[data-testid^="assigned-tasks-empty-"]'),
      error:!!first('[data-testid="assigned-tab-error"],[data-testid="assigned-task-error"]')};
  }
  function uniqueNodes(nodes) {
    return [...new Set(nodes)].filter(node=>!nodes.some(other=>other!==node && other.contains(node)));
  }
  function titleOf(node,kind) {
    const attrs=kind==='subject'?['data-subject-name','data-name']:['data-lesson-name','data-name'];
    for(const attr of attrs)if(clean(node.getAttribute(attr)))return clean(node.getAttribute(attr));
    if(kind==='lesson'&&node.matches('[data-testid="core-coursework-alllessons-activity-card-navigate"]')) {
      const title=first('div.body-lg-regular.line-clamp-2[dir="ltr"]',node);
      if(title)return text(title);
      const thumbnail=first('[aria-label$=" activity thumbnail"]',node);
      if(thumbnail)return clean(thumbnail.getAttribute('aria-label').replace(/ activity thumbnail$/,''));
    }
    const name=first(kind==='subject'?'[data-testid="subject-title"],[data-subject-name],[class*="subject-name"],[class*="subjectName"],h2,h3,h4,[role="heading"]':'[data-testid="level-title"],[data-lesson-name],[data-testid="lesson-title"],[data-testid="activity-title"],h2,h3,h4,[role="heading"]',node);
    return clean(name?text(name):node.getAttribute('aria-label') || text(node));
  }
  function knownSubject(node) {
    const lines=(node.innerText || node.textContent || '').split(/\n/).map(clean).filter(Boolean);
    const heading=titleOf(node,'subject');
    const exact=[heading,...lines].find(line=>SUBJECT_NAMES.includes(norm(line)));
    if(exact)return exact;
    return null;
  }
  function discoverSubjects() {
    subjects=new Map();
    if(loginPage())return [];
    let nodes=all(selectors.subject || SUBJECT_CARDS);
    if(!selectors.subject) {
      const fallback=all('a[href],button,[role="button"],[tabindex="0"],div[class*="card" i],article').filter(node=>{
        if(catalogAncestor(node) || node.closest(LESSON_CARDS))return false;
        const href=safeHref(node);
        return /\/(?:subjects?|courses?)(?:\/[^/?#]+|\?)/i.test(href) || !!knownSubject(node);
      });
      nodes=[...nodes,...fallback];
    }
    for(const node of uniqueNodes(nodes)) {
      const name=knownSubject(node) || titleOf(node,'subject');
      if(!name || name.length>160)continue;
      const id=node.getAttribute('data-alef-subject') || node.getAttribute('data-subject-id') || node.id ||
        `subject-${hash((safeHref(node)||'')+name)}`;
      if(subjects.has(id))continue;
      subjects.set(id,{id,name,node});
    }
    return [...subjects.values()].map(({id,name})=>({id,name}));
  }
  function statusFlag(node,kind) {
    const locked=kind==='locked';
    if(node.matches(CORE_LESSON_CARDS)) {
      if(locked&&node.querySelector('[data-testid="lock-icon"],[data-testid="in-review-label"]'))return true;
      if(!locked) {
        if(node.querySelector('[data-testid="teacher-test-completed-status"],[data-testid="assigned-item-score"]'))return true;
        const label=first(CORE_LESSON_BUTTONS,node)||first('.body-md-light.text-subject-color-160',node);
        if(label&&/^(review|مراجعة|راجع)$/.test(norm(text(label))))return true;
      }
    }
    const selectorsForStatus=locked
      ? '[data-locked="true"],[data-status="locked"],[aria-disabled="true"],.locked,.is-locked,.lesson-locked,[data-testid="lesson-lock"],[data-testid="locked-icon"]'
      : '[data-completed="true"],[data-status="completed"],[data-status="complete"],.completed,.is-completed,.lesson-completed,[data-testid="lesson-completed"],[data-testid="completed-icon"]';
    if(node.matches(selectorsForStatus)||first(selectorsForStatus,node))return true;
    if(locked && disabled(node))return true;
    const labels=all('[aria-label],[title],[data-status]',node).map(el=>norm(el.getAttribute('aria-label')||el.getAttribute('title')||el.getAttribute('data-status')));
    return labels.some(label=>(locked?/^(locked|unavailable|مقفل|مغلق|غير متاح)$/:/^(completed|complete|done|مكتمل|مكتملة|تم الاكمال|تم الانجاز)$/).test(label));
  }
  function discoverLessons() {
    lessons=new Map();
    if(loginPage())return [];
    let nodes=all(selectors.lesson || LESSON_CARDS);
    if(!selectors.lesson)nodes.push(...all('a[href]').filter(node=>!node.closest(SUBJECT_CARDS) &&
      /\/(?:lessons?|activities|assignments?|level-access-content)(?:\/[^/?#]+|\?)/i.test(safeHref(node))));
    nodes=nodes.map(node=>{
      const skill=node.matches('li[aria-label="Skill"]')?node:null;
      if(skill){let wrapper=skill;while(wrapper.parentElement && wrapper.parentElement.getAttribute('aria-label')!=='SkillList')wrapper=wrapper.parentElement;return wrapper;}
      return node;
    });
    let index=0;
    for(const node of uniqueNodes(nodes)) {
      if(node.matches(SUBJECT_CARDS)||node.closest(SUBJECT_CARDS))continue;
      const name=titleOf(node,'lesson');
      if(!name || name.length>220)continue;
      let id=node.getAttribute('data-alef-lesson') || node.getAttribute('data-lesson-id') || node.getAttribute('data-activity-id') || (node.getAttribute('data-testid')?.startsWith('level-card-container-')?node.getAttribute('data-testid'):null) || node.id ||
        `lesson-${hash((safeHref(node)||'')+name)}`;
      if(lessons.has(id)) {
        // Core's responsive views may render the same activity twice without
        // an exposed ID. Keep one stable title/href identity across layouts.
        if(node.matches(CORE_LESSON_CARDS))continue;
        id+=`-${++index}`;
      }
      const core=node.matches(CORE_LESSON_CARDS);
      const clickNode=core?(first(CORE_LESSON_BUTTONS,node)||node):node;
      const lesson={id,name,locked:statusFlag(node,'locked')||disabled(clickNode),completed:statusFlag(node,'completed'),kind:node.matches('[data-testid^="level-card-container-"]')?'level':core?'core-lesson':'lesson',node:clickNode};
      const href=safeHref(node);if(href)lesson.href=href;
      lessons.set(id,lesson);
    }
    return [...lessons.values()].map(({node,...item})=>item);
  }
  function learningContext() {
    return /\/(?:pathways|lesson|activity|learn|content|assessment|exercise|progress)/i.test(location.pathname+location.hash) ||
      !!first('[data-testid="question-renderer"],[data-testid="adaptive-question-renderer"],[data-alef-instruction],[data-alef-question],[data-alef-completed],[data-testid="content-page"],[data-testid="content-page-body-player"],[data-testid="ncle-activity-page"],ul[aria-label="SkillList"]');
  }
  const assessmentTitle=label=>/\b(?:assessment|exit ticket|check (?:your |my )?understanding|practice|quiz|test)\b|اختبار|تقييم|تدريب|اسئلة|تحقق من فهمك|اختبر فهمك|بطاقة الخروج|تذكرة الخروج/.test(norm(label));
  function coreComponentTitle(node) {
    return text(first('span[dir="ltr"]',node))||clean(node.getAttribute('aria-label')||node.getAttribute('title'));
  }
  function availableAssessment(node) {
    if(!node.matches('[data-testid="ncle-main-contents"] [data-testid="ncle-component-item"]')||node.getAttribute('aria-current')==='step'||node.classList.contains('completed')||node.classList.contains('text-primary-60'))return false;
    // These classes reflect isComponentAccessibleForStudent in the public NCLE
    // component. An enabled button alone does not mean the section is assigned.
    if(!node.classList.contains('text-primary-100')&&!node.classList.contains('text-subject-color-160'))return false;
    const current=first('[data-testid="ncle-main-contents"] [data-testid="ncle-component-item"][aria-current="step"]');
    if(current&&assessmentTitle(coreComponentTitle(current)))return false;
    // Keep working on a rendered assessment of unknown authored title rather
    // than jumping away just because another assessment is in the sidebar.
    if(first('[data-alef-question],[data-question-id],[data-testid="question-renderer"],[data-testid="new-question-renderer"]')&&
      (!current||!(/\b(?:learn|learning|introduction|explanation)\b|تعلم|شرح|مقدمة/.test(norm(coreComponentTitle(current))))))return false;
    return assessmentTitle(coreComponentTitle(node));
  }
  function actionKind(node) {
    const testId=node.getAttribute('data-testid')||'';
    const label=norm(node.getAttribute('aria-label')||text(node));
    if(node.matches('[data-testid="ncle-main-contents"] [data-testid="ncle-component-item"]'))return availableAssessment(node)?'assessment':null;
    if(/^core-coursework-(?:foryou|assigned)-showmore-btn-expand$/.test(testId))return 'expand';
    if(testId==='core-coursework-assigned-tab-select'||testId==='core-coursework-foryou-viewall-btn-navigate')return coreCatalog()?.tab==='assigned'?null:'catalog';
    if(testId==='core-coursework-alllessons-tab-select'||/^core-coursework-(?:foryou|assigned|assigned-filterempty)-alllessons-btn-navigate$/.test(testId))return coreCatalog()?.tab==='alllessons'?null:'catalog';
    if(testId==='core-coursework-assigned-all-chip-filter')return node.getAttribute('aria-pressed')==='true'?null:'catalog';
    if(testId==='skip-content-modal-leave-button')return 'skip';
    if(testId==='activity-navigation-bar__next-button')return 'next';
    if(testId==='activity-navigation-bar__finish-button'||testId==='finish-button')return 'finish';
    if((testId==='next-button'||node.id==='alef-next-button')&&!/^(submit|submit answer|check|check answer|confirm answer|try again|ارسال|ارسال الاجابة|تحقق|تحقق من الاجابة|تاكيد الاجابة|حاول مرة اخري|حاول مجددا)$/.test(label))return 'next';
    if(testId==='ncle-sidebar-back'||testId==='ncle-completion-page-back')return 'back';
    if(node.matches('#skill-player-practice,[data-alef-assessment],[data-testid="start-assessment"],[data-testid="practice-button"]'))return 'assessment';
    if(node.matches('[data-alef-skip],[data-testid="skip-button"],[data-testid="skip-intro"]'))return 'skip';
    if(node.matches('[data-alef-next-lesson],[data-testid="next-lesson"]'))return 'nextLesson';
    if(node.matches('[data-alef-back],[data-testid="pathway-back-button-header"],[data-testid="back-to-lessons"],[data-testid="back-button"],[data-testid="mobile-close-button"]'))return 'back';
    if(node.matches('[data-alef-finish],[data-testid="finish-lesson"]'))return 'finish';
    if(node.matches('[data-alef-next]'))return 'next';
    if(/^(تخطي|تجاوز|تخطي المقدمة|تجاوز المقدمة|تخطي الشرح|تجاوز الشرح|skip|skip intro|skip introduction|skip explanation)$/.test(label))return 'skip';
    if(/^(i['’]?ll try later|try later|ساحاول لاحقا|ساجرب لاحقا|احاول لاحقا)$/.test(label))return 'skip';
    if(/^(try again|حاول مرة اخري|حاول مجددا)$/.test(label)&&learningContext())return 'retry';
    if(/^(start|ابدا|بدء|ابدا الان)$/.test(label)&&learningContext())return 'next';
    if(/^(ابدا الاسئلة|بدء الاسئلة|انتقل الي الاسئلة|ابدا الاختبار|بدء الاختبار|ابدا التقييم|ابدا التمرين|اختبر فهمك|قيم فهمك|اسئلة الدرس|لنختبر فهمك|start assessment|start quiz|take assessment|go to assessment|start practice|start exercise|check your understanding|ready for questions|let's go)$/.test(label))return 'assessment';
    if(/^(الدرس التالي|انتقل الي الدرس التالي|النشاط التالي|next lesson|next activity)$/.test(label))return 'nextLesson';
    if(/^(العودة للدروس|العودة الي الدروس|رجوع الي الدروس|قائمة الدروس|العودة للمادة|العودة الي المادة|العودة الي المقرر|back to lessons|back to course|back to subject|back to coursework)$/.test(label))return 'back';
    if(!learningContext())return null;
    if(/^(التالي|السؤال التالي|متابعة|استمرار|next|next question|continue|continue practice)$/.test(label))return 'next';
    if(/^(انهاء|انهاء الدرس|اكمال الدرس|finish|finish lesson|complete lesson|done)$/.test(label))return 'finish';
    if(/^(رجوع|العودة|السابق|back)$/.test(label))return 'back';
    return null;
  }
  function discoverActions() {
    actions=new Map();
    if(loginPage())return [];
    const query='[data-testid^="core-coursework-"],[data-testid="skip-content-modal-leave-button"],[data-testid="back-button"],[data-testid="mobile-close-button"],button,a[href],[role="button"],#alef-next-button,#skill-player-practice,[data-alef-skip],[data-alef-assessment],[data-alef-next],[data-alef-next-lesson],[data-alef-back],[data-alef-finish]';
    const candidates=all(query).filter(node=>!disabled(node) && !catalogAncestor(node));
    const counts=new Map();
    for(const node of candidates) {
      const kind=actionKind(node);if(!kind)continue;
      if(first('[data-testid="ncle-lock-screen"]')&&kind!=='back')continue;
      const label=clean(node.getAttribute('aria-label')||text(node)).slice(0,160)||kind;
      const base=node.id || node.getAttribute('data-testid') || `${kind}-${hash(label+safeHref(node))}`;
      const count=counts.get(base)||0;counts.set(base,count+1);
      const id=count?`${base}-${count}`:base;
      let metadata={};
      if(kind==='catalog') {
        const testId=node.getAttribute('data-testid');
        metadata=testId==='core-coursework-assigned-all-chip-filter'?{filter:'all',priority:1}
          :testId==='core-coursework-assigned-tab-select'||testId==='core-coursework-foryou-viewall-btn-navigate'?{catalogTab:'assigned',priority:0}
            :{catalogTab:'alllessons',priority:2};
      }
      actions.set(id,{id,label,kind,...metadata,node});
    }
    return [...actions.values()].map(({node,...item})=>item);
  }
  function button(kind) {
    const explicit=selectors[kind] || `[data-alef-${kind}]`;
    let matches=all(explicit).filter(el=>!disabled(el));
    if(matches.length>1)throw new Error('توجد أزرار متشابهة؛ اضبط محدد زر '+(kind==='submit'?'الإرسال.':'التالي.'));
    if(matches.length)return matches[0];
    if(selectors[kind])return null;
    if(kind==='next') {
      const candidates=discoverActions().filter(action=>action.kind==='next');
      if(candidates.length>1)throw new Error('زر الانتقال غير واضح؛ اضبط محدد الصفحة أولًا.');
      return candidates.length?actions.get(candidates[0].id).node:null;
    }
    matches=all('button,[role="button"],input[type="submit"]').filter(el=>!disabled(el) &&
      /^(تحقق|تحقق من الاجابة|ارسال|ارسال الاجابة|تاكيد الاجابة|حفظ الاجابة|submit|submit answer|check|check answer|confirm answer)$/.test(norm(text(el)||el.value)));
    if(matches.length>1)throw new Error('زر الإرسال غير واضح؛ اضبط محدد الصفحة أولًا.');
    return matches[0]||null;
  }
  function completionVisible() {
    if(!selectors.completed&&first('[data-testid="ncle-assessment-result"]')&&!first('[data-testid="ncle-completion-page"]'))return false;
    if(all(selectors.completed || '[data-testid="ncle-completion-page"],[data-testid="go-super-pro-btn"],[data-alef-completed],[data-testid="lesson-complete"],[data-testid="assessment-complete"],[data-testid="assessment-completed"]').filter(el=>!catalogAncestor(el)).length)return true;
    return all('[role="status"],[role="alert"],h1,h2').some(el=>!catalogAncestor(el) &&
      /^(اكملت الدرس|اكملت الدرس بنجاح|اكملت الواجب بنجاح|اكتمل الدرس|اكتملت الاسئلة|lesson complete|lesson completed|assessment complete|assessment completed|you completed this lesson|all questions completed)$/.test(norm(text(el))));
  }
  function inspect() {
    const listedSubjects=discoverSubjects();
    const listedLessons=discoverLessons();
    const navigation=discoverActions();
    const catalog=coreCatalog();
    const diagnostics=[...new Set(frameDiagnostics)];
    let question=null,questionFound=false,questionState={};
    const completed=!loginPage() && completionVisible();
    if(!completed && !loginPage()) {
      try {questionFound=!!questionContainer();if(questionFound){questionState=readQuestion();question=questionState.question;}}
      catch(error){questionFound=true;diagnostics.push(error.message);}
    }
    let stage='unknown';
    if(loginPage())stage='unknown';
    else if(completed)stage='complete';
    else if(first('[data-testid="skip-content-modal"],[data-testid="ncle-lock-screen"]'))stage='instruction';
    else if(questionFound&&!question&&navigation.some(action=>action.kind==='next'&&/^(start|ابدا|بدء)$/.test(norm(action.label))))stage='instruction';
    else if(questionFound && !((navigation.some(action=>['skip','assessment'].includes(action.kind)) && first('[data-alef-instruction],[data-testid="content-page"],[data-testid="content-page-body-player"]'))||
      (navigation.some(action=>action.kind==='skip'||(action.kind==='assessment'&&actions.get(action.id)?.node.matches('[data-testid="ncle-component-item"]')))&&first('[data-testid="ncle-activity-page-player"]'))))stage='question';
    else if(listedLessons.length||catalog)stage='lessons';
    else if(!loginPage() && (navigation.some(action=>['skip','assessment'].includes(action.kind)) || (learningContext()&&navigation.some(action=>action.kind==='next')) ||
      first('[data-alef-instruction],[data-testid="content-page"],[data-testid="content-page-body-player"],[data-testid="ncle-activity-page"],.lesson-intro,.instruction')))stage='instruction';
    else if(listedSubjects.length)stage='subjects';
    if(loginPage())diagnostics.push('صفحة تسجيل الدخول ظاهرة. سجّل الدخول إلى ألف ثم أعد فحص المواد.');
    else if(stage==='unknown')diagnostics.push('لم تتطابق الصفحة مع مواد أو دروس أو سؤال مدعوم. أرسل تقرير تشخيص الواجهة لضبط القارئ.');
    if(first('[data-testid="ncle-lock-screen"]'))diagnostics.push('هذا القسم غير مسند أو مقفل في ألف؛ لا يمكن تجاوز القفل تلقائيًا.');
    if(catalog?.error)diagnostics.push('تعذر تحميل المهام المسندة في ألف. أعد تحميل قائمة المادة ثم افحصها.');
    if(!listedSubjects.length && ['lessons','instruction','question','complete'].includes(stage)) {
      subjects.set('current',{id:'current',name:'المادة المفتوحة حاليًا',node:null});
      listedSubjects.push({id:'current',name:'المادة المفتوحة حاليًا'});
    }
    const fingerprint=hash(JSON.stringify([location.pathname,location.search,location.hash,stage,catalog,listedSubjects,listedLessons,question?.id,question?.fingerprint,navigation,completed,text(first('[data-alef-instruction],[data-testid="content-page-body-player"],.instruction,main')).slice(0,3000)]));
    return {ok:true,page:{title:document.title,url:location.href},stage,subjects:listedSubjects,lessons:listedLessons,
      question,needsPreparation:!!questionState.needsPreparation,feedback:questionState.feedback,completed,canNext:navigation.some(action=>action.kind==='next'),navigation,fingerprint,...(catalog?{catalog}:{}),
      diagnostics:[...new Set(diagnostics)],capabilities:{text:true,single:true,multiple:true,images:false,dragAndDrop:true,customSelectors:true,courseNavigation:true}};
  }
  const scan=()=>inspect();
  function questionContainer() {
    let found=all(selectors.question||'[data-alef-question],[data-question-id],[data-testid="question-renderer"],[data-testid="new-question-renderer"]');
    if(!found.length&&!selectors.question)found=all('fieldset,[role="radiogroup"],[role="group"][aria-labelledby]').filter(el=>el.querySelector('input,textarea,select,[role="radio"],[role="checkbox"],[data-alef-item]'));
    found=uniqueNodes(found);
    if(found.length>1)throw new Error('توجد عدة أسئلة ظاهرة. تعذّر تحديد السؤال الحالي بأمان.');
    return found[0]||null;
  }
  function optionNodes(container) {
    const marked=all(selectors.option||'[data-alef-option],[data-testid="choice-item"]',container);
    if(marked.length){const attempts=all('div[data-testid^="attempt-"]',container).filter(node=>node.querySelector('[data-testid="choice-item"]'));const active=attempts.at(-1);return active?marked.filter(node=>active.contains(node)):marked;}
    return all('input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"]',container);
  }
  function describeOption(node) {
    const actual=node.matches('[data-testid="choice-item"]');
    const control=node.matches('input,[role="radio"],[role="checkbox"]')?node:node.querySelector('input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"]')||node;
    const label=node.matches('input')?clean([...node.labels||[]].map(text).join(' ')||node.getAttribute('aria-label')||node.value):text(node);
    const id=node.getAttribute('data-alef-option')||control.getAttribute('data-option-id')||control.id||(control.value&&control.value!=='on'?control.value:'')||`option-${hash(label)}`;
    return {id,text:label,node,control,actual};
  }
  function selected(option) {
    if(option.actual)return !!option.node.querySelector('.choice.selected,.input-placeholder.selected,.input-placeholder.selected-by-user,.choice-select.selected')||option.node.classList.contains('selected');
    return option.control.matches('input')?option.control.checked:option.control.getAttribute('aria-checked')==='true';
  }
  function promptText(container) {
    const prompt=first('[data-alef-question-text],[data-testid="multiple-choice-question-prompt"],[data-testid="multiple-selection-question-prompt"],legend,h1,h2,h3,h4,[role="heading"]',container);
    let value=text(prompt);
    if(prompt?.querySelector('[data-testid^="fill-blank-dd-"]')){const copy=prompt.cloneNode(true);copy.querySelectorAll('[data-testid^="fill-blank-dd-"]').forEach(node=>node.replaceWith(' [blank:'+node.getAttribute('data-testid').slice(14)+'] '));value=text(copy);}
    if(prompt?.querySelector('select,[role="combobox"],[data-testid="selectableChoice"]')){const copy=prompt.cloneNode(true);copy.querySelectorAll('select,[role="combobox"],[data-testid="selectableChoice"]').forEach(node=>node.replaceWith(' [قائمة الإجابة] '));value=text(copy);}
    if(!value&&container.getAttribute('aria-labelledby'))value=clean(container.getAttribute('aria-labelledby').split(/\s+/).map(id=>text(container.ownerDocument.getElementById(id))).join(' '));
    if(!value||container.querySelector('select,[role="combobox"],[data-testid^="fill-blank-dd-"]')){
      const copy=container.cloneNode(true);
      copy.querySelectorAll('[data-testid="selectableChoice"],select,[role="combobox"]').forEach(node=>node.replaceWith(' [قائمة الإجابة] '));
      copy.querySelectorAll('[data-testid^="fill-blank-dd-"]').forEach(node=>node.replaceWith(' [blank:'+node.getAttribute('data-testid').slice(14)+'] '));
      copy.querySelectorAll('[data-testid="draggableChoice"],[data-testid="choice-item-dd"],[data-testid="general-answer-feedback"],[data-testid="answerFeedback"],[data-testid="question-passage-content"]').forEach(node=>node.remove());
      copy.querySelectorAll('button,input,textarea,select,[data-alef-option],[data-testid="choice-item"],[role="radio"],[role="checkbox"],label,[data-testid="matching-choices"],[data-testid="matching-answers"],[role="listbox"],[class*="react-select"]').forEach(el=>el.remove());
      value=text(copy);
    }
    const passage=text(first('[data-testid="question-passage-content"],[data-alef-passage]',container));
    return clean((passage?passage+' ':'')+value);
  }
  function matchingControls(container) {
    const actualItems=all('[data-testid^="matching-choice-"]',container);
    const actualTargets=all('[data-testid^="matching-answer-"]',container);
    if(actualItems.length&&actualTargets.length)return {mode:'click-pairs',items:actualItems.map(node=>({id:node.dataset.testid.slice('matching-choice-'.length),text:text(node),node})),targets:actualTargets.map(node=>({id:node.dataset.testid.slice('matching-answer-'.length),text:text(node),node}))};
    const blanks=all('[data-testid^="fill-blank-dd-"]',container),choices=all('[data-testid="draggableChoice"]',container);
    if(blanks.length){
      const key=location.href+'|'+(container.getAttribute('data-alef-question')||first('[data-testid^="question-renderer-"]',container)?.getAttribute('data-testid')||promptText(container));
      if(fillCache?.key!==key){
        if(!choices.length)return null;
        fillCache={key,targets:choices.map(node=>({id:'choice-'+hash(text(node)),text:text(node)}))};
      }
      return {mode:'blank-choice',items:blanks.map((node,index)=>({id:node.getAttribute('data-testid').slice(14),text:'الفراغ '+(index+1)+' [blank:'+node.getAttribute('data-testid').slice(14)+']',node})),targets:fillCache.targets.map(item=>({...item,node:choices.find(node=>text(node)===item.text)||null}))};
    }
    const items=all('[data-alef-item]',container),targets=all('[data-alef-target]',container);
    if(items.length&&targets.length)return {mode:'drag',items:items.map(node=>({id:node.dataset.alefItem,text:text(node),node})),targets:targets.map(node=>({id:node.dataset.alefTarget,text:node.getAttribute('data-target-label')||text(node),node}))};
    return null;
  }
  function dropdownControls(container){return all('select,[role="combobox"]',container).filter(node=>!disabled(node));}
  function feedback(container){
    const retry=all('button,[role="button"]').some(node=>!disabled(node)&&/^(try again|حاول مرة اخري|حاول مجددا)$/.test(norm(text(node))));
    const attempts=all('div[data-testid^="attempt-"]',container);const active=attempts.at(-1)||container;
    return retry||(!button('next')&&!!first('[data-testid="wrong-answer-feedback"],[data-alef-feedback="wrong"]',active))?'wrong':null;
  }
  function readQuestion() {
    if(completionVisible())return {ok:true,question:null,completed:true,canNext:false};
    const container=questionContainer();
    if(!container)return {ok:true,question:null,completed:false,canNext:!!button('next')};
    if(first('[data-testid="question-passage-collapsed-caret"],[data-alef-passage-toggle][aria-expanded="false"]',container))return {ok:true,question:null,completed:false,needsPreparation:true,canNext:false};
    if(all('img:not([role="presentation"]),canvas',container).length)throw new Error('السؤال يحتوي على صورة أو رسم يحتاج قراءة مرئية؛ لم تُخمن الإجابة.');
    let prompt=promptText(container);
    const matching=matchingControls(container);
    const drops=dropdownControls(container);
    const controls=optionNodes(container).map(describeOption);
    let options=controls.map(({id,text})=>({id,text})),type,extra={};
    if(matching){type='matching';options=[];extra={items:matching.items.map(({id,text})=>({id,text})),targets:matching.targets.map(({id,text})=>({id,text}))};}
    else if(drops.length){
      if(drops.length!==1)throw new Error('السؤال يحتوي على أكثر من قائمة؛ يحتاج ربطًا مخصصًا للحفاظ على تطابق كل فراغ.');
      type='single';
      if(drops[0].tagName==='SELECT')options=[...drops[0].options].filter(option=>!option.disabled&&option.value!=='').map((option,index)=>({id:option.value||`select-${index}`,text:clean(option.textContent)}));
      else {
        const cacheKey=hash(location.href+prompt);
        options=dropdownCache?.key===cacheKey?dropdownCache.options:[];
        if(!options.length)return {ok:true,question:null,completed:false,needsPreparation:true,canNext:false};
      }
    }else if(options.length){
      const types=new Set(controls.map(({control})=>control.type||control.getAttribute('role')));
      if(types.size!==1||![...types].every(value=>['radio','checkbox'].includes(value)))throw new Error('لم أتعرف على نوع خيارات هذا السؤال.');
      type=[...types][0]==='checkbox'?'multiple':'single';
    }else{
      const inputs=all('textarea,[data-alef-answer],input[type="text"],input[type="number"],input:not([type])',container).filter(node=>node.matches('input,textarea')&&!node.readOnly);
      if(inputs.length!==1)throw new Error('هذا السؤال يحتاج نوع تفاعل لم يُربط بعد؛ لن تُرسل إجابة تخمينية.');
      type='text';
    }
    if(!prompt)throw new Error('لم يظهر نص السؤال بوضوح.');
    if(options.some(option=>!option.text)||new Set(options.map(option=>option.id)).size!==options.length)throw new Error('خيارات الإجابة غير واضحة أو متكررة.');
    const fingerprint=hash(JSON.stringify([prompt,type,options,extra]));
    const code=first('[data-testid^="question-renderer-"]',container)?.getAttribute('data-testid');
    const id=container.getAttribute('data-alef-question')||container.getAttribute('data-question-id')||code||`question-${fingerprint}`;
    return {ok:true,question:{id,text:prompt,type,options,...extra,fingerprint},completed:false,canNext:!!button('next'),feedback:feedback(container)};
  }
  function setValue(control,value) {
    const realm=view(control),proto=control.tagName==='TEXTAREA'?realm.HTMLTextAreaElement.prototype:control.tagName==='SELECT'?realm.HTMLSelectElement.prototype:realm.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(control,value);
    control.dispatchEvent(new realm.Event('input',{bubbles:true}));control.dispatchEvent(new realm.Event('change',{bubbles:true}));
  }
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  function assertNotCancelled(){if(cancelled)throw new Error('تم إيقاف تطبيق الإجابة.');}
  function assertQuestion(question){const current=readQuestion().question;if(!current||current.id!==question.id||current.fingerprint!==question.fingerprint)throw new Error('تغير السؤال أثناء الحل؛ لم يُضغط زر الإرسال.');}
  function submitAnswer(question,message){
    assertNotCancelled();assertQuestion(question);
    if(!message.autoSubmit)return {ok:true,applied:true,submitted:false};
    const submit=button('submit');
    if(!submit)return {ok:true,applied:true,submitted:false,reason:'لم يظهر زر إرسال واضح؛ بقيت الإجابة للمراجعة.'};
    click(submit);return {ok:true,applied:true,submitted:true};
  }
  async function prepareQuestion(){
    let container=questionContainer();if(!container)throw new Error('لم يظهر السؤال.');
    const collapsed=first('[data-testid="question-passage-collapsed-caret"],[data-alef-passage-toggle][aria-expanded="false"]',container);
    if(collapsed){const toggle=first('[data-testid="question-passage-chevron"]',container)||collapsed.closest('button,[role="button"]')||collapsed;click(toggle);await delay(100);assertNotCancelled();container=questionContainer();if(!container)throw new Error('تغير السؤال عند فتح القطعة.');}
    const drops=dropdownControls(container);if(drops.length!==1||drops[0].tagName==='SELECT')return readQuestion();
    const key=hash(location.href+promptText(container));
    const control=drops[0];control.focus();
    const realm=view(control);control.dispatchEvent(new realm.KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',bubbles:true}));
    await delay(100);assertNotCancelled();
    let options=all('[role="option"],[class*="react-select__option"]');
    if(!options.length){const clickable=control.closest('[class*="react-select__control"]')||control;clickable.dispatchEvent(new realm.MouseEvent('mousedown',{button:0,bubbles:true}));await delay(100);options=all('[role="option"],[class*="react-select__option"]');}
    const data=options.map((node,index)=>({id:`dropdown-${hash(text(node))}`,text:text(node)}));
    if(!data.length||new Set(data.map(item=>item.id)).size!==data.length)throw new Error('لم تظهر خيارات القائمة أو كانت متشابهة.');
    dropdownCache={key,options:data};
    control.dispatchEvent(new realm.KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));
    return readQuestion();
  }
  async function applyMatching(question,answer,message){
    const original=matchingControls(questionContainer());
    if(!Array.isArray(answer.matches)||answer.matches.length!==original.items.length)throw new Error('مطابقة الإجابات غير مكتملة.');
    const used=new Set(),targets=new Set();
    for(const pair of answer.matches){if(used.has(pair.itemId)||targets.has(pair.targetId)||!original.items.some(item=>item.id===pair.itemId)||!original.targets.some(item=>item.id===pair.targetId))throw new Error('أزواج المطابقة غير صالحة.');used.add(pair.itemId);targets.add(pair.targetId);}
    for(const pair of answer.matches){
      assertNotCancelled();assertQuestion(question);
      let current=matchingControls(questionContainer()),item=current.items.find(row=>row.id===pair.itemId),target=current.targets.find(row=>row.id===pair.targetId);
      if(current.mode==='click-pairs'){
        click(item.node.firstElementChild||item.node);await delay(60);assertNotCancelled();
        current=matchingControls(questionContainer());target=current.targets.find(row=>row.id===pair.targetId);click(target.node.firstElementChild||target.node);await delay(60);
        current=matchingControls(questionContainer());
        if(!current.items.find(row=>row.id===pair.itemId).node.classList.contains('selected')||!current.targets.find(row=>row.id===pair.targetId).node.classList.contains('selected'))throw new Error('لم يؤكد الموقع تثبيت زوج المطابقة.');
      }else if(current.mode==='blank-choice'){
        if(!target.node)throw new Error('خيار المطابقة لم يعد متاحًا.');
        click(target.node);await delay(60);assertNotCancelled();
        current=matchingControls(questionContainer());item=current.items.find(row=>row.id===pair.itemId);click(item.node);await delay(60);
        current=matchingControls(questionContainer());item=current.items.find(row=>row.id===pair.itemId);
        if(!text(item.node).includes(target.text))throw new Error('لم يؤكد الموقع وضع الكلمة في الفراغ.');
      }else{
        const realm=view(item.node),transfer=new realm.DataTransfer();transfer.setData('text/plain',pair.itemId);
        item.node.dispatchEvent(new realm.DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));target.node.dispatchEvent(new realm.DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));target.node.dispatchEvent(new realm.DragEvent('drop',{bubbles:true,dataTransfer:transfer}));item.node.dispatchEvent(new realm.DragEvent('dragend',{bubbles:true,dataTransfer:transfer}));await delay(60);
        if(target.node.getAttribute('data-selected-item')!==pair.itemId&&!target.node.contains(item.node))throw new Error('لم يؤكد الموقع موضع الإجابة المسحوبة.');
      }
    }
    return submitAnswer(question,message);
  }
  async function applyCustomDropdown(question,answer,message){
    const control=dropdownControls(questionContainer())[0];
    const realm=view(control);control.focus();control.dispatchEvent(new realm.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
    await delay(100);assertNotCancelled();
    const desired=question.options.find(option=>option.id===answer.optionIds[0]);
    const matches=all('[role="option"],[class*="react-select__option"]').filter(node=>text(node)===desired.text);
    if(matches.length!==1)throw new Error('لم تتطابق خيارات القائمة مع السؤال الحالي.');
    click(matches[0]);await delay(100);assertNotCancelled();
    if(!text(control.closest('[data-testid="selectableChoice"]')||control.parentElement).includes(desired.text))throw new Error('لم يؤكد الموقع اختيار القائمة.');
    return submitAnswer(question,message);
  }
  function apply(message){
    assertNotCancelled();
    const question=readQuestion().question;if(!question||question.id!==message.questionId||(message.questionFingerprint&&message.questionFingerprint!==question.fingerprint))throw new Error('تغير السؤال أثناء الحل. لم تُطبّق الإجابة.');
    const answer=message.answer;if(!answer||!Array.isArray(answer.optionIds))throw new Error('صيغة الإجابة غير صالحة.');
    const container=questionContainer();
    if(question.type==='matching')return applyMatching(question,answer,message);
    if(question.type==='text'){
      if(typeof answer.text!=='string'||!answer.text.trim()||answer.optionIds.length)throw new Error('الإجابة النصية غير صالحة.');
      const inputs=all('textarea,input[type="text"],input[type="number"],input:not([type])',container).filter(node=>!node.readOnly&&!disabled(node));
      if(inputs.length!==1)throw new Error('حقل الإجابة غير واضح.');setValue(inputs[0],answer.text);assertQuestion(question);
      if(!inputs[0].isConnected||inputs[0].value!==answer.text)throw new Error('لم يؤكد الموقع إدخال النص؛ لم تُرسل الإجابة.');
    }else{
      const ids=new Set(answer.optionIds);if(!ids.size||ids.size!==answer.optionIds.length||(question.type==='single'&&ids.size!==1)||[...ids].some(id=>!question.options.some(option=>option.id===id)))throw new Error('الاختيارات لا تطابق السؤال.');
      const dropdown=dropdownControls(container)[0];
      if(dropdown){if(dropdown.tagName!=='SELECT')return applyCustomDropdown(question,answer,message);setValue(dropdown,answer.optionIds[0]);if(dropdown.value!==answer.optionIds[0])throw new Error('لم يثبت اختيار القائمة.');}
      else{
        const options=optionNodes(container).map(describeOption);
        for(const option of options){if(disabled(option.control))throw new Error('خيارات السؤال معطلة.');const wanted=ids.has(option.id);if(wanted!==selected(option)&&(question.type==='multiple'||wanted))click(option.actual?option.node:option.control);}
        assertQuestion(question);
        const chosen=optionNodes(questionContainer()).map(describeOption).filter(selected).map(option=>option.id);
        if(chosen.length!==ids.size||chosen.some(id=>!ids.has(id)))throw new Error('لم يؤكد الموقع اختيار الإجابة.');
      }
    }
    return submitAnswer(question,message);
  }
  function diagnostics(){
    const snapshot=inspect();
    const cleanUrl=value=>{try{const url=new URL(value,location.href);return url.origin+url.pathname+(url.hash.startsWith('#/')?url.hash.split('?')[0]:'');}catch{return '';}};
    return {ok:true,diagnostics:{version:'0.4.1',page:{url:cleanUrl(location.href)},stage:snapshot.stage,subjects:snapshot.subjects,lessons:snapshot.lessons.map(({href,...lesson})=>({...lesson,href:href?cleanUrl(href):undefined})),navigation:snapshot.navigation,issues:snapshot.diagnostics,frames:[...document.querySelectorAll('iframe')].map(frame=>({url:cleanUrl(frame.src),sameOrigin:!!frame.contentDocument})),controls:all('button,[role="button"],[data-testid]').filter(node=>!node.closest('form')&&!node.matches('input,textarea')).slice(0,100).map(node=>({tag:node.tagName,role:node.getAttribute('role'),testId:node.getAttribute('data-testid'),classes:[...node.classList].slice(0,6),label:clean(node.getAttribute('aria-label')|| (node.matches('button,[role="button"]')?text(node):'')).slice(0,100)}))}};
  }
  function handle(message){
    rootsCache=null;frameDiagnostics=[];settings(message.selectors);
    switch(message.type){
      case 'ALEF_SCAN':case 'ALEF_INSPECT':return inspect();
      case 'ALEF_DIAGNOSTICS':return diagnostics();
      case 'ALEF_GET_QUESTION':return readQuestion();
      case 'ALEF_PREPARE_QUESTION':assertNotCancelled();return prepareQuestion();
      case 'ALEF_CANCEL':cancelled=true;return {ok:true};
      case 'ALEF_SELECT_SUBJECT':{
        cancelled=false;
        if(!subjects.size)discoverSubjects();const subject=subjects.get(message.subjectId);if(!subject)throw new Error('المادة المحددة لم تعد ظاهرة.');if(subject.node)click(subject.node);return {ok:true,selected:true};
      }
      case 'ALEF_OPEN_LESSON':{
        const snapshot=inspect();if(message.fingerprint&&snapshot.fingerprint!==message.fingerprint)throw new Error('تغيرت قائمة الدروس؛ لم يُفتح الدرس.');
        const lesson=lessons.get(message.lessonId);if(!lesson||lesson.locked||lesson.completed)throw new Error('الدرس غير متاح أو مقفل أو مكتمل.');click(lesson.node);return {ok:true,clicked:true};
      }
      case 'ALEF_NAVIGATE':{
        const snapshot=inspect();if(message.fingerprint&&snapshot.fingerprint!==message.fingerprint)throw new Error('تغيرت خطوة الدرس؛ لم يُضغط الزر.');const action=actions.get(message.actionId);if(!action)throw new Error('زر الانتقال لم يعد متاحًا.');click(action.node);return {ok:true,clicked:true};
      }
      case 'ALEF_APPLY':return apply(message);
      case 'ALEF_NEXT':{const next=button('next');if(next)click(next);return {ok:true,clicked:!!next};}
      default:return null;
    }
  }
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(sender.id!==chrome.runtime.id||!message?.type?.startsWith('ALEF_'))return false;
    try{const result=handle(message);if(result?.then){result.then(respond,error=>respond({ok:false,error:error.message||'تعذر التفاعل مع الصفحة.'}));return true;}respond(result);}
    catch(error){respond({ok:false,error:error.message||'تعذر قراءة عناصر الصفحة.'});}return false;
  });
})();
