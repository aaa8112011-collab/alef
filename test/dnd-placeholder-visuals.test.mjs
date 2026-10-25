import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

// Published Weaver DEFAULT and K4 blanks use the same drop-placeholder-icon
// IMG class with different assets. Those controls are not authored evidence.
async function setup(t,{language='ar',layout='DEFAULT',legacy=false,authoredImage=null}={}){
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(async({language,layout,legacy,authoredImage})=>{
    const w=word=>legacy?word:'lib-'+word;
    const ar=language==='ar';document.documentElement.dir=ar?'rtl':'ltr';
    document.body.innerHTML=`<main id="player-container"><div data-testid="ncle-activity-page-player">
      <div data-testid="progress-bar-slide-count">1/5</div>
      <section class="${w('dnd-container')} ${w('question-widget')}">
        <h2>${ar?'اقرأ العبارة ثم اسحب كلمتين إلى الفراغين.':'Read the statement and drag two words into the blanks.'}</h2>
        <p>${ar?'نوع التعبير':'Expression type'} <span class="${w('dnd-droppable')}" id="droppable-0" data-index="0" style="display:inline-block;width:150px;height:45px;border:1px solid"><span class="${w('placeholder-wrapper')}"></span></span>
          ${ar?'والعنصر المقصود':'and the named element'} <span class="${w('dnd-droppable')}" id="droppable-1" data-index="1" style="display:inline-block;width:150px;height:45px;border:1px solid"><span class="${w('placeholder-wrapper')}"></span></span>.</p>
        <div class="${w('dnd-options-wrapper')}"></div>
      </section><button disabled>${ar?'أرسل إجابتي':'Submit Answer'}</button>
    </div></main>`;
    const labels=ar?['المُشَبَّهُ','استعارة مكنية','أداة الشبه','استعارة تصريحية','المُشَبَّهُ به','تشبيه بليغ','وجه الشبه']:
      ['subject','implicit metaphor','comparison tool','explicit metaphor','comparison target','concise simile','shared attribute'];
    for(const label of labels){
      const choice=document.createElement('div');choice.className=w('dnd-options-draggable');choice.textContent=label;
      document.querySelector('.'+w('dnd-options-wrapper')).append(choice);
    }
    const source=(color,shape)=>'data:image/svg+xml,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><${shape} ${shape==='rect'?'x="3" y="3" width="18" height="18"':'cx="12" cy="12" r="8"'} fill="${color}"/></svg>`);
    if(authoredImage){
      const image=new Image(20,20);image.alt='Required authored miniature';image.src=source('blue','circle');
      const parent=authoredImage==='inside'?document.querySelector('#droppable-0'):document.querySelector('section');
      parent.append(image);await image.decode();
    }
    window.addPublishedDragPlaceholders=async()=>{
      for(const wrapper of document.querySelectorAll('.'+w('placeholder-wrapper'))){
        const image=new Image(24,24);image.className=w('drop-placeholder-icon');
        image.src=layout==='K4'?source('#506070','rect'):source('#607080','circle');
        if(layout==='K4'){
          const inner=document.createElement('div');inner.className=w('placeholder-inner-wrapper');inner.append(image);wrapper.append(inner);
        }else{wrapper.append(image);const label=document.createElement('p');label.textContent='Drop Here';wrapper.append(label);}
        await image.decode();
      }
    };
  },{language,layout,legacy,authoredImage});
  const read=async()=>{
    const result=await h.send({type:'ALEF_GET_QUESTION'});assert.equal(result.ok,true,JSON.stringify(result));
    assert.equal(result.question?.type,'matching',JSON.stringify(result));
    assert.equal(result.question.items.length,2);assert.equal(result.question.targets.length,7);
    assert.deepEqual(result.question.options,[]);return result.question;
  };
  return {h,read};
}

for(const language of ['ar','en'])for(const layout of ['DEFAULT','K4'])test(`${language}: published ${layout} drag placeholders are not vision evidence and keep both blank bindings stable`,async t=>{
  const {h,read}=await setup(t,{language,layout}),before=await read();
  assert.equal(before.requiresVision,undefined);assert.equal(before.visuals,undefined);
  await h.page.evaluate(()=>window.addPublishedDragPlaceholders());
  const after=await read();
  assert.equal(after.requiresVision,undefined,'Drop controls must not select the vision model for a text-only matching question');
  assert.equal(after.visuals,undefined);assert.equal(after.id,before.id);assert.equal(after.fingerprint,before.fingerprint);
  assert.equal(after.text,before.text);assert.deepEqual(after.items,before.items);assert.deepEqual(after.targets,before.targets);
  assert.ok(after.text.includes('[blank:0]'));assert.ok(after.text.includes('[blank:1]'));
});

for(const layout of ['DEFAULT','K4'])test(`legacy ${layout} drop-placeholder-icon keeps a text-only Arabic drag question`,async t=>{
  const {h,read}=await setup(t,{layout,legacy:true}),before=await read();
  await h.page.evaluate(()=>window.addPublishedDragPlaceholders());const after=await read();
  assert.equal(after.requiresVision,undefined);assert.equal(after.visuals,undefined);
  assert.equal(after.id,before.id);assert.equal(after.fingerprint,before.fingerprint);assert.deepEqual(after.targets,before.targets);
});

for(const placement of ['inside','outside'])test(`a genuine 20px authored image ${placement} a drag blank remains required while placeholder icons are excluded`,async t=>{
  const {h,read}=await setup(t,{authoredImage:placement}),before=await read();
  assert.equal(before.requiresVision,true);assert.equal(before.visuals.length,1);
  assert.equal(before.visuals[0].alt,'Required authored miniature');
  await h.page.evaluate(()=>window.addPublishedDragPlaceholders());const after=await read();
  assert.equal(after.requiresVision,true);assert.deepEqual(after.visuals,before.visuals);
  assert.equal(after.id,before.id);assert.equal(after.fingerprint,before.fingerprint);
});
