import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import Select,{components} from 'react-select';

// Reproduce the published Weaver integration, not a home-made select:
// 6758/index-TQ7pOSCE.js uses isSearchable=false, openMenuOnFocus=true,
// a body portal, custom Option, and SingleValue containing an authored label.
// React Select itself supplies the surrounding __single-value element and
// keyboard/focus/portal state. No third-party implementation is vendored here.
const settings=window.__reactSelectSettings;
// The published Weaver m()/w() helper prefixes every CSS token with lib-.
const w=value=>settings.legacyClasses?value:value.split(/\s+/).filter(Boolean).map(token=>token.startsWith('lib-')?token:'lib-'+token).join(' ');
const ar=settings.language==='ar';
const option=(id,text)=>({id,content:{text,type:'text'}});
const labels=settings.numeric?['2','12']:['70°','65°'];
const domains=[labels.map((text,index)=>option(index+1,text)),[
  option(1,ar?'متشابهان':'are similar'),option(2,ar?'غير متشابهين':'are not similar')
]];
if(settings.k4)domains[0].push(option(3,'Cancel'));

function Option({data:{content,id},innerProps,isSelected,isFocused}){
  return <div {...innerProps} id={'dropdown-option-'+id} role="option"
    aria-selected={isSelected} aria-label={content.text}
    className={w('dropdown-item '+(id===-1?'dropdown-item-cancel ':'')+
      (isSelected?'is-selected dropdown-item-selected ':'')+(isFocused?'is-focused':''))}>
    <div id={'dropdown-'+id}>{content.text}</div>
  </div>;
}
function SingleValue(props){
  const label=settings.wrongLabel?'12':props.data.content.text;
  return <components.SingleValue {...props} className={w("dropdown-single-value")}>
    <div className={w("dropdown-single-value-content")}>{label}</div>
    {settings.duplicateLabels&&<div className={w("dropdown-single-value-content")}>{label}</div>}
  </components.SingleValue>;
}
function Indicator(props){return <div {...props.innerProps} className={w("Select__indicators")}>▼</div>;}
function Field({index,answer,onChange}){
  const options=settings.k4?[...domains[index],option(-1,ar?'إلغاء':'Cancel')]:domains[index];
  return <div className={w('dropdown-input-field-container is-inline '+(answer?'is-selected':''))}
    data-index={index} data-testid={'dropdown-'+index} style={{display:'inline-block',width:180}}>
    <Select className={w("dropdown-field-wrapper dropdown-input-field-wrapper")} classNamePrefix={w("default Select")}
      placeholder={ar?'اختر...':'Select...'} isSearchable={false} menuPlacement="auto"
      menuPortalTarget={document.body} tabIndex={0} aria-label={ar?'اختر إجابة':'Select an option'}
      openMenuOnFocus={true} options={options} value={answer}
      onChange={value=>{if(value&&value.id!==-1)onChange(value);}}
      isOptionSelected={value=>value.id===answer?.id} formatOptionLabel={value=>value.content.text}
      components={{Option,DropdownIndicator:Indicator,SingleValue}} />
  </div>;
}
function App(){
  const count=settings.single?1:2;
  const [answers,setAnswers]=useState(Array(count).fill(null));
  const [done,setDone]=useState(false);
  const canvas=useRef();
  window.__realSelect.answers=answers;
  useEffect(()=>{
    const context=canvas.current.getContext('2d');
    context.fillStyle='white';context.fillRect(0,0,240,160);
    context.strokeStyle='black';context.beginPath();context.moveTo(20,130);context.lineTo(140,20);context.lineTo(220,130);context.closePath();context.stroke();
    context.fillStyle='black';context.font='16px sans-serif';context.fillText('70°',130,50);context.fillText('45°',40,125);
    window.__realSelect.ready=true;
  },[]);
  if(done)return <section data-alef-completed>Lesson completed</section>;
  const field=index=><Field index={index} answer={answers[index]} onChange={answer=>{
    window.__realSelect.changes.push({field:index,id:answer.id,text:answer.content.text});
    setAnswers(previous=>previous.map((value,position)=>position===index?answer:value));
  }}/>;
  return <main id="player-container"><div data-testid="ncle-activity-page-player">
    {settings.persistentProgress!==false&&<div role="progressbar" aria-valuenow="2" aria-valuemax="5" style={{width:500,height:8,background:'#abd'}}>2/5</div>}
    <section className={w("dropdown-container question-widget")}>
      <h3>{ar?'اختر الإجابة الصحيحة من القائمة.':'Choose the correct option from the drop-down list.'}</h3>
      <div className={w("dropdown-sentence-container")}>{ar?'في الشكل، قياس الزاوية د هو ':'In the given figure, the measure of angle D is '}
        {field(0)}{count===2&&<>{ar?' والمثلثان ':' and the triangles '}{field(1)}</>}.
      </div>
      <canvas ref={canvas} width="240" height="160" aria-label="A triangle with angle labels"/>
      <button data-alef-submit disabled={!answers.every(Boolean)} onClick={()=>{
        window.__realSelect.submissions.push(answers.map(answer=>({id:answer.id,text:answer.content.text})));
        setDone(true);
      }}>Submit Answer</button>
    </section>
  </div></main>;
}
window.__realSelect={answers:[],changes:[],submissions:[],ready:false};
createRoot(document.getElementById('root')).render(<App/>);
