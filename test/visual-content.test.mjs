import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createBrowserHarness} from '../scripts/test-browser.mjs';

async function mount(t,{language='en',kind='img',outside=false,decorative=false,broken=false,count=1}={}) {
  const h=await createBrowserHarness();
  t.after(()=>h.close());
  await h.page.evaluate(async({language,kind,outside,decorative,broken,count})=>{
    const statement=language==='ar'
      ? 'الشكل أ′ب′ج′د′ ناتج تمدد للشكل أبجد ومركزه نقطة الأصل. ما معامل التمدد في الرسم البياني؟'
      : 'Figure A′B′C′D′ is a dilation of figure ABCD centered at the origin. What is the scale factor in the graph?';
    document.body.innerHTML='<main><section data-testid="ncle-activity-page"><article data-testid="ncle-activity-page-player"><div class="mcq-container question-widget" data-alef-question="dilation-question"><div data-testid="question-statement-container"></div><div role="radiogroup"><div data-testid="mcq-option-container" role="radio" aria-checked="false" aria-describedby="option-first-content"><span data-testid="mcq-item-label" id="option-first-content">1.5</span></div><div data-testid="mcq-option-container" role="radio" aria-checked="false" aria-describedby="option-second-content"><span data-testid="mcq-item-label" id="option-second-content">2</span></div></div></div><button>Submit answer</button></article></section></main>';
    const widget=document.querySelector('.question-widget');
    const statementNode=document.querySelector('[data-testid="question-statement-container"]');
    statementNode.textContent=statement;
    const scope=outside?document.querySelector('[data-testid="ncle-activity-page-player"]'):statementNode;
    if(outside){
      const context=document.createElement('p');
      context.setAttribute('data-alef-question-context','');
      context.textContent=language==='ar'?'اقرأ الإحداثيات من الشكل المقابل.':'Read the coordinates in the accompanying figure.';
      scope.insertBefore(context,widget);
    }
    function graph(index=0){
      const c=document.createElement('canvas');c.width=300;c.height=180;
      const ctx=c.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,300,180);
      ctx.strokeStyle='#ddd';
      for(let x=0;x<300;x+=20){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,180);ctx.stroke();}
      for(let y=0;y<180;y+=20){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(300,y);ctx.stroke();}
      ctx.fillStyle=index?'#b82040':'#005adc';ctx.fillRect(30+index,40,80,60);
      ctx.strokeStyle='#222';ctx.beginPath();ctx.moveTo(10,170);ctx.lineTo(290,170);ctx.moveTo(10,170);ctx.lineTo(10,5);ctx.stroke();
      ctx.fillStyle='black';ctx.font='15px sans-serif';ctx.fillText('E (2, 4)',130,40);ctx.fillText("E′ (3, 6)",130,70);
      return c;
    }
    const pending=[];
    for(let index=0;index<count;index++){
      let visual;
      if(kind==='canvas'){
        visual=graph(index);visual.setAttribute('aria-label','Coordinate diagram');
      }else if(kind==='svg'){
        const wrap=document.createElement('div');
        wrap.innerHTML='<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Coordinate diagram" width="300" height="180" viewBox="0 0 300 180"><rect width="300" height="180" fill="white"/><rect x="30" y="40" width="80" height="60" fill="#005adc"/><path d="M 10 5 V 170 H 290" stroke="black" fill="none"/><text x="130" y="40">E (2, 4)</text><text x="130" y="70">E′ (3, 6)</text></svg>';
        visual=wrap.firstElementChild;
      }else if(kind==='background'){
        visual=document.createElement('div');visual.style.cssText='width:300px;height:180px;background-size:100% 100%';
        visual.style.backgroundImage=`url("${graph(index).toDataURL('image/png')}")`;
        visual.setAttribute('role','img');visual.setAttribute('aria-label','Coordinate diagram');
      }else{
        visual=document.createElement('img');visual.width=300;visual.height=180;visual.alt='Coordinate diagram';
        visual.src=broken?'data:image/png;base64,invalid':graph(index).toDataURL('image/png');
        pending.push(new Promise(resolve=>{if(visual.complete)resolve();else{visual.onload=resolve;visual.onerror=resolve;}}));
      }
      visual.classList.add('authored-graph');
      if(outside)scope.insertBefore(visual,widget);else scope.append(visual);
    }
    if(decorative){
      const icons=document.createElement('span');icons.className='mcq-icon-container';
      icons.innerHTML='<svg aria-hidden="true" width="16" height="16"><path d="M0 0H16V16H0Z"/></svg><img role="presentation" alt="" width="16" height="16">';
      widget.append(icons);
    }
    await Promise.all(pending);
  },{language,kind,outside,decorative,broken,count});
  return h;
}

async function current(h){
  const result=await h.send({type:'ALEF_GET_QUESTION'});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.ok(result.question,JSON.stringify(result));
  return result.question;
}
const capture=(h,q)=>h.send({type:'ALEF_GET_VISUALS',questionId:q.id,questionFingerprint:q.fingerprint});

async function assertRealGraph(h,image){
  assert.match(image.mimeType,/^image\/(?:png|jpeg)$/);
  assert.ok(typeof image.data==='string'&&image.data.length>100);
  assert.ok(Buffer.from(image.data,'base64').byteLength<=1_048_576);
  const pixels=await h.page.evaluate(async image=>{
    const bitmap=new Image();bitmap.src=`data:${image.mimeType};base64,${image.data}`;await bitmap.decode();
    const canvas=document.createElement('canvas');canvas.width=bitmap.naturalWidth;canvas.height=bitmap.naturalHeight;
    const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);
    return {width:canvas.width,height:canvas.height,pixel:[...ctx.getImageData(Math.round(canvas.width*.2),Math.round(canvas.height/3),1,1).data]};
  },image);
  assert.ok(pixels.width>100&&pixels.height>80,JSON.stringify(pixels));
  assert.ok(pixels.pixel[2]>100&&pixels.pixel[0]<70,`The captured image must contain the actual blue graph, not a blank placeholder: ${JSON.stringify(pixels)}`);
}

for(const language of ['en','ar']){
  test(`${language} graph questions retain their language and deliver the original visual to the vision solver`,async t=>{
    const h=await mount(t,{language,decorative:true});
    const q=await current(h);
    assert.equal(q.requiresVision,true);
    assert.equal(q.visuals.length,1,'Decorative icons must not become graph evidence');
    assert.match(q.text,language==='ar'?/معامل التمدد/:/scale factor/);
    const result=await capture(h,q);
    assert.equal(result.ok,true,JSON.stringify(result));
    assert.equal(result.images.length,1);
    assert.equal(result.questionId,q.id);
    assert.equal(result.questionFingerprint,q.fingerprint);
    await assertRealGraph(h,result.images[0]);
    assert.equal((await current(h)).fingerprint,q.fingerprint,'Capturing evidence cannot change question identity');
  });
}

for(const kind of ['canvas','svg','background']){
  test(`${kind} authored diagrams are detected and rasterized instead of silently treated as text-only`,async t=>{
    const h=await mount(t,{kind});
    const q=await current(h);assert.equal(q.requiresVision,true);assert.equal(q.visuals.length,1);
    const result=await capture(h,q);assert.equal(result.ok,true,JSON.stringify(result));
    assert.equal(result.images.length,1);await assertRealGraph(h,result.images[0]);
  });
}

test('the graph and question context beside a narrow question widget remain attached to that question',async t=>{
  const h=await mount(t,{outside:true,language:'ar'});
  const q=await current(h);assert.equal(q.requiresVision,true);
  assert.match(q.text,/الإحداثيات/);
  const result=await capture(h,q);assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.images.length,1);await assertRealGraph(h,result.images[0]);
});

test('an image-only authored problem keeps its visual evidence instead of requiring invented text',async t=>{
  const h=await mount(t);
  await h.page.evaluate(()=>{
    const statement=document.querySelector('[data-testid="question-statement-container"]');
    statement.replaceChildren(document.querySelector('img.authored-graph'));
  });
  const q=await current(h);
  assert.equal(q.requiresVision,true);assert.ok(q.text.trim());assert.equal(q.visuals.length,1);
  const result=await capture(h,q);assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.images.length,1);await assertRealGraph(h,result.images[0]);
});

test('image-only choice labels retain stable IDs and every visual is associated with its original option',async t=>{
  const h=await mount(t);
  await h.page.evaluate(async()=>{
    const pending=[];
    for(const [index,label] of [...document.querySelectorAll('[data-testid="mcq-item-label"]')].entries()){
      const canvas=document.createElement('canvas');canvas.width=180;canvas.height=120;
      const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,180,120);
      ctx.fillStyle=index?'#dc5900':'#005adc';ctx.fillRect(20,20,80,60);
      const image=new Image();image.width=180;image.height=120;image.setAttribute('role','img');image.alt='';
      const loaded=new Promise(resolve=>{image.onload=resolve;});image.src=canvas.toDataURL('image/png');pending.push(loaded);
      label.replaceChildren(image);
    }
    await Promise.all(pending);
  });
  const q=await current(h);assert.equal(q.requiresVision,true);assert.equal(q.options.length,2);
  assert.ok(q.options.every(option=>option.text.trim()),JSON.stringify(q.options));
  const ids=q.options.map(option=>option.id);
  assert.equal(new Set(ids).size,2);
  const associated=q.visuals.filter(visual=>visual.optionId);
  assert.deepEqual(associated.map(visual=>visual.optionId).sort(),[...ids].sort());
  const result=await capture(h,q);assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.images.length,3);
  assert.deepEqual(result.images.filter(image=>image.optionId).map(image=>image.optionId).sort(),[...ids].sort());
  assert.equal((await current(h)).fingerprint,q.fingerprint);
});

for(const language of ['en','ar']){
  test(`${language} references to an unavailable diagram cannot silently become text-only inference`,async t=>{
    const h=await mount(t,{language});
    await h.page.evaluate(()=>{document.querySelector('img.authored-graph').remove();});
    const q=await current(h);assert.equal(q.requiresVision,true);
    const result=await capture(h,q);assert.equal(result.ok,false);assert.equal(result.images,undefined);
  });
}

test('a changed question is rejected before an old visual request can return evidence for it',async t=>{
  const h=await mount(t);const q=await current(h);
  await h.page.evaluate(()=>{document.querySelector('[data-testid="question-statement-container"]').prepend('This is now another question. ');});
  const result=await capture(h,q);assert.equal(result.ok,false);
  assert.equal(result.images,undefined);
});

test('a changed graph source invalidates the old question even when the wording and choices stay the same',async t=>{
  const h=await mount(t);const q=await current(h);
  await h.page.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=300;canvas.height=180;
    const ctx=canvas.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,300,180);
    const image=document.querySelector('img.authored-graph');
    const loaded=new Promise(resolve=>{image.onload=resolve;});image.src=canvas.toDataURL('image/png');await loaded;
  });
  assert.notEqual((await current(h)).fingerprint,q.fingerprint);
  const result=await capture(h,q);assert.equal(result.ok,false);assert.equal(result.images,undefined);
});

test('cancelled visual capture never returns images that could trigger a late solve',async t=>{
  const h=await mount(t);const q=await current(h);
  assert.equal((await h.send({type:'ALEF_CANCEL'})).ok,true);
  const result=await capture(h,q);assert.equal(result.ok,false);assert.equal(result.images,undefined);
});

test('an unreadable authored diagram fails closed instead of sending an incomplete text-only question',async t=>{
  const h=await mount(t,{broken:true});const q=await current(h);
  assert.equal(q.requiresVision,true);
  const result=await capture(h,q);assert.equal(result.ok,false);assert.equal(result.images,undefined);
});

test('questions exceeding the visual budget do not drop diagrams and continue with partial evidence',async t=>{
  const h=await mount(t,{count:4});
  const result=await h.send({type:'ALEF_GET_QUESTION'});
  if(!result.ok){assert.ok(result.error);return;}
  assert.equal(result.question.requiresVision,true);
  const captured=await capture(h,result.question);assert.equal(captured.ok,false);assert.equal(captured.images,undefined);
});

test('an SVG requiring embedded HTML is not partially rasterized with its authored labels removed',async t=>{
  const h=await mount(t,{kind:'svg'});
  await h.page.evaluate(()=>{
    const foreign=document.createElementNS('http://www.w3.org/2000/svg','foreignObject');
    foreign.setAttribute('width','100');foreign.setAttribute('height','50');
    const label=document.createElement('div');label.textContent='إحداثيات لازمة للحل';foreign.append(label);
    document.querySelector('svg').append(foreign);
  });
  const q=await current(h);assert.equal(q.requiresVision,true);
  const result=await capture(h,q);assert.equal(result.ok,false);assert.equal(result.images,undefined);
});

test('a large authored graph marked as presentation or aria-hidden remains visual evidence',async t=>{
  const h=await mount(t,{decorative:true});
  await h.page.evaluate(()=>{
    const image=document.querySelector('.authored-graph');image.setAttribute('role','presentation');
    const wrap=document.createElement('div');wrap.setAttribute('aria-hidden','true');image.replaceWith(wrap);wrap.append(image);
  });
  const q=await current(h);assert.equal(q.requiresVision,true);assert.equal(q.visuals.length,1);
  const result=await capture(h,q);assert.equal(result.ok,true,JSON.stringify(result));await assertRealGraph(h,result.images[0]);
});

test('an aria-hidden previous slide does not contribute a different question graph',async t=>{
  const h=await mount(t,{outside:true});
  await h.page.evaluate(()=>{
    const player=document.querySelector('[data-testid="ncle-activity-page-player"]');
    const old=document.createElement('section');old.setAttribute('aria-hidden','true');
    old.append(document.querySelector('.authored-graph').cloneNode(true));
    const other=document.querySelector('.question-widget').cloneNode(true);other.setAttribute('data-alef-question','previous-question');old.append(other);player.append(old);
  });
  const q=await current(h);assert.equal(q.requiresVision,true);assert.equal(q.visuals.length,1);
  const result=await capture(h,q);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.images.length,1);
});

for(const cors of [true,false]){
  test(`cross-origin graph ${cors?'with CORS can be recaptured anonymously':'without CORS stops without partial evidence'}`,async t=>{
    const h=await mount(t);
    const png=await h.page.locator('img.authored-graph').getAttribute('src');
    const bytes=Buffer.from(png.split(',')[1],'base64');
    const server=createServer((_request,response)=>{
      response.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store',...(cors?{'Access-Control-Allow-Origin':'*'}:{})});
      response.end(bytes);
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    t.after(()=>new Promise(resolve=>server.close(resolve)));
    await h.page.evaluate(async url=>{
      const image=document.querySelector('img.authored-graph');
      const loaded=new Promise(resolve=>{image.onload=resolve;image.onerror=resolve;});image.src=url;await loaded;
    },`http://127.0.0.1:${server.address().port}/graph.png`);
    const q=await current(h);assert.equal(q.requiresVision,true);
    const result=await capture(h,q);
    if(cors){assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.images.length,1);await assertRealGraph(h,result.images[0]);}
    else{assert.equal(result.ok,false);assert.equal(result.images,undefined);}
  });
}
