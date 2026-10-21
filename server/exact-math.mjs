// A deliberately small exact solver. Unsupported prose, missing diagrams and
// ambiguous options always fall back to the model/review path.
const MAX_BITS = 256;
const MAX_TERMS = 40;
const MAX_DEGREE = 12;
const ZERO = Object.freeze({n:0n,d:1n});
const ONE = Object.freeze({n:1n,d:1n});
const fail = () => { throw new Error('Unsupported exact expression'); };
const abs = n => n < 0n ? -n : n;
function gcd(a,b) { while(b) [a,b]=[b,a%b]; return a; }
function rational(n,d=1n) {
  if(!d) fail();
  if(d<0n) { n=-n;d=-d; }
  const factor=gcd(abs(n),d);n/=factor;d/=factor;
  if(abs(n).toString(2).length>MAX_BITS || d.toString(2).length>MAX_BITS) fail();
  return {n,d};
}
const plus = (a,b) => rational(a.n*b.d+b.n*a.d,a.d*b.d);
const times = (a,b) => rational(a.n*b.n,a.d*b.d);
const negate = a => ({n:-a.n,d:a.d});
const equalRational = (a,b) => a.n===b.n && a.d===b.d;
function polynomial(variable,terms) {
  for(const [degree,value] of terms) if(!value.n) terms.delete(degree);
  if(terms.size>MAX_TERMS || [...terms.keys()].some(n=>n>MAX_DEGREE)) fail();
  return {variable:[...terms.keys()].some(n=>n>0)?variable:null,terms};
}
const constant = n => polynomial(null,new Map([[0,n]]));
function compatible(a,b) {
  if(a.variable && b.variable && a.variable!==b.variable) fail();
  return a.variable||b.variable;
}
function add(a,b) {
  const variable=compatible(a,b), terms=new Map(a.terms);
  for(const [degree,value] of b.terms) terms.set(degree,plus(terms.get(degree)||ZERO,value));
  return polynomial(variable,terms);
}
const negative = a => polynomial(a.variable,new Map([...a.terms].map(([degree,value])=>[degree,negate(value)])));
function multiply(a,b) {
  const variable=compatible(a,b), terms=new Map();
  for(const [left,lvalue] of a.terms) for(const [right,rvalue] of b.terms) {
    if(left+right>MAX_DEGREE) fail();
    terms.set(left+right,plus(terms.get(left+right)||ZERO,times(lvalue,rvalue)));
  }
  return polynomial(variable,terms);
}
function divide(a,b) {
  if(b.variable || b.terms.size!==1 || !b.terms.get(0)?.n) fail();
  const value=b.terms.get(0);
  return polynomial(a.variable,new Map([...a.terms].map(([degree,coefficient])=>[degree,times(coefficient,rational(value.d,value.n))])));
}
function power(a,n) {
  if(!Number.isInteger(n)||n<0||n>8) fail();
  if(n===0&&!a.terms.size)fail();
  let result=constant(ONE);
  for(let index=0;index<n;index++) result=multiply(result,a);
  return result;
}
function normalize(value) {
  if(typeof value!=='string'||value.length>3000) fail();
  if(/[\d٠-٩۰-۹]\s*[¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/.test(value))fail();
  const superscripts='⁰¹²³⁴⁵⁶⁷⁸⁹';
  return value.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g,part=>'^'+[...part].map(char=>superscripts.indexOf(char)).join(''))
    .replace(/[٠-٩]/g,char=>String(char.charCodeAt(0)-0x660))
    .replace(/[۰-۹]/g,char=>String(char.charCodeAt(0)-0x6f0))
    .replace(/٫/g,'.').normalize('NFKC').toLowerCase()
    .replace(/[\u064b-\u065f\u0670\u0640]/g,'').replace(/[أإآ]/g,'ا')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,'')
    .replace(/[−–﹣]/g,'-').replace(/[×·⋅]/g,'*').replace(/÷/g,'/')
    .replace(/⁄/g,'/').replace(/\\(?:left|right)\b/g,'')
    .replace(/\\(?:cdot|times)\b/g,'*').replace(/\\div\b/g,'/')
    .replace(/\\[()[\]]/g,'').replace(/\$/g,'').replace(/\s+/g,' ').trim();
}
function latexFractions(source) {
  let text=source;
  function group(start) {
    while(/\s/.test(text[start]||'!')) start++;
    if(text[start]!=='{') fail();
    let level=1,end=start+1;
    while(end<text.length&&level) { if(text[end]==='{')level++;if(text[end]==='}')level--;end++; }
    if(level) fail();
    return {value:text.slice(start+1,end-1),end};
  }
  for(let index=0;index<20;index++) {
    const match=/\\(?:dfrac|tfrac|frac)\s*/.exec(text);
    if(!match) return text.replace(/\{/g,'(').replace(/\}/g,')');
    const numerator=group(match.index+match[0].length),denominator=group(numerator.end);
    text=text.slice(0,match.index)+'(('+numerator.value+')/('+denominator.value+'))'+text.slice(denominator.end);
  }
  fail();
}
function parseExpression(raw) {
  const source=latexFractions(normalize(raw));
  if(source.length>600 || /[a-zسصعنل]{2}/.test(source)) fail();
  const tokens=[];
  let cursor=0;
  while(cursor<source.length) {
    if(source[cursor]===' ') { cursor++;continue; }
    const match=/^(?:\d+(?:\.\d+)?|\.\d+|[a-zسصعنل]|[+*/^()-])/.exec(source.slice(cursor));
    if(!match) fail();
    tokens.push(match[0]);cursor+=match[0].length;
    if(tokens.length>160) fail();
  }
  let position=0,operations=0;
  const take = () => tokens[position++];
  const peek = () => tokens[position];
  const count = () => { if(++operations>160) fail(); };
  const variable = token => /^[a-zسصعنل]$/.test(token||'');
  function number(token) {
    if(!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(token||'') || token.replace('.','').length>18) fail();
    const [whole,fraction='']=token.split('.');
    return rational(BigInt((whole||'0')+fraction),10n**BigInt(fraction.length));
  }
  function primary() {
    count();const token=take();
    if(token==='(') { const value=sum();if(take()!==')')fail();return value; }
    if(variable(token)) return polynomial(token,new Map([[1,ONE]]));
    return constant(number(token));
  }
  function exponent() {
    let value=primary();
    if(peek()==='^') {
      take();const grouped=peek()==='(';if(grouped)take();
      const token=take();if(!/^\d+$/.test(token||''))fail();
      if(grouped&&take()!==')')fail();
      value=power(value,Number(token));
    }
    return value;
  }
  function unary() { count();if(peek()==='+'){take();return unary();}if(peek()==='-'){take();return negative(unary());}return exponent(); }
  function product() {
    let value=unary(),divided=false;
    while(position<tokens.length) {
      const token=peek();
      if(token==='*'||token==='/') { take();count();value=token==='*'?multiply(value,unary()):divide(value,unary());divided=token==='/'; }
      else if(token==='('||variable(token)) {
        // Adjacent variable identifiers (including prose) are never interpreted
        // as an implicit multiplication. Numeric coefficients and brackets are.
        if(divided || variable(token)&&variable(tokens[position-1]))fail();
        count();value=multiply(value,unary());
      } else break;
    }
    return value;
  }
  function sum() {
    let value=product();
    while(peek()==='+'||peek()==='-') { const op=take();count();const next=product();value=add(value,op==='-'?negative(next):next); }
    return value;
  }
  if(!tokens.length) fail();
  const value=sum();if(position!==tokens.length)fail();return value;
}
function equal(a,b) {
  return a.variable===b.variable && a.terms.size===b.terms.size && [...a.terms].every(([degree,value])=>b.terms.has(degree)&&equalRational(value,b.terms.get(degree)));
}
function explicitOperation(raw) {
  let text=normalize(raw);
  if(/\b(?:figure|diagram|graph|shown|picture|image)\b|الشكل|الرسم|البياني|الصورة/.test(text)) fail();
  const instruction=/^(?:select the correct answer|choose the correct answer|اختر الاجابة الصحيحة|حدد الاجابة الصحيحة)[.!؟?]?\s*/;
  const instructionEnd=/\s*(?:select the correct answer|choose the correct answer|اختر الاجابة الصحيحة|حدد الاجابة الصحيحة)[.!؟?]?$/;
  text=text.replace(instruction,'').replace(instructionEnd,'').trim().replace(/[.!؟?]+$/,'').trim();
  text=text.replace(/\s*=\s*$/,'').trim();
  let match;
  const two = (left,right,op) => { const a=parseExpression(left),b=parseExpression(right);return op==='+'?add(a,b):op==='-'?add(a,negative(b)):multiply(a,b); };
  if((match=/^(?:find |calculate |compute )?(?:the )?(sum|difference|product) of (.+) and (.+)$/.exec(text))) return two(match[2],match[3],{sum:'+',difference:'-',product:'*'}[match[1]]);
  if((match=/^subtract (.+) from (.+)$/.exec(text)))return two(match[2],match[1],'-');
  if((match=/^(?:multiply) (.+) by (.+)$/.exec(text)))return two(match[1],match[2],'*');
  if((match=/^add (.+) and (.+)$/.exec(text)))return two(match[1],match[2],'+');
  if((match=/^(?:(?:اوجد|احسب) (?:ناتج )?)?(مجموع|جمع|حاصل ضرب|ضرب|الفرق بين) (.+) و (.+)$/.exec(text))) return two(match[2],match[3],/ضرب/.test(match[1])?'*':match[1]==='الفرق بين'?'-':'+');
  if((match=/^اطرح (.+) من (.+)$/.exec(text)))return two(match[2],match[1],'-');
  if((match=/^(?:simplify|بسط|اوجد ابسط صورة)(?:\s*:)?\s+(.+)$/.exec(text)))return parseExpression(match[1]);
  if((match=/^(?:which expression is equivalent to|اي العبارات تكافئ|اي عبارة تكافئ) (.+)$/.exec(text)))return parseExpression(match[1]);
  if((match=/^(?:evaluate|calculate|compute|find the value of|what is the value of|what is|احسب|احسب ناتج|اوجد ناتج|اوجد قيمة|ما ناتج|ما هو ناتج|ما قيمة)(?:\s*:)?\s+(.+)$/.exec(text))) {
    if(!/[+*/^-]|\\(?:dfrac|tfrac|frac)\b/.test(match[1]))fail();
    const expression=parseExpression(match[1]);
    if(expression.variable) fail();
    return expression;
  }
  if(!/[+*/^-]/.test(text))fail();
  return parseExpression(text);
}

export function solveExactMath(question) {
  try {
    if(!question || question.type!=='single' || question.requiresVision || question.images?.length || question.visuals?.length
      || !Array.isArray(question.options) || question.options.length<2 || question.options.length>20) return null;
    const ids=question.options.map(option=>option?.id);
    if(ids.some(id=>typeof id!=='string'||!id) || new Set(ids).size!==ids.length) return null;
    const value=explicitOperation(question.text);
    const options=question.options.map(option=>({id:option.id,value:parseExpression(option.text)}));
    const matching=options.filter(option=>equal(value,option.value));
    if(matching.length!==1)return null;
    return {optionIds:[matching[0].id],text:'',explanation:'طابقتُ الناتج مع الخيار بحساب جبري دقيق باستخدام كسور دون تقريب.',confidence:1};
  } catch { return null; }
}
