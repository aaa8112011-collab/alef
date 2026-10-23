import React,{useState,useEffect} from 'react';
import {createRoot} from 'react-dom/client';

// Real controlled React inputs: assertions read the committed application
// state captured by the Submit handler, not merely the native DOM value.
function WritingQuestion({language,kind,mode}) {
  const [value,setValue]=useState('');
  const state=window.reactWriting;
  useEffect(()=>{state.value=value;state.commits.push(value);state.ready=true;},[value]);
  const onChange=event=>{
    const next=event.target.value;
    state.changes.push(next);
    if(mode==='reject')return;
    if(mode==='delayed')setTimeout(()=>setValue(next),110);
    else setValue(next);
  };
  const props={value,onChange,'aria-label':language==='ar'?'الإجابة':'Answer',
    key:mode==='remount'&&value?'replacement':'initial'};
  return <main><section data-alef-question="react-writing">
    <h2>{language==='ar'?'اكتب الإجابة في الحقل.':'Write the answer in the field.'}</h2>
    {kind==='number'?<input {...props} type="number" min="0" max="10" step="0.5"/>:<textarea {...props}/>}
    <button data-alef-submit disabled={!value} onClick={()=>state.submitted.push(value)}>Submit Answer</button>
  </section></main>;
}

window.mountReactWriting=settings=>{
  window.reactWriting={value:'',changes:[],commits:[],submitted:[],ready:false};
  document.body.innerHTML='<div id="react-writing-root"></div>';
  createRoot(document.querySelector('#react-writing-root')).render(<WritingQuestion {...settings}/>);
};
