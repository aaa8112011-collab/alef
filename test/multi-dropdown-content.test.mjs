import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

async function mount(t,settings={}){
  const h=await createBrowserHarness();t.after(()=>h.close());
  await h.page.evaluate(settings=>{
    document.body.innerHTML='<main data-testid="ncle-activity-page"><div data-testid="assessment-content-player"><div data-testid="progress-bar-slide-count" role="progressbar" aria-valuenow="2" aria-valuemax="5">2/5</div><section data-alef-question="two-inline-dropdowns" class="dropdown-container question-widget"></section></div></main>';
    const section=document.querySelector('section');
    const state=window.multiDropdown={selected:[],submitted:[],opened:[],unrelated:0,menuActive:null,instance:10};
    const labels=settings.language==='ar'?[['٧٠°','لا يمكن التحديد'],['متشابهان','لا يمكن التحديد']]:[['70°','Cannot determine'],['Similar','Cannot determine']];
    state.labels=labels;
    const phrase=settings.language==='ar'?['في الشكل، قياس الزاوية D هو ',' والمثلثان ',' .']:['In the figure, angle D is ',' and the triangles are ',' .'];
    const prompt=document.createElement('p');
    const aggregate=document.createElement('span');aggregate.setAttribute('data-testid','selectableChoice');prompt.append(aggregate);
    section.append(prompt);
    const desired=[labels[0][0],labels[1][1]];
    const ready=()=>{submit.disabled=!state.selected[0]||!state.selected[1];};
    const fieldNodes=()=>[...section.querySelectorAll('select,[role="combobox"]')];
    const renderControl=(index,replacement=false)=>{
      const input=document.createElement('input');input.readOnly=true;input.setAttribute('role','combobox');input.setAttribute('aria-expanded','false');
      input.id=settings.remount?`react-select-${state.instance++}-input`:`authored-dropdown-${index}`;
      input.setAttribute('aria-controls',`owned-options-${index}`);
      const close=()=>{
        document.querySelector(`#owned-options-${index}`)?.remove();
        fieldNodes()[index]?.setAttribute('aria-expanded','false');state.menuActive=null;
      };
      input.onkeydown=event=>{
        if(event.key==='Escape'){setTimeout(close,60);return;}
        if(event.key!=='ArrowDown'||input.getAttribute('aria-expanded')==='true')return;
        if(state.menuActive!==null)throw new Error('The previous owned dropdown was not closed.');
        state.opened.push(index);state.menuActive=index;input.setAttribute('aria-expanded','true');
        setTimeout(()=>{
          const menu=document.createElement('div');menu.id=`owned-options-${index}`;menu.setAttribute('role','listbox');
          for(const label of labels[index]){
            const option=document.createElement('div');option.setAttribute('role','option');option.textContent=label;
            option.onclick=()=>setTimeout(()=>{
              const wrapper=section.querySelectorAll('.dropdown-input-field-container')[index];
              wrapper.querySelector('.dropdown-single-value-content').textContent=label;state.selected[index]=label;
              if(settings.corruptFirst&&index===1){state.selected[0]=labels[0][1];section.querySelector('.dropdown-single-value-content').textContent=labels[0][1];}
              if(settings.remount){
                for(const [position,current] of fieldNodes().entries()){
                  if(current.tagName==='INPUT')current.replaceWith(renderControl(position,true));
                }
              }
              setTimeout(()=>{close();ready();},60);
            },80);
            menu.append(option);
          }
          document.body.append(menu);
        },180);
      };
      if(replacement)input.setAttribute('aria-expanded','false');
      return input;
    };
    for(let index=0;index<2;index++){
      aggregate.append(document.createTextNode(phrase[index]));
      const wrapper=document.createElement('span');wrapper.className='dropdown-input-field-container';
      wrapper.style.cssText='display:inline-block;margin:8px;padding:8px;border:1px solid #ccc';
      if(settings.native||settings.mixed&&index===0){
        const select=document.createElement('select');select.id=`native-dropdown-${index}`;
        select.innerHTML='<option value="" disabled selected>Select…</option>';
        labels[index].forEach((label,position)=>{const option=document.createElement('option');option.value=`option-${position}`;option.textContent=label;select.append(option);});
        select.onchange=()=>{state.selected[index]=select.selectedOptions[0].textContent;ready();};wrapper.append(select);
      }else{
        const display=document.createElement('span');display.className='dropdown-single-value-content';display.textContent='Select…';wrapper.append(display,renderControl(index));
      }
      aggregate.append(wrapper);
    }
    aggregate.append(document.createTextNode(phrase[2]));
    const canvas=document.createElement('canvas');canvas.width=350;canvas.height=220;canvas.setAttribute('aria-label','Triangle ABC with angle B 70 degrees and angle A 45 degrees');
    const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,350,220);ctx.beginPath();ctx.moveTo(20,200);ctx.lineTo(180,20);ctx.lineTo(320,200);ctx.closePath();ctx.stroke();ctx.fillStyle='black';ctx.fillText('70°',170,50);ctx.fillText('45°',50,190);section.append(canvas);
    const submit=document.createElement('button');submit.setAttribute('data-alef-submit','');submit.textContent='Submit Answer';submit.disabled=true;
    submit.onclick=()=>state.submitted.push([...state.selected]);section.append(submit);
    const unrelated=document.createElement('div');unrelated.setAttribute('role','listbox');unrelated.innerHTML='<div role="option">70°</div><div role="option">Cannot determine</div>';
    unrelated.onclick=()=>state.unrelated++;document.body.append(unrelated);
    state.desired=desired;
  },settings);
  return h;
}
const answer=(q,desired)=>({optionIds:[],text:'',selections:q.fields.map((field,index)=>({fieldId:field.id,optionId:field.options.find(option=>option.text===desired[index]).id})),explanation:'Interaction fixture only',confidence:.99});
const apply=(h,q,value)=>h.send({type:'ALEF_APPLY',questionId:q.id,questionFingerprint:q.fingerprint,answer:value,autoSubmit:true});
async function prepare(h){const result=await h.send({type:'ALEF_PREPARE_QUESTION'});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.question?.type,'dropdowns',JSON.stringify(result));return result.question;}

for(const language of ['ar','en'])test(`${language}: two inline custom dropdowns preserve separate blanks, diagram and shared labels`,async t=>{
  const h=await mount(t,{language});const initial=await h.send({type:'ALEF_GET_QUESTION'});
  assert.equal(initial.needsPreparation,true);const q=await prepare(h);
  assert.equal(q.fields.length,2);assert.equal(q.requiresVision,true);assert.equal(q.visuals.length,1);
  for(const field of q.fields)assert.ok(q.text.includes(`[dropdown:${field.id}]`),q.text);
  assert.ok(q.text.indexOf(`[dropdown:${q.fields[0].id}]`)<q.text.indexOf(`[dropdown:${q.fields[1].id}]`));
  assert.equal(q.fields[0].options[1].id,q.fields[1].options[1].id,'Shared labels may repeat across field-scoped domains');
  const desired=await h.page.evaluate(()=>multiDropdown.desired);
  assert.equal((await apply(h,q,answer(q,desired))).submitted,true);
  const state=await h.page.evaluate(()=>multiDropdown);
  assert.deepEqual(state.submitted,[desired]);assert.equal(state.unrelated,0);assert.deepEqual(state.opened,[0,1,0,1]);
  const after=await h.send({type:'ALEF_GET_QUESTION'});assert.equal(after.question.fingerprint,q.fingerprint);
});

test('native dropdowns allow the same option ID in separate field domains and retain both selections',async t=>{
  const h=await mount(t,{native:true});const read=await h.send({type:'ALEF_GET_QUESTION'});const q=read.question;
  assert.equal(q.type,'dropdowns');assert.deepEqual(q.fields.map(field=>field.options.map(option=>option.id)),[['option-0','option-1'],['option-0','option-1']]);
  const desired=await h.page.evaluate(()=>multiDropdown.desired);
  assert.equal((await apply(h,q,answer(q,desired))).submitted,true);
  assert.deepEqual(await h.page.evaluate(()=>multiDropdown.submitted),[desired]);
});

test('a native and a delayed custom dropdown are prepared and applied independently',async t=>{
  const h=await mount(t,{mixed:true});const q=await prepare(h);const desired=await h.page.evaluate(()=>multiDropdown.desired);
  assert.equal((await apply(h,q,answer(q,desired))).submitted,true);
  assert.deepEqual(await h.page.evaluate(()=>multiDropdown.submitted),[desired]);
  assert.deepEqual(await h.page.evaluate(()=>multiDropdown.opened),[1,1]);
});

test('React Select remounts with fresh generated IDs preserve field identities and the full mapping',async t=>{
  const h=await mount(t,{remount:true});const q=await prepare(h);assert.deepEqual(q.fields.map(field=>field.id),['field-1','field-2']);
  const desired=await h.page.evaluate(()=>multiDropdown.desired);
  const result=await apply(h,q,answer(q,desired));assert.equal(result.submitted,true,JSON.stringify(result));
  const after=await h.send({type:'ALEF_GET_QUESTION'});assert.equal(after.question.fingerprint,q.fingerprint);
  assert.deepEqual(await h.page.evaluate(()=>multiDropdown.submitted),[desired]);
});

for(const variant of ['missing','duplicate','cross-field'])test(`${variant} mapping is rejected before any dropdown changes`,async t=>{
  const h=await mount(t);const q=await prepare(h);const desired=await h.page.evaluate(()=>multiDropdown.desired);const value=answer(q,desired);
  if(variant==='missing')value.selections.pop();
  else if(variant==='duplicate')value.selections[1].fieldId=value.selections[0].fieldId;
  else value.selections[0].optionId=q.fields[1].options[0].id;
  const result=await apply(h,q,value);assert.equal(result.ok,false,JSON.stringify(result));
  assert.deepEqual(await h.page.evaluate(()=>multiDropdown.selected),[]);assert.deepEqual(await h.page.evaluate(()=>multiDropdown.submitted),[]);
});

test('a later dropdown cannot silently overwrite the earlier selected blank and submit',async t=>{
  const h=await mount(t,{corruptFirst:true});const q=await prepare(h);const desired=await h.page.evaluate(()=>multiDropdown.desired);
  const result=await apply(h,q,answer(q,desired));assert.equal(result.ok,false,JSON.stringify(result));
  assert.deepEqual(await h.page.evaluate(()=>multiDropdown.submitted),[]);
});

test('STOP during the second delayed menu prevents all selection and submission',async t=>{
  const h=await mount(t);const pending=h.send({type:'ALEF_PREPARE_QUESTION'});
  await h.page.waitForFunction(()=>multiDropdown.opened.length===2);await h.send({type:'ALEF_CANCEL'});
  const result=await pending;assert.equal(result.ok,false,JSON.stringify(result));
  assert.deepEqual(await h.page.evaluate(()=>multiDropdown.selected),[]);assert.deepEqual(await h.page.evaluate(()=>multiDropdown.submitted),[]);
});

for(const changed of ['progress','diagram','authored-question'])test(`same text and field IDs re-prepare all menus after changing ${changed}`,async t=>{
  const h=await mount(t);const first=await prepare(h);
  await h.page.evaluate(changed=>{
    multiDropdown.labels[0][0]='65°';multiDropdown.labels[1][0]='Not similar';
    if(changed==='progress')document.querySelector('[data-testid="progress-bar-slide-count"]').textContent='3/5';
    if(changed==='diagram')document.querySelector('canvas').getContext('2d').fillRect(140,140,10,10);
    if(changed==='authored-question')document.querySelector('section').setAttribute('data-alef-question','new-authored-question');
  },changed);
  const pending=await h.send({type:'ALEF_GET_QUESTION'});assert.equal(pending.needsPreparation,true,JSON.stringify(pending));
  assert.equal(pending.question,null);const second=await prepare(h);
  assert.deepEqual(second.fields.map(field=>field.id),first.fields.map(field=>field.id));
  assert.equal(second.fields[0].options[0].text,'65°');assert.equal(second.fields[1].options[0].text,'Not similar');
  assert.deepEqual(await h.page.evaluate(()=>multiDropdown.opened),[0,1,0,1]);
});
