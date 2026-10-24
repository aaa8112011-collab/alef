(() => {
  'use strict';
  if (globalThis.__alefAssistantInstalled==='0.5.12') return;
  globalThis.__alefAssistantInstalled = '0.5.12';

  let selectors = {};
  let subjects = new Map();
  let lessons = new Map();
  let actions = new Map();
  let dropdownCache = null;
  let fillCache = null;
  let weaverDragCache = null;
  let cancelled = false;
  let lastDiagnosticInteraction = null;
  const mathTargets = new Set();
  const visualTargets = new Set();
  // A scan is synchronous and read-only. Share expensive DOM/style lookups
  // within that scan, then discard them before any click or asynchronous wait.
  let readPass = null;
  let frameEntries = new Map();
  const frameLoadStates = new WeakMap();
  let topCourseContext = false;
  let questionEvidence = null;
  const inferredOptions = new WeakMap();
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  // Weaver's published m()/w() class helper adds lib- to every CSS token.
  // Keep legacy widgets readable, and expand only our literal built-in selectors:
  // user-provided selectors and third-party math classes remain untouched.
  const WEAVER_CLASSES=new Set(['mcq-container','dropdown-container','open-ended-container','fib-container','dnd-container',
    'question-widget','question-statement-container','mcq-option-content-container','mcq-icon-container','mcq-option-icon-container',
    'dnd-grip-icon','dropdown-input-field-container','dropdown-item','dropdown-item-cancel','dropdown-single-value-content',
    'dnd-droppable','dnd-options-draggable','dnd-options-draggable-overlay','dnd-overlay','text-on-image','image-on-image',
    'sequence-image','sequence-text','selected-option','dnd-droppable__edit-label-tab','validationIcon']);
  const weaverSelector=literal=>literal.replace(/\.([a-zA-Z][\w-]*)/g,(match,name)=>
    WEAVER_CLASSES.has(name)?`:is(.${name},.lib-${name})`:match);
  const hasWeaverClass=(node,name)=>!!node&&(node.classList.contains(name)||node.classList.contains('lib-'+name));
  const WEAVER_QUESTIONS=weaverSelector('.mcq-container.question-widget,.dropdown-container.question-widget,.open-ended-container.question-widget,.fib-container.question-widget,.dnd-container.question-widget');
  const PLAYER_SCOPES='[data-testid="assessment-content-player"],[data-testid="ncle-activity-page-player"],[data-testid="content-page-body-player"],main#player-container';
  const hash = text => {
    let n = 2166136261;
    for (const c of text) n = Math.imul(n ^ c.charCodeAt(0), 16777619);
    return (n >>> 0).toString(36);
  };
  const isElement = node => node?.nodeType === 1;
  const view = node => node.ownerDocument.defaultView;
  function withReadPass(read) {
    if(readPass)return read();
    readPass={roots:new WeakMap(),styles:new WeakMap(),visible:new WeakMap(),ancestors:new WeakMap(),visual:new WeakMap()};
    try{return read();}finally{readPass=null;}
  }
  function styleOf(node) {
    const cached=readPass?.styles.get(node);
    if(cached)return cached;
    const style=view(node).getComputedStyle(node);
    readPass?.styles.set(node,style);
    return style;
  }
  function ancestorsVisible(el) {
    const path=[];
    let allowed=true;
    for(let node=el;node;node=node.parentElement||node.getRootNode()?.host) {
      const cached=readPass?.ancestors.get(node);
      if(cached!==undefined){allowed=cached;break;}
      path.push(node);
      const style=styleOf(node);
      if(node.matches('[hidden],[aria-hidden="true"],[inert]')||style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse') {
        allowed=false;break;
      }
    }
    for(const node of path)readPass?.ancestors.set(node,allowed);
    return allowed;
  }
  const norm = value => clean(value).toLowerCase().normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670\u0640]/g,'').replace(/[أإآ]/g,'ا').replace(/ى/g,'ي')
    .replace(/[\u200b-\u200f\u202a-\u202e]/g,'').replace(/[\s:!؟?.،,·•|]+/g,' ').trim();
  function visible(el) {
    if (!isElement(el) || !el.isConnected) return false;
    const cached=readPass?.visible.get(el);
    if(cached!==undefined)return cached;
    const result=visibleElement(el);
    readPass?.visible.set(el,result);
    return result;
  }
  function visibleElement(el) {
    // Layout-only wrappers have no rectangle of their own. Their rendered
    // children still contain the question/choices, including in display:contents.
    if (!el.getClientRects().length && (styleOf(el).display!=='contents' || ![...el.children].some(visible))) return false;
    if(!ancestorsVisible(el))return false;
    try { const frame=view(el).frameElement; if(frame && !visible(frame))return false; } catch { return false; }
    return true;
  }
  function roots(scope=document) {
    const cached=readPass?.roots.get(scope);
    if(cached)return cached;
    const found=[],seen=new Set();
    function visit(root) {
      if(!root || seen.has(root))return;
      seen.add(root);found.push(root);
      for(const node of root.querySelectorAll('*')) {
        // A MathLive host is one answer control. Its keyboard sink, rendered
        // value and toolbar are private implementation details, not questions.
        if(node.shadowRoot&&node.tagName!=='MATH-FIELD')visit(node.shadowRoot);
        if(node.tagName==='IFRAME' && visible(node)) {
          try {
            const doc=node.contentDocument;
            const entry=describeFrame(node,doc);frameEntries.set(node,entry);
            if(doc?.documentElement&&entry.role!=='supplementary'&&!entry.independent)visit(doc);
          }catch{frameEntries.set(node,describeFrame(node,null));}
        }
      }
    }
    visit(scope);
    readPass?.roots.set(scope,found);
    return found;
  }
  function describeFrame(node,doc) {
    const srcdoc=node.hasAttribute('srcdoc');
    const raw=srcdoc?'about:srcdoc':node.getAttribute('src')||'about:blank';
    let source;
    try{source=new URL(raw,node.baseURI||node.ownerDocument.location.href);}catch{}
    const kind=srcdoc?'srcdoc':source?.protocol==='data:'?'data':source?.protocol==='blob:'?'blob':source?.protocol==='about:'?'about':'url';
    const sandbox=node.hasAttribute('sandbox')?[...node.sandbox]:null;
    const opaque=!!sandbox&&!sandbox.includes('allow-same-origin')||kind==='data';
    const supplementary=node.matches('#lesson-float-iframe,[data-testid="lesson-float-iframe"]')||
      !!node.closest('[data-testid="lesson-float-player"],[data-testid="dhabhi-player"],[data-testid="help-player"],[data-alef-supplementary]');
    const required=!supplementary&&(node.matches('[data-testid="iframed-mlo"],[data-testid="ncle-extra-content-assignment-player"]')||
      !!node.closest('[data-testid="ncle-activity-page"],[data-testid="ncle-extra-content-assignment-player"],[data-testid="content-page-body-player"],[data-alef-question-scope],[data-alef-instruction]'));
    // An embedded material has its own question and completion state. Reading
    // its DOM as part of the NCLE parent can mistake component completion for
    // completion of the whole lesson, or click the parent's Next too early.
    const independent=required&&!!node.closest('[data-testid="ncle-activity-page"],[data-testid="ncle-extra-content-assignment-player"],[data-testid="content-page-body-player"]');
    const ownerOrigin=node.ownerDocument.location.origin;
    let parentURL='';
    try{const ownerURL=new URL(node.ownerDocument.location.href);parentURL=/^https?:$/.test(ownerURL.protocol)?ownerURL.origin+ownerURL.pathname:ownerURL.protocol==='about:'?'about:'+ownerURL.pathname:ownerURL.protocol;}catch{}
    const origin=source&&source.origin!=='null'?source.origin:kind==='srcdoc'||kind==='about'?ownerOrigin:null;
    const url=kind==='data'?'data:':kind==='srcdoc'?'about:srcdoc':kind==='about'?(source?.pathname==='blank'?'about:blank':'about:'):kind==='blob'?`blob:${origin||''}`:source&&/^https?:$/.test(source.protocol)?source.origin+source.pathname:source?.protocol||'';
    const sourceKey=raw;
    let load=frameLoadStates.get(node);
    if(!load){
      load={source:sourceKey,observed:false};frameLoadStates.set(node,load);
      node.addEventListener('load',()=>{const current=frameLoadStates.get(node);if(current)current.observed=true;});
    }else if(load.source!==sourceKey){load.source=sourceKey;load.observed=false;}
    let accessible=false,loading=null,readyState=null;
    try{
      accessible=!!doc?.documentElement;
      readyState=accessible?doc.readyState:null;
      if(accessible)loading=readyState==='loading'||doc.URL==='about:blank'&&kind==='url';
      else if(load.observed)loading=false;
    }catch{}
    if(node.getAttribute('aria-busy')==='true'||node.getAttribute('data-loading')==='true')loading=true;
    return {url,parentURL,origin:origin&&origin!=='null'?origin:null,initiatorOrigin:ownerOrigin&&ownerOrigin!=='null'?ownerOrigin:null,
      kind,accessible,sameOrigin:accessible,loading,readyState,opaque,required,relevant:required,independent,
      role:supplementary?'supplementary':required?'lesson':'unknown',...(sandbox?{sandbox}:{})};
  }
  const all = (query,scope=document) => [...new Set(roots(scope).flatMap(root=>[...root.querySelectorAll(query)]))].filter(visible);
  function first(query,scope=document) {
    for(const root of roots(scope))for(const node of root.querySelectorAll(query))if(visible(node))return node;
    return null;
  }
  const disabled = el => !el || !!el.disabled || el.getAttribute('aria-disabled')==='true' || el.getAttribute('aria-busy')==='true' ||
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
    if (!el.matches?.('.katex,math,mjx-container,sup,sub') && !el.querySelector?.('.katex,math,mjx-container,sup,sub')) {
      return clean(el.innerText || el.textContent || el.getAttribute('aria-label'));
    }
    function read(node) {
      if (node.nodeType === 3) return node.textContent;
      if (!isElement(node)) return '';
      const style=styleOf(node);
      if (node.matches('[hidden],[aria-hidden="true"],script,style') || style.display==='none' || ['hidden','collapse'].includes(style.visibility)) return '';
      if (node.matches('.katex,math,mjx-container')) {
        const latex = node.querySelector('annotation[encoding="application/x-tex"]');
        if (latex?.textContent.trim()) return ` $${latex.textContent.trim()}$ `;
        const math = node.matches('math') ? node : node.querySelector('math');
        if (math) return ` ${math.outerHTML} `;
        const label = node.getAttribute('aria-label');
        if (label) return ` ${label} `;
        throw new Error('الصيغة الرياضية مرسومة دون نص قابل للقراءة؛ راجع السؤال يدويًا.');
      }
      if (node.matches('sup,sub')) {
        const value=clean([...node.childNodes].map(read).join(''));
        if(!value)return '';
        if(node.matches('sup')) {
          // Prime point labels, ordinal suffixes and explicit citation markers
          // are typography, rather than powers of a number or variable.
          if(/^[′″‴⁗'’]+$/.test(value)||/^(?:st|nd|rd|th)$/i.test(value)||/^[°ºª℉℃]$/.test(value))return value;
          const citation='[role="doc-noteref"],[data-footnote],a[rel~="footnote"],a[href^="#fn"],a[href^="#footnote"]';
          if(node.closest(citation)||node.querySelector(citation)||/(?:^|[\s_-])(?:footnote|noteref|reference|citation)(?:$|[\s_-])/i.test(node.className||''))return ` [${value}] `;
        }
        // Parentheses retain multi-character, negative and nested scripts.
        // Concatenating these nodes would turn 2³ into 23 or x₁ into x1.
        return `${node.matches('sup')?'^':'_'}(${value})`;
      }
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
  function loginPage() {
    if(readPass?.login!==undefined)return readPass.login;
    const result=!!first('input[type="password"],form[data-testid*="login" i],form[id*="login" i]');
    if(readPass)readPass.login=result;
    return result;
  }
  function catalogAncestor(node) {return !!node.closest(`${SUBJECT_CARDS},${LESSON_CARDS}`);}
  function coreCatalog() {
    if(readPass&&Object.hasOwn(readPass,'catalog'))return readPass.catalog;
    const result=readCoreCatalog();
    if(readPass)readPass.catalog=result;
    return result;
  }
  function readCoreCatalog() {
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
    const unique=[...new Set(nodes)],members=new Set(unique);
    return unique.filter(node=>{
      for(let parent=node.parentElement;parent;parent=parent.parentElement)if(members.has(parent))return false;
      return true;
    });
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
    if(readPass?.learning!==undefined)return readPass.learning;
    const result=topCourseContext || /\/(?:pathways|lesson|activity|learn|content|assessment|exercise|progress)/i.test(location.pathname+location.hash) ||
      !!first('[data-testid="question-renderer"],[data-testid="adaptive-question-renderer"],[data-alef-instruction],[data-alef-question],[data-alef-completed],[data-testid="content-page"],[data-testid="content-page-body-player"],[data-testid="ncle-activity-page"],ul[aria-label="SkillList"],'+WEAVER_QUESTIONS);
    if(readPass)readPass.learning=result;
    return result;
  }
  function actionKind(node) {
    const testId=node.getAttribute('data-testid')||'';
    const label=norm(text(node)||node.getAttribute('aria-label'));
    // A sidebar jump does not traverse/complete the current teaching component.
    // Only ordinary Start/Next/try-later controls may advance the lesson.
    if(node.matches('[data-testid="ncle-main-contents"] [data-testid="ncle-component-item"]'))return null;
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
      const label=clean(text(node)||node.getAttribute('aria-label')).slice(0,160)||kind;
      const base=node.id || node.getAttribute('data-testid') || `${kind}-${hash(label+safeHref(node))}`;
      const count=counts.get(base)||0;counts.set(base,count+1);
      const id=count?`${base}-${count}`:base;
      let metadata=kind==='assessment'?{sequential:true}:{};
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
  function instructionPosition() {
    const positions=[];
    // Weaver can hide the numeric count while retaining its segmented bar.
    // These are authored slide positions, not changes in playback or buffering.
    for(const bar of all('[data-testid="slides-progress-bar"],[data-testid="k4-slides-progress-bar"],#slides-progress-bar,#k4-slides-progress-bar')) {
      const segments=all('[data-testid="bar-active"],[data-testid="bar-inactive"],[data-testid="k4-bar-active"],[data-testid="k4-bar-inactive"]',bar);
      if(!segments.length||segments.length>250)continue;
      let slideId=null;
      for(let parent=bar.parentElement;parent;parent=parent.parentElement) {
        if(parent.matches('main#player-container,[data-testid="player-wrapper"],[data-testid$="-player-wrapper"],'+PLAYER_SCOPES))break;
        const id=parent.getAttribute('data-testid');
        if(id){slideId=id.slice(0,180);break;}
      }
      const declared=Number(bar.getAttribute('data-progressbar-no-of-slides'));
      positions.push({slideId,total:Number.isInteger(declared)&&declared>0&&declared<=250?declared:segments.length,
        states:segments.map(segment=>segment.getAttribute('data-testid').endsWith('bar-inactive')?'inactive':'active')});
    }
    return positions.length?{positions}:null;
  }
  const MEDIA_UI='.lib-controls-bar,.lib-video-seekbar,.lib-seekbar-container,.lib-volume-slider-time-section,.lib-playrate-container,.lib-playrate-list,.lib-video-subtitle-container,.lib-cc-list,[data-testid="transcript-container"],[data-testid="video-big-play-btn"],.lib-video-big-play-btn';
  function instructionTextOf(node) {
    if(!node||node.matches(MEDIA_UI))return '';
    // Media controls and timed subtitles can tick without any Next navigation.
    // Keep them out of the navigation identity; question extraction is unchanged.
    return (node.querySelector(MEDIA_UI)?promptBody(node,{omitMediaUI:true}):text(node)).slice(0,3000);
  }
  function inspect() {return withReadPass(inspectPage);}
  function inspectPage() {
    const listedSubjects=discoverSubjects();
    const listedLessons=discoverLessons();
    const navigation=discoverActions();
    const catalog=coreCatalog();
    const diagnostics=[];
    let question=null,questionFound=false,questionState={},questionNode=null,questionReadFailed=false;
    const completed=!loginPage() && completionVisible();
    if(!completed && !loginPage()) {
      try {questionNode=questionContainer();questionFound=!!questionNode;if(questionFound){questionState=readQuestion();question=questionState.question;}}
      catch(error){questionFound=true;questionReadFailed=true;diagnostics.push(error.message);}
    }
    let stage='unknown';
    if(loginPage())stage='unknown';
    else if(completed)stage='complete';
    else if(first('[data-testid="skip-content-modal"],[data-testid="ncle-lock-screen"]'))stage='instruction';
    else if(questionFound&&!question&&navigation.some(action=>action.kind==='next'&&/^(start|ابدا|بدء)$/.test(norm(action.label))))stage='instruction';
    else if(questionFound && !((navigation.some(action=>['skip','assessment'].includes(action.kind)) && first('[data-alef-instruction],[data-testid="content-page"],[data-testid="content-page-body-player"]'))||
      (navigation.some(action=>action.kind==='skip')&&first('[data-testid="ncle-activity-page-player"]'))))stage='question';
    else if(listedLessons.length||catalog)stage='lessons';
    else if(!loginPage() && (navigation.some(action=>['skip','assessment'].includes(action.kind)) || (learningContext()&&navigation.some(action=>action.kind==='next')) ||
      first('[data-alef-instruction],[data-testid="content-page"],[data-testid="content-page-body-player"],[data-testid="ncle-activity-page"],.lesson-intro,.instruction')))stage='instruction';
    else if(listedSubjects.length)stage='subjects';
    const frames=[...frameEntries.values()];
    const player=first('[data-testid="ncle-activity-page-player"],[data-testid="content-page-body-player"],[data-alef-instruction],.lesson-intro,.instruction')||
      (topCourseContext?document.body:null);
    const spinner=player&&first('.spinner,.loading-spinner,[data-testid="loading-spinner"],[role="progressbar"],[aria-busy="true"]',player);
    // Slide progress bars and stale shell spinners may remain around a ready
    // exercise. They must not hide a visible reader error behind a load timeout.
    // An empty question wrapper is still allowed to finish mounting its tools.
    const readyQuestion=!!question||questionState.needsPreparation===true||questionReadFailed&&!!questionNode&&!!first(
      weaverSelector('input:not([type="hidden"]),textarea,select,[role="combobox"],[role="radio"],[role="checkbox"],[data-testid="choice-item"],.dnd-droppable,[data-alef-item],math-field'),questionNode);
    const loading=!loginPage()&&(frames.some(frame=>frame.required&&frame.loading===true)||
      !readyQuestion&&(document.readyState==='loading'||!!spinner));
    for(const frame of frames){
      if(!frame.required||frame.accessible||frame.loading===true)continue;
      const host=frame.origin?new URL(frame.origin).host:null;
      diagnostics.push(host?`لم يُقرأ محتوى إطار الدرس من ${host} بعد؛ قد يحتاج إذن الوصول لهذا المصدر.`:
        'لم يُقرأ محتوى إطار الدرس بعد؛ يلزم فحص تحميله وإذن الوصول إليه.');
    }
    if(loginPage())diagnostics.push('صفحة تسجيل الدخول ظاهرة. سجّل الدخول إلى ألف ثم أعد فحص المواد.');
    else if(stage==='unknown')diagnostics.push('لم تتطابق الصفحة مع مواد أو دروس أو سؤال مدعوم. أرسل تقرير تشخيص الواجهة لضبط القارئ.');
    if(first('[data-testid="ncle-lock-screen"]'))diagnostics.push('هذا القسم غير مسند أو مقفل في ألف؛ لا يمكن تجاوز القفل تلقائيًا.');
    if(catalog?.error)diagnostics.push('تعذر تحميل المهام المسندة في ألف. أعد تحميل قائمة المادة ثم افحصها.');
    if(!listedSubjects.length && ['lessons','instruction','question','complete'].includes(stage)) {
      subjects.set('current',{id:'current',name:'المادة المفتوحة حاليًا',node:null});
      listedSubjects.push({id:'current',name:'المادة المفتوحة حاليًا'});
    }
    const progress=text(first('[data-testid="progress-bar-slide-count"]'));
    const instructionStep=instructionPosition();
    const instructionText=instructionTextOf(first('[data-alef-instruction],[data-testid="content-page-body-player"],.instruction,main'));
    const fingerprint=hash(JSON.stringify([location.pathname,location.search,location.hash,progress,instructionStep,stage,catalog,listedSubjects,listedLessons,question?.id,question?.fingerprint,navigation,completed,loading,frames,instructionText]));
    // Loading flags and temporary enabled/disabled controls are not evidence
    // that the platform advanced a step. Preserve a separate content identity.
    const transitionFingerprint=hash(JSON.stringify([location.pathname,location.search,location.hash,progress,instructionStep,stage,
      catalog&&{type:catalog.type,tab:catalog.tab,filter:catalog.filter,empty:catalog.empty,error:catalog.error},
      listedSubjects,listedLessons,question?.id,question?.fingerprint,completed,
      frames.map(({url,origin,kind,role,required,independent})=>({url,origin,kind,role,required,independent})),instructionText]));
    return {ok:true,page:{title:document.title,url:location.href},stage,subjects:listedSubjects,lessons:listedLessons,
      question,needsPreparation:!!questionState.needsPreparation,feedback:questionState.feedback,completed,canNext:navigation.some(action=>action.kind==='next'),navigation,fingerprint,transitionFingerprint,...(catalog?{catalog}:{}),
      loading,frames,...(instructionStep?{instructionStep}:{}),context:{frame:window!==window.top,documentReadyState:document.readyState},
      ...(questionEvidence?{questionEvidence:{...questionEvidence}}:{}),
      diagnostics:[...new Set(diagnostics)],capabilities:{text:true,single:true,multiple:true,images:true,visionCapture:true,dragAndDrop:true,customSelectors:true,courseNavigation:true,frameContext:true}};
  }
  const scan=()=>inspect();
  function questionContainer() {
    let found=all(selectors.question||'[data-alef-question],[data-question-id],[data-testid="question-renderer"],[data-testid="new-question-renderer"],'+WEAVER_QUESTIONS);
    if(!found.length&&!selectors.question)found=all('fieldset,[role="radiogroup"],[role="group"][aria-labelledby],[role="selectgroup"][aria-labelledby]').filter(el=>el.querySelector('input,textarea,select,[role="radio"],[role="checkbox"],[data-alef-item]'));
    if(!found.length&&!selectors.question)return playerChoiceContainer();
    found=uniqueNodes(found);
    if(found.length>1)throw new Error('توجد عدة أسئلة ظاهرة. تعذّر تحديد السؤال الحالي بأمان.');
    if(found[0])inferredOptions.delete(found[0]);
    return found[0]||null;
  }
  function playerChoiceContainer() {
    if(loginPage())return null;
    const scopes=all(PLAYER_SCOPES);
    // Prefer the innermost platform player rather than its course/sidebar shell.
    const active=scopes.filter(scope=>!scopes.some(other=>other!==scope&&scope.contains(other)));
    if(!active.length&&topCourseContext&&document.body)active.push(document.body);
    const primary=all('button,[role="button"],input[type="submit"]').filter(node=>
      /^(submit|submit answer|check|check answer|confirm answer|try again|next|next question|continue|done|finish|ارسال|ارسال الاجابة|تحقق|تحقق من الاجابة|تاكيد الاجابة|حاول مرة اخري|حاول مجددا|التالي|متابعة|استمرار|انهاء)$/.test(norm(text(node)||node.value)));
    const found=[];
    let unreadable=false;
    for(const scope of active) {
      const controls=all('input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"]',scope);
      if(!controls.length||!primary.some(node=>node.ownerDocument===scope.ownerDocument&&(scope.contains(node)||active.length===1)))continue;
      questionEvidence={source:'player-choices',choiceCount:controls.length,scope:scope.getAttribute('data-testid')||'embedded-lesson',recognizedAction:true};
      const native=controls.filter(node=>node.matches('input[type="radio"]'));
      const semantic=controls.filter(node=>node.matches('[role="radio"]')&&!node.matches('input'));
      let options;
      if(native.length===controls.length) {
        const name=native[0].name;
        if(name&&native.length>=2&&native.every(node=>node.name===name&&node.form===native[0].form)&&
          native.every(node=>clean([...node.labels||[]].map(text).join(' ')||node.getAttribute('aria-label'))))options=native;
      } else if(semantic.length===controls.length&&semantic.length>=2&&
        semantic.every(node=>node.parentElement===semantic[0].parentElement&&clean(text(node)||node.getAttribute('aria-label'))))options=semantic;
      if(!options){unreadable=true;continue;}
      inferredOptions.set(scope,options);found.push(scope);
    }
    if(found.length>1||unreadable&&found.length)throw new Error('توجد مجموعات إجابة متعددة داخل المشغّل؛ تعذّر ربط كل مجموعة بسؤالها بأمان.');
    if(unreadable)throw new Error('تظهر خيارات إجابة في الدرس، لكن مجموعتها أو تسمياتها غير واضحة للقارئ. لم تُرسل إجابة؛ صدّر فحص الصفحة لتحديد أدوات هذا السؤال.');
    if(found.length)questionEvidence={...questionEvidence,source:inferredOptions.get(found[0])[0].matches('input')?'native-player-radio':'semantic-player-radio'};
    return found[0]||null;
  }
  function optionNodes(container) {
    if(inferredOptions.has(container))return inferredOptions.get(container).filter(visible);
    const marked=all(selectors.option||'[data-alef-option],[data-testid="choice-item"],[data-testid="mcq-option-container"]',container);
    if(marked.length){const attempts=all('div[data-testid^="attempt-"]',container).filter(node=>node.querySelector('[data-testid="choice-item"]'));const active=attempts.at(-1);return active?marked.filter(node=>active.contains(node)):marked;}
    return all('input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"]',container);
  }
  function describeOption(node,index=0) {
    const actual=node.matches('[data-testid="choice-item"]');
    const control=node.matches('input,[role="radio"],[role="checkbox"]')?node:node.querySelector('input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"]')||node;
    const weaver=node.matches('[data-testid="mcq-option-container"]');
    const authored=weaver?first(weaverSelector('[data-testid="mcq-item-label"],.mcq-option-content-container'),node):null;
    // Weaver's accessibility label gains “Selected/Correct” after clicking.
    // Authored option content and its option UUID remain stable across renders.
    let label=node.matches('input')?clean([...node.labels||[]].map(text).join(' ')||node.getAttribute('aria-label')||node.value):authored?text(authored):text(node);
    if(!label&&(visualAll('img,canvas,svg',node).some(visual=>!visual.closest(VISUAL_EXCLUSIONS))||[node,...visualAll('*',node)].some(visual=>/url\(/.test(styleOf(visual).backgroundImage))))label=`الخيار المصوّر ${index+1}`;
    const describedId=weaver?node.getAttribute('aria-describedby')?.split(/\s+/).find(id=>/^option-.+-content$/.test(id)):null;
    const id=node.getAttribute('data-alef-option')||control.getAttribute('data-option-id')||control.id||describedId||(control.value&&control.value!=='on'?control.value:'')||`option-${hash(label)}`;
    return {id,text:label,node,control,actual};
  }
  function selected(option) {
    if(option.actual)return !!option.node.querySelector('.choice.selected,.input-placeholder.selected,.input-placeholder.selected-by-user,.choice-select.selected')||hasWeaverClass(option.node,'selected');
    return option.control.matches('input')?option.control.checked:option.control.getAttribute('aria-checked')==='true';
  }
  const VISUAL_EXCLUSIONS=weaverSelector('.mcq-icon-container,.mcq-option-icon-container,.dnd-grip-icon,.katex,math,math-field,mjx-container,.MathJax,[data-testid$="question-feedback-container"],[data-testid="custom-feedback-container"],[data-testid="general-answer-feedback"],[data-testid="answerFeedback"],[data-testid="answer-feedback"],[data-testid="wrong-answer-feedback"],[data-testid="correct-answer-feedback"],[data-alef-feedback],[role="status"],[role="alert"],aside,nav,[role="banner"],[role="navigation"]');
  const MAX_VISUALS=3;
  const MAX_VISUAL_BYTES=1_048_576;
  const QUESTION_ROOTS='[data-alef-question],[data-question-id],[data-testid="question-renderer"],[data-testid="new-question-renderer"],'+WEAVER_QUESTIONS;
  function visibleVisual(el) {
    if(!isElement(el)||!el.isConnected)return false;
    const cached=readPass?.visual.get(el);
    if(cached!==undefined)return cached;
    if(!el.getClientRects().length){readPass?.visual.set(el,false);return false;}
    for(let node=el;node;node=node.parentElement||node.getRootNode()?.host) {
      const style=styleOf(node);
      if(node.matches('[hidden],[inert]')||style.display==='none'||['hidden','collapse'].includes(style.visibility)){
        readPass?.visual.set(el,false);return false;
      }
    }
    readPass?.visual.set(el,true);
    return true;
  }
  const visualAll=(query,scope)=>[...new Set(roots(scope).flatMap(root=>[...root.querySelectorAll(query)]))].filter(visibleVisual);
  function authoredScope(container) {
    // The assessment micro-app and Weaver's main player also put the actual
    // stem beside the question widget. Only widen inside an observed player
    // with one active question, never into the top-level course/account body.
    const scope=container.closest(PLAYER_SCOPES+',main#player-container,[data-alef-question-scope],.slide-container,[data-testid="slide-container"]')||
      (topCourseContext?container.closest('main,[role="main"]'):null);
    if(!scope||scope===container)return container;
    const questions=uniqueNodes(all(QUESTION_ROOTS,scope));
    if(questions.length)return questions.length===1&&questions[0]===container?scope:container;
    // A native/semantic choice group can be the active question without one of
    // the authored widget markers. Keep the same single-group boundary.
    const groups=uniqueNodes(all('fieldset,[role="radiogroup"],[role="group"][aria-labelledby],[role="selectgroup"][aria-labelledby]',scope));
    return groups.length===1&&groups[0]===container?scope:container;
  }
  function visualNodes(container) {
    const scope=authoredScope(container),found=[],seen=new Set();
    const optionRows=optionNodes(container).map(describeOption);
    function add(node,kind,source) {
      if(!visibleVisual(node)||node.closest(VISUAL_EXCLUSIONS))return;
      const ownerQuestion=node.closest(QUESTION_ROOTS),hiddenSlide=node.closest('[aria-hidden="true"]');
      if(ownerQuestion&&ownerQuestion!==container&&!container.contains(ownerQuestion))return;
      if(hiddenSlide&&!hiddenSlide.contains(container)&&hiddenSlide.querySelector(QUESTION_ROOTS))return;
      const option=optionRows.find(row=>row.node===node||row.node.contains(node));
      const box=node.getBoundingClientRect();
      if(Math.max(box.width,box.height)<40&&(node.closest('[role="presentation"],[aria-hidden="true"]')||!option&&node.closest('button,[role="button"]')))return;
      const alt=clean(node.getAttribute('alt')||node.getAttribute('aria-label')).slice(0,240);
      const id='visual-'+hash(JSON.stringify([kind,source,option?.id||'']));
      if(seen.has(id))return;
      seen.add(id);
      found.push({node,kind,source,id,alt,...(option?{optionId:option.id}:{})});
    }
    for(const node of visualAll('img,canvas,svg',scope)) {
      if(node.tagName.toLowerCase()==='img')add(node,'image',node.currentSrc||node.src||node.getAttribute('src')||'unloaded');
      else if(node.tagName.toLowerCase()==='canvas') {
        let pixels='unreadable';try{pixels=node.toDataURL('image/png');}catch{}
        add(node,'canvas',`${node.width}x${node.height}:${hash(pixels)}`);
      } else if(!node.parentElement?.closest('svg')) {
        const box=node.getBoundingClientRect();
        if(node.getAttribute('role')==='img'||box.width>=40&&box.height>=40){
          const copy=node.cloneNode(true);copy.removeAttribute('data-alef-visual-target');
          add(node,'svg',copy.outerHTML);
        }
      }
    }
    for(const node of [scope,...visualAll('*',scope)]) {
      if(node.closest(VISUAL_EXCLUSIONS)||node.closest('svg')||node.matches('img,canvas'))continue;
      const box=node.getBoundingClientRect();
      if(box.width<40||box.height<40)continue;
      const background=styleOf(node).backgroundImage;
      for(const match of background.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g)) {
        add(node,'background',match[1]||match[2]||match[3]?.trim()||'');
      }
    }
    for(const node of visualAll('[role="img"],[data-alef-visual]',scope)) {
      const box=node.getBoundingClientRect();
      if(Math.max(box.width,box.height)<40&&!node.hasAttribute('data-alef-visual'))continue;
      if(!found.some(entry=>entry.node===node||node.contains(entry.node)))add(node,'unsupported',node.outerHTML);
    }
    return found;
  }
  const visualMetadata=rows=>rows.map(({id,kind,alt,optionId})=>({id,kind,alt,...(optionId?{optionId}:{})}));
  function referencesDiagram(value) {
    return /\b(?:figure|diagram|pictured|illustration)\b|\b(?:graph|image|picture)\s+(?:below|above|shown|provided)\b|(?:الشكل|الشكلين|الرسم|الصورة)\s+(?:المقابل|التالي|الموضح|ادناه|اعلاه)|الرسم البياني|(?:الشكل|الشكلين).{0,100}(?:تمدد|معامل التمدد)/i.test(norm(value));
  }
  async function readyImage(image) {
    const deadline=Date.now()+4500;
    while(!image.complete) {
      assertNotCancelled();
      if(Date.now()>=deadline)throw new Error('لم يكتمل تحميل صورة السؤال؛ لم تُرسل بيانات ناقصة للحل.');
      await delay(40);
    }
    assertNotCancelled();
    if(!image.naturalWidth||!image.naturalHeight)throw new Error('تعذّرت قراءة صورة السؤال؛ انتظر تحميل الرسم ثم أعد المحاولة.');
    return image;
  }
  async function imageAt(url,owner,anonymous=false) {
    if(!/^(?:https?:|data:image\/(?:png|jpe?g|webp|gif|svg\+xml)[;,]|blob:)/i.test(url))throw new Error('صيغة صورة السؤال غير مدعومة للقراءة المرئية.');
    const image=new owner.Image();
    if(anonymous)image.crossOrigin='anonymous';
    image.src=url;
    return readyImage(image);
  }
  function rasterize(source,width,height,owner) {
    if(!width||!height)throw new Error('أبعاد الرسم غير صالحة للقراءة.');
    const scale=Math.min(1,1600/Math.max(width,height));
    const canvas=owner.document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));
    const ctx=canvas.getContext('2d');
    ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(source,0,0,canvas.width,canvas.height);
    let encoded=canvas.toDataURL('image/png');
    const bytes=value=>Math.floor((value.length-value.indexOf(',')-1)*3/4);
    if(bytes(encoded)>MAX_VISUAL_BYTES)encoded=canvas.toDataURL('image/jpeg',.88);
    if(bytes(encoded)>MAX_VISUAL_BYTES) {
      const smaller=owner.document.createElement('canvas');smaller.width=Math.round(canvas.width*.75);smaller.height=Math.round(canvas.height*.75);
      smaller.getContext('2d').drawImage(canvas,0,0,smaller.width,smaller.height);encoded=smaller.toDataURL('image/jpeg',.8);
    }
    if(bytes(encoded)>MAX_VISUAL_BYTES)throw new Error('حجم الرسم يتجاوز حد القراءة؛ لم تُحذف تفاصيل منه لإرسال جواب تخميني.');
    const [,mimeType,data]=encoded.match(/^data:(image\/(?:png|jpeg));base64,(.+)$/)||[];
    if(!data)throw new Error('تعذّر تحويل الرسم إلى صورة قابلة للقراءة.');
    return {data,mimeType};
  }
  async function captureSourceVisual(entry) {
    const {node,kind,source}=entry,owner=view(node);
    if(kind==='unsupported')throw new Error('يحتوي السؤال على رسم لا يمكن التقاطه كاملًا؛ لم تُرسل مسألة ناقصة للحل.');
    if(kind==='canvas')return rasterize(node,node.width,node.height,owner);
    if(kind==='svg') {
      if(node.querySelector('foreignObject'))throw new Error('يتضمن الرسم المتجه محتوى لا يمكن التقاطه كاملًا؛ لم تُحذف معلومات منه للحل.');
      const copy=node.cloneNode(true),original=[node,...node.querySelectorAll('*')],cloned=[copy,...copy.querySelectorAll('*')];
      for(let index=0;index<original.length;index++) {
        const current=original[index],target=cloned[index],style=owner.getComputedStyle(current);
        for(const attr of [...target.attributes])if(/^on/i.test(attr.name))target.removeAttribute(attr.name);
        for(const property of ['fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','opacity','font-family','font-size','font-weight','text-anchor'])target.style.setProperty(property,style.getPropertyValue(property));
        for(const attr of ['href','xlink:href'])if(target.hasAttribute(attr)&&!target.getAttribute(attr).startsWith('#'))throw new Error('الرسم المتجه يعتمد على ملف خارجي؛ تعذّرت قراءة كل بياناته.');
      }
      copy.querySelectorAll('script,foreignObject,style').forEach(child=>child.remove());
      const box=node.getBoundingClientRect();
      const width=node.viewBox?.baseVal?.width||node.width?.baseVal?.value||box.width;
      const height=node.viewBox?.baseVal?.height||node.height?.baseVal?.value||box.height;
      copy.setAttribute('xmlns','http://www.w3.org/2000/svg');copy.setAttribute('width',String(width));copy.setAttribute('height',String(height));
      const url=owner.URL.createObjectURL(new owner.Blob([new owner.XMLSerializer().serializeToString(copy)],{type:'image/svg+xml'}));
      try{return rasterize(await imageAt(url,owner),width,height,owner);}finally{owner.URL.revokeObjectURL(url);}
    }
    if(kind==='image') {
      await readyImage(node);
      try{return rasterize(node,node.naturalWidth,node.naturalHeight,owner);}catch(error) {
        if(error.name!=='SecurityError')throw error;
      }
    }
    try {
      const image=await imageAt(source,owner,/^https?:/i.test(source));
      return rasterize(image,image.naturalWidth,image.naturalHeight,owner);
    }catch(error) {
      assertNotCancelled();
      throw new Error('تعذّرت قراءة جميع صور السؤال من مصدرها. لم يُحل السؤال كنص ناقص أو تُرسل إجابة تخمينية.');
    }
  }
  function clearVisualTargets(){
    for(const node of visualTargets)node.removeAttribute('data-alef-visual-target');
    visualTargets.clear();
  }
  async function captureVisual(entry,question){
    try{return await captureSourceVisual(entry);}catch(originalError){
      assertNotCancelled();assertQuestion(question);
      if(!['image','background','canvas','svg'].includes(entry.kind)||
        entry.kind==='image'&&(!entry.node.complete||!entry.node.naturalWidth||!entry.node.naturalHeight))throw originalError;
      const node=entry.node,target=crypto.randomUUID();
      node.setAttribute('data-alef-visual-target',target);visualTargets.add(node);
      const request=()=>chrome.runtime.sendMessage({type:'ALEF_CAPTURE_VISUAL',target,kind:entry.kind,source:entry.source,
        expectedURL:node.ownerDocument.location.href});
      try{
        let response=await request();
        assertNotCancelled();assertQuestion(question);
        if(response?.code==='visual_not_fully_visible'){
          // Scroll only the selected diagram and retry once. It must still be
          // the same question and source; never capture a clipped illustration.
          node.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
          await delay(80);assertNotCancelled();assertQuestion(question);
          response=await request();assertNotCancelled();assertQuestion(question);
        }
        if(!response)throw originalError;
        if(!response.ok)throw new Error(response.error||'تعذّر التقاط رسم السؤال من الإضافة. افتح تبويب ألف في الواجهة ثم أعد المحاولة.');
        if(!['image/png','image/jpeg'].includes(response.mimeType)||typeof response.data!=='string'||
          !response.data.length||response.data.length>1_398_104||!/^[A-Za-z0-9+/]+={0,2}$/.test(response.data))throw new Error('رد التقاط الرسم غير صالح؛ لم تُرسل صورة ناقصة.');
        return {data:response.data,mimeType:response.mimeType};
      }finally{node.removeAttribute('data-alef-visual-target');visualTargets.delete(node);}
    }
  }
  async function getVisuals(message) {
    assertNotCancelled();
    const question=readQuestion().question;
    if(!question||question.id!==message.questionId||question.fingerprint!==message.questionFingerprint)throw new Error('تغيّر السؤال قبل قراءة الرسم؛ لم تُستخدم صورة لسؤال آخر.');
    const entries=visualNodes(questionContainer());
    if(question.requiresVision&&!entries.length)throw new Error('يشير السؤال إلى رسم غير ظاهر؛ لم تُرسل مسألة ناقصة للنموذج.');
    if(entries.length>MAX_VISUALS)throw new Error('السؤال يحتوي على أكثر من ثلاث صور؛ لم تُحذف صور لازمة لإكمال الحل.');
    const images=[];
    for(const entry of entries) {
      assertNotCancelled();assertQuestion(question);
      const data=await captureVisual(entry,question);
      assertNotCancelled();assertQuestion(question);
      images.push({id:entry.id,...data,alt:entry.alt,...(entry.optionId?{optionId:entry.optionId}:{})});
    }
    return {ok:true,questionId:question.id,questionFingerprint:question.fingerprint,requiresVision:question.requiresVision,images};
  }
  const PROMPT_CONTEXT=weaverSelector('[data-alef-question-context],[data-testid="question-statement-container"],.question-statement-container');
  const CONTEXT_CHROME='aside,nav,button,[role="button"],input,textarea,select,math-field,[role="banner"],[role="navigation"],[data-testid="ncle-main-contents"],[data-testid="ncle-sidebar"],[data-testid="progress-bar-slide-count"],[role="progressbar"]';
  const PROMPT_FEEDBACK='[data-testid="general-answer-feedback"],[data-testid="answerFeedback"],[data-testid="answer-feedback"],[data-testid="correct-answer-feedback"],[data-alef-feedback],[data-testid="wrong-answer-feedback"],[data-testid$="question-feedback-container"],[data-testid="custom-feedback-container"],[role="status"],[role="alert"]';
  function promptBody(authored,{context=false,omitMediaUI=false,dropdownFields=[]}={}) {
    if(authored.nodeType===3)return visible(authored.parentElement)?clean(authored.textContent):'';
    if(authored.matches(PROMPT_FEEDBACK)||context&&authored.matches(CONTEXT_CHROME))return '';
    const copy=authored.cloneNode(true);
    // Detached clones lose computed styles. Carry visibility from the live
    // question before removing options, so hidden distractor text cannot turn
    // a correct calculation into a different expression. Math renderers keep
    // hidden semantic source below their visible outer math node intentionally.
    const originalNodes=[...authored.querySelectorAll('*')],copiedNodes=[...copy.querySelectorAll('*')];
    originalNodes.forEach((node,index)=>{
      if(node.parentElement?.closest('.katex,math,mjx-container'))return;
      const style=styleOf(node);
      if(style.display==='none'||['hidden','collapse'].includes(style.visibility))copiedNodes[index].setAttribute('hidden','');
    });
    copy.querySelectorAll(weaverSelector('.dropdown-input-field-container,[data-testid="selectableChoice"],select,[role="combobox"]')).forEach(node=>{
      const original=originalNodes[copiedNodes.indexOf(node)];
      const fields=dropdownFields.filter(field=>original===field.node||original?.contains(field.node));
      if(dropdownFields.length>1&&fields.length>1){node.replaceWith(...node.childNodes);return;}
      node.replaceWith(dropdownFields.length>1&&fields.length===1?` [dropdown:${fields[0].id}] `:' [قائمة الإجابة] ');
    });
    copy.querySelectorAll(weaverSelector('.dnd-droppable[id^="droppable-"][data-index]')).forEach(node=>node.replaceWith(' [blank:'+node.getAttribute('data-index')+'] '));
    copy.querySelectorAll(weaverSelector('.dnd-options-draggable,.dnd-options-draggable-overlay,.dnd-overlay')).forEach(node=>node.remove());
    copy.querySelectorAll('[data-testid^="fill-blank-dd-"]').forEach(node=>node.replaceWith(' [blank:'+node.getAttribute('data-testid').slice(14)+'] '));
    copy.querySelectorAll('[data-testid="draggableChoice"],[data-testid="choice-item-dd"],[data-testid="general-answer-feedback"],[data-testid="answerFeedback"],[data-testid="answer-feedback"],[data-testid="correct-answer-feedback"],[data-alef-feedback],[data-testid="wrong-answer-feedback"],[data-testid$="question-feedback-container"],[data-testid="custom-feedback-container"],[role="status"],[role="alert"]').forEach(node=>node.remove());
    copy.querySelectorAll('math-field').forEach(node=>node.remove());
    copy.querySelectorAll('button,input,textarea,[data-alef-option],[data-testid="choice-item"],[role="radio"],[role="checkbox"],label,[data-testid="matching-choices"],[data-testid="matching-answers"],[data-testid^="matching-choice-"],[data-testid^="matching-answer-"],[data-alef-item],[data-alef-target],[role="listbox"],[class*="react-select"],[hidden],[aria-hidden="true"],script,style').forEach(node=>node.remove());
    if(context)copy.querySelectorAll(CONTEXT_CHROME).forEach(node=>node.remove());
    if(omitMediaUI)copy.querySelectorAll(MEDIA_UI).forEach(node=>node.remove());
    // A detached copy has no layout-derived innerText line breaks. Preserve
    // boundaries between instruction, stem and math instead of joining words.
    copy.querySelectorAll('div,p,section,h1,h2,h3,h4,li,br').forEach(node=>{node.prepend(' ');node.append(' ');});
    return text(copy);
  }
  function questionReferences(container) {
    const providers=[container,...all('[role="radiogroup"],[role="selectgroup"],fieldset,[role="group"][aria-labelledby]',container)];
    const found=[];
    for(const provider of providers)for(const name of ['aria-describedby','aria-labelledby']) {
      for(const id of (provider.getAttribute(name)||'').split(/\s+/).filter(Boolean)) {
        const node=provider.getRootNode().getElementById?.(id);
        if(!node||!visible(node)||node===container||node.contains(container)||node.closest(CONTEXT_CHROME+','+PROMPT_FEEDBACK))continue;
        const owner=node.closest(QUESTION_ROOTS);
        if(owner&&owner!==container&&!container.contains(owner))continue;
        found.push(node);
      }
    }
    return uniqueNodes(found);
  }
  function promptText(container) {
    // A short selection instruction is not the stem. Read preceding authored
    // content in the single-question player, and explicitly associated content
    // even when CSS places it after the answer widget. Following unassociated
    // siblings are excluded: legacy renderers append untagged result feedback.
    const dropdownFields=dropdownFieldEntries(container);
    const authored=container.matches('[data-testid="question-renderer"]')
      ? first('[data-testid^="question-renderer-"]',container)||container : container;
    const scope=authoredScope(container),preceding=[];
    if(scope.contains(authored)) {
      for(let node=authored;node&&node!==scope;node=node.parentElement) {
        const siblings=[];
        for(let sibling=node.previousSibling;sibling;sibling=sibling.previousSibling) {
          if(sibling.nodeType===3||isElement(sibling)&&visible(sibling))siblings.unshift(sibling);
        }
        preceding.unshift(...siblings);
      }
    }
    const pieces=preceding.map(node=>promptBody(node,{context:true,dropdownFields})).filter(Boolean);
    const value=promptBody(authored,{dropdownFields});if(value)pieces.push(value);
    const referenced=[...questionReferences(container),...all(PROMPT_CONTEXT,scope).filter(node=>!authored.contains(node)&&!node.contains(container))];
    for(const node of uniqueNodes(referenced)) {
      const extra=promptBody(node,{context:true,dropdownFields});
      if(extra&&!pieces.some(piece=>piece.includes(extra)))pieces.push(extra);
    }
    return clean(pieces.join(' '));
  }
  function genericInstructionOnly(value) {
    return /^(?:select the correct answers?|choose the correct answers?|select all that apply|choose all correct answers|select one answer|answer the question|write your answer|enter your answer|complete the answer|اختر الاجابة الصحيحة|اختر الاجابات الصحيحة|حدد الاجابة الصحيحة|اختر الاجابة المناسبة|اختر الاجابة|اكمل الاجابة|اكتب الاجابة|اكتب اجابتك|اجب عن السؤال|اختر من القائمة)$/.test(norm(value));
  }
  function matchingControls(container) {
    if(container.matches(weaverSelector('.dnd-container.question-widget'))){
      if(container.matches(weaverSelector('.text-on-image,.image-on-image,.sequence-image,.sequence-text')))throw new Error('هذا السحب يعتمد على صورة أو ترتيب خاص؛ لم يُربط تلقائيًا.');
      const blanks=all(weaverSelector('.dnd-droppable[id^="droppable-"][data-index]'),container);
      const choices=all(weaverSelector('.dnd-options-draggable'),container);
      if(!blanks.length)return null;
      const key=location.href+'|'+text(first('[data-testid="progress-bar-slide-count"]'))+'|'+promptText(container);
      if(weaverDragCache?.key!==key){
        const targets=choices.map(node=>({id:'choice-'+hash(text(node)),text:text(node)}));
        if(!targets.length||targets.some(item=>!item.text)||new Set(targets.map(item=>item.id)).size!==targets.length)throw new Error('كلمات السحب غير واضحة أو متكررة؛ تعذّر تحديدها بأمان.');
        weaverDragCache={key,targets};
      }
      return {mode:'weaver-mouse',items:blanks.map((node,index)=>({id:node.getAttribute('data-index'),text:'الفراغ '+(index+1)+' [blank:'+node.getAttribute('data-index')+']',node})),targets:weaverDragCache.targets.map(item=>({...item,node:choices.find(node=>text(node)===item.text)||null}))};
    }

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
  // Read answered/locked controls too: Try Again must keep the same question
  // identity. Write paths separately require an enabled, editable control.
  function dropdownControls(container){return all('select,[role="combobox"]',container);}
  function dropdownFieldEntries(container){
    const controls=dropdownControls(container);
    // React Select allocates a new numeric instance ID after a remount. The
    // authored blank's order stays stable even though that runtime ID changes.
    const authored=controls.map(node=>clean(node.getAttribute('data-alef-field-id')||node.getAttribute('data-field-id')||
      node.getAttribute('name')||(!/^react-select-\d+-input$/.test(node.id)?node.id:'')));
    return controls.map((node,index)=>{
      const source=authored[index],id=source&&authored.filter(value=>value===source).length===1?`field-${hash(source)}`:`field-${index+1}`;
      return {id,text:`القائمة ${index+1} [dropdown:${id}]`,node};
    });
  }
  function nativeDropdownOptions(control){
    return [...control.options].filter(option=>availableSelectOption(option)&&option.value!=='')
      .map(option=>({id:option.value,text:clean(option.textContent)}));
  }
  function validateDropdownOptions(options,multiple=false){
    if(!options.length||options.some(option=>!option.text)||new Set(options.map(option=>option.id)).size!==options.length||
      multiple&&(options.length>20||new Set(options.map(option=>option.text)).size!==options.length))
      throw new Error('خيارات القائمة غير واضحة أو متكررة أو تتجاوز الحد المدعوم.');
    return options;
  }
  function textAnswerControls(container){
    return all('math-field,textarea,[data-alef-answer],input[type="text"],input[type="number"],input:not([type])',container)
      .filter(node=>node.tagName==='MATH-FIELD'||node.matches('input,textarea')&&!node.matches('[role="combobox"]')&&!node.closest('math-field'));
  }
  function editableTextAnswer(node){return !disabled(node)&&!node.readOnly&&!node.hasAttribute('readonly')&&!node.hasAttribute('read-only')&&node.getAttribute('aria-readonly')!=='true';}
  function availableSelectOption(option){return !option.disabled&&!option.closest('optgroup[disabled]');}
  function feedback(container){
    const retry=all('button,[role="button"]').some(node=>!disabled(node)&&/^(try again|حاول مرة اخري|حاول مجددا)$/.test(norm(text(node))));
    const attempts=all('div[data-testid^="attempt-"]',container);const active=attempts.at(-1)||container;
    return retry||(!button('next')&&!!first('[data-testid="wrong-answer-feedback"],[data-alef-feedback="wrong"]',active))?'wrong':null;
  }
  function readQuestion() {return withReadPass(readQuestionPage);}
  function readQuestionPage() {
    if(completionVisible())return {ok:true,question:null,completed:true,canNext:false};
    const container=questionContainer();
    if(!container)return {ok:true,question:null,completed:false,canNext:!!button('next')};
    if(first('[data-testid="question-passage-collapsed-caret"],[data-alef-passage-toggle][aria-expanded="false"]',container))return {ok:true,question:null,completed:false,needsPreparation:true,canNext:false};
    let prompt=promptText(container);
    const visuals=visualMetadata(visualNodes(container));
    const requiresVision=visuals.length>0||referencesDiagram(prompt);
    const matching=matchingControls(container);
    const drops=dropdownControls(container);
    const controls=optionNodes(container).map(describeOption);
    let options=controls.map(({id,text})=>({id,text})),type,extra={};
    if(matching){type='matching';options=[];extra={items:matching.items.map(({id,text})=>({id,text})),targets:matching.targets.map(({id,text})=>({id,text}))};}
    else if(drops.length){
      if(drops.length>20)throw new Error('السؤال يحتوي على أكثر من 20 قائمة؛ لم تُحذف فراغات من السؤال.');
      const cacheKey=dropdownKey(container,prompt,visuals);
      if(drops.length>1){
        type='dropdowns';options=[];
        const fields=dropdownFieldEntries(container).map(({id,text,node})=>({id,text,options:node.tagName==='SELECT'?nativeDropdownOptions(node):dropdownCache?.key===cacheKey?dropdownCache.fields?.[id]||[]:[]}));
        if(fields.some(field=>!field.options.length))return {ok:true,question:null,completed:false,needsPreparation:true,canNext:false};
        fields.forEach(field=>validateDropdownOptions(field.options,true));
        extra={fields};
      }else{
        type='single';
        if(drops[0].tagName==='SELECT')options=nativeDropdownOptions(drops[0]);
        else {
          options=dropdownCache?.key===cacheKey?dropdownCache.options:[];
          if(!options.length)return {ok:true,question:null,completed:false,needsPreparation:true,canNext:false};
        }
      }
    }else if(options.length){
      const types=new Set(controls.map(({control})=>control.type||control.getAttribute('role')));
      if(types.size!==1||![...types].every(value=>['radio','checkbox'].includes(value)))throw new Error('لم أتعرف على نوع خيارات هذا السؤال.');
      type=[...types][0]==='checkbox'?'multiple':'single';
    }else{
      const inputs=textAnswerControls(container);
      if(inputs.length!==1)throw new Error(inputs.some(node=>node.tagName==='MATH-FIELD')?'هذا السؤال يحتوي على عدة حقول إجابة؛ يدعم الربط الحالي محرر معادلات واحدًا فقط.':'هذا السؤال يحتاج نوع تفاعل لم يُربط بعد؛ لن تُرسل إجابة تخمينية.');
      type='text';
      if(inputs[0].tagName==='MATH-FIELD')extra={answerFormat:'latex'};
    }
    if(!prompt&&visuals.length)prompt='اقرأ السؤال الظاهر في الصور المرفقة، ثم أجب اعتمادًا على بياناتها.';
    if(!prompt)throw new Error('لم يظهر نص السؤال بوضوح.');
    if(type!=='matching'&&!visuals.length&&genericInstructionOnly(prompt))throw new Error('لم يُقرأ نص المسألة؛ ظهرت تعليمات اختيار الإجابة فقط. لم يُرسل سؤال ناقص للنموذج؛ صدّر فحص الصفحة لتحديد موضع النص.');
    if(options.some(option=>!option.text)||new Set(options.map(option=>option.id)).size!==options.length)throw new Error('خيارات الإجابة غير واضحة أو متكررة.');
    const fingerprint=hash(JSON.stringify([prompt,type,options,extra,visuals,text(first('[data-testid="progress-bar-slide-count"]'))]));
    const code=first('[data-testid^="question-renderer-"]',container)?.getAttribute('data-testid');
    const id=container.getAttribute('data-alef-question')||container.getAttribute('data-question-id')||code||`question-${fingerprint}`;
    return {ok:true,question:{id,text:prompt,type,options,...extra,fingerprint,...(requiresVision?{requiresVision:true,visuals}:{})},completed:false,canNext:!!button('next'),feedback:feedback(container)};
  }
  function setValue(control,value) {
    const realm=view(control),proto=control.tagName==='TEXTAREA'?realm.HTMLTextAreaElement.prototype:control.tagName==='SELECT'?realm.HTMLSelectElement.prototype:realm.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(control,value);
    control.dispatchEvent(new realm.Event('input',{bubbles:true}));control.dispatchEvent(new realm.Event('change',{bubbles:true}));
  }
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  function assertNotCancelled(){if(cancelled)throw new Error('تم إيقاف تطبيق الإجابة.');}
  function assertQuestion(question){const current=readQuestion().question;if(!current||current.id!==question.id||current.fingerprint!==question.fingerprint)throw new Error('تغير السؤال أثناء الحل؛ لم يُضغط زر الإرسال.');}
  async function waitAcknowledged(question,predicate,message,timeout=2000){
    const deadline=Date.now()+timeout;
    for(;;){
      assertNotCancelled();assertQuestion(question);
      if(predicate())return;
      if(Date.now()>=deadline)throw new Error(message);
      await delay(40);
    }
  }
  async function waitStableField(question,predicate,currentControl,message){
    let lastControl=null,stableSince=0;
    // A native setter changes the DOM before a controlled framework commits.
    // Observe a short stable window even when Submit was already enabled.
    await waitAcknowledged(question,()=>{
      const control=currentControl(),now=Date.now();
      if(!predicate()){lastControl=null;stableSince=0;return false;}
      if(control!==lastControl){lastControl=control;stableSince=now;return false;}
      return now-stableSince>=160;
    },message);
  }
  function clearMathTargets(){
    for(const node of mathTargets)node.removeAttribute('data-alef-math-target');
    mathTargets.clear();
  }
  function mathAnswerValue(value){
    let latex=value.trim();
    if(latex.startsWith('$$')&&latex.endsWith('$$'))latex=latex.slice(2,-2).trim();
    else if(latex.startsWith('$')&&latex.endsWith('$'))latex=latex.slice(1,-1).trim();
    else if(latex.startsWith('\\(')&&latex.endsWith('\\)')||latex.startsWith('\\[')&&latex.endsWith('\\]'))latex=latex.slice(2,-2).trim();
    latex=latex.replace(/[\u0660-\u0669\u06f0-\u06f9]/g,char=>String(char.charCodeAt(0)-(char>='\u06f0'?0x6f0:0x660))).replace(/\u066b/g,'.').replace(/\u2212/g,'-');
    if(!latex||latex.length>4096||/[\x00-\x08\x0b\x0c\x0e-\x1f`<>$]/.test(latex)||/\\(?:href|url|html\w*|includegraphics)\b/i.test(latex))throw new Error('إجابة محرر المعادلات ليست صيغة رياضية صالحة؛ لم يُدخل نص شرح أو تنسيق غير مدعوم.');
    return latex;
  }
  function currentMathField(){
    const fields=textAnswerControls(questionContainer());
    if(fields.length!==1||fields[0].tagName!=='MATH-FIELD'||!editableTextAnswer(fields[0]))throw new Error('محرر المعادلات معطل أو تغير؛ انتظر زر حاول مرة أخرى.');
    return fields[0];
  }
  async function applyMathField(question,answer,message){
    const latex=mathAnswerValue(answer.text);
    let marked=null;
    const request=async(operation,value)=>{
      assertNotCancelled();assertQuestion(question);
      const node=currentMathField();
      if(node!==marked){clearMathTargets();node.setAttribute('data-alef-math-target',crypto.randomUUID());mathTargets.add(node);marked=node;}
      const response=await chrome.runtime.sendMessage({type:'ALEF_MATH_FIELD',operation,target:node.getAttribute('data-alef-math-target'),
        expectedURL:node.ownerDocument.location.href,...(operation==='write'?{value}:{})});
      assertNotCancelled();assertQuestion(question);
      // A committed React render may replace the host while a read is pending.
      // Reacquire it on the next read; never replay the write or submit.
      if(operation==='read'&&node!==currentMathField())return null;
      if(!response?.ok)throw new Error(response?.error||'تعذر ربط محرر المعادلات. حدّث الإضافة ثم حدّث صفحة ألف وأعد المحاولة.');
      return response;
    };
    try{
      const written=await request('write',latex);
      if(!written.valid||written.disabled||written.readOnly||typeof written.value!=='string'||!written.value.trim())throw new Error('لم يقبل محرر المعادلات الصيغة المدخلة؛ لم تُرسل الإجابة.');
      const expected=written.value,deadline=Date.now()+2000;
      let lastControl=null,stableSince=0;
      for(;;){
        const state=await request('read'),node=currentMathField(),now=Date.now();
        if(state?.valid&&!state.disabled&&!state.readOnly&&state.value===expected){
          if(node!==lastControl){lastControl=node;stableSince=now;}
          if(now-stableSince>=160)break;
        }else{lastControl=null;stableSince=0;}
        if(now>=deadline)throw new Error('لم يثبت الموقع إجابة محرر المعادلات؛ لم تُرسل الإجابة.');
        await delay(40);
      }
      // Check the public editor value again immediately before clicking. The
      // generic native-input setter cannot access a page-defined custom element
      // from Chrome's isolated world, so all reads/writes use the narrow bridge.
      return await submitAnswer(question,message,async()=>{
        const final=await request('read');
        return final?.valid&&final.value===expected&&!final.disabled&&!final.readOnly;
      });
    }finally{clearMathTargets();}
  }
  async function submitAnswer(question,message,acknowledged=null){
    assertNotCancelled();assertQuestion(question);
    if(!message.autoSubmit)return {ok:true,applied:true,submitted:false};
    // React can acknowledge a selection before enabling its Submit button.
    // Observe readiness without replaying the choice or submitting twice.
    const deadline=Date.now()+2000;
    for(;;){
      assertNotCancelled();assertQuestion(question);
      const submit=button('submit');
      if(submit&&(!acknowledged||await acknowledged())){
        assertNotCancelled();assertQuestion(question);
        if(button('submit')!==submit)continue;
        click(submit);return {ok:true,applied:true,submitted:true};
      }
      if(Date.now()>=deadline)return {ok:true,applied:true,submitted:false,reason:'لم يظهر زر إرسال متاح بعد تثبيت الإجابة؛ توقف التشغيل في هذا السؤال.'};
      await delay(40);
    }
  }
  const DROPDOWN_OPTIONS='[role="option"],[class*="react-select__option"]';
  function dropdownKey(container=questionContainer(),prompt=null,visuals=null){
    if(!container)return null;
    const code=first('[data-testid^="question-renderer-"]',container)?.getAttribute('data-testid');
    return hash(JSON.stringify([location.href,prompt??promptText(container),
      container.getAttribute('data-alef-question')||container.getAttribute('data-question-id')||code||'',
      text(first('[data-testid="progress-bar-slide-count"]')),instructionPosition(),visuals??visualMetadata(visualNodes(container))]));
  }
  function currentDropdown(fieldId=null){
    const fields=dropdownFieldEntries(questionContainer());
    const field=fieldId?fields.find(item=>item.id===fieldId):fields.length===1?fields[0]:null;
    if(!field)throw new Error('تغير حقل القائمة في السؤال.');
    return field.node;
  }
  function dropdownMenuOptions(control,opening){
    // React Select portals belong to the combobox's document/shadow tree,
    // never to another iframe or an unrelated menu elsewhere on the page.
    const root=control.getRootNode(),ids=[...new Set(clean([control.getAttribute('aria-controls'),control.getAttribute('aria-owns')].filter(Boolean).join(' ')).split(' ').filter(Boolean))];
    let menus;
    if(ids.length){
      menus=ids.map(id=>root.getElementById?.(id)).filter(node=>node&&visible(node));
      if(!menus.length)return [];
    }else{
      const wrapper=control.closest(weaverSelector('[data-testid="selectableChoice"],.dropdown-input-field-container,[class*="__control"]'))||control.parentElement;
      const inside=[...wrapper.querySelectorAll('[role="listbox"]')].filter(visible);
      if(inside.length>1)throw new Error('ظهرت قوائم متعددة لحقل الإجابة.');
      if(inside.length)menus=inside;
      else {
        const candidates=[...root.querySelectorAll('[role="listbox"]')].filter(visible);
        const opened=candidates.filter(node=>!opening.menus.has(node));
        if(opened.length>1)throw new Error('تعذّر ربط القائمة المفتوحة بحقل الإجابة.');
        menus=opened;
        if(!menus.length&&opening.expanded&&control.getAttribute('aria-expanded')==='true'&&candidates.length===1)menus=candidates;
      }
    }
    if(menus.length>1)throw new Error('تعذّر تحديد قائمة الإجابة الحالية.');
    // K4 adds a Cancel action to the menu with role=option, but its handler
    // explicitly ignores it as an answer. Keep that action out of the solver.
    const options=menus.flatMap(menu=>[...menu.querySelectorAll(DROPDOWN_OPTIONS)]).filter(node=>visible(node)&&!disabled(node)&&!node.matches(weaverSelector('.dropdown-item-cancel')));
    // A busy menu may expose an incomplete first batch of answers.
    return menus.some(menu=>menu.matches('[aria-busy="true"]'))?[]:options;
  }
  async function openDropdown(key,question=null,fieldId=null){
    let control=currentDropdown(fieldId);if(control.tagName==='SELECT')throw new Error('تغير نوع القائمة في السؤال.');
    if(disabled(control))throw new Error('القائمة معطلة؛ انتظر زر حاول مرة أخرى.');
    const root=control.getRootNode(),opening={menus:new Set([...root.querySelectorAll('[role="listbox"]')].filter(visible)),expanded:control.getAttribute('aria-expanded')==='true'};
    const check=()=>{assertNotCancelled();if(question)assertQuestion(question);if(dropdownKey()!==key)throw new Error('تغير السؤال عند فتح القائمة.');};
    check();control.focus();control.dispatchEvent(new (view(control).KeyboardEvent)('keydown',{key:'ArrowDown',code:'ArrowDown',bubbles:true}));
    const started=Date.now();let mouseOpened=false;
    for(;;){
      check();control=currentDropdown(fieldId);if(control.tagName==='SELECT'||disabled(control))throw new Error('تعطلت القائمة أو تغير نوعها أثناء فتحها.');
      const options=dropdownMenuOptions(control,opening);if(options.length)return {control,options,opening};
      if(Date.now()-started>=2000)throw new Error('لم تظهر خيارات القائمة بعد فتحها.');
      if(!mouseOpened&&Date.now()-started>=160&&control.getAttribute('aria-expanded')!=='true'){
        const clickable=control.closest('[class*="__control"]')||control;
        clickable.dispatchEvent(new (view(control).MouseEvent)('mousedown',{button:0,bubbles:true}));mouseOpened=true;
      }
      await delay(40);
    }
  }
  async function closeDropdown(key,opening,fieldId=null){
    const control=currentDropdown(fieldId);control.dispatchEvent(new (view(control).KeyboardEvent)('keydown',{key:'Escape',code:'Escape',bubbles:true}));
    const deadline=Date.now()+2000;
    for(;;){
      assertNotCancelled();if(dropdownKey()!==key)throw new Error('تغير السؤال عند إغلاق القائمة.');
      const current=currentDropdown(fieldId);
      if(current.getAttribute('aria-expanded')!=='true'&&!dropdownMenuOptions(current,opening).length)return;
      if(Date.now()>=deadline)throw new Error('لم تُغلق قائمة الإجابة بعد فحصها.');
      await delay(40);
    }
  }
  function dropdownSelected(control,desired){
    if(control.getAttribute('aria-expanded')==='true')return false;
    const wrapper=control.closest(weaverSelector('[data-testid="selectableChoice"],.dropdown-input-field-container,[class*="__control"]'))||control.parentElement;
    // Weaver's authored label sits inside React Select's __single-value.
    // Those are two nested nodes for one chosen answer, not two selections.
    const authored=[...wrapper.querySelectorAll(weaverSelector('.dropdown-single-value-content'))].filter(visible);
    if(authored.length)return authored.length===1&&text(authored[0])===desired;
    const displays=[...wrapper.querySelectorAll('[class*="__single-value"]')].filter(node=>visible(node)&&!node.querySelector('[class*="__single-value"]'));
    if(displays.length)return displays.length===1&&text(displays[0])===desired;
    if(clean(control.getAttribute('aria-valuetext'))===desired)return true;
    // Search input values alone do not acknowledge a chosen option. The
    // rendered label must match in full ("2" must never acknowledge "12").
    const copy=wrapper.cloneNode(true);for(const node of copy.querySelectorAll('input,textarea,select,[role="listbox"],[role="option"]'))node.remove();
    return clean(copy.textContent)===desired;
  }
  function textInputValue(control,value){
    if(control.tagName!=='INPUT'||control.type!=='number')return value;
    const normalized=value.trim().replace(/[\u0660-\u0669\u06f0-\u06f9]/g,char=>String(char.charCodeAt(0)-(char>='\u06f0'?0x6f0:0x660))).replace(/\u066b/g,'.').replace(/\u2212/g,'-');
    if(!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)||!Number.isFinite(Number(normalized)))throw new Error('حقل الإجابة يتطلب عددًا صالحًا دون وحدات أو نص إضافي.');
    return normalized;
  }
  async function prepareQuestion(){
    let container=questionContainer();if(!container)throw new Error('لم يظهر السؤال.');
    const collapsed=first('[data-testid="question-passage-collapsed-caret"],[data-alef-passage-toggle][aria-expanded="false"]',container);
    if(collapsed){const toggle=first('[data-testid="question-passage-chevron"]',container)||collapsed.closest('button,[role="button"]')||collapsed;click(toggle);await delay(100);assertNotCancelled();container=questionContainer();if(!container)throw new Error('تغير السؤال عند فتح القطعة.');}
    const fields=dropdownFieldEntries(container);if(!fields.length||fields.length===1&&fields[0].node.tagName==='SELECT')return readQuestion();
    if(fields.length>20)throw new Error('السؤال يحتوي على أكثر من 20 قائمة؛ لم تُحذف فراغات من السؤال.');
    const key=dropdownKey(),prepared={};
    for(const field of fields){
      assertNotCancelled();if(dropdownKey()!==key)throw new Error('تغير السؤال أثناء فحص القوائم.');
      if(field.node.tagName==='SELECT'){validateDropdownOptions(nativeDropdownOptions(currentDropdown(field.id)),fields.length>1);continue;}
      const opened=await openDropdown(key,null,field.id);
      const data=validateDropdownOptions(opened.options.map(node=>({id:`dropdown-${hash(text(node))}`,text:text(node)})),fields.length>1);
      prepared[field.id]=data;
      await closeDropdown(key,opened.opening,field.id);
    }
    // Commit only after every list was inspected and closed. Partial menus
    // cannot turn into a model request missing a later blank.
    dropdownCache={key,fields:prepared,...(fields.length===1?{options:prepared[fields[0].id]}:{})};
    return readQuestion();
  }
  function blankHasWord(blank,expected){
    if(!blank)return false;
    // Read the authored answer itself. The blank may also contain an editor
    // label or validation icon; a substring match confuses ماء with ماء مالح.
    const placed=all(weaverSelector('.selected-option'),blank).filter(node=>!node.querySelector(weaverSelector('.selected-option')));
    if(placed.length)return placed.length===1&&clean(text(placed[0]))===expected;
    const copy=blank.cloneNode(true);
    copy.querySelectorAll(weaverSelector('.dnd-droppable__edit-label-tab,.dnd-grip-icon,.validationIcon,button,[role="button"],[aria-hidden="true"]')).forEach(node=>node.remove());
    return clean(text(copy))===expected;
  }
  function weaverBlankHasWord(blank,expected){return hasWeaverClass(blank,'is-selected')&&blankHasWord(blank,expected);}
  function weaverDragPoint(node){
    if(!visible(node))throw new Error('موضع السحب لم يعد ظاهرًا في السؤال الحالي.');
    const rect=node.getBoundingClientRect();
    if(!rect.width||!rect.height)throw new Error('تعذّر تحديد موضع السحب الحالي.');
    return {clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2};
  }
  async function applyMatching(question,answer,message){
    const original=matchingControls(questionContainer());
    let lastMouseReleaseAt=null;
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
        await waitAcknowledged(question,()=>{const active=matchingControls(questionContainer());return hasWeaverClass(active?.items.find(row=>row.id===pair.itemId)?.node,'selected')&&hasWeaverClass(active?.targets.find(row=>row.id===pair.targetId)?.node,'selected');},'لم يؤكد الموقع تثبيت زوج المطابقة.');
      }else if(current.mode==='blank-choice'){
        if(!target.node)throw new Error('خيار المطابقة لم يعد متاحًا.');
        click(target.node);await delay(60);assertNotCancelled();
        current=matchingControls(questionContainer());item=current.items.find(row=>row.id===pair.itemId);click(item.node);await delay(60);
        current=matchingControls(questionContainer());item=current.items.find(row=>row.id===pair.itemId);
        await waitAcknowledged(question,()=>blankHasWord(matchingControls(questionContainer())?.items.find(row=>row.id===pair.itemId)?.node,target.text),'لم يؤكد الموقع وضع الكلمة في الفراغ.');
      }else if(current.mode==='weaver-mouse'){
        if(weaverBlankHasWord(item.node,target.text))continue;
        if(!target.node||disabled(target.node))throw new Error('كلمة السحب غير متاحة في السؤال الحالي.');
        const realm=view(target.node),doc=target.node.ownerDocument;
        target.node.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
        assertNotCancelled();assertQuestion(question);
        const start=weaverDragPoint(target.node);
        const mouse=(type,point,buttons)=>new realm.MouseEvent(type,{...point,bubbles:true,cancelable:true,composed:true,view:realm,button:0,buttons});
        let released=false,end=null;
        try{
          // Keep the primary button held until the actual MouseSensor activates.
          // Some lessons activate in 100 ms; others require about a second.
          target.node.dispatchEvent(mouse('mousedown',start,1));
          await waitAcknowledged(question,()=>{const active=matchingControls(questionContainer()).targets.find(row=>row.id===pair.targetId)?.node;return !!active&&(hasWeaverClass(active,'is-dragging')||hasWeaverClass(active,'is-item-dragging')||active.getAttribute('aria-pressed')==='true');},'لم يبدأ الموقع سحب الكلمة.');
          const moveToBlank=()=>{
            const blank=matchingControls(questionContainer())?.items.find(row=>row.id===pair.itemId)?.node;
            if(!blank)throw new Error('فراغ الإجابة لم يعد متاحًا.');
            blank.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
            const point=weaverDragPoint(blank);
            const moved=!end||Math.abs(point.clientX-end.clientX)>.5||Math.abs(point.clientY-end.clientY)>.5;
            // Scrolling can keep the same viewport coordinates while moving
            // the underlying blank. Re-dispatch until that blank acknowledges
            // hover, including after a layout change caused by the first move.
            if(moved||!hasWeaverClass(blank,'is-about-to-drop')){end=point;doc.dispatchEvent(mouse('mousemove',end,1));}
            return {blank,moved};
          };
          moveToBlank();
          await waitAcknowledged(question,()=>{const {blank,moved}=moveToBlank();return !moved&&hasWeaverClass(blank,'is-about-to-drop');},'لم يؤكد الموقع موضع إسقاط الكلمة.');
          assertNotCancelled();assertQuestion(question);
          doc.dispatchEvent(mouse('mouseup',end,0));released=true;lastMouseReleaseAt=performance.now();
          await waitAcknowledged(question,()=>weaverBlankHasWord(matchingControls(questionContainer())?.items.find(row=>row.id===pair.itemId)?.node,target.text),'لم يؤكد الموقع وضع الكلمة في الفراغ.');
        }finally{
          if(!released){doc.dispatchEvent(new realm.KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true,cancelable:true}));doc.dispatchEvent(mouse('mouseup',start,0));}
        }
      }else{
        const realm=view(item.node),transfer=new realm.DataTransfer();transfer.setData('text/plain',pair.itemId);
        item.node.dispatchEvent(new realm.DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));target.node.dispatchEvent(new realm.DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));target.node.dispatchEvent(new realm.DragEvent('drop',{bubbles:true,dataTransfer:transfer}));item.node.dispatchEvent(new realm.DragEvent('dragend',{bubbles:true,dataTransfer:transfer}));await delay(60);
        await waitAcknowledged(question,()=>{const active=matchingControls(questionContainer());const placed=active?.targets.find(row=>row.id===pair.targetId)?.node;const source=active?.items.find(row=>row.id===pair.itemId)?.node;return !!placed&&(placed.getAttribute('data-selected-item')===pair.itemId||!!source&&placed.contains(source));},'لم يؤكد الموقع موضع الإجابة المسحوبة.');
      }
    }
    const wordAcknowledged=original.mode==='weaver-mouse'?weaverBlankHasWord:original.mode==='blank-choice'?blankHasWord:null;
    const allMatchesPlaced=()=>{
      const active=matchingControls(questionContainer());
      return answer.matches.every(pair=>{
        const item=active?.items.find(row=>row.id===pair.itemId)?.node,target=active?.targets.find(row=>row.id===pair.targetId)?.node;
        if(wordAcknowledged)return wordAcknowledged(item,original.targets.find(row=>row.id===pair.targetId).text);
        if(original.mode==='click-pairs')return hasWeaverClass(item,'selected')&&hasWeaverClass(target,'selected');
        return !!target&&(target.getAttribute('data-selected-item')===pair.itemId||!!item&&target.contains(item));
      });
    };
    await waitAcknowledged(question,allMatchesPlaced,wordAcknowledged?'لم يؤكد الموقع تثبيت جميع الكلمات في فراغاتها الصحيحة.':'لم يؤكد الموقع تثبيت جميع أزواج المطابقة.');
    // DndKit keeps its capture-phase click suppression for 50 ms after a
    // MouseSensor ends. A ready-looking Submit click inside that window is
    // swallowed before the application's handler sees it. Wait only for our
    // latest mouse release, then recheck cancellation and the current mapping.
    if(message.autoSubmit&&lastMouseReleaseAt!==null){
      const remaining=75-(performance.now()-lastMouseReleaseAt);
      if(remaining>0)await delay(remaining);
      assertNotCancelled();assertQuestion(question);
    }
    return submitAnswer(question,message,allMatchesPlaced);
  }
  async function chooseCustomDropdown(question,options,optionId,fieldId=null){
    const desired=options.find(option=>option.id===optionId);
    const opened=await openDropdown(dropdownKey(),question,fieldId);
    const actual=opened.options.map(node=>({id:`dropdown-${hash(text(node))}`,text:text(node)}));
    if(actual.length!==options.length||actual.some(row=>!options.some(option=>option.id===row.id&&option.text===row.text)))throw new Error('تغيرت خيارات القائمة؛ لم تُطبّق الإجابة.');
    const matches=opened.options.filter(node=>text(node)===desired.text);
    if(matches.length!==1)throw new Error('لم تتطابق خيارات القائمة مع السؤال الحالي.');
    assertNotCancelled();assertQuestion(question);click(matches[0]);
    const acknowledged=()=>{
      const control=currentDropdown(fieldId);
      // A React remount can replace the combobox with aria-expanded=false
      // before its old portal finishes closing. Do not open the next blank
      // while that previously owned menu is still visible.
      return control.tagName!=='SELECT'&&!disabled(control)&&!opened.options.some(visible)&&dropdownSelected(control,desired.text);
    };
    await waitAcknowledged(question,acknowledged,'لم يؤكد الموقع اختيار القائمة.');
    return acknowledged;
  }
  async function applyCustomDropdown(question,answer,message){
    const acknowledged=await chooseCustomDropdown(question,question.options,answer.optionIds[0]);
    return submitAnswer(question,message,acknowledged);
  }
  async function applyDropdownFields(question,answer,message){
    const fields=question.fields,selections=answer.selections;
    if(answer.optionIds.length||answer.text&&String(answer.text).trim()||!Array.isArray(selections)||selections.length!==fields.length||
      new Set(selections.map(selection=>selection.fieldId)).size!==fields.length||selections.some(selection=>{
        const field=fields.find(item=>item.id===selection.fieldId);
        return !field||!field.options.some(option=>option.id===selection.optionId);
      }))throw new Error('لم تتطابق إجابات القوائم مع جميع فراغات السؤال؛ لم تُطبّق إجابة جزئية.');
    const acknowledgements=[];
    for(const field of fields){
      assertNotCancelled();assertQuestion(question);
      const selection=selections.find(item=>item.fieldId===field.id),control=currentDropdown(field.id);
      if(disabled(control))throw new Error('إحدى قوائم الإجابة معطلة؛ انتظر زر حاول مرة أخرى.');
      let acknowledged;
      if(control.tagName==='SELECT'){
        const desired=[...control.options].find(option=>option.value===selection.optionId);
        if(!desired||!availableSelectOption(desired))throw new Error('خيار القائمة غير متاح في الفراغ المحدد.');
        setValue(control,selection.optionId);
        acknowledged=()=>{const current=currentDropdown(field.id);return current.tagName==='SELECT'&&!disabled(current)&&current.value===selection.optionId;};
        await waitStableField(question,acknowledged,()=>currentDropdown(field.id),'لم يثبت اختيار القائمة في الفراغ المحدد.');
      }else acknowledged=await chooseCustomDropdown(question,field.options,selection.optionId,field.id);
      acknowledgements.push(acknowledged);
      await waitAcknowledged(question,()=>acknowledgements.every(check=>check()),'تغير اختيار سابق أثناء تطبيق قوائم السؤال؛ لم تُرسل إجابة جزئية.');
    }
    const allFieldsSelected=()=>acknowledgements.every(check=>check());
    return submitAnswer(question,message,allFieldsSelected);
  }
  async function apply(message){
    assertNotCancelled();
    const question=readQuestion().question;if(!question||question.id!==message.questionId||(message.questionFingerprint&&message.questionFingerprint!==question.fingerprint))throw new Error('تغير السؤال أثناء الحل. لم تُطبّق الإجابة.');
    const answer=message.answer;if(!answer||!Array.isArray(answer.optionIds))throw new Error('صيغة الإجابة غير صالحة.');
    const container=questionContainer();
    let acknowledged=null;
    if(question.type==='matching')return applyMatching(question,answer,message);
    if(question.type==='dropdowns')return applyDropdownFields(question,answer,message);
    if(question.type==='text'){
      if(typeof answer.text!=='string'||!answer.text.trim()||answer.optionIds.length)throw new Error('الإجابة النصية غير صالحة.');
      const inputs=textAnswerControls(container);
      if(inputs.length!==1||!editableTextAnswer(inputs[0]))throw new Error('حقل الإجابة معطل أو غير قابل للكتابة؛ انتظر زر حاول مرة أخرى.');
      if(question.answerFormat==='latex')return applyMathField(question,answer,message);
      const expected=textInputValue(inputs[0],answer.text);setValue(inputs[0],expected);assertQuestion(question);
      acknowledged=()=>{const current=textAnswerControls(questionContainer());return current.length===1&&editableTextAnswer(current[0])&&current[0].value===expected&&current[0].validity.valid;};
      await waitStableField(question,acknowledged,()=>textAnswerControls(questionContainer())[0],'لم يؤكد الموقع إدخال نص صالح؛ لم تُرسل الإجابة.');
    }else{
      const ids=new Set(answer.optionIds);if(!ids.size||ids.size!==answer.optionIds.length||(question.type==='single'&&ids.size!==1)||[...ids].some(id=>!question.options.some(option=>option.id===id)))throw new Error('الاختيارات لا تطابق السؤال.');
      const dropdown=dropdownControls(container)[0];
      if(dropdown){
        if(disabled(dropdown))throw new Error('القائمة معطلة؛ انتظر زر حاول مرة أخرى.');
        if(dropdown.tagName!=='SELECT')return applyCustomDropdown(question,answer,message);
        const desired=[...dropdown.options].find(option=>option.value===answer.optionIds[0]);
        if(!desired||!availableSelectOption(desired))throw new Error('خيار القائمة غير متاح.');
        setValue(dropdown,answer.optionIds[0]);
        acknowledged=()=>{const current=dropdownControls(questionContainer());return current.length===1&&!disabled(current[0])&&current[0].value===answer.optionIds[0];};
        await waitStableField(question,acknowledged,()=>dropdownControls(questionContainer())[0],'لم يثبت اختيار القائمة.');
      }
      else{
        for(const original of question.options){
          assertNotCancelled();assertQuestion(question);
          const option=optionNodes(questionContainer()).map(describeOption).find(item=>item.id===original.id);
          if(!option||disabled(option.control))throw new Error('خيارات السؤال معطلة أو تغيرت.');
          const wanted=ids.has(option.id);
          if(wanted!==selected(option)&&(question.type==='multiple'||wanted)){
            click(option.actual?option.node:option.control);
            await waitAcknowledged(question,()=>{const current=optionNodes(questionContainer()).map(describeOption).find(item=>item.id===original.id);return !!current&&selected(current)===wanted;},'لم يؤكد الموقع اختيار الإجابة.');
          }
        }
        await waitAcknowledged(question,()=>{const chosen=optionNodes(questionContainer()).map(describeOption).filter(selected).map(option=>option.id);return chosen.length===ids.size&&chosen.every(id=>ids.has(id));},'لم يؤكد الموقع اختيار الإجابة.');
      }
    }
    return submitAnswer(question,message,acknowledged);
  }
  function interactionDiagnostics(snapshot){
    let container=null;
    try{if(!loginPage())container=questionContainer();}catch{}
    const empty={questionVisible:false,questionType:snapshot.question?.type||null,dropdowns:[],textFields:[],drag:{sources:0,targets:0},menus:[]};
    if(!container)return empty;
    // Record structure and anonymous relationships only. DOM IDs, accessible
    // labels, option text and input values can contain account or answer data.
    const references=new WeakMap();let nextReference=1;
    const reference=node=>{if(!references.has(node))references.set(node,`node-${nextReference++}`);return references.get(node);};
    const knownClasses=new Set(['dropdown-input-field-container','dropdown-field-wrapper','dropdown-input-field-wrapper',
      'dropdown-container','question-widget','dropdown-item','dropdown-item-cancel','dropdown-single-value',
      'dropdown-single-value-content','is-selected','is-focused','is-correct','is-incorrect','is-inline','rtl','k4',
      'dnd-container','dnd-droppable','dnd-options-draggable','is-dragging','is-about-to-drop','open-ended-container','fib-container']);
    const classes=node=>[...new Set([...node.classList].flatMap(value=>knownClasses.has(value.startsWith('lib-')?value.slice(4):value)?[value]:
      /__(?:control|menu|menu-list|option|input|single-value|indicators)$/.test(value)?[value.slice(value.lastIndexOf('__'))]:
        /^css-/.test(value)?['generated-css']:[]))].slice(0,8);
    const roles=new Set(['combobox','listbox','option','textbox','radio','checkbox','button','group','radiogroup','selectgroup']);
    const describe=node=>({ref:reference(node),tag:node.tagName,role:roles.has(node.getAttribute('role'))?node.getAttribute('role'):null,
      classes:classes(node),hasId:!!node.id,hasTestId:node.hasAttribute('data-testid'),visible:visible(node)});
    const controls=all('select,[role="combobox"]',container).slice(0,20),menuOwners=new Map();
    const dropdowns=controls.map((node,index)=>{
      const root=node.getRootNode(),ids=clean([node.getAttribute('aria-controls'),node.getAttribute('aria-owns')].filter(Boolean).join(' ')).split(' ').filter(Boolean);
      const linked=[...new Set(ids.map(id=>root.getElementById?.(id)).filter(isElement))];
      for(const menu of linked){if(!menuOwners.has(menu))menuOwners.set(menu,[]);menuOwners.get(menu).push(index+1);}
      const ancestors=[];for(let parent=node.parentElement;parent&&parent!==container&&ancestors.length<3;parent=parent.parentElement)ancestors.push(describe(parent));
      return {...describe(node),index:index+1,disabled:disabled(node),readOnly:node.readOnly===true,
        expanded:node.getAttribute('aria-expanded')==='true',focused:root.activeElement===node,
        nativeOptions:node.tagName==='SELECT'?node.options.length:null,
        linkedMenuCount:linked.length,unresolvedReferences:Math.max(0,new Set(ids).size-linked.length),
        menuRefs:linked.map(reference),ancestors};
    });
    const menuNodes=new Set(menuOwners.keys());
    for(const root of new Set(controls.map(node=>node.getRootNode())))for(const menu of root.querySelectorAll('[role="listbox"],[class*="__menu-list"]'))if(visible(menu)&&menuNodes.size<30)menuNodes.add(menu);
    const menus=[...menuNodes].slice(0,30).map(node=>({...describe(node),ownerFields:menuOwners.get(node)||[],busy:node.getAttribute('aria-busy')==='true',
      semanticOptions:all('[role="option"]',node).length,weaverOptions:all(weaverSelector('.dropdown-item:not(.dropdown-item-cancel)'),node).length,
      cancelOptions:all(weaverSelector('.dropdown-item-cancel'),node).length}));
    const textFields=all('input:not([type="hidden"]),textarea,[contenteditable="true"],math-field',container)
      .filter(node=>!node.matches('[role="combobox"],input[type="radio"],input[type="checkbox"]')).slice(0,20)
      .map(node=>({...describe(node),type:node.tagName==='INPUT'&&['text','number','search','email','password','tel','url'].includes(node.type)?node.type:null,
        disabled:disabled(node),readOnly:node.readOnly===true,contentEditable:node.getAttribute('contenteditable')==='true',
        valid:node.validity?.valid??null}));
    return {questionVisible:true,questionType:snapshot.question?.type||null,dropdowns,textFields,menus,
      drag:{sources:all(weaverSelector('.dnd-options-draggable,[data-alef-item],[data-testid="draggableChoice"]'),container).length,
        targets:all(weaverSelector('.dnd-droppable,[data-alef-target],[data-testid^="fill-blank-dd-"]'),container).length}};
  }
  function diagnostics(){
    const started=performance.now();
    const snapshot=inspect();
    const inspectionDurationMs=Math.round(performance.now()-started);
    const cleanUrl=value=>{try{const url=new URL(value,location.href);return url.origin+url.pathname+(url.hash.startsWith('#/')?url.hash.split('?')[0]:'');}catch{return '';}};
    const login=loginPage();
    const inPlayer=node=>!!node.closest(PLAYER_SCOPES)||topCourseContext&&!login;
    const safeForm=node=>!node.closest('form')||inPlayer(node)&&!login;
    const controls=all('button,[role="button"],[role="radio"],[role="checkbox"],[role="radiogroup"],[role="combobox"],[data-testid]')
      .filter(node=>safeForm(node)&&!node.matches('input,textarea')).sort((a,b)=>Number(inPlayer(b))-Number(inPlayer(a)));
    const choices=all('input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"]').filter(node=>inPlayer(node)&&safeForm(node));
    // Structure and timing help distinguish an empty app mount from an
    // unsupported question without exporting account text or input values.
    const rendering={readyState:document.readyState,visibilityState:document.visibilityState,
      bodyChildren:document.body?.childElementCount||0,inspectionDurationMs,
      appRoots:[...document.querySelectorAll('#root,#app,app-root,[data-reactroot],main')].slice(0,8).map(node=>({
        tag:node.tagName,kind:node.matches('#root')?'root':node.matches('#app')?'app':node.matches('main')?'main':'app-root',
        children:node.childElementCount,visible:visible(node)}))};
    return {ok:true,diagnostics:{version:'0.5.12',page:{url:cleanUrl(location.href)},stage:snapshot.stage,rendering,
      subjects:snapshot.subjects,lessons:snapshot.lessons.map(({href,...lesson})=>({...lesson,href:href?cleanUrl(href):undefined})),
      navigation:snapshot.navigation,issues:snapshot.diagnostics,frames:snapshot.frames,loading:snapshot.loading,
      ...(snapshot.questionEvidence?{questionEvidence:snapshot.questionEvidence}:{}),
      interactionStructure:interactionDiagnostics(snapshot),
      lastInteraction:lastDiagnosticInteraction?{operation:lastDiagnosticInteraction.operation,status:lastDiagnosticInteraction.status,
        durationMs:lastDiagnosticInteraction.durationMs??Math.max(0,Math.round(performance.now()-lastDiagnosticInteraction.startedAt)),cancelled}:null,
      questionControls:{visibleChoices:choices.length,nativeRadio:choices.filter(node=>node.matches('input[type="radio"]')).length,
        nativeCheckbox:choices.filter(node=>node.matches('input[type="checkbox"]')).length,
        semanticRadio:choices.filter(node=>node.matches('[role="radio"]')).length,
        semanticCheckbox:choices.filter(node=>node.matches('[role="checkbox"]')).length,
        playerScopes:all(PLAYER_SCOPES).map(node=>node.getAttribute('data-testid'))},
      controls:controls.slice(0,100).map(node=>({tag:node.tagName,role:node.getAttribute('role'),testId:node.getAttribute('data-testid'),
        classes:[...node.classList].slice(0,6),disabled:disabled(node),
        label:node.matches('button,[role="button"]')?clean(text(node)||node.getAttribute('aria-label')).slice(0,100):''}))}};
  }
  function handle(message){
    frameEntries=new Map();questionEvidence=null;topCourseContext=message.topCourseContext===true;settings(message.selectors);
    switch(message.type){
      case 'ALEF_SCAN':case 'ALEF_INSPECT':return inspect();
      case 'ALEF_DIAGNOSTICS':return diagnostics();
      case 'ALEF_GET_QUESTION':return readQuestion();
      case 'ALEF_GET_VISUALS':return getVisuals(message);
      case 'ALEF_BEGIN':cancelled=false;return {ok:true};
      case 'ALEF_PREPARE_QUESTION':assertNotCancelled();return prepareQuestion();
      case 'ALEF_CANCEL':cancelled=true;clearMathTargets();clearVisualTargets();return {ok:true};
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
    if(message.type==='ALEF_BEGIN')lastDiagnosticInteraction=null;
    const operation={ALEF_PREPARE_QUESTION:'prepare-question',ALEF_APPLY:'apply-answer',ALEF_GET_VISUALS:'capture-visuals'}[message.type];
    const record=operation?{operation,status:'running',startedAt:performance.now()}:null;
    if(record)lastDiagnosticInteraction=record;
    const finish=status=>{if(record){record.status=status;record.durationMs=Math.max(0,Math.round(performance.now()-record.startedAt));}};
    try{const result=handle(message);if(result?.then){result.then(value=>{finish(value?.ok===false?'failed':'succeeded');respond(value);},error=>{finish('failed');respond({ok:false,error:error.message||'تعذر التفاعل مع الصفحة.'});});return true;}finish(result?.ok===false?'failed':'succeeded');respond(result);}
    catch(error){finish('failed');respond({ok:false,error:error.message||'تعذر قراءة عناصر الصفحة.'});}return false;
  });
})();
