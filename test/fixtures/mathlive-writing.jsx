import React,{useState,useEffect,useRef,useCallback} from 'react';
import {createRoot} from 'react-dom/client';
import {MathfieldElement} from 'mathlive';

// The same MathLive version bundled by Weaver. Fonts/sounds are unnecessary
// to test actual editor state, and are disabled to keep this fixture offline.
MathfieldElement.fontsDirectory=null;
MathfieldElement.soundsDirectory=null;

function MathEditor({value,onInput,readOnly=false,disabled=false}) {
  const current=useRef(null),handler=useRef(onInput);handler.current=onInput;
  const ref=useCallback(node=>{
    if(current.current)current.current.removeEventListener('input',current.current.__fixtureInput);
    current.current=node;
    if(!node)return;
    node.mathVirtualKeyboardPolicy='manual';node.readOnly=readOnly;node.disabled=disabled;
    node.setAttribute('dir','ltr');node.value=value;
    node.__fixtureInput=event=>handler.current(event.target.value);
    node.addEventListener('input',node.__fixtureInput);
  },[]);
  useEffect(()=>{const node=current.current;if(node&&node.value!==value)node.value=value;},[value]);
  useEffect(()=>{const node=current.current;if(node){node.readOnly=readOnly;node.disabled=disabled;}},[readOnly,disabled]);
  return <math-field ref={ref} class="lib-fib-math-editor" aria-label="Math expression editor"
    style={{display:'inline-block',width:200,minHeight:42,border:'1px solid #455',padding:4}}/>;
}

function MathQuestion({language='en',mode='normal',readOnly=false,disabled=false,multiple=false}) {
  const [value,setValue]=useState(''),[submitReady,setSubmitReady]=useState(false),state=window.realMathLive;
  useEffect(()=>{state.value=value;state.commits.push(value);state.ready=true;},[value]);
  const onInput=next=>{
    state.changes.push(next);
    if(mode==='reject'){
      // Model a site rejecting the answer after its input handler; a retained
      // DOM value alone must never authorize submitting a reset editor.
      setTimeout(()=>document.querySelector('math-field').setValue('',{silenceNotifications:true}),25);
      return;
    }
    if(mode==='late-reset'){
      setValue(next);
      // A later site validation resets the real editor after its first stable
      // interval. Submit becomes enabled independently, reproducing a stale
      // ready button that must not authorize sending the cleared answer.
      setTimeout(()=>{setValue('');state.lateReset=true;},300);
      setTimeout(()=>{setSubmitReady(true);state.submitReady=true;},450);
      return;
    }
    if(mode==='delayed')setTimeout(()=>setValue(next),110);
    else setValue(next);
  };
  return <main id="player-container"><div data-testid="ncle-activity-page-player">
    <div role="progressbar" style={{width:500,height:8,background:'#abd'}}>1/5</div>
    <div className="lib-question-statement-container">{language==='ar'?
      'المثلثان متشابهان. محيط المثلث الأول ٦٣ سنتيمترًا، ومحيط المثلث الثاني ٤٢ سنتيمترًا. ما معامل القياس من الثاني إلى الأول؟':
      'The triangles are similar. The first perimeter is 63 centimeters and the second perimeter is 42 centimeters. What is the scale factor from the second to the first?'}</div>
    <section className="lib-fib-container lib-question-widget">
      <p>{language==='ar'?'اكتب الإجابة الصحيحة.':'Type the correct answer(s).'}</p>
      <span>{language==='ar'?'معامل القياس هو':'The scale factor is'} </span>
      <MathEditor key={mode==='remount'&&value?'replacement':'initial'} value={value} onInput={onInput} readOnly={readOnly} disabled={disabled}/>
      {multiple?<MathEditor value="" onInput={()=>{}}/>:null}
    </section>
    <button disabled={(mode==='late-reset'?!submitReady:!value)||readOnly||disabled} onClick={()=>state.submitted.push(value)}>Submit Answer</button>
  </div></main>;
}

window.mountMathLive=settings=>{
  window.realMathLive={version:'0.110.0',value:'',changes:[],commits:[],submitted:[],ready:false,lateReset:false,submitReady:false};
  document.documentElement.dir=settings.language==='ar'?'rtl':'ltr';
  document.body.innerHTML='<div id="mathlive-root"></div>';
  createRoot(document.querySelector('#mathlive-root')).render(<MathQuestion {...settings}/>);
};
