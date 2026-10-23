import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

const value=(optionIds=[],text='')=>({optionIds,text,explanation:'fixture answer',confidence:.99});
const apply=(h,q,answer,autoSubmit=true)=>h.send({type:'ALEF_APPLY',questionId:q.id,questionFingerprint:q.fingerprint,answer,autoSubmit});

async function mount(t,settings={}){
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(settings=>{
    document.body.innerHTML='<main></main>';
    const main=document.querySelector('main');
    const state=window.interactionUpgrade={submitted:[],selected:[],unrelated:0,opened:0,closed:0,committed:false,inputStarted:false,submittedBeforeCommit:false};
    let root=document;
    if(settings.shadow){const host=document.createElement('div');main.append(host);root=host.attachShadow({mode:'open'});}
    const owner=root===document?main:root;
    const section=document.createElement('section');section.setAttribute('data-alef-question','interaction-upgrade');owner.append(section);
    const prompt=document.createElement('h2');prompt.textContent=settings.language==='ar'?'اختر العدد اثنين أو اكتب الإجابة.':'Choose the number two or write the answer.';section.append(prompt);
    const submit=document.createElement('button');submit.setAttribute('data-alef-submit','');submit.textContent='Submit Answer';submit.disabled=true;
    const ready=()=>{submit.disabled=false;};
    if(settings.kind==='text'||settings.kind==='number'){
      const input=document.createElement('input');input.type=settings.kind==='number'?'number':'text';input.setAttribute('aria-label','Answer');
      if(settings.kind==='number'){input.min='0';input.max='10';input.step='.5';}
      section.append(input);
      input.oninput=()=>{
        state.inputStarted=true;
        if(settings.replace){
          setTimeout(()=>{const replacement=input.cloneNode();replacement.value=settings.clearReplacement?'':input.value;input.replaceWith(replacement);state.committed=true;ready();},110);
        }else {state.committed=true;ready();}
      };
      submit.onclick=()=>{if(!state.committed)state.submittedBeforeCommit=true;state.submitted.push(section.querySelector('input').value);};
    }else if(settings.kind==='native'){
      section.insertAdjacentHTML('beforeend','<select aria-label="Answer"><option value="" disabled>Choose</option><option value="two">2</option><option value="twelve">12</option></select>');
      if(settings.disabledGroup)section.querySelector('select').insertAdjacentHTML('beforeend','<optgroup label="unavailable" disabled><option value="locked">99</option></optgroup>');
      section.querySelector('select').onchange=()=>{
        state.inputStarted=true;
        const select=section.querySelector('select');
        if(settings.replace)setTimeout(()=>{const replacement=select.cloneNode(true);replacement.value=settings.clearReplacement?'':select.value;select.replaceWith(replacement);state.committed=true;ready();},110);
        else {state.committed=true;ready();}
      };
      submit.onclick=()=>{if(!state.committed)state.submittedBeforeCommit=true;state.submitted.push(section.querySelector('select').value);};
    }else{
      section.insertAdjacentHTML('beforeend','<span class="dropdown-input-field-container"><span class="dropdown-single-value-content">Choose</span><input readonly role="combobox" aria-expanded="false"></span>');
      const input=section.querySelector('input');
      if(!settings.ambiguous)input.setAttribute(settings.owns?'aria-owns':'aria-controls','owned-menu');
      if(settings.bothOwnedReferences)input.setAttribute('aria-owns','owned-menu');
      const close=()=>setTimeout(()=>{root.querySelector('#owned-menu')?.remove();root.querySelector('#second-new-menu')?.remove();input.setAttribute('aria-expanded','false');state.closed++;},90);
      const open=()=>{
        state.opened++;
        if(input.getAttribute('aria-expanded')==='true')return;
        input.setAttribute('aria-expanded','true');
        setTimeout(()=>{
          const menu=document.createElement('div');menu.id='owned-menu';menu.setAttribute('role','listbox');
          for(const label of settings.duplicate?['2','2']:['2','12']){
            const option=document.createElement('div');option.setAttribute('role','option');option.textContent=label;
            option.onclick=()=>{state.selected.push(label);setTimeout(()=>{section.querySelector('.dropdown-single-value-content').textContent=settings.wrongLabel?'12':label;close();ready();},110);};
            menu.append(option);
          }
          (root===document?document.body:root).append(menu);
          if(settings.ambiguous){const other=menu.cloneNode(true);other.id='second-new-menu';document.body.append(other);}
        },200);
      };
      input.onkeydown=event=>{if(event.key==='ArrowDown')open();if(event.key==='Escape')close();};
      submit.onclick=()=>state.submitted.push(section.querySelector('.dropdown-single-value-content').textContent);
      if(!settings.ambiguous){
        const unrelated=document.createElement('div');unrelated.setAttribute('role','listbox');unrelated.id=settings.shadow?'owned-menu':'unrelated-menu';
        unrelated.innerHTML='<div role="option">2</div><div role="option">12</div>';
        unrelated.onclick=()=>state.unrelated++;document.body.append(unrelated);
      }
    }
    if(settings.initialSubmitEnabled)submit.disabled=false;
    section.append(submit);
  },settings);
  return h;
}

async function read(h){const result=await h.send({type:'ALEF_GET_QUESTION'});assert.equal(result.ok,true,JSON.stringify(result));assert.ok(result.question,JSON.stringify(result));return result.question;}
async function prepared(h){const result=await h.send({type:'ALEF_PREPARE_QUESTION'});assert.equal(result.ok,true,JSON.stringify(result));assert.ok(result.question,JSON.stringify(result));return result.question;}

for(const language of ['en','ar'])test(`${language}: delayed readonly combobox uses only its owned portal and waits for selection and close`,async t=>{
  const h=await mount(t,{language});const q=await prepared(h);
  assert.deepEqual(q.options.map(row=>row.text),['2','12']);
  assert.equal(await h.page.locator('[role="combobox"]').getAttribute('aria-expanded'),'false');
  const result=await apply(h,q,value([q.options.find(row=>row.text==='2').id]));
  assert.equal(result.submitted,true,JSON.stringify(result));
  assert.deepEqual(await h.page.evaluate(()=>window.interactionUpgrade.submitted),['2']);
  assert.equal(await h.page.evaluate(()=>window.interactionUpgrade.unrelated),0);
  assert.equal((await read(h)).fingerprint,q.fingerprint);
});

test('shadow-root aria-owns resolves its own portal even when a document menu has the same ID',async t=>{
  const h=await mount(t,{shadow:true,owns:true});const q=await prepared(h);
  const result=await apply(h,q,value([q.options[0].id]));assert.equal(result.submitted,true,JSON.stringify(result));
  assert.deepEqual(await h.page.evaluate(()=>window.interactionUpgrade.submitted),['2']);
  assert.equal(await h.page.evaluate(()=>window.interactionUpgrade.unrelated),0);
});

test('aria-controls and aria-owns referencing the same listbox describe one menu',async t=>{
  const h=await mount(t,{bothOwnedReferences:true});const q=await prepared(h);
  const result=await apply(h,q,value([q.options[0].id]));assert.equal(result.submitted,true,JSON.stringify(result));
  assert.deepEqual(await h.page.evaluate(()=>window.interactionUpgrade.submitted),['2']);
});

test('two newly opened unowned portals are ambiguous and never select or submit',async t=>{
  const h=await mount(t,{ambiguous:true});const result=await h.send({type:'ALEF_PREPARE_QUESTION'});
  assert.equal(result.ok,false,JSON.stringify(result));assert.match(result.error,/قائمة|القائمة/);
  assert.deepEqual(await h.page.evaluate(()=>window.interactionUpgrade.submitted),[]);
});

test('duplicate labels in a custom dropdown are rejected before an answer can be applied',async t=>{
  const h=await mount(t,{duplicate:true});const result=await h.send({type:'ALEF_PREPARE_QUESTION'});
  assert.equal(result.ok,false,JSON.stringify(result));assert.deepEqual(await h.page.evaluate(()=>window.interactionUpgrade.selected),[]);
});

test('selecting 2 cannot acknowledge a rendered 12 or submit a partial label match',async t=>{
  const h=await mount(t,{wrongLabel:true});const q=await prepared(h);
  const result=await apply(h,q,value([q.options[0].id]));assert.equal(result.ok,false,JSON.stringify(result));
  assert.deepEqual(await h.page.evaluate(()=>window.interactionUpgrade.submitted),[]);
});

test('cancel during delayed portal opening never applies a late choice',async t=>{
  const h=await mount(t);const pending=h.send({type:'ALEF_PREPARE_QUESTION'});
  await h.page.waitForFunction(()=>window.interactionUpgrade.opened>0);
  await h.send({type:'ALEF_CANCEL'});const result=await pending;assert.equal(result.ok,false,JSON.stringify(result));
  assert.deepEqual(await h.page.evaluate(()=>window.interactionUpgrade.selected),[]);
});

for(const language of ['en','ar'])test(`${language}: text survives controlled input replacement before Submit becomes ready`,async t=>{
  const h=await mount(t,{kind:'text',replace:true,language});const q=await read(h);const text=language==='ar'?'أبوظبي':'Abu Dhabi';
  const result=await apply(h,q,value([],text));assert.equal(result.submitted,true,JSON.stringify(result));
  assert.deepEqual(await h.page.evaluate(()=>window.interactionUpgrade.submitted),[text]);
});

test('a framework-cleared replacement text field is rechecked at actual Submit and never submitted',async t=>{
  const h=await mount(t,{kind:'text',replace:true,clearReplacement:true});const q=await read(h);
  const result=await apply(h,q,value([],'answer'));assert.equal(result.ok,false,JSON.stringify(result));
  assert.match(result.error,/لم يؤكد الموقع إدخال نص صالح/);
  assert.deepEqual(await h.page.evaluate(()=>window.interactionUpgrade.submitted),[]);
});

for(const kind of ['text','native'])for(const clearReplacement of [false,true])test(`${kind}: already-enabled Submit waits through controlled replacement (${clearReplacement?'cleared':'retained'})`,async t=>{
  const h=await mount(t,{kind,replace:true,clearReplacement,initialSubmitEnabled:true});const q=await read(h);
  const result=await apply(h,q,kind==='text'?value([],'Abu Dhabi'):value(['two']));
  const state=await h.page.evaluate(()=>window.interactionUpgrade);
  if(clearReplacement){assert.equal(result.ok,false,JSON.stringify(result));assert.match(result.error,/لم يؤكد|لم يثبت/);assert.deepEqual(state.submitted,[]);}
  else {assert.equal(result.submitted,true,JSON.stringify(result));assert.deepEqual(state.submitted,[kind==='text'?'Abu Dhabi':'two']);}
  assert.equal(state.submittedBeforeCommit,false,'The native setter is not the controlled application acknowledgement');
});

for(const kind of ['text','native'])test(`${kind}: STOP during short field stability check prevents an already-enabled Submit`,async t=>{
  const h=await mount(t,{kind,initialSubmitEnabled:true});const q=await read(h);
  const pending=apply(h,q,kind==='text'?value([],'answer'):value(['two']));
  await h.page.waitForFunction(()=>window.interactionUpgrade.inputStarted);
  assert.equal((await h.send({type:'ALEF_CANCEL'})).ok,true);
  const result=await pending;assert.equal(result.ok,false,JSON.stringify(result));
  assert.deepEqual(await h.page.evaluate(()=>window.interactionUpgrade.submitted),[]);
});

for(const kind of ['text','native'])test(`locked ${kind} remains readable with stable identity until Try Again but cannot be applied`,async t=>{
  const h=await mount(t,{kind});const q=await read(h);
  await h.page.evaluate(()=>document.querySelector('input,select').disabled=true);
  const locked=await read(h);assert.equal(locked.id,q.id);assert.equal(locked.fingerprint,q.fingerprint);
  const result=await apply(h,q,kind==='text'?value([],'answer'):value(['two']));assert.equal(result.ok,false,JSON.stringify(result));
  assert.deepEqual(await h.page.evaluate(()=>window.interactionUpgrade.submitted),[]);
});

for(const readonly of ['native','aria'])test(`a ${readonly} readonly text answer remains readable but is never written`,async t=>{
  const h=await mount(t,{kind:'text'});const q=await read(h);await h.page.evaluate(readonly=>{const input=document.querySelector('input');if(readonly==='native')input.readOnly=true;else input.setAttribute('aria-readonly','true');},readonly);
  assert.equal((await read(h)).fingerprint,q.fingerprint);
  const result=await apply(h,q,value([],'answer'));assert.equal(result.ok,false,JSON.stringify(result));
  assert.equal(await h.page.locator('input').inputValue(),'');
});

test('native select applies its actual value and submits only that selection',async t=>{
  const h=await mount(t,{kind:'native'});const q=await read(h);const result=await apply(h,q,value(['two']));
  assert.equal(result.submitted,true,JSON.stringify(result));assert.deepEqual(await h.page.evaluate(()=>window.interactionUpgrade.submitted),['two']);
});

test('native select excludes disabled optgroup options and never applies their values',async t=>{
  const h=await mount(t,{kind:'native',disabledGroup:true});const q=await read(h);
  assert.deepEqual(q.options.map(row=>row.id),['two','twelve']);
  const result=await apply(h,q,value(['locked']));assert.equal(result.ok,false,JSON.stringify(result));
  assert.deepEqual(await h.page.evaluate(()=>window.interactionUpgrade.submitted),[]);
});

test('native number accepts Arabic digits and decimal separator after normalization',async t=>{
  const h=await mount(t,{kind:'number'});const q=await read(h);const result=await apply(h,q,value([],'٢٫٥'));
  assert.equal(result.submitted,true,JSON.stringify(result));assert.deepEqual(await h.page.evaluate(()=>window.interactionUpgrade.submitted),['2.5']);
});

for(const text of ['5 kg','20','2.3'])test(`native number rejects unsupported or invalid value ${text} without submission`,async t=>{
  const h=await mount(t,{kind:'number'});const q=await read(h);const result=await apply(h,q,value([],text));
  assert.equal(result.ok,false,JSON.stringify(result));assert.deepEqual(await h.page.evaluate(()=>window.interactionUpgrade.submitted),[]);
});
