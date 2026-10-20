(() => {
  'use strict';
  if (globalThis.__alefAssistantInstalled) return;
  globalThis.__alefAssistantInstalled = true;

  let selectors = {};
  let subjects = new Map();
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const hash = text => {
    let n = 2166136261;
    for (const c of text) n = Math.imul(n ^ c.charCodeAt(0), 16777619);
    return (n >>> 0).toString(36);
  };
  const visible = el => el instanceof Element && !el.closest('[hidden],[aria-hidden="true"],[inert]') &&
    getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' &&
    (el.getClientRects().length > 0);
  const all = (query, scope = document) => [...scope.querySelectorAll(query)].filter(visible);
  function text(el) {
    if (!el) return '';
    // Preserve fraction/exponent structure instead of flattening rendered math or
    // reading both KaTeX's visual and accessibility copies of the same formula.
    if (!el.matches?.('.katex,math,mjx-container') && !el.querySelector?.('.katex,math,mjx-container')) {
      return clean(el.innerText || el.textContent || el.getAttribute('aria-label'));
    }
    function read(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent;
      if (!(node instanceof Element)) return '';
      if (node.matches('.katex,math,mjx-container')) {
        const latex = node.querySelector('annotation[encoding="application/x-tex"]');
        if (latex?.textContent.trim()) return ` $${latex.textContent.trim()}$ `;
        const math = node.matches('math') ? node : node.querySelector('math');
        if (math) return ` ${math.outerHTML} `;
        const label = node.getAttribute('aria-label');
        if (label) return ` ${label} `;
        throw new Error('الصيغة الرياضية مرسومة دون نص قابل للقراءة؛ راجع السؤال يدويًا.');
      }
      if (node.matches('[hidden],[aria-hidden="true"],script,style') || getComputedStyle(node).display === 'none') return '';
      return [...node.childNodes].map(read).join('');
    }
    return clean(read(el));
  }
  function settings(next) {
    if (!next) return;
    for (const [name, value] of Object.entries(next)) {
      if (!['subject', 'question', 'option', 'submit', 'next', 'completed'].includes(name)) continue;
      if (typeof value !== 'string' || value.length > 600) throw new Error('محدد الصفحة غير صالح.');
      if (value) document.querySelector(value);
    }
    selectors = {...selectors, ...next};
  }
  function button(kind) {
    const explicit = selectors[kind] || `[data-alef-${kind}]`;
    const matches = all(explicit).filter(el => !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    if (matches.length > 1) throw new Error('توجد أزرار متشابهة؛ اضبط محدد زر ' + (kind === 'submit' ? 'الإرسال.' : 'التالي.'));
    if (matches.length) return matches[0];
    if (selectors[kind]) return null;
    const patterns = kind === 'submit'
      ? /^(تحقق|تحقّق|تحقق من الإجابة|تحقّق من الإجابة|إرسال|ارسال|submit|check|check answer)$/i
      : /^(التالي|التالى|السؤال التالي|متابعة|next|next question|continue)$/i;
    const fallback = all('button,[role="button"],input[type="submit"]').filter(el =>
      !el.disabled && el.getAttribute('aria-disabled') !== 'true' && patterns.test(clean(text(el) || el.value)));
    if (fallback.length > 1) throw new Error('زر الانتقال غير واضح؛ اضبط محدد الصفحة أولًا.');
    return fallback[0] || null;
  }
  function scan() {
    subjects = new Map();
    let nodes = all(selectors.subject || '[data-alef-subject]');
    if (!nodes.length && !selectors.subject) {
      nodes = all('a[href],button,[role="button"]').filter(el => {
        const label = text(el);
        const href = el.getAttribute('href') || '';
        return label.length > 1 && label.length < 100 &&
          (/\/(subjects?|courses?)\//i.test(href) || /^(الرياضيات|العلوم|اللغة العربية|اللغة الإنجليزية|الدراسات الاجتماعية|التربية الإسلامية|الفيزياء|الكيمياء|الأحياء|mathematics|math|science|english|arabic)$/i.test(label));
      });
    }
    for (const node of nodes) {
      const name = clean(node.getAttribute('data-subject-name') || text(node));
      if (!name) continue;
      const id = node.getAttribute('data-alef-subject') || node.getAttribute('data-subject-id') ||
        `subject-${hash((node.getAttribute('href') || '') + name)}`;
      if (subjects.has(id)) continue;
      subjects.set(id, {id, name, node});
    }
    // An open exercise is a usable entry point even when the course menu is absent.
    if (!subjects.size) subjects.set('current', {id:'current', name:'المادة المفتوحة حاليًا', node:null});
    return {
      ok:true,
      page:{title:document.title, url:location.href},
      subjects:[...subjects.values()].map(({id,name}) => ({id,name})),
      capabilities:{text:true, single:true, multiple:true, images:false, dragAndDrop:false, customSelectors:true},
    };
  }
  function questionContainer() {
    const explicit = selectors.question || '[data-alef-question],[data-question-id]';
    let found = all(explicit);
    if (!found.length && !selectors.question) {
      found = all('fieldset,[role="radiogroup"],[role="group"][aria-labelledby]').filter(el =>
        el.querySelector('input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"],textarea,[data-alef-answer]'));
      // A nested radiogroup belongs to its enclosing fieldset, not a second question.
      found = found.filter(el => !found.some(other => other !== el && other.contains(el)));
    }
    if (found.length > 1) throw new Error('توجد عدة أسئلة ظاهرة. افتح سؤالًا واحدًا أو اضبط محدد السؤال.');
    return found[0] || null;
  }
  function optionNodes(container) {
    const marked = all(selectors.option || '[data-alef-option]', container);
    if (marked.length) return marked;
    return all('input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"]', container);
  }
  function describeOption(node) {
    const control = node.matches('input,[role="radio"],[role="checkbox"]') ? node :
      node.querySelector('input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"]') || node;
    const label = node.matches('input')
      ? clean([...node.labels || []].map(text).join(' ') || node.getAttribute('aria-label') || node.value)
      : text(node);
    const id = node.getAttribute('data-alef-option') || control.getAttribute('data-option-id') ||
      control.id || (control.value && control.value !== 'on' ? control.value : '') || `option-${hash(label)}`;
    return {id, text:label, node, control};
  }
  function readQuestion() {
    const completed = all(selectors.completed || '[data-alef-completed]').length > 0;
    if (completed) return {ok:true,question:null,completed:true,canNext:false};
    const container = questionContainer();
    if (!container) return {ok:true,question:null,completed:false,canNext:!!button('next')};
    const images = all('img:not([role="presentation"]),canvas', container);
    if (images.length) throw new Error('السؤال يحتوي على صورة أو رسم؛ يحتاج مراجعة يدوية لأن قارئ الصفحة يدعم النص فقط.');
    const options = optionNodes(container).map(describeOption);
    if (options.some(item => !item.text) || new Set(options.map(item=>item.id)).size !== options.length) {
      throw new Error('نص الخيارات أو معرفاتها غير واضح؛ اضبط محدد الخيارات.');
    }
    let prompt = text(container.querySelector('[data-alef-question-text],legend,h1,h2,h3,h4,[role="heading"]'));
    if (!prompt && container.getAttribute('aria-labelledby')) {
      prompt = clean(container.getAttribute('aria-labelledby').split(/\s+/).map(id => text(document.getElementById(id))).join(' '));
    }
    if (!prompt) {
      const copy = container.cloneNode(true);
      copy.querySelectorAll('button,input,textarea,select,[data-alef-option],[role="radio"],[role="checkbox"],label').forEach(el=>el.remove());
      prompt = text(copy);
    }
    if (!prompt) throw new Error('لم أجد نص السؤال. اضبط محدد السؤال ليتضمن النص والخيارات.');
    const textInputs = all('textarea,[data-alef-answer],input[type="text"],input[type="number"],input:not([type])',container)
      .filter(el => el.matches('input,textarea'));
    let type;
    if (options.length) {
      const types = new Set(options.map(({control}) => control.type || control.getAttribute('role')));
      if (types.size > 1 || ![...types].every(t=>['radio','checkbox'].includes(t))) {
        throw new Error('نوع خيارات السؤال غير مدعوم؛ حدد عناصر radio أو checkbox بوضوح.');
      }
      type = [...types][0] === 'checkbox' ? 'multiple' : 'single';
    } else if (textInputs.length === 1) type = 'text';
    else throw new Error('هذا السؤال يحتاج تفاعلًا غير مدعوم مثل السحب أو المطابقة، أو أن عناصره غير واضحة.');
    const fingerprint = hash(JSON.stringify([prompt,type,options.map(({id,text})=>[id,text])]));
    const id = container.getAttribute('data-alef-question') || container.getAttribute('data-question-id') || `question-${fingerprint}`;
    return {ok:true,question:{id,text:prompt,type,options:options.map(({id,text})=>({id,text})),fingerprint},completed:false,canNext:!!button('next')};
  }
  function setValue(control,value) {
    const proto = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(control,value);
    control.dispatchEvent(new Event('input',{bubbles:true}));
    control.dispatchEvent(new Event('change',{bubbles:true}));
  }
  function apply(message) {
    const snapshot = readQuestion();
    if (!snapshot.question || snapshot.question.id !== message.questionId ||
      (message.questionFingerprint && snapshot.question.fingerprint !== message.questionFingerprint)) {
      throw new Error('تغير السؤال أثناء الحل. لم تُطبّق الإجابة؛ أعد قراءة الصفحة.');
    }
    const {question} = snapshot;
    const answer = message.answer;
    const container = questionContainer();
    if (!answer || !Array.isArray(answer.optionIds)) throw new Error('صيغة الإجابة غير صالحة.');
    if (question.type === 'text') {
      if (typeof answer.text !== 'string' || !clean(answer.text) || answer.text.length > 12000 || answer.optionIds.length) throw new Error('الإجابة النصية غير صالحة.');
      const inputs = all('textarea,[data-alef-answer],input[type="text"],input[type="number"],input:not([type])',container)
        .filter(el=>el.matches('input,textarea') && !el.disabled);
      if (inputs.length !== 1) throw new Error('حقل الإجابة غير واضح.');
      setValue(inputs[0],answer.text);
      const after = readQuestion();
      if (!after.question || after.question.id !== question.id || after.question.fingerprint !== question.fingerprint) {
        throw new Error('تغير السؤال بعد إدخال النص. لم يُضغط زر الإرسال.');
      }
      const currentInputs = all('textarea,[data-alef-answer],input[type="text"],input[type="number"],input:not([type])',questionContainer())
        .filter(el=>el.matches('input,textarea') && !el.disabled);
      if (currentInputs.length !== 1 || currentInputs[0].value !== answer.text) {
        throw new Error('لم يؤكد الموقع إدخال النص؛ أوقف الإرسال لمراجعته.');
      }
    } else {
      const ids = new Set(answer.optionIds);
      if (!ids.size || ids.size !== answer.optionIds.length || (question.type === 'single' && ids.size !== 1) ||
        [...ids].some(id=>!question.options.some(option=>option.id===id))) throw new Error('الاختيارات الواردة لا تطابق خيارات السؤال.');
      const options = optionNodes(container).map(describeOption);
      if (options.some(({control})=>control.disabled || control.getAttribute('aria-disabled') === 'true')) throw new Error('خيارات السؤال معطلة أو سبق إرسالها.');
      for (const option of options) {
        const wanted = ids.has(option.id);
        const checked = option.control.matches('input') ? option.control.checked : option.control.getAttribute('aria-checked') === 'true';
        if (wanted !== checked && (question.type === 'multiple' || wanted)) option.control.click();
      }
      // UI frameworks may reject programmatic clicks or replace the question while it changes.
      const after = readQuestion();
      if (!after.question || after.question.id !== question.id || after.question.fingerprint !== question.fingerprint) throw new Error('تغير السؤال بعد اختيار الإجابة. لم يُضغط زر الإرسال.');
      const selected = optionNodes(questionContainer()).map(describeOption).filter(({control})=>
        control.matches('input') ? control.checked : control.getAttribute('aria-checked') === 'true').map(({id})=>id);
      if (selected.length !== ids.size || selected.some(id=>!ids.has(id))) throw new Error('لم يؤكد الموقع اختيار الإجابة؛ أوقف الإرسال لمراجعتها.');
    }
    let submitted = false;
    if (message.autoSubmit) {
      const submit = button('submit');
      if (!submit) return {ok:true,applied:true,submitted:false,reason:'لم يظهر زر إرسال واضح. راجع الإجابة ثم أرسلها يدويًا.'};
      submit.click();
      submitted = true;
    }
    return {ok:true,applied:true,submitted};
  }
  function handle(message) {
    settings(message.selectors);
    switch(message.type) {
      case 'ALEF_SCAN': return scan();
      case 'ALEF_SELECT_SUBJECT': {
        if (!subjects.size) scan();
        const subject = subjects.get(message.subjectId);
        if (!subject) throw new Error('المادة المحددة لم تعد ظاهرة؛ أعد فحص الصفحة.');
        if (subject.node) {
          if (!subject.node.isConnected || !visible(subject.node)) throw new Error('المادة لم تعد ظاهرة؛ أعد فحص الصفحة.');
          if (subject.node.matches('a[href]')) {
            const destination = new URL(subject.node.href,location.href);
            if (destination.origin !== location.origin) throw new Error('رابط المادة ينتقل إلى موقع آخر؛ افتحه يدويًا أولًا.');
          }
          subject.node.click();
        }
        return {ok:true,selected:true};
      }
      case 'ALEF_GET_QUESTION': return readQuestion();
      case 'ALEF_APPLY': return apply(message);
      case 'ALEF_NEXT': {
        const next = button('next');
        if (next) next.click();
        return {ok:true,clicked:!!next};
      }
      default: return null;
    }
  }
  chrome.runtime.onMessage.addListener((message,sender,respond) => {
    if (sender.id !== chrome.runtime.id || !message?.type?.startsWith('ALEF_')) return;
    try { respond(handle(message)); }
    catch (error) { respond({ok:false,error:error.message || 'تعذر قراءة عناصر الصفحة.'}); }
    return false;
  });
})();
