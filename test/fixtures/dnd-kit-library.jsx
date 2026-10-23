import React,{useState,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {DndContext,MouseSensor,useSensor,useSensors,useDraggable,useDroppable,pointerWithin} from '@dnd-kit/core';

function Word({word,selected}) {
  const {attributes,listeners,setNodeRef,isDragging}=useDraggable({id:word.id,disabled:selected});
  return <div ref={setNodeRef} {...listeners} {...attributes}
    className={'dnd-options-draggable'+(isDragging?' is-dragging':'')+(selected?' is-selected':'')}
    style={{display:'inline-block',border:'1px solid #777',padding:20,margin:10}}>{word.text}</div>;
}
function Blank({index,word}) {
  const {setNodeRef,isOver}=useDroppable({id:'droppable-'+index});
  return <span ref={setNodeRef} id={'droppable-'+index} data-index={index}
    className={'dnd-droppable'+(isOver?' is-about-to-drop':'')+(word?' is-selected':'')}
    style={{display:'block',width:200,height:60,border:'1px solid #555',margin:20}}>
    {word?<span className="selected-option">{word.text}</span>:null}
  </span>;
}
function Question({language,cancelOnOver=false,cancelAfterFinalDrop=false}) {
  const [answers,setAnswers]=useState({}),state=window.realDndKit;
  const words=language==='ar'?[{id:'word-0',text:'ماء'},{id:'word-1',text:'ماء مالح'}]:[{id:'word-0',text:'water'},{id:'word-1',text:'salt water'}];
  const sensors=useSensors(useSensor(MouseSensor,{activationConstraint:{delay:1000,tolerance:5}}));
  useEffect(()=>{state.answers=answers;state.ready=true;},[answers]);
  return <DndContext sensors={sensors} collisionDetection={pointerWithin}
    onDragStart={({active})=>{state.starts.push({id:active.id,at:performance.now()});}}
    onDragOver={({over})=>{if(cancelOnOver&&over&&!state.stopSent){state.stopSent=true;window.__dispatchExtension({type:'ALEF_CANCEL'});}}}
    onDragCancel={()=>state.cancelled++}
    onDragEnd={({active,over})=>{
      state.ends.push({word:active.id,blank:over?.id||null});
      state.releaseTimes.push(performance.now());
      if(over){
        const next={...answers,[over.id]:words.find(word=>word.id===active.id)};setAnswers(next);
        if(cancelAfterFinalDrop&&Object.keys(next).length===2)setTimeout(()=>{
          state.stopSent=true;window.__dispatchExtension({type:'ALEF_CANCEL'});
        },15);
      }
    }}>
    <main><section className="dnd-container question-widget" data-alef-question="actual-dnd-kit">
      <h2 data-testid="question-statement-container">{language==='ar'?'ضع كل كلمة في فراغها الصحيح.':'Place each word in its correct blank.'}</h2>
      <div className="template-container">{[0,1].map(index=><Blank key={index} index={index} word={answers['droppable-'+index]}/>)}</div>
      <div className="dnd-options-wrapper">{words.map(word=><Word key={word.id} word={word} selected={Object.values(answers).some(answer=>answer.id===word.id)}/>)}</div>
      <button data-alef-submit disabled={Object.keys(answers).length!==2} onClick={()=>{
        state.submitTimes.push(performance.now());state.submitted.push(answers);
      }}>Submit Answer</button>
    </section></main>
  </DndContext>;
}
window.mountRealDndKit=settings=>{
  window.realDndKit={answers:{},starts:[],ends:[],releaseTimes:[],submitTimes:[],cancelled:0,submitted:[],ready:false,stopSent:false};
  document.body.innerHTML='<div id="dnd-kit-root"></div>';
  createRoot(document.querySelector('#dnd-kit-root')).render(<Question {...settings}/>);
};
