import{c4 as V,D,c as v,a as t,F as _,G as w,cL as me,cM as xe,cN as ge,d as O,u as q,aq as pe,o as S,b as $,C as B,n as R,e as ye,cG as Ce,cn as we,M as ze,$ as Re,g as W,r as K,i as Q,cr as Se,h as Y,dB as Te,O as _e,k as Be,m as U,cO as $e,q as s,Q as j,w as E,af as L,s as De,bU as Fe,a4 as Ae,be as Me}from"./index-DN9hiid6.js";var Ie=()=>(()=>{const e=V("75be776d8875fa17");return e[0]||(e[0]=D("svg",{viewBox:"0 0 64 64",class:"check-icon"},[D("path",{d:"M50.42,16.76L22.34,39.45l-8.1-11.46c-1.12-1.58-3.3-1.96-4.88-0.84c-1.58,1.12-1.95,3.3-0.84,4.88l10.26,14.51  c0.56,0.79,1.42,1.31,2.38,1.45c0.16,0.02,0.32,0.03,0.48,0.03c0.8,0,1.57-0.27,2.2-0.78l30.99-25.03c1.5-1.21,1.74-3.42,0.52-4.92  C54.13,15.78,51.93,15.55,50.42,16.76z"})],-1))})(),Ue=()=>(()=>{const e=V("c6eed899356c8404");return e[0]||(e[0]=D("svg",{viewBox:"0 0 100 100",class:"line-icon"},[D("path",{d:"M80.2,55.5H21.4c-2.8,0-5.1-2.5-5.1-5.5l0,0c0-3,2.3-5.5,5.1-5.5h58.7c2.8,0,5.1,2.5,5.1,5.5l0,0C85.2,53.1,82.9,55.5,80.2,55.5z"})],-1))})(),Ne=v([t("checkbox",`
 font-size: var(--n-font-size);
 outline: none;
 cursor: pointer;
 display: inline-flex;
 flex-wrap: nowrap;
 align-items: flex-start;
 word-break: break-word;
 line-height: var(--n-size);
 --n-merged-color-table: var(--n-color-table);
 `,[_("show-label","line-height: var(--n-label-line-height);"),v("&:hover",[t("checkbox-box",[w("border","border: var(--n-border-checked);")])]),v("&:focus:not(:active)",[t("checkbox-box",[w("border",`
 border: var(--n-border-focus);
 box-shadow: var(--n-box-shadow-focus);
 `)])]),_("inside-table",[t("checkbox-box",`
 background-color: var(--n-merged-color-table);
 `)]),_("checked",[t("checkbox-box",`
 background-color: var(--n-color-checked);
 `,[t("checkbox-icon",[v(".check-icon",`
 opacity: 1;
 transform: scale(1);
 `)])])]),_("indeterminate",[t("checkbox-box",[t("checkbox-icon",[v(".check-icon",`
 opacity: 0;
 transform: scale(.5);
 `),v(".line-icon",`
 opacity: 1;
 transform: scale(1);
 `)])])]),_("checked, indeterminate",[v("&:focus:not(:active)",[t("checkbox-box",[w("border",`
 border: var(--n-border-checked);
 box-shadow: var(--n-box-shadow-focus);
 `)])]),t("checkbox-box",`
 background-color: var(--n-color-checked);
 border-left: 0;
 border-top: 0;
 `,[w("border",{border:"var(--n-border-checked)"})])]),_("disabled",{cursor:"not-allowed"},[_("checked",[t("checkbox-box",`
 background-color: var(--n-color-disabled-checked);
 `,[w("border",{border:"var(--n-border-disabled-checked)"}),t("checkbox-icon",[v(".check-icon, .line-icon",{fill:"var(--n-check-mark-color-disabled-checked)"})])])]),t("checkbox-box",`
 background-color: var(--n-color-disabled);
 `,[w("border",`
 border: var(--n-border-disabled);
 `),t("checkbox-icon",[v(".check-icon, .line-icon",`
 fill: var(--n-check-mark-color-disabled);
 `)])]),w("label",`
 color: var(--n-text-color-disabled);
 `)]),t("checkbox-box-wrapper",`
 position: relative;
 width: var(--n-size);
 flex-shrink: 0;
 flex-grow: 0;
 user-select: none;
 -webkit-user-select: none;
 `),t("checkbox-box",`
 position: absolute;
 left: 0;
 top: 50%;
 transform: translateY(-50%);
 height: var(--n-size);
 width: var(--n-size);
 display: inline-block;
 box-sizing: border-box;
 border-radius: var(--n-border-radius);
 background-color: var(--n-color);
 transition: background-color 0.3s var(--n-bezier);
 `,[w("border",`
 transition:
 border-color .3s var(--n-bezier),
 box-shadow .3s var(--n-bezier);
 border-radius: inherit;
 position: absolute;
 left: 0;
 right: 0;
 top: 0;
 bottom: 0;
 border: var(--n-border);
 `),t("checkbox-icon",`
 display: flex;
 align-items: center;
 justify-content: center;
 position: absolute;
 left: 1px;
 right: 1px;
 top: 1px;
 bottom: 1px;
 `,[v(".check-icon, .line-icon",`
 width: 100%;
 fill: var(--n-check-mark-color);
 opacity: 0;
 transform: scale(0.5);
 transform-origin: center;
 transition:
 fill 0.3s var(--n-bezier),
 transform 0.3s var(--n-bezier),
 opacity 0.3s var(--n-bezier),
 border-color 0.3s var(--n-bezier);
 `),me({left:"1px",top:"1px"})])]),w("label",`
 color: var(--n-text-color);
 transition: color .3s var(--n-bezier);
 user-select: none;
 -webkit-user-select: none;
 padding: var(--n-label-padding);
 font-weight: var(--n-label-font-weight);
 `,[v("&:empty",{display:"none"})])]),xe(t("checkbox",`
 --n-merged-color-table: var(--n-color-table-modal);
 `)),ge(t("checkbox",`
 --n-merged-color-table: var(--n-color-table-popover);
 `))]);const Pe=["id"],Ke=["tabindex","aria-checked","aria-labelledby","onKeyup","onKeydown","onClick"],Ee={...q.props,size:String,checked:{type:[Boolean,String,Number],default:void 0},defaultChecked:{type:[Boolean,String,Number],default:!1},value:[String,Number],disabled:{type:Boolean,default:void 0},indeterminate:Boolean,label:String,focusable:{type:Boolean,default:!0},checkedValue:{type:[Boolean,String,Number],default:!0},uncheckedValue:{type:[Boolean,String,Number],default:!1},"onUpdate:checked":[Function,Array],onUpdateChecked:[Function,Array],privateInsideTable:Boolean,onChange:[Function,Array]};var Ve=O({name:"Checkbox",props:Ee,setup(e){const a=Re(J,null),r=K(null),{mergedClsPrefixRef:n,inlineThemeDisabled:k,mergedRtlRef:f,mergedComponentPropsRef:T}=W(e),i=K(e.defaultChecked),l=E(e,"checked"),M=Q(l,i),C=Se(()=>{if(a){const o=a.valueSetRef.value;return o&&e.value!==void 0?o.has(e.value):!1}else return M.value===e.checkedValue}),z=Y(e,{mergedSize(o){const{size:p}=e;if(p!==void 0)return p;if(a){const{value:h}=a.mergedSizeRef;if(h!==void 0)return h}if(o){const{mergedSize:h}=o;if(h!==void 0)return h.value}const y=T?.value?.Checkbox?.size;return y||"medium"},mergedDisabled(o){const{disabled:p}=e;if(p!==void 0)return p;if(a){if(a.disabledRef.value)return!0;const{maxRef:{value:y},checkedCountRef:h}=a;if(y!==void 0&&h.value>=y&&!C.value)return!0;const{minRef:{value:F}}=a;if(F!==void 0&&h.value<=F&&C.value)return!0}return o?o.disabled.value:!1}}),{mergedDisabledRef:c,mergedSizeRef:m}=z,d=q("Checkbox","-checkbox",Ne,Te,e,n);function u(o){if(a&&e.value!==void 0)a.toggleCheckbox(!C.value,e.value);else{const{onChange:p,"onUpdate:checked":y,onUpdateChecked:h}=e,{nTriggerFormInput:F,nTriggerFormChange:P}=z,A=C.value?e.uncheckedValue:e.checkedValue;y&&s(y,A,o),h&&s(h,A,o),p&&s(p,A,o),F(),P(),i.value=A}}function x(o){c.value||u(o)}function g(o){if(!c.value)switch(o.key){case" ":case"Enter":u(o)}}function b(o){o.key===" "&&o.preventDefault()}const I={focus:()=>{r.value?.focus()},blur:()=>{r.value?.blur()}},N=_e("Checkbox",f,n),G=U(()=>{const{value:o}=m,{common:{cubicBezierEaseInOut:p},self:{borderRadius:y,color:h,colorChecked:F,colorDisabled:P,colorTableHeader:A,colorTableHeaderModal:X,colorTableHeaderPopover:Z,checkMarkColor:ee,checkMarkColorDisabled:oe,border:re,borderFocus:ae,borderDisabled:ce,borderChecked:ne,boxShadowFocus:le,textColor:te,textColorDisabled:ie,checkMarkColorDisabledChecked:de,colorDisabledChecked:se,borderDisabledChecked:ue,labelPadding:be,labelLineHeight:he,labelFontWeight:fe,[j("fontSize",o)]:ke,[j("size",o)]:ve}}=d.value;return{"--n-label-line-height":he,"--n-label-font-weight":fe,"--n-size":ve,"--n-bezier":p,"--n-border-radius":y,"--n-border":re,"--n-border-checked":ne,"--n-border-focus":ae,"--n-border-disabled":ce,"--n-border-disabled-checked":ue,"--n-box-shadow-focus":le,"--n-color":h,"--n-color-checked":F,"--n-color-table":A,"--n-color-table-modal":X,"--n-color-table-popover":Z,"--n-color-disabled":P,"--n-color-disabled-checked":se,"--n-text-color":te,"--n-text-color-disabled":ie,"--n-check-mark-color":ee,"--n-check-mark-color-disabled":oe,"--n-check-mark-color-disabled-checked":de,"--n-font-size":ke,"--n-label-padding":be}}),H=k?Be("checkbox",U(()=>m.value[0]),G,e):void 0;return Object.assign(z,I,{rtlEnabled:N,selfRef:r,mergedClsPrefix:n,mergedDisabled:c,renderedChecked:C,mergedTheme:d,labelId:$e(),handleClick:x,handleKeyUp:g,handleKeyDown:b,cssVars:k?void 0:G,themeClass:H?.themeClass,onRender:H?.onRender})},render(){const{$slots:e,renderedChecked:a,mergedDisabled:r,indeterminate:n,privateInsideTable:k,cssVars:f,labelId:T,label:i,mergedClsPrefix:l,focusable:M,handleKeyUp:C,handleKeyDown:z,handleClick:c}=this;this.onRender?.();const m=pe(e.default,d=>i||d?(S(),$("span",{key:1,class:R(`${l}-checkbox__label`),id:T},[B(()=>i||d)],10,Pe)):null);return(()=>{const d=V("70be6e74cd27cb50");return S(),$("div",{ref:"selfRef",class:R([`${l}-checkbox`,this.themeClass,this.rtlEnabled&&`${l}-checkbox--rtl`,a&&`${l}-checkbox--checked`,r&&`${l}-checkbox--disabled`,n&&`${l}-checkbox--indeterminate`,k&&`${l}-checkbox--inside-table`,m&&`${l}-checkbox--show-label`]),tabindex:r||!M?void 0:0,role:"checkbox","aria-checked":n?"mixed":a,"aria-labelledby":T,style:ze(f),onKeyup:C,onKeydown:z,onClick:c,onMousedown:d[0]||(d[0]=()=>{we("selectstart",window,u=>{u.preventDefault()},{once:!0})})},[D("div",{class:R(`${l}-checkbox-box-wrapper`)},[d[1]||(d[1]=B(" ",-1)),D("div",{class:R(`${l}-checkbox-box`)},[ye(Ce,null,{default:()=>this.indeterminate?(S(),$("div",{key:"indeterminate",class:R(`${l}-checkbox-icon`)},[B(()=>Ue())],2)):(S(),$("div",{key:"check",class:R(`${l}-checkbox-icon`)},[B(()=>Ie())],2))},1024),D("div",{class:R(`${l}-checkbox-box__border`)},null,2)],2)],2),B(()=>m)],46,Ke)})()}});const J=Fe("n-checkbox-group"),Ge={min:Number,max:Number,size:String,options:Array,labelField:{type:String,default:"label"},valueField:{type:String,default:"value"},value:Array,defaultValue:{type:Array,default:null},disabled:{type:Boolean,default:void 0},"onUpdate:value":[Function,Array],onUpdateValue:[Function,Array],onChange:[Function,Array]};var je=O({name:"CheckboxGroup",props:Ge,setup(e){const{mergedClsPrefixRef:a}=W(e),r=Y(e),{mergedSizeRef:n,mergedDisabledRef:k}=r,f=K(e.defaultValue),T=U(()=>e.value),i=Q(T,f),l=U(()=>i.value?.length||0),M=U(()=>Array.isArray(i.value)?new Set(i.value):new Set);function C(z,c){const{nTriggerFormInput:m,nTriggerFormChange:d}=r,{onChange:u,"onUpdate:value":x,onUpdateValue:g}=e;if(Array.isArray(i.value)){const b=Array.from(i.value),I=b.findIndex(N=>N===c);z?~I||(b.push(c),g&&s(g,b,{actionType:"check",value:c}),x&&s(x,b,{actionType:"check",value:c}),m(),d(),f.value=b,u&&s(u,b)):~I&&(b.splice(I,1),g&&s(g,b,{actionType:"uncheck",value:c}),x&&s(x,b,{actionType:"uncheck",value:c}),u&&s(u,b),f.value=b,m(),d())}else z?(g&&s(g,[c],{actionType:"check",value:c}),x&&s(x,[c],{actionType:"check",value:c}),u&&s(u,[c]),f.value=[c],m(),d()):(g&&s(g,[],{actionType:"uncheck",value:c}),x&&s(x,[],{actionType:"uncheck",value:c}),u&&s(u,[]),f.value=[],m(),d())}return Ae(J,{checkedCountRef:l,maxRef:E(e,"max"),minRef:E(e,"min"),valueSetRef:M,disabledRef:k,mergedSizeRef:n,toggleCheckbox:C}),{mergedClsPrefix:a}},render(){const{options:e,labelField:a,valueField:r}=this.$props;return S(),$("div",{class:R(`${this.mergedClsPrefix}-checkbox-group`),role:"group"},[e?(S(),$(L,{key:0},[B(()=>e.map(n=>{const k=n[r];return S(),De(Ve,{key:k,value:k,disabled:n.disabled,label:n[a]},null,8,["value","disabled","label"])}))],64)):(S(),$(L,{key:1},[B(()=>this.$slots.default?.())],64))],2)}});async function Le(e){const a=String(e??"");if(navigator.clipboard&&typeof navigator.clipboard.writeText=="function"&&window.isSecureContext)try{await navigator.clipboard.writeText(a);return}catch{}const r=document.createElement("textarea");r.value=a,r.setAttribute("readonly",""),r.style.position="fixed",r.style.top="-1000px",r.style.opacity="0";const n=document.activeElement,k='[role="dialog"], [aria-modal="true"]',f=document.querySelectorAll('[aria-modal="true"]');(n&&typeof n.closest=="function"&&n.closest(k)||f[f.length-1]||document.body).appendChild(r),r.focus(),r.select();let i=!1;try{i=document.execCommand("copy")}catch{i=!1}if(r.remove(),n&&typeof n.focus=="function"&&n.focus(),!i)throw new Error(Me("utils.clipboardBlocked"))}export{Ve as C,je as a,Le as c};
