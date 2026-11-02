// Page-side guard scripts for the canonical text transaction. Keeping them
// separate holds the transaction module inside the subsystem budget.

// Rich editors that draw their text on a canvas (Google Docs, some design tools)
// expose an editable element whose DOM text does not track what the user types.
// Readback cannot confirm those surfaces, so the transaction must say so instead
// of claiming an unknown delivery after the first character.
export const SURFACE_PROBE = `function(index){
  const e=this.nodes?this.nodes[index]:this;
  // Duck-typed node checks: an embed editor can hand back an element from
  // another realm, where instanceof against this world's constructors is false.
  const tagOf=n=>n&&typeof n.tagName==='string'?n.tagName.toUpperCase():'';
  const rich=!!e&&e.nodeType===1&&typeof e.getAttribute==='function'&&tagOf(e)!=='INPUT'&&tagOf(e)!=='TEXTAREA'&&(e.isContentEditable===true||e.getAttribute('role')==='textbox');
  const plain=tagOf(e)==='TEXTAREA'||tagOf(e)==='INPUT'&&['text','search','email','url','tel'].includes(e.type);
  const text=rich?(e.innerText??e.textContent??''):'';
  // Canvas editors often paint the text beside or above the editable element,
  // not inside it. Search the nearby container chain, but never the whole page:
  // an unrelated canvas elsewhere must not disable readback for a normal form.
  const paints=n=>!!n.querySelector&&!!n.querySelector('canvas,[class*="canvas-tile"],[data-canvas-content]');
  let canvas=rich&&paints(e);
  for(let p=e.parentElement,depth=0;!canvas&&p&&depth<3;p=p.parentElement,depth+=1)canvas=paints(p);
  // Some editors host the editing surface in a blank same-origin frame and keep
  // the text in their own model; that element never reports what was typed.
  // Only a document that belongs to a subframe counts: a top-level about:blank
  // page (a fresh tab, or a test harness) is its own document and does report
  // its text, so flagging it would refuse readback for no reason.
  const blankFrame=rich&&(()=>{try{
    const doc=e.ownerDocument;
    const win=doc.defaultView;
    const framed=!!win&&win!==win.top;
    return framed&&doc.location.href==='about:blank';
  }catch(_){return false}})();
  return {rich,plain,canvas,event_target_frame:blankFrame,text_length:text.length,readable:!rich||!(canvas||blankFrame)};
}`;

export const TRANSACTION_GUARD = `function(expectedKind,expectedValue,expectedAnchor,operation,prepare,normalize,lenientFocus,index,valueOnly,unreadable){
  const e=this.nodes?this.nodes[index]:this;
  if(!e||!e.isConnected)return {ok:false,reason:'target_stale'};
  const tagOf=n=>n&&typeof n.tagName==='string'?n.tagName.toUpperCase():'';
  const rich=!!e&&e.nodeType===1&&typeof e.getAttribute==='function'&&tagOf(e)!=='INPUT'&&tagOf(e)!=='TEXTAREA'&&(e.isContentEditable===true||e.getAttribute('role')==='textbox');
  const plain=tagOf(e)==='TEXTAREA'||tagOf(e)==='INPUT'&&['text','search','email','url','tel'].includes(e.type);
  const trusted=e.closest('[data-requires-trusted]');
  if(!rich&&!plain)return {ok:false,reason:'not_editable'};
  if(e.matches(':disabled,[aria-disabled="true"]')||e.readOnly||e.getAttribute('aria-readonly')==='true'||e.getAttribute('contenteditable')?.toLowerCase()==='false'||e.closest('[data-masked]')||(trusted&&trusted!==e))return {ok:false,reason:'blocked'};
  const NL=String.fromCharCode(10),NB=String.fromCharCode(160);
  const BLOCKS=new Set(['DIV','P','LI','UL','OL','BLOCKQUOTE','PRE','H1','H2','H3','H4','H5','H6','TABLE','TR','SECTION','ARTICLE','HEADER','FOOTER','FIGURE','FIGCAPTION']);
  // Read the text the user wrote, not the editor's decoration. Gmail keeps an
  // inline "Tab to improve / Esc to dismiss" affordance inside the editable
  // element; innerText counts it, so the first readback after a keystroke
  // looked like a conflicting edit and the whole transaction stopped as
  // unknown. Skip non-editable and hidden subtrees, and give block boundaries
  // the line break innerText would have produced.
  const userText=n=>{
    let out='';
    const walk=m=>{
      if(!m)return;
      if(m.nodeType===3){out+=String(m.nodeValue||'').split(NB).join(' ');return;}
      if(m.nodeType!==1)return;
      const tag=String(m.tagName||'').toUpperCase();
      if(tag==='BR'){out+=NL;return;}
      if(tag==='SCRIPT'||tag==='STYLE')return;
      if(m.getAttribute('contenteditable')==='false'||m.getAttribute('aria-hidden')==='true'||m.hasAttribute('hidden'))return;
      const block=BLOCKS.has(tag);
      if(block&&out&&!out.endsWith(NL))out+=NL;
      for(const child of m.childNodes)walk(child);
      if(block&&!out.endsWith(NL))out+=NL;
    };
    for(const child of n.childNodes)walk(child);
    while(out.endsWith(NL))out=out.slice(0,-1);
    return out;
  };
  // One canonical readback, whatever the caller's newline policy. Returning a
  // rewritten value here made the guard disagree with the snapshot: a caller
  // reads the page's paragraphs, passes them back as the expected value, and
  // the guard halved the readback's blank line away and rejected the field as
  // stale. The policy now only widens matching (variants); it never rewrites
  // what is read.
  // For an append the meaningful pre-state is the text before the caret. Rich
  // editors paint suggestions after the caret (Gmail's "Tab to improve, Esc to
  // dismiss"), and including them made the readback change on its own between
  // two otherwise identical reads: the caller's expected value then no longer
  // matched and the append refused as stale.
  const caretText=()=>{
    const sel=e.ownerDocument.getSelection();
    if(!sel||!sel.anchorNode||!e.contains(sel.anchorNode))return null;
    try{
      const r=e.ownerDocument.createRange();
      r.setStart(e,0);
      r.setEnd(sel.anchorNode,sel.anchorOffset);
      return userText(r.cloneContents());
    }catch(_){return null}
  };
  const read=()=>{
    if(!rich)return e.value;
    const scoped=operation==='append'?caretText():null;
    const raw=scoped!=null?scoped:userText(e);
    return /^\\s*$/.test(raw)?'':raw;
  };
  let value=read();
  // Visibility travels with every rejection: a chunk dispatched to a tab that
  // just went to the background is queued by Chrome rather than applied, and
  // the caller needs that fact to switch transports instead of giving up.
  const hiddenNow=e.ownerDocument.visibilityState!=='visible';
  // A canvas editor's editable element does not hold the document text, so its
  // value is not evidence of anything. Only visibility, focus, and liveness are
  // read from it.
  // A rich editor adds a trailing line break for its empty last block, and the
  // decoration it renders between two reads can differ. Compare the text that
  // carries meaning: trailing whitespace is not a conflicting edit, while any
  // other difference still stops the transaction. Both spellings of a
  // paragraph break (one newline, or the doubled form some editors produce)
  // are accepted, because the caller may hold either.
  const forms=s=>{
    const t=String(s??'');
    const list=[t];
    if(normalize){const halved=t.replace(/\\n{2,}/g,b=>NL.repeat(Math.ceil(b.length/2)));if(halved!==t)list.push(halved);}
    return rich?list.map(x=>x.replace(/[\\s\\u00a0]+$/,'')):list;
  };
  const agrees=(a,b,test)=>forms(a).some(x=>forms(b).some(y=>test(x,y)));
  const exactOk=unreadable===true||expectedKind==='unchecked'||expectedKind==='contains'?expectedKind==='contains'?agrees(value,expectedValue,(x,y)=>x.includes(y)):true:expectedKind==='suffix'?agrees(value,expectedValue,(x,y)=>x.endsWith(y)):agrees(value,rich&&/^\\s*$/.test(expectedValue)?'':expectedValue,(x,y)=>x===y);
  // Appending to a rich editor: an editor may render decoration at the caret
  // that the caller never typed (Gmail's inline writing hint, a ghost
  // suggestion, a trailing empty block). The prior text is still provably the
  // text the caller saw when everything it supplied is a prefix of what the
  // field now holds, so the append keeps its anchor instead of refusing as
  // stale. Anything else is still a conflicting edit.
  // Either side may carry the decoration: it can appear after the read and be
  // gone by the next one, so a prefix in either direction is the strongest
  // claim about the caller's text that survives the editor's own churn.
  // An empty expectation or an empty field is not an anchor: the exact path
  // above already accepts a genuinely empty editor. Prefix tolerance only
  // widens a match between two real values.
  const appendPrefixOk=rich&&operation==='append'&&value!==''&&String(expectedValue??'')!==''&&agrees(value,expectedValue,(x,y)=>x.startsWith(y)||y.startsWith(x));
  const expectedOk=exactOk||appendPrefixOk;
  if(!expectedOk)return {ok:false,reason:'stale_value',value,length:value.length,rich,hidden:hiddenNow,focused:e.ownerDocument.activeElement===e};
  if(prepare){
    e.focus();
    if(rich){
      const s=e.ownerDocument.getSelection(),r=e.ownerDocument.createRange();
      if(operation==='replace')r.selectNodeContents(e);
      else {r.selectNodeContents(e);r.collapse(false)}
      s.removeAllRanges();s.addRange(r);
    }else if(operation==='replace')e.setSelectionRange(0,e.value.length);
    else if(operation==='append')e.setSelectionRange(e.value.length,e.value.length);
  }
  const focused=e.ownerDocument.activeElement===e||e.contains(e.ownerDocument.activeElement);
  let atBoundary=true,selectionStart=null,selectionEnd=null;
  if(rich){
    const s=e.ownerDocument.getSelection();
    selectionStart=s?.anchorOffset??null;selectionEnd=s?.focusOffset??null;
    if(operation==='append'){if(s?.isCollapsed&&s.anchorNode){const r=e.ownerDocument.createRange();r.selectNodeContents(e);r.setStart(s.anchorNode,s.anchorOffset);atBoundary=r.toString()===''}else atBoundary=false}
    if(operation==='replace')atBoundary=!!s&&!s.isCollapsed&&s.toString()===value;
  }else{
    selectionStart=e.selectionStart;selectionEnd=e.selectionEnd;
    if(operation==='append')atBoundary=selectionStart===selectionEnd&&selectionEnd===e.value.length;
    if(operation==='replace')atBoundary=selectionStart===0&&selectionEnd===e.value.length;
  }
  if(!valueOnly&&(operation==='insert_at_caret'?false:(!focused&&lenientFocus!==true)||!atBoundary))return {ok:false,reason:'focus_or_selection_changed',value,length:value.length,focused,atBoundary,rich,hidden:hiddenNow};
  value=read();
  return {ok:true,value,length:value.length,rich,focused,selectionStart,selectionEnd,expectedAnchor:expectedAnchor??null,hidden:hiddenNow,
    // The identity a detached editor can be looked up by again.
    identity:{tag:String(e.tagName||'').toUpperCase(),role:e.getAttribute('role')||'',label:String(e.getAttribute('aria-label')||'').trim(),placeholder:String(e.getAttribute('aria-placeholder')||e.getAttribute('data-placeholder')||'').trim(),id:e.id||''}};
}`;
