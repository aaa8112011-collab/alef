import React,{useState,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {DndContext,MouseSensor,useSensor,useSensors,useDraggable,useDroppable,pointerWithin,DragOverlay} from '@dnd-kit/core';
const w=value=>value.split(/\s+/).filter(Boolean).map(token=>'lib-'+token).join(' ');
function Word({word,selected,epoch}){
 const {attributes,listeners,setNodeRef,isDragging}=useDraggable({id:word.id,disabled:selected});
 return <div ref={setNodeRef} {...listeners} {...attributes} data-word-id={word.id} data-epoch={epoch}
  className={w('dnd-options-draggable'+(isDragging?' is-dragging':'')+(selected?' is-selected':''))}
  style={{height:42,margin:4,padding:8,border:'1px solid #777'}}>{word.text}</div>;
}
function Blank({index,word}){
 const {setNodeRef,isOver}=useDroppable({id:'droppable-'+index});
 return <span ref={setNodeRef} id={'droppable-'+index} data-index={index}
  className={w('dnd-droppable'+(isOver?' is-about-to-drop':'')+(word?' is-selected':''))}
  style={{display:'inline-block',width:190,height:55,border:'1px solid #555',margin:12}}>
  {word?<span className={w('selected-option')}>{word.text}</span>:null}</span>;
}
function Question({language,delayed,cancelSecond,sensorDelay=1000,overlay=false}){
 const state=window.secondDragState,[answers,setAnswers]=useState({}),[epoch,setEpoch]=useState(0),[dragged,setDragged]=useState(null);
 const words=(language==='ar'?['ماء','ماء مالح','هواء','نبات','أرض','شمس','قمر']:['water','salt water','air','plant','earth','sun','moon']).map((text,index)=>({id:'word-'+index,text}));
 const sensors=useSensors(useSensor(MouseSensor,{activationConstraint:{delay:sensorDelay,tolerance:5}}));
 useEffect(()=>{state.answers=answers;state.epoch=epoch;state.ready=true;state.remountBank=()=>setEpoch(value=>value+1);},[answers,epoch]);
 const bank=epoch?[...words.slice(2),...words.slice(0,2)]:words;
 return <DndContext sensors={sensors} collisionDetection={pointerWithin}
  onDragStart={({active})=>{setDragged(active.id);state.starts.push({id:active.id,at:performance.now()});if(cancelSecond&&state.starts.length===2){state.stopSent=true;window.__dispatchExtension({type:'ALEF_CANCEL'});}}}
  onDragCancel={()=>{setDragged(null);state.cancelled++;}}
  onDragEnd={({active,over})=>{setDragged(null);
   state.ends.push({word:active.id,blank:over?.id||null});state.releases.push(performance.now());
   if(over){const next={...answers,[over.id]:words.find(word=>word.id===active.id)};setAnswers(next);
    if(Object.keys(next).length===1){if(delayed)setTimeout(()=>setEpoch(1),80);else setEpoch(1);}}
  }}>
  <main id="player-container"><div data-testid="assessment-content-player"><section className={w('dnd-container question-widget')}>
   <h2>{language==='ar'?'ضع الكلمتين في الفراغين الصحيحين.':'Place the two words into their correct blanks.'}</h2>
   <div className={w('template-container')}>{[0,1].map(index=><Blank key={index} index={index} word={answers['droppable-'+index]}/>)}</div>
   <div className={w('dnd-options-wrapper')} key={epoch}>{bank.map(word=><Word key={word.id} word={word} epoch={epoch} selected={Object.values(answers).some(answer=>answer.id===word.id)}/>)}</div>
   <button data-alef-submit disabled={Object.keys(answers).length!==2} onClick={()=>state.submitted.push(answers)}>Submit Answer</button>
  </section></div></main>{overlay&&<DragOverlay dropAnimation={{duration:250,easing:'ease'}}>{dragged?<div className={w('dnd-options-draggable-overlay')} style={{padding:8,background:'#bdf'}}>{words.find(word=>word.id===dragged)?.text}</div>:null}</DragOverlay>}
 </DndContext>;
}
window.mountSecondDrag=settings=>{
 window.secondDragState={ready:false,answers:{},epoch:0,starts:[],ends:[],releases:[],submitted:[],cancelled:0,downs:[],blocked:[],stopSent:false};
 document.documentElement.dir=settings.language==='ar'?'rtl':'ltr';
 document.body.innerHTML='<div id="second-drag-root"></div>';
 document.addEventListener('mousedown',event=>{
  const node=event.target.closest('[data-word-id]'),state=window.secondDragState;if(!node)return;
  state.downs.push({id:node.dataset.wordId,epoch:node.dataset.epoch,at:performance.now()});
  // Explicit synthetic readiness blocker. It simulates a second source missing
  // its first press, not a claimed reproduction of the authenticated website.
  // The retry still has to activate and complete the real DndKit sensor.
  if(node.dataset.wordId==='word-1'&&state.answers['droppable-0']&&state.blocked.length<(settings.blockSecondPresses||0)){
   event.stopImmediatePropagation();state.blocked.push({nodeEpoch:node.dataset.epoch,at:performance.now()});
   if(settings.remountBlockedPress)state.remountBank();
   if(settings.cancelBlockedPress)setTimeout(()=>{state.stopSent=true;window.__dispatchExtension({type:'ALEF_CANCEL'});},40);
   if(settings.changeQuestionBlockedPress)setTimeout(()=>{state.questionChanged=true;document.querySelector('h2').textContent='A different question has replaced the original prompt.';},40);
  }
 },true);
 createRoot(document.querySelector('#second-drag-root')).render(<Question {...settings}/>);
};
