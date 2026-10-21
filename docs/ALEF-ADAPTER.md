# ربط ألف في الإصدار 0.4.2

قُرئت الصفحة العامة `https://moe.alefed.com/` وملفات JavaScript التابعة لها بنجاح أثناء العمل الحالي. لم يُستخدم حساب طالب أو اتصال API خاص ولم تُستخرج جلسات دخول. العناصر التالية ملاحظة في الشفرة العامة المنشورة، وليست ادعاءً بتجربة حساب حقيقي:

- بطاقات المواد: `[data-testid="subject-card"]`، العنوان `[data-testid="subject-title"]`، ومعرّف `pathway-subject-cards-*`. تنتقل إلى `/pathways/classes/{classId}`.
- مستويات For You المعروضة: `[data-testid="levels-container"]` و`[data-testid^="level-card-container-"]` والعنوان `[data-testid="level-title"]`. لا ينتقل القارئ تلقائيًا إلى قسم NEXT LEVELS لفتح محتوى مستقبلي.
- أنشطة المستوى: `ul[aria-label="SkillList"]` وعناصر `li[aria-label="Skill"]` داخل غلاف يستقبل النقر.
- الشرح: `[data-testid="content-page"]` و`[data-testid="content-page-body-player"]`. الاختصار `#skill-player-practice` ينتقل إلى التدريب **المشترك للمستوى**؛ لذلك يدخل البرنامج نشاطًا واحدًا للوصول إليه، ثم ينتقل للمستوى التالي بعد اكتماله ولا يعيده لكل مهارة.
- الأسئلة: `[data-testid="question-renderer"]` مع رمز السؤال الفرعي. بطاقات `[data-testid="choice-item"]` تستقبل النقر. حقول radio/checkbox الأصلية مخفية؛ قراءة الاختيار المؤكد تعتمد على حالة `.choice.selected`.
- النص القرائي: `[data-testid="question-passage-content"]`، وتُفتح القطعة المطوية عند توفر زرها قبل طلب الحل. تُحفظ الحركات العربية.
- القوائم: select الأصلي، وcombobox/React Select الذي يعرض عناصر role=option عند فتحه. يدعم الإصدار قائمة واحدة في السؤال.
- المطابقة النصية: `matching-choice-*` و`matching-answer-*`؛ المكتبة توفر اختيار الزوج بالنقر أيضًا. الفراغات `fill-blank-dd-*` والكلمات `draggableChoice` توفر اختيار الكلمة ثم موضعها؛ يتطلب التطبيق إقرار الواجهة بالموضع قبل الإرسال.
- اكتمال تدريب Pathways عند نافذة Proficient ذات `[data-testid="go-super-pro-btn"]`. زر Continue Practice في ارتقاء المرحلة الوسيطة يعني المتابعة، ولا يُحسب وحده اكتمالًا.

مصادر الملاحظة: ملف الوحدة العامة `/student_pathways/__federation_expose_Module.4364567e258a482e.js` ومكوّن مكتبة الأسئلة `/student_pathways/4295.c5a798bbfabfa8af.js` والملفات العامة التابعة لهما. لم تُنسخ الحزم إلى المستودع؛ يحوي المشروع قارئًا مستقلًا واختبارات HTML مشتقة من بنية العناصر الملاحظة.

## واجهة المهام المسندة Core Coursework ومشغّل NCLE

أظهرت لقطة المستخدم صفحة المادة ذات تبويبات «صفحتي / المهام المسندة / جميع الدروس»، ومسارها من الشكل `/#/classes/{classId}?tab=forYou`. قُرئت ملفات الواجهة العامة وخرائط المصدر للمقاطع `2360` و`6654` و`492` و`3424` و`1654`. تؤكد مكوّنات `AssignedItemCard` و`AssignedTasksPanel` و`AssignedTab` و`AllLessonsTab` البنية التالية:

- تبويبا المهام وجميع الدروس: `core-coursework-assigned-tab-select` و`core-coursework-alllessons-tab-select`، وكل المحددات هنا تستخدم الخاصية `data-testid`.
- بطاقات «صفحتي» والمهام: `core-coursework-foryou-activity-card-navigate` و`core-coursework-assigned-activity-card-navigate`. العنوان داخل `h3[dir=ltr]`، والنقر يكون مرة واحدة على البطاقة أو زرها الداخلي `*-activity-btn-navigate`.
- «إظهار المزيد»: `core-coursework-foryou-showmore-btn-expand` و`core-coursework-assigned-showmore-btn-expand`.
- مرشحات المهام: `core-coursework-assigned-all-chip-filter` و`*-todo-chip-filter` و`*-overdue-chip-filter` و`*-completed-chip-filter`. مرشح To Do لا يشمل المتأخر؛ لذلك يستخدم المشغّل All ثم يستبعد المكتمل والمقفل من صفوف الدروس.
- بطاقات جميع الدروس: `core-coursework-alllessons-activity-card-navigate`، وعنوانها `div.body-lg-regular.line-clamp-2[dir=ltr]`. علامة `lock-icon` تعني قفلًا، و`in-review-label` تعني انتظار المراجعة. لا تُفتح هذه العناصر بالقوة.
- لا توفّر بطاقات المهام معرّف درس ثابتًا في DOM؛ يشتق القارئ هوية من العنوان والوجهة المرئية، ويزيل تكرار البطاقات المتجاوبة.

مشغّل الدروس من الشكل `/#/progress/ncle/class/{classId}/lesson/{lessonId}/material/...`:

- الصفحة `ncle-activity-page`؛ المحتويات `ncle-main-contents` وأزرارها `ncle-component-item`. العنصر الحالي يحمل `aria-current=step` والمكتمل علامة `ncle-component-item-completed`.
- التالي والإنهاء: `activity-navigation-bar__next-button` و`activity-navigation-bar__finish-button`. قد يكون نص التالي «Go to …»؛ لذلك لا يكفي البحث عن النص Next وحده. يدعم القارئ أيضًا `#alef-next-button` و`data-testid=next-button`.
- تأكيد تخطي الشرح: `skip-content-modal-leave-button`، وقد يكون العنصر div.
- العودة: `ncle-sidebar-back` و`ncle-completion-page-back`.
- `ncle-assessment-result` نتيجة قسم فقط. `ncle-completion-page` اكتمال الدرس كله.
- قد يكون زر المكوّن غير المعيّن غير معطّل برمجيًا، مع مظهر `text-primary-60` يؤدي إلى `ncle-lock-screen`. لا يستخدم المشغّل أزرار `ncle-component-item` اختصارًا للأسئلة؛ يتبع خطوات المحتوى بالترتيب، ولا يفتح المقفل.

يُقرأ مسار hash مع pathname لتحديد سياق الدرس وتغيّر الصفحة. لا تُحفظ معرّفات حساب المستخدم أو روابطه الخاصة في الشفرة أو بيانات الاختبار.

## تفعيل التبويبات في 0.4.1

أظهر تقرير المستخدم أن 0.4 يتعرّف على الصفحة لكنه يتوقف عند فتح تبويب المهام المسندة. في الحزمة العامة `7846.aca43159d49214d6.js`، الوحدة `10091`، يستخدم `TabsTrigger` من Radix حدث `onMouseDown` لزر الماوس الأساسي مع `ctrlKey=false` لاستدعاء تغيير التبويب، ولا يفعّله `onClick` وحده. لذلك لم يكن `HTMLElement.click()` كافيًا.

يرسل القارئ الآن تسلسل `mousedown → mouseup → click` إلى عناصر `role=tab` فقط، ويتحقق من اتصال العنصر وإتاحته بين الأحداث لأن React قد يستبدله عند الانتقال. تبقى أزرار الإجابة والإرسال والدروس على نقرة واحدة. يحاكي الاختبار الجديد عقد الأحداث المستخرج من المصدر؛ فشل قبل الإصلاح وبقي المسار `forYou`، ثم نجح بعده. لا يدّعي الاختبار تشغيل مكوّن Radix الأصلي أو حساب طالب حقيقي.

## التقدم داخل الدرس في 0.4.2

كشف تقرير المستخدم عن فتح دروس كثيرة مع صفر إرسال. كانت قائمة العامل الخلفي لا تحتفظ بخاصية `kind` للدرس، فيُقبل تغيّر تخطيط كتالوج Core Coursework قبل ظهور المشغّل ويُعامل كأنه قائمة أنشطة داخل المستوى. تُحفظ الخاصية الآن، وينتظر فتح المشغّل قبل معالجة السؤال. يتوقف التشغيل في الدرس الحالي عند تعذّر التطبيق أو غياب الإرسال أو انخفاض الثقة؛ تظل الدروس التالية بانتظار الحل. لا تُعرض المراجعات كتقدم مكتمل.

يتبع المشغّل خطوات محتوى NCLE بالترتيب، ولا يستخدم عناصر `ncle-component-item` للقفز إلى التقييم. تُستخدم أزرار Start وNext وI’ll try later المتاحة، ثم تُحل الأسئلة المدعومة وتُرسل تلقائيًا عند تفعيل الإرسال. لا يُحسب `ncle-assessment-result` اكتمالًا لكل الدرس.

تستخدم أسئلة Weaver الجديدة `.mcq-container.question-widget` وحاوية `question-statement-container` بجانب مجموعة الخيارات. قراءة `radiogroup` وحدها تفقد نص المسألة وتُبقي عبارة التعليمات العامة. وتضيف الواجهة كلمة Selected إلى الوصف الصوتي للخيار بعد اختياره؛ يجب اشتقاق معرّف الخيار ونصه من المحتوى الثابت، وقراءة `aria-checked` لإقرار الاختيار، دون إدخال وصف الحالة المتغيّر في بصمة السؤال. يُنتظر إقرار الاختيار وإتاحة زر الإرسال دون إعادة ضغط الإرسال.

قُرئت هذه البنية من المصادر العامة `weaver-player-mfe/3834.c21fd9a92463b040.js.map` للاختيار، و`4765.c7c2900bb39fb2ec.js.map` لأزرار الانتقال، و`6758.ee8dd72912395f92.js.map` للقوائم، و`2943.a7f5d28e78b16371.js.map` للسحب، و`3698.ca979170463b4362.js.map` و`6810.1827b7b0438b19d2.js.map` للكتابة. لم تُضمَّن هذه الحزم في المشروع.

يدعم القارئ قائمة Weaver واحدة داخل `.dropdown-container.question-widget` مع خيارات `role=option` التي قد تظهر في body، ويحافظ على بصمة ثابتة للفراغ قبل الاختيار وبعده. يدعم textarea في `.open-ended-container.question-widget` وحقلًا أصليًا واحدًا في `.fib-container.question-widget`. محرر `math-field` وعدة قوائم أو عدة حقول تحتاج ربطًا آخر وتتوقف للمراجعة.

في السحب النصي داخل `.dnd-container.question-widget`، يربط القارئ `.dnd-options-draggable` بالفراغ `.dnd-droppable[data-index]`. يستخدم مصدر المنصة DndKit MouseSensor بمهلة تفعيل 100ms؛ تُرسل حركة ماوس محدودة بعد الانتظار، ويُطلب إقرار بدء السحب وموضع الإسقاط وثبات النص في الفراغ قبل الإرسال. لا تعمل أحداث HTML DragEvent وحدها مع هذا النوع. تبقى الصور وترتيبات السحب الخاصة والكلمات المتكررة غير المميَّزة خارج هذا الربط. يميز عدّاد `progress-bar-slide-count` الشرائح المتجاورة المتشابهة.

تعرض مساحة الإجابة المادة والدرس وحالة الاقتراح أو الإرسال. يُزال الجواب السابق عند فتح سؤال أو درس جديد؛ يحمل سجل الأحداث سياق الدرس كي لا تختلط الإجابات.

الاختبارات لا تنفّذ تقييم ألف الحقيقي ولا تثبت دقة النموذج المحلي. لا يتجاوز البرنامج قفل الدرس أو متطلب مشاهدة إلزامي بدون زر تخطٍ متاح. تغيّر إصدار المنصة أو وجود إطار من نطاق آخر أو نوع سؤال غير مدعوم يظهر كتقرير تشخيص أو درس يحتاج مراجعة.
