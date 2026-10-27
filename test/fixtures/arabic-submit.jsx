import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {DndContext,MouseSensor,useSensor,useSensors,useDraggable,useDroppable,pointerWithin} from '@dnd-kit/core';

const w=value=>value.split(/\s+/).filter(Boolean).map(token=>'lib-'+token).join(' ');
function Word({word,selected}){
 const {attributes,listeners,setNodeRef,isDragging}=useDraggable({id:word.id,disabled:selected});
 return <div ref={setNodeRef} {...attributes} {...listeners} data-word-id={word.id}
  className={w('dnd-options-draggable'+(isDragging?' is-dragging':'')+(selected?' is-selected':''))}
  style={{height:35,padding:8,margin:4,border:'1px solid #789'}}>{word.text}</div>;
}
function Blank({index,word}){
 const {setNodeRef,isOver}=useDroppable({id:'droppable-'+index});
 return <span ref={setNodeRef} id={'droppable-'+index} data-index={index}
  className={w('dnd-droppable'+(isOver?' is-about-to-drop':'')+(word?' is-selected':''))}
  style={{display:'inline-block',width:180,height:45,margin:10,border:'1px solid #789'}}>
  {word?<span className={w('selected-option')}>{word.text}</span>:null}</span>;
}
function Question({language='ar',label='أرسل إجابتي',testId='navigation-next-button',buttonId='',neverEnable=false,enableDelay=0,cancelWhileEnabling=false,duplicate=false,inputSubmit=false}){
 const state=window.arabicSubmitState,[answers,setAnswers]=useState({}),[enabled,setEnabled]=useState(false);
 const words=(language==='ar'?['ماء','ماء مالح','هواء','شمس','أرض','نبات','قمر']:['water','salt water','air','sun','earth','plant','moon']).map((text,index)=>({id:'word-'+index,text}));
 const sensors=useSensors(useSensor(MouseSensor,{activationConstraint:{delay:100,tolerance:5}}));
 useEffect(()=>{state.ready=true;state.answers=answers;},[answers]);
 useEffect(()=>{
  if(Object.keys(answers).length!==2||neverEnable)return;
  const enable=setTimeout(()=>{state.enabledAt=performance.now();setEnabled(true);},enableDelay);
  const stop=cancelWhileEnabling?setTimeout(()=>{state.stopSent=true;window.__dispatchExtension({type:'ALEF_CANCEL'});},100):null;
  return()=>{clearTimeout(enable);if(stop!==null)clearTimeout(stop);};
 },[answers,neverEnable,enableDelay,cancelWhileEnabling]);
 const props={type:inputSubmit?'submit':'button',id:buttonId||undefined,'data-testid':testId||undefined,disabled:!enabled,
  onClick:()=>state.submitted.push({answers,at:performance.now()})};
 return <DndContext sensors={sensors} collisionDetection={pointerWithin}
  onDragStart={({active})=>state.starts.push(active.id)}
  onDragEnd={({active,over})=>{state.ends.push({word:active.id,blank:over?.id||null});if(over)setAnswers(previous=>({...previous,[over.id]:words.find(word=>word.id===active.id)}));}}>
  <main id="player-container"><div data-testid="assessment-content-player"><section className={w('dnd-container question-widget')}>
   <h2>{language==='ar'?'ضع الماء ثم الماء المالح في الفراغين.':'Place water then salt water into the blanks.'}</h2>
   <div className={w('template-container')}>{[0,1].map(index=><Blank key={index} index={index} word={answers['droppable-'+index]}/>)}</div>
   <div className={w('dnd-options-wrapper')}>{words.map(word=><Word key={word.id} word={word} selected={Object.values(answers).some(answer=>answer.id===word.id)}/>)}</div>
   {inputSubmit?<input {...props} value={label}/>:<button {...props}>{label}</button>}
   {duplicate&&<button disabled={!enabled} onClick={()=>state.otherSubmitted++}>{label}</button>}
  </section></div></main>
 </DndContext>;
}
window.mountArabicSubmit=settings=>{
 window.arabicSubmitState={ready:false,answers:{},starts:[],ends:[],submitted:[],otherSubmitted:0,enabledAt:null,stopSent:false};
 document.documentElement.dir=settings.language==='en'?'ltr':'rtl';
 document.body.innerHTML='<div id="arabic-submit-root"></div>';
 createRoot(document.querySelector('#arabic-submit-root')).render(<Question {...settings}/>);
};
