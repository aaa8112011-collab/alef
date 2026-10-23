import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createAppServer} from '../server/index.mjs';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

// Explicit deterministic provider answers test transport and interaction only.
// They do not benchmark a real model's interpretation of a geometry figure.
async function setup(t,language){
  const h=await createBrowserHarness();
  t.after(()=>h.close());
  await h.page.evaluate(language=>{
    const ar=language==='ar',main=document.createElement('main');
    document.body.replaceChildren(main);
    const state=window.multiDropdownIntegration={actions:[],submissions:[],decoyClicks:0,completed:false};
    const unknown=ar?'لا يمكن الاستنتاج':'Cannot conclude';
    const node=(tag,text='',attrs={})=>{const n=document.createElement(tag);n.textContent=text;for(const[k,v]of Object.entries(attrs))n.setAttribute(k,v);return n;};
    const subject=node('button',ar?'الرياضيات':'Math',{'data-alef-subject':'math'});main.append(subject);
    subject.onclick=()=>{
      history.replaceState(null,'','#/progress/ncle/class/integration/lesson/two-dropdowns/material/assessment');
      main.replaceChildren();
      const player=node('section','',{'data-testid':'ncle-activity-page-player'});
      const spinner=node('span','',{'role':'progressbar','aria-label':'background synchronization'});spinner.style.cssText='display:block;width:12px;height:12px;background:teal';
      const q=node('section','',{'data-alef-question':'inline-angle-and-triangles',class:'dropdown-container question-widget'});
      const statement=node('div','',{'data-testid':'question-statement-container'});
      statement.append(document.createTextNode(ar?'في الشكل المعطى، قياس الزاوية د هو ':'In the given figure, the measure of angle D is '));
      const submit=node('button',ar?'إرسال الإجابة':'Submit Answer',{'data-alef-submit':''});submit.disabled=true;
      const values=[null,null],choices=[['70°','65°',unknown],[ar?'متشابهان':'Similar',unknown,ar?'غير متشابهين':'Not similar']];
      function addDropdown(index){
        const blank=node('span','',{class:'dropdown-input-field-container','data-index':String(index)});blank.style.cssText='display:inline-block;padding:10px;border:1px solid gray;margin:5px';
        const control=node('span','',{class:'react-select__control'}),label=node('span','Select…',{class:'dropdown-single-value-content'});
        const input=node('input','',{id:'inline-field-'+index,role:'combobox',readonly:'','aria-expanded':'false','aria-controls':'inline-menu-'+index});input.style.width='1px';
        let menu=null,opening=false;
        const close=()=>{menu?.remove();menu=null;input.setAttribute('aria-expanded','false');state.actions.push({kind:'close',field:index});};
        const open=()=>{
          if(opening||menu)return;opening=true;input.setAttribute('aria-expanded','true');state.actions.push({kind:'open',field:index});
          setTimeout(()=>{
            opening=false;if(!input.isConnected||input.getAttribute('aria-expanded')!=='true')return;
            menu=node('div','',{role:'listbox',id:'inline-menu-'+index});menu.style.cssText='display:block;padding:8px;background:#fff;border:1px solid #aaa';
            for(const value of choices[index]){
              const option=node('div',value,{role:'option'});option.style.padding='8px';
              option.onclick=()=>{
                state.actions.push({kind:'select',field:index,value});
                setTimeout(()=>{label.textContent=value;values[index]=value;close();submit.disabled=values.some(value=>value===null);},110);
              };menu.append(option);
            }
            document.body.append(menu);
          },200);
        };
        input.onkeydown=event=>{if(event.key==='ArrowDown')open();if(event.key==='Escape')setTimeout(close,70);};control.onmousedown=open;
        control.append(label,input);blank.append(control);statement.append(blank);
      }
      addDropdown(0);statement.append(document.createTextNode(ar?' والمثلثان ':' and the triangles '));addDropdown(1);statement.append(document.createTextNode('.'));
      const canvas=document.createElement('canvas');canvas.width=260;canvas.height=180;canvas.setAttribute('aria-label',ar?'الرسم الهندسي':'geometry figure');
      const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,260,180);ctx.strokeStyle='black';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(20,150);ctx.lineTo(130,20);ctx.lineTo(235,150);ctx.closePath();ctx.stroke();ctx.beginPath();ctx.moveTo(75,85);ctx.lineTo(120,150);ctx.stroke();ctx.fillStyle='black';ctx.font='16px sans-serif';ctx.fillText('70°',125,55);ctx.fillText('45°',40,140);
      q.append(statement,canvas);player.append(spinner,q,submit);main.append(player);
      const decoy=node('div','',{role:'listbox',id:'unrelated-menu'});decoy.append(node('div',unknown,{role:'option'}));decoy.onclick=()=>state.decoyClicks++;document.body.append(decoy);
      submit.onclick=()=>{
        const actual=[...q.querySelectorAll('.dropdown-single-value-content')].map(n=>n.textContent);
        const valid=actual[0]==='70°'&&actual[1]===unknown&&values.every((value,index)=>value===actual[index]);
        state.submissions.push({actual,valid});state.actions.push({kind:'submit',valid});
        if(valid){state.completed=true;main.innerHTML='<section data-alef-completed>Completed</section>';decoy.remove();}
      };
    };
  },language);
  const chats=[],snapshots=[];
  const token='multi-dropdown-integration-fixture-token';
  const app=createAppServer({provider:'ollama',model:'qwen3:8b',visionModel:'qwen3-vl:8b',pairingToken:token,requestTimeoutMs:10000,healthTimeoutMs:1500,
    fetchImpl:async(url,options={})=>{
      if(url.endsWith('/api/tags'))return Response.json({models:[{name:'qwen3:8b'},{name:'qwen3-vl:8b'}]});
      if(url.endsWith('/api/show'))return Response.json({capabilities:['completion','vision']});
      assert.ok(url.endsWith('/api/chat'),url);
      const body=JSON.parse(options.body),sent=JSON.parse(body.messages[1].content);chats.push(body);
      assert.equal(body.model,'qwen3-vl:8b');assert.equal(sent.question.type,'dropdowns');assert.equal(sent.question.fields.length,2);
      assert.equal(body.messages[1].images.length,1);
      assert.deepEqual(Buffer.from(body.messages[1].images[0],'base64').subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
      const branches=body.format.properties.selections.items.anyOf;
      for(const field of sent.question.fields){
        const branch=branches.find(branch=>branch.properties.fieldId.enum[0]===field.id);assert.ok(branch);
        assert.deepEqual(branch.properties.optionId.enum,field.options.map(option=>option.id));
      }
      const selected=sent.question.fields.map((field,index)=>({fieldId:field.id,optionId:field.options.find(option=>option.text===(index===0?'70°':language==='ar'?'لا يمكن الاستنتاج':'Cannot conclude')).id}));
      // Independent verification must compare the mapping, not array order.
      if(chats.length===2)selected.reverse();
      return Response.json({message:{content:JSON.stringify({optionIds:[],text:'',selections:selected,confidence:.99,explanation:'Deterministic interaction fixture; not real geometry inference.'})}});
    }});
  await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise(resolve=>{app.close(resolve);app.closeAllConnections();}));
  const serverUrl=`http://127.0.0.1:${app.address().port}`,events=[],storage={};let listener;
  const chrome={runtime:{id:'fixture-extension',getURL:path=>'chrome-extension://fixture-extension/'+path,getPlatformInfo:async()=>({}),onMessage:{addListener(fn){listener=fn;}},sendMessage:async message=>events.push(structuredClone(message))},
    storage:{session:{get:async key=>({[key]:storage[key]}),set:async values=>Object.assign(storage,structuredClone(values)),remove:async key=>{delete storage[key];}}},
    tabs:{get:async()=>({id:1,url:h.page.url()}),sendMessage:async(_id,message)=>{const result=await h.send(message);if(result?.question)snapshots.push(structuredClone(result.question));return result;},onRemoved:{addListener(){}}},
    scripting:{executeScript:async()=>{}},action:{onClicked:{addListener(){}}}};
  vm.runInNewContext(await readFile(new URL('../extension/background.js',import.meta.url),'utf8'),{chrome,URL,AbortController,AbortSignal,DOMException,setTimeout,clearTimeout,setInterval,clearInterval,fetch});
  const send=message=>new Promise((resolve,reject)=>{if(!listener({tabId:1,...message},{id:'fixture-extension',url:'chrome-extension://fixture-extension/dashboard.html'},resolve))reject(Error('Worker refused request'));});
  t.after(()=>send({type:'STOP'}));
  return {h,chats,events,snapshots,send,start:async()=>{
    assert.equal((await send({type:'CONNECT'})).ok,true);
    const result=await send({type:'START',subjectId:'math',config:{serverUrl,token,qualityMode:true,verify:true,autoSubmit:true,skipInstruction:true,minConfidence:.85}});
    assert.equal(result.ok,true,JSON.stringify(result));
  }};
}

for(const language of ['ar','en'])test(`${language}: two inline owned dropdowns and graph reach verified solving and submit only after both selections`,async t=>{
  const h=await setup(t,language);await h.start();
  const deadline=Date.now()+18000;
  while(!h.events.some(item=>['complete','review','error'].includes(item.event?.kind))){if(Date.now()>deadline)assert.fail(JSON.stringify(h.events));await new Promise(resolve=>setTimeout(resolve,30));}
  const terminal=h.events.find(item=>['complete','review','error'].includes(item.event?.kind)).event;
  assert.equal(terminal.kind,'complete',JSON.stringify({terminal,events:h.events}));
  assert.equal(h.chats.length,2,'Both visual accuracy requests must preserve every inline field.');
  const sent=h.chats.map(chat=>JSON.parse(chat.messages[1].content).question);
  for(const question of sent){
    assert.equal(question.fields.length,2);assert.equal(question.requiresVision,true);
    assert.match(question.text,language==='ar'?/قياس الزاوية/:/measure of angle D/);
    for(const field of question.fields)assert.ok(question.text.includes('[dropdown:'+field.id+']'));
    const shared=question.fields[0].options.find(option=>option.text===(language==='ar'?'لا يمكن الاستنتاج':'Cannot conclude'));
    assert.ok(question.fields[1].options.some(option=>option.text===shared.text),'Repeated labels must stay associated with both original fields.');
  }
  assert.equal(h.chats[0].messages[1].images[0],h.chats[1].messages[1].images[0]);
  const actual=await h.h.page.evaluate(()=>window.multiDropdownIntegration);
  assert.equal(actual.completed,true);assert.deepEqual(actual.submissions,[{actual:['70°',language==='ar'?'لا يمكن الاستنتاج':'Cannot conclude'],valid:true}]);
  assert.equal(actual.decoyClicks,0);
  assert.deepEqual(actual.actions.filter(action=>action.kind==='select').map(action=>action.field),[0,1]);
  assert.equal(h.events.filter(item=>item.event?.kind==='submitted').length,1);
  assert.ok(h.snapshots.length>1);assert.equal(new Set(h.snapshots.map(question=>question.fingerprint)).size,1,'Opening or filling one menu must not change the prepared question identity.');
  const pixel=h.chats[0].messages[1].images[0];assert.equal(JSON.stringify(h.events).includes(pixel),false);
  assert.equal(h.events.some(item=>/30 ثانية|لم يكتمل تحميل/.test(item.event?.message||'')),false,'An incidental progress indicator must not hide a ready multi-dropdown question.');
});
