import{cW as Ot,c2 as $t,cX as Ao,cY as Bo,cZ as Qt,c_ as ko,c$ as Ze,d0 as kn,d1 as Qe,d2 as jt,d3 as _o,d4 as dn,d5 as Io,d6 as un,d7 as cn,d8 as xt,d9 as Eo,da as fn,c1 as Ro,db as Do,dc as en,dd as Lo,de as No,df as Wo,dg as _n,cE as Vo,dh as Ko,di as Ho,dj as Uo,dk as jo,bU as In,N as Ne,a2 as We,dl as Go,$ as ge,cn as Ye,ck as De,cr as Ae,r as T,a7 as En,a5 as Rn,a6 as Dn,d as ue,dm as Xo,a4 as Le,dn as Yo,x as ct,dp as hn,V as be,ae as Ln,a9 as qo,c3 as Nn,A as fe,B as Pt,w as Z,l as tn,b9 as Jo,c as ne,a as B,c6 as qe,G as X,F as re,dq as Zo,o as p,b as O,D as de,M as Oe,n as _,u as $e,s as H,t as Me,T as nn,g as Ft,dr as Qo,O as on,a1 as rn,k as Tt,m as W,P as pn,Z as er,z as Be,C as F,aq as at,af as ie,cz as tr,ad as Et,y as Ct,U as Wn,p as Gt,ds as nr,cc as or,dt as rr,i as Xt,q as ae,c9 as Vn,b_ as ir,du as Rt,c4 as Kn,c5 as Xe,cp as Dt,bX as lr,f as Hn,cF as ar,X as sr,S as dr,dv as ur,cB as cr,Q as Re,cb as st,dw as fr,b7 as Lt,al as hr,dx as pr,e as vr,ao as gr,h as br,ap as mr,dy as wr}from"./index-C1wQvtt2.js";import{d as yr,a as Un,b as lt,E as xr,h as dt,e as Cr,V as Sr,c as Mr}from"./create-BGnvRatF.js";var Yt=Ot($t,"WeakMap"),Or=Ao(Object.keys,Object),$r=Object.prototype,Pr=$r.hasOwnProperty;function Fr(e){if(!Bo(e))return Or(e);var t=[];for(var n in Object(e))Pr.call(e,n)&&n!="constructor"&&t.push(n);return t}function ln(e){return Qt(e)?ko(e):Fr(e)}function Tr(e,t){for(var n=-1,o=t.length,r=e.length;++n<o;)e[r+n]=t[n];return e}function zr(e,t){for(var n=-1,o=e==null?0:e.length,r=0,a=[];++n<o;){var i=e[n];t(i,n,e)&&(a[r++]=i)}return a}function Ar(){return[]}var Br=Object.prototype,kr=Br.propertyIsEnumerable,vn=Object.getOwnPropertySymbols,_r=vn?function(e){return e==null?[]:(e=Object(e),zr(vn(e),function(t){return kr.call(e,t)}))}:Ar;function Ir(e,t,n){var o=t(e);return Ze(e)?o:Tr(o,n(e))}function gn(e){return Ir(e,ln,_r)}var qt=Ot($t,"DataView"),Jt=Ot($t,"Promise"),Zt=Ot($t,"Set"),bn="[object Map]",Er="[object Object]",mn="[object Promise]",wn="[object Set]",yn="[object WeakMap]",xn="[object DataView]",Rr=Qe(qt),Dr=Qe(jt),Lr=Qe(Jt),Nr=Qe(Zt),Wr=Qe(Yt),ze=kn;(qt&&ze(new qt(new ArrayBuffer(1)))!=xn||jt&&ze(new jt)!=bn||Jt&&ze(Jt.resolve())!=mn||Zt&&ze(new Zt)!=wn||Yt&&ze(new Yt)!=yn)&&(ze=function(e){var t=kn(e),n=t==Er?e.constructor:void 0,o=n?Qe(n):"";if(o)switch(o){case Rr:return xn;case Dr:return bn;case Lr:return mn;case Nr:return wn;case Wr:return yn}return t});var Vr="__lodash_hash_undefined__";function Kr(e){return this.__data__.set(e,Vr),this}function Hr(e){return this.__data__.has(e)}function St(e){var t=-1,n=e==null?0:e.length;for(this.__data__=new _o;++t<n;)this.add(e[t])}St.prototype.add=St.prototype.push=Kr;St.prototype.has=Hr;function Ur(e,t){for(var n=-1,o=e==null?0:e.length;++n<o;)if(t(e[n],n,e))return!0;return!1}function jr(e,t){return e.has(t)}var Gr=1,Xr=2;function jn(e,t,n,o,r,a){var i=n&Gr,l=e.length,s=t.length;if(l!=s&&!(i&&s>l))return!1;var x=a.get(e),b=a.get(t);if(x&&b)return x==t&&b==e;var m=-1,u=!0,h=n&Xr?new St:void 0;for(a.set(e,t),a.set(t,e);++m<l;){var v=e[m],g=t[m];if(o)var M=i?o(g,v,m,t,e,a):o(v,g,m,e,t,a);if(M!==void 0){if(M)continue;u=!1;break}if(h){if(!Ur(t,function(c,C){if(!jr(h,C)&&(v===c||r(v,c,n,o,a)))return h.push(C)})){u=!1;break}}else if(!(v===g||r(v,g,n,o,a))){u=!1;break}}return a.delete(e),a.delete(t),u}function Yr(e){var t=-1,n=Array(e.size);return e.forEach(function(o,r){n[++t]=[r,o]}),n}function qr(e){var t=-1,n=Array(e.size);return e.forEach(function(o){n[++t]=o}),n}var Jr=1,Zr=2,Qr="[object Boolean]",ei="[object Date]",ti="[object Error]",ni="[object Map]",oi="[object Number]",ri="[object RegExp]",ii="[object Set]",li="[object String]",ai="[object Symbol]",si="[object ArrayBuffer]",di="[object DataView]",Cn=dn?dn.prototype:void 0,Nt=Cn?Cn.valueOf:void 0;function ui(e,t,n,o,r,a,i){switch(n){case di:if(e.byteLength!=t.byteLength||e.byteOffset!=t.byteOffset)return!1;e=e.buffer,t=t.buffer;case si:return!(e.byteLength!=t.byteLength||!a(new un(e),new un(t)));case Qr:case ei:case oi:return Io(+e,+t);case ti:return e.name==t.name&&e.message==t.message;case ri:case li:return e==t+"";case ni:var l=Yr;case ii:var s=o&Jr;if(l||(l=qr),e.size!=t.size&&!s)return!1;var x=i.get(e);if(x)return x==t;o|=Zr,i.set(e,t);var b=jn(l(e),l(t),o,r,a,i);return i.delete(e),b;case ai:if(Nt)return Nt.call(e)==Nt.call(t)}return!1}var ci=1,fi=Object.prototype,hi=fi.hasOwnProperty;function pi(e,t,n,o,r,a){var i=n&ci,l=gn(e),s=l.length,x=gn(t),b=x.length;if(s!=b&&!i)return!1;for(var m=s;m--;){var u=l[m];if(!(i?u in t:hi.call(t,u)))return!1}var h=a.get(e),v=a.get(t);if(h&&v)return h==t&&v==e;var g=!0;a.set(e,t),a.set(t,e);for(var M=i;++m<s;){u=l[m];var c=e[u],C=t[u];if(o)var P=i?o(C,c,u,t,e,a):o(c,C,u,e,t,a);if(!(P===void 0?c===C||r(c,C,n,o,a):P)){g=!1;break}M||(M=u=="constructor")}if(g&&!M){var D=e.constructor,R=t.constructor;D!=R&&"constructor"in e&&"constructor"in t&&!(typeof D=="function"&&D instanceof D&&typeof R=="function"&&R instanceof R)&&(g=!1)}return a.delete(e),a.delete(t),g}var vi=1,Sn="[object Arguments]",Mn="[object Array]",wt="[object Object]",gi=Object.prototype,On=gi.hasOwnProperty;function bi(e,t,n,o,r,a){var i=Ze(e),l=Ze(t),s=i?Mn:ze(e),x=l?Mn:ze(t);s=s==Sn?wt:s,x=x==Sn?wt:x;var b=s==wt,m=x==wt,u=s==x;if(u&&cn(e)){if(!cn(t))return!1;i=!0,b=!1}if(u&&!b)return a||(a=new xt),i||Eo(e)?jn(e,t,n,o,r,a):ui(e,t,s,n,o,r,a);if(!(n&vi)){var h=b&&On.call(e,"__wrapped__"),v=m&&On.call(t,"__wrapped__");if(h||v){var g=h?e.value():e,M=v?t.value():t;return a||(a=new xt),r(g,M,n,o,a)}}return u?(a||(a=new xt),pi(e,t,n,o,r,a)):!1}function an(e,t,n,o,r){return e===t?!0:e==null||t==null||!fn(e)&&!fn(t)?e!==e&&t!==t:bi(e,t,n,o,an,r)}var mi=1,wi=2;function yi(e,t,n,o){var r=n.length,a=r;if(e==null)return!a;for(e=Object(e);r--;){var i=n[r];if(i[2]?i[1]!==e[i[0]]:!(i[0]in e))return!1}for(;++r<a;){i=n[r];var l=i[0],s=e[l],x=i[1];if(i[2]){if(s===void 0&&!(l in e))return!1}else{var b=new xt,m;if(!(m===void 0?an(x,s,mi|wi,o,b):m))return!1}}return!0}function Gn(e){return e===e&&!Ro(e)}function xi(e){for(var t=ln(e),n=t.length;n--;){var o=t[n],r=e[o];t[n]=[o,r,Gn(r)]}return t}function Xn(e,t){return function(n){return n==null?!1:n[e]===t&&(t!==void 0||e in Object(n))}}function Ci(e){var t=xi(e);return t.length==1&&t[0][2]?Xn(t[0][0],t[0][1]):function(n){return n===e||yi(n,e,t)}}function Si(e,t){return e!=null&&t in Object(e)}function Mi(e,t,n){t=Do(t,e);for(var o=-1,r=t.length,a=!1;++o<r;){var i=en(t[o]);if(!(a=e!=null&&n(e,i)))break;e=e[i]}return a||++o!=r?a:(r=e==null?0:e.length,!!r&&Lo(r)&&No(i,r)&&(Ze(e)||Wo(e)))}function Oi(e,t){return e!=null&&Mi(e,t,Si)}var $i=1,Pi=2;function Fi(e,t){return _n(e)&&Gn(t)?Xn(en(e),t):function(n){var o=Vo(n,e);return o===void 0&&o===t?Oi(n,e):an(t,o,$i|Pi)}}function Ti(e){return function(t){return t?.[e]}}function zi(e){return function(t){return Ko(t,e)}}function Ai(e){return _n(e)?Ti(en(e)):zi(e)}function Bi(e){return typeof e=="function"?e:e==null?Ho:typeof e=="object"?Ze(e)?Fi(e[0],e[1]):Ci(e):Ai(e)}function ki(e,t){return e&&Uo(e,t,ln)}function _i(e,t){return function(n,o){if(n==null)return n;if(!Qt(n))return e(n,o);for(var r=n.length,a=-1,i=Object(n);++a<r&&o(i[a],a,i)!==!1;);return n}}var Ii=_i(ki);function Ei(e,t){var n=-1,o=Qt(e)?Array(e.length):[];return Ii(e,function(r,a,i){o[++n]=t(r,a,i)}),o}function Ri(e,t){var n=Ze(e)?jo:Ei;return n(e,Bi(t))}const sn=In("n-internal-select-menu"),Yn=In("n-internal-select-menu-body");let Je,ut;const Di=()=>{var e,t;Je=Go?(t=(e=document)===null||e===void 0?void 0:e.fonts)===null||t===void 0?void 0:t.ready:void 0,ut=!1,Je!==void 0?Je.then(()=>{ut=!0}):ut=!0};Di();function Li(e){if(ut)return;let t=!1;Ne(()=>{ut||Je?.then(()=>{t||e()})}),We(()=>{t=!0})}const qn="__disabled__";function Pe(e){const t=ge(En,null),n=ge(Rn,null),o=ge(Dn,null),r=ge(Yn,null),a=T();if(typeof document<"u"){a.value=document.fullscreenElement;const i=()=>{a.value=document.fullscreenElement};Ne(()=>{Ye("fullscreenchange",document,i)}),We(()=>{De("fullscreenchange",document,i)})}return Ae(()=>{const{to:i}=e;return i!==void 0?i===!1?qn:i===!0?a.value||"body":i:t?.value?t.value.$el??t.value:n?.value?n.value:o?.value?o.value:r?.value?r.value:i??(a.value||"body")})}Pe.tdkey=qn;Pe.propTo={type:[String,Object,Boolean],default:void 0};let Wt;function Ni(){return Wt===void 0&&(Wt=navigator.userAgent.includes("Node.js")||navigator.userAgent.includes("jsdom")),Wt}let Te=null;function Jn(){if(Te===null&&(Te=document.getElementById("v-binder-view-measurer"),Te===null)){Te=document.createElement("div"),Te.id="v-binder-view-measurer";const{style:e}=Te;e.position="fixed",e.left="0",e.right="0",e.top="0",e.bottom="0",e.pointerEvents="none",e.visibility="hidden",document.body.appendChild(Te)}return Te.getBoundingClientRect()}function Wi(e,t){const n=Jn();return{top:t,left:e,height:0,width:0,right:n.width-e,bottom:n.height-t}}function Vt(e){const t=e.getBoundingClientRect(),n=Jn();return{left:t.left-n.left,top:t.top-n.top,bottom:n.height+n.top-t.bottom,right:n.width+n.left-t.right,width:t.width,height:t.height}}function Vi(e){return e.nodeType===9?null:e.parentNode}function Zn(e){if(e===null)return null;const t=Vi(e);if(t===null)return null;if(t.nodeType===9)return document;if(t.nodeType===1){const{overflow:n,overflowX:o,overflowY:r}=getComputedStyle(t);if(/(auto|scroll|overlay)/.test(n+r+o))return t}return Zn(t)}const Qn=ue({name:"Binder",props:{syncTargetWithParent:Boolean,syncTarget:{type:Boolean,default:!0}},setup(e){var t;Le("VBinder",(t=Yo())===null||t===void 0?void 0:t.proxy);const n=ge("VBinder",null),o=T(null),r=c=>{o.value=c,n&&e.syncTargetWithParent&&n.setTargetRef(c)};let a=[];const i=()=>{let c=o.value;for(;c=Zn(c),c!==null;)a.push(c);for(const C of a)Ye("scroll",C,m,!0)},l=()=>{for(const c of a)De("scroll",c,m,!0);a=[]},s=new Set,x=c=>{s.size===0&&i(),s.has(c)||s.add(c)},b=c=>{s.has(c)&&s.delete(c),s.size===0&&l()},m=()=>{yr(u)},u=()=>{s.forEach(c=>c())},h=new Set,v=c=>{h.size===0&&Ye("resize",window,M),h.has(c)||h.add(c)},g=c=>{h.has(c)&&h.delete(c),h.size===0&&De("resize",window,M)},M=()=>{h.forEach(c=>c())};return We(()=>{De("resize",window,M),l()}),{targetRef:o,setTargetRef:r,addScrollListener:x,removeScrollListener:b,addResizeListener:v,removeResizeListener:g}},render(){return Xo("binder",this.$slots)}}),eo=ue({name:"Target",setup(){const{setTargetRef:e,syncTarget:t}=ge("VBinder");return{syncTarget:t,setTargetDirective:{mounted:e,updated:e}}},render(){const{syncTarget:e,setTargetDirective:t}=this;return e?ct(hn("follower",this.$slots),[[t]]):hn("follower",this.$slots)}}),Ge="@@mmoContext",Ki={mounted(e,{value:t}){e[Ge]={handler:void 0},typeof t=="function"&&(e[Ge].handler=t,Ye("mousemoveoutside",e,t))},updated(e,{value:t}){const n=e[Ge];typeof t=="function"?n.handler?n.handler!==t&&(De("mousemoveoutside",e,n.handler),n.handler=t,Ye("mousemoveoutside",e,t)):(e[Ge].handler=t,Ye("mousemoveoutside",e,t)):n.handler&&(De("mousemoveoutside",e,n.handler),n.handler=void 0)},unmounted(e){const{handler:t}=e[Ge];t&&De("mousemoveoutside",e,t),e[Ge].handler=void 0}},yt={top:"bottom",bottom:"top",left:"right",right:"left"},$n={start:"end",center:"center",end:"start"},Kt={top:"height",bottom:"height",left:"width",right:"width"},Hi={"bottom-start":"top left",bottom:"top center","bottom-end":"top right","top-start":"bottom left",top:"bottom center","top-end":"bottom right","right-start":"top left",right:"center left","right-end":"bottom left","left-start":"top right",left:"center right","left-end":"bottom right"},Ui={"bottom-start":"bottom left",bottom:"bottom center","bottom-end":"bottom right","top-start":"top left",top:"top center","top-end":"top right","right-start":"top right",right:"center right","right-end":"bottom right","left-start":"top left",left:"center left","left-end":"bottom left"},ji={"bottom-start":"right","bottom-end":"left","top-start":"right","top-end":"left","right-start":"bottom","right-end":"top","left-start":"bottom","left-end":"top"},Pn={top:!0,bottom:!1,left:!0,right:!1},Fn={top:"end",bottom:"start",left:"end",right:"start"};function Gi(e,t,n,o,r,a){if(!r||a)return{placement:e,top:0,left:0};const[i,l]=e.split("-");let s=l??"center",x={top:0,left:0};const b=(h,v,g)=>{let M=0,c=0;const C=n[h]-t[v]-t[h];return C>0&&o&&(g?c=Pn[v]?C:-C:M=Pn[v]?C:-C),{left:M,top:c}},m=i==="left"||i==="right";if(s!=="center"){const h=ji[e],v=yt[h],g=Kt[h];if(n[g]>t[g]){if(t[h]+t[g]<n[g]){const M=(n[g]-t[g])/2;t[h]<M||t[v]<M?t[h]<t[v]?(s=$n[l],x=b(g,v,m)):x=b(g,h,m):s="center"}}else n[g]<t[g]&&t[v]<0&&t[h]>t[v]&&(s=$n[l])}else{const h=i==="bottom"||i==="top"?"left":"top",v=yt[h],g=Kt[h],M=(n[g]-t[g])/2;(t[h]<M||t[v]<M)&&(t[h]>t[v]?(s=Fn[h],x=b(g,h,m)):(s=Fn[v],x=b(g,v,m)))}let u=i;return t[i]<n[Kt[i]]&&t[i]<t[yt[i]]&&(u=yt[i]),{placement:s!=="center"?`${u}-${s}`:u,left:x.left,top:x.top}}function Xi(e,t){return t?Ui[e]:Hi[e]}function Yi(e,t,n,o,r,a){if(a)switch(e){case"bottom-start":return{top:`${Math.round(n.top-t.top+n.height)}px`,left:`${Math.round(n.left-t.left)}px`,transform:"translateY(-100%)"};case"bottom-end":return{top:`${Math.round(n.top-t.top+n.height)}px`,left:`${Math.round(n.left-t.left+n.width)}px`,transform:"translateX(-100%) translateY(-100%)"};case"top-start":return{top:`${Math.round(n.top-t.top)}px`,left:`${Math.round(n.left-t.left)}px`,transform:""};case"top-end":return{top:`${Math.round(n.top-t.top)}px`,left:`${Math.round(n.left-t.left+n.width)}px`,transform:"translateX(-100%)"};case"right-start":return{top:`${Math.round(n.top-t.top)}px`,left:`${Math.round(n.left-t.left+n.width)}px`,transform:"translateX(-100%)"};case"right-end":return{top:`${Math.round(n.top-t.top+n.height)}px`,left:`${Math.round(n.left-t.left+n.width)}px`,transform:"translateX(-100%) translateY(-100%)"};case"left-start":return{top:`${Math.round(n.top-t.top)}px`,left:`${Math.round(n.left-t.left)}px`,transform:""};case"left-end":return{top:`${Math.round(n.top-t.top+n.height)}px`,left:`${Math.round(n.left-t.left)}px`,transform:"translateY(-100%)"};case"top":return{top:`${Math.round(n.top-t.top)}px`,left:`${Math.round(n.left-t.left+n.width/2)}px`,transform:"translateX(-50%)"};case"right":return{top:`${Math.round(n.top-t.top+n.height/2)}px`,left:`${Math.round(n.left-t.left+n.width)}px`,transform:"translateX(-100%) translateY(-50%)"};case"left":return{top:`${Math.round(n.top-t.top+n.height/2)}px`,left:`${Math.round(n.left-t.left)}px`,transform:"translateY(-50%)"};default:return{top:`${Math.round(n.top-t.top+n.height)}px`,left:`${Math.round(n.left-t.left+n.width/2)}px`,transform:"translateX(-50%) translateY(-100%)"}}switch(e){case"bottom-start":return{top:`${Math.round(n.top-t.top+n.height+o)}px`,left:`${Math.round(n.left-t.left+r)}px`,transform:""};case"bottom-end":return{top:`${Math.round(n.top-t.top+n.height+o)}px`,left:`${Math.round(n.left-t.left+n.width+r)}px`,transform:"translateX(-100%)"};case"top-start":return{top:`${Math.round(n.top-t.top+o)}px`,left:`${Math.round(n.left-t.left+r)}px`,transform:"translateY(-100%)"};case"top-end":return{top:`${Math.round(n.top-t.top+o)}px`,left:`${Math.round(n.left-t.left+n.width+r)}px`,transform:"translateX(-100%) translateY(-100%)"};case"right-start":return{top:`${Math.round(n.top-t.top+o)}px`,left:`${Math.round(n.left-t.left+n.width+r)}px`,transform:""};case"right-end":return{top:`${Math.round(n.top-t.top+n.height+o)}px`,left:`${Math.round(n.left-t.left+n.width+r)}px`,transform:"translateY(-100%)"};case"left-start":return{top:`${Math.round(n.top-t.top+o)}px`,left:`${Math.round(n.left-t.left+r)}px`,transform:"translateX(-100%)"};case"left-end":return{top:`${Math.round(n.top-t.top+n.height+o)}px`,left:`${Math.round(n.left-t.left+r)}px`,transform:"translateX(-100%) translateY(-100%)"};case"top":return{top:`${Math.round(n.top-t.top+o)}px`,left:`${Math.round(n.left-t.left+n.width/2+r)}px`,transform:"translateY(-100%) translateX(-50%)"};case"right":return{top:`${Math.round(n.top-t.top+n.height/2+o)}px`,left:`${Math.round(n.left-t.left+n.width+r)}px`,transform:"translateY(-50%)"};case"left":return{top:`${Math.round(n.top-t.top+n.height/2+o)}px`,left:`${Math.round(n.left-t.left+r)}px`,transform:"translateY(-50%) translateX(-100%)"};default:return{top:`${Math.round(n.top-t.top+n.height+o)}px`,left:`${Math.round(n.left-t.left+n.width/2+r)}px`,transform:"translateX(-50%)"}}}const qi=lt([lt(".v-binder-follower-container",{position:"absolute",left:"0",right:"0",top:"0",height:"0",pointerEvents:"none",zIndex:"auto"}),lt(".v-binder-follower-content",{position:"absolute",zIndex:"auto"},[lt("> *",{pointerEvents:"all"})])]),to=ue({name:"Follower",inheritAttrs:!1,props:{show:Boolean,enabled:{type:Boolean,default:void 0},placement:{type:String,default:"bottom"},syncTrigger:{type:Array,default:["resize","scroll"]},to:[String,Object],flip:{type:Boolean,default:!0},internalShift:Boolean,x:Number,y:Number,width:String,minWidth:String,containerClass:String,teleportDisabled:Boolean,zindexable:{type:Boolean,default:!0},zIndex:Number,overlap:Boolean},setup(e){const t=ge("VBinder"),n=Ae(()=>e.enabled!==void 0?e.enabled:e.show),o=T(null),r=T(null),a=()=>{const{syncTrigger:u}=e;u.includes("scroll")&&t.addScrollListener(s),u.includes("resize")&&t.addResizeListener(s)},i=()=>{t.removeScrollListener(s),t.removeResizeListener(s)};Ne(()=>{n.value&&(s(),a())});const l=Nn();qi.mount({id:"vueuc/binder",head:!0,anchorMetaName:Un,ssr:l}),We(()=>{i()}),Li(()=>{n.value&&s()});const s=()=>{if(!n.value)return;const u=o.value;if(u===null)return;const h=t.targetRef,{x:v,y:g,overlap:M}=e,c=v!==void 0&&g!==void 0?Wi(v,g):Vt(h);u.style.setProperty("--v-target-width",`${Math.round(c.width)}px`),u.style.setProperty("--v-target-height",`${Math.round(c.height)}px`);const{width:C,minWidth:P,placement:D,internalShift:R,flip:L}=e;u.setAttribute("v-placement",D),M?u.setAttribute("v-overlap",""):u.removeAttribute("v-overlap");const{style:U}=u;C==="target"?U.width=`${c.width}px`:C!==void 0?U.width=C:U.width="",P==="target"?U.minWidth=`${c.width}px`:P!==void 0?U.minWidth=P:U.minWidth="";const Q=Vt(u),z=Vt(r.value),{left:V,top:S,placement:I}=Gi(D,c,Q,R,L,M),te=Xi(I,M),{left:$,top:q,transform:j}=Yi(I,z,c,S,V,M);u.setAttribute("v-placement",I),u.style.setProperty("--v-offset-left",`${Math.round(V)}px`),u.style.setProperty("--v-offset-top",`${Math.round(S)}px`),u.style.transform=`translateX(${$}) translateY(${q}) ${j}`,u.style.setProperty("--v-transform-origin",te),u.style.transformOrigin=te};fe(n,u=>{u?(a(),x()):i()});const x=()=>{Pt().then(s).catch(u=>console.error(u))};["placement","x","y","internalShift","flip","width","overlap","minWidth"].forEach(u=>{fe(Z(e,u),s)}),["teleportDisabled"].forEach(u=>{fe(Z(e,u),x)}),fe(Z(e,"syncTrigger"),u=>{u.includes("resize")?t.addResizeListener(s):t.removeResizeListener(s),u.includes("scroll")?t.addScrollListener(s):t.removeScrollListener(s)});const b=tn(),m=Ae(()=>{const{to:u}=e;if(u!==void 0)return u;b.value});return{VBinder:t,mergedEnabled:n,offsetContainerRef:r,followerRef:o,mergedTo:m,syncPosition:s}},render(){return be(qo,{show:this.show,to:this.mergedTo,disabled:this.teleportDisabled},{default:()=>{var e,t;const n=be("div",{class:["v-binder-follower-container",this.containerClass],ref:"offsetContainerRef"},[be("div",{class:"v-binder-follower-content",ref:"followerRef"},(t=(e=this.$slots).default)===null||t===void 0?void 0:t.call(e))]);return this.zindexable?ct(n,[[Ln,{enabled:this.mergedEnabled,zIndex:this.zIndex}]]):n}})}}),Ce="v-hidden",Ji=lt("[v-hidden]",{display:"none!important"}),Tn=ue({name:"Overflow",props:{getCounter:Function,getTail:Function,updateCounter:Function,onUpdateCount:Function,onUpdateOverflow:Function},setup(e,{slots:t}){const n=T(null),o=T(null);function r(i){const{value:l}=n,{getCounter:s,getTail:x}=e;let b;if(s!==void 0?b=s():b=o.value,!l||!b)return;b.hasAttribute(Ce)&&b.removeAttribute(Ce);const{children:m}=l;if(i.showAllItemsBeforeCalculate)for(const P of m)P.hasAttribute(Ce)&&P.removeAttribute(Ce);const u=l.offsetWidth,h=[],v=t.tail?x?.():null;let g=v?v.offsetWidth:0,M=!1;const c=l.children.length-(t.tail?1:0);for(let P=0;P<c-1;++P){if(P<0)continue;const D=m[P];if(M){D.hasAttribute(Ce)||D.setAttribute(Ce,"");continue}else D.hasAttribute(Ce)&&D.removeAttribute(Ce);const R=D.offsetWidth;if(g+=R,h[P]=R,g>u){const{updateCounter:L}=e;for(let U=P;U>=0;--U){const Q=c-1-U;L!==void 0?L(Q):b.textContent=`${Q}`;const z=b.offsetWidth;if(g-=h[U],g+z<=u||U===0){M=!0,P=U-1,v&&(P===-1?(v.style.maxWidth=`${u-z}px`,v.style.boxSizing="border-box"):v.style.maxWidth="");const{onUpdateCount:V}=e;V&&V(Q);break}}}}const{onUpdateOverflow:C}=e;M?C!==void 0&&C(!0):(C!==void 0&&C(!1),b.setAttribute(Ce,""))}const a=Nn();return Ji.mount({id:"vueuc/overflow",head:!0,anchorMetaName:Un,ssr:a}),Ne(()=>r({showAllItemsBeforeCalculate:!1})),{selfRef:n,counterRef:o,sync:r}},render(){const{$slots:e}=this;return Pt(()=>this.sync({showAllItemsBeforeCalculate:!1})),be("div",{class:"v-overflow",ref:"selfRef"},[Jo(e,"default"),e.counter?e.counter():be("span",{style:{display:"inline-block"},ref:"counterRef"}),e.tail?e.tail():null])}}),Ht={top:"bottom",bottom:"top",left:"right",right:"left"},ee="var(--n-arrow-height) * 1.414";var Zi=ne([B("popover",`
 transition:
 box-shadow .3s var(--n-bezier),
 background-color .3s var(--n-bezier),
 color .3s var(--n-bezier);
 position: relative;
 font-size: var(--n-font-size);
 color: var(--n-text-color);
 box-shadow: var(--n-box-shadow);
 word-break: break-word;
 `,[ne(">",[B("scrollbar",`
 height: inherit;
 max-height: inherit;
 `)]),qe("raw",`
 background-color: var(--n-color);
 border-radius: var(--n-border-radius);
 `,[qe("scrollable",[qe("show-header-or-footer","padding: var(--n-padding);")])]),X("header",`
 padding: var(--n-padding);
 border-bottom: 1px solid var(--n-divider-color);
 transition: border-color .3s var(--n-bezier);
 `),X("footer",`
 padding: var(--n-padding);
 border-top: 1px solid var(--n-divider-color);
 transition: border-color .3s var(--n-bezier);
 `),re("scrollable, show-header-or-footer",[X("content",`
 padding: var(--n-padding);
 `)])]),B("popover-shared",`
 transform-origin: inherit;
 `,[B("popover-arrow-wrapper",`
 position: absolute;
 overflow: hidden;
 pointer-events: none;
 `,[B("popover-arrow",`
 transition: background-color .3s var(--n-bezier);
 position: absolute;
 display: block;
 width: calc(${ee});
 height: calc(${ee});
 box-shadow: 0 0 8px 0 rgba(0, 0, 0, .12);
 transform: rotate(45deg);
 background-color: var(--n-color);
 pointer-events: all;
 `)]),ne("&.popover-transition-enter-from, &.popover-transition-leave-to",`
 opacity: 0;
 transform: scale(.85);
 `),ne("&.popover-transition-enter-to, &.popover-transition-leave-from",`
 transform: scale(1);
 opacity: 1;
 `),ne("&.popover-transition-enter-active",`
 transition:
 box-shadow .3s var(--n-bezier),
 background-color .3s var(--n-bezier),
 color .3s var(--n-bezier),
 opacity .15s var(--n-bezier-ease-out),
 transform .15s var(--n-bezier-ease-out);
 `),ne("&.popover-transition-leave-active",`
 transition:
 box-shadow .3s var(--n-bezier),
 background-color .3s var(--n-bezier),
 color .3s var(--n-bezier),
 opacity .15s var(--n-bezier-ease-in),
 transform .15s var(--n-bezier-ease-in);
 `)]),ce("top-start",`
 top: calc(${ee} / -2);
 left: calc(${Se("top-start")} - var(--v-offset-left));
 `),ce("top",`
 top: calc(${ee} / -2);
 transform: translateX(calc(${ee} / -2)) rotate(45deg);
 left: 50%;
 `),ce("top-end",`
 top: calc(${ee} / -2);
 right: calc(${Se("top-end")} + var(--v-offset-left));
 `),ce("bottom-start",`
 bottom: calc(${ee} / -2);
 left: calc(${Se("bottom-start")} - var(--v-offset-left));
 `),ce("bottom",`
 bottom: calc(${ee} / -2);
 transform: translateX(calc(${ee} / -2)) rotate(45deg);
 left: 50%;
 `),ce("bottom-end",`
 bottom: calc(${ee} / -2);
 right: calc(${Se("bottom-end")} + var(--v-offset-left));
 `),ce("left-start",`
 left: calc(${ee} / -2);
 top: calc(${Se("left-start")} - var(--v-offset-top));
 `),ce("left",`
 left: calc(${ee} / -2);
 transform: translateY(calc(${ee} / -2)) rotate(45deg);
 top: 50%;
 `),ce("left-end",`
 left: calc(${ee} / -2);
 bottom: calc(${Se("left-end")} + var(--v-offset-top));
 `),ce("right-start",`
 right: calc(${ee} / -2);
 top: calc(${Se("right-start")} - var(--v-offset-top));
 `),ce("right",`
 right: calc(${ee} / -2);
 transform: translateY(calc(${ee} / -2)) rotate(45deg);
 top: 50%;
 `),ce("right-end",`
 right: calc(${ee} / -2);
 bottom: calc(${Se("right-end")} + var(--v-offset-top));
 `),...Ri({top:["right-start","left-start"],right:["top-end","bottom-end"],bottom:["right-end","left-end"],left:["top-start","bottom-start"]},(e,t)=>{const n=["right","left"].includes(t),o=n?"width":"height";return e.map(r=>{const a=r.split("-")[1]==="end",i=`calc((${`var(--v-target-${o}, 0px)`} - ${ee}) / 2)`,l=Se(r);return ne(`[v-placement="${r}"] >`,[B("popover-shared",[re("center-arrow",[B("popover-arrow",`${t}: calc(max(${i}, ${l}) ${a?"+":"-"} var(--v-offset-${n?"left":"top"}));`)])])])})})]);function Se(e){return["top","bottom"].includes(e.split("-")[0])?"var(--n-arrow-offset)":"var(--n-arrow-offset-vertical)"}function ce(e,t){const n=e.split("-")[0],o=["top","bottom"].includes(n)?"height: var(--n-space-arrow);":"width: var(--n-space-arrow);";return ne(`[v-placement="${e}"] >`,[B("popover-shared",`
 margin-${Ht[n]}: var(--n-space);
 `,[re("show-arrow",`
 margin-${Ht[n]}: var(--n-space-arrow);
 `),re("overlap",`
 margin: 0;
 `),Zo("popover-arrow-wrapper",`
 right: 0;
 left: 0;
 top: 0;
 bottom: 0;
 ${n}: 100%;
 ${Ht[n]}: auto;
 ${o}
 `,[B("popover-arrow",t)])])])}const no={...$e.props,to:Pe.propTo,show:Boolean,trigger:String,showArrow:Boolean,delay:Number,duration:Number,raw:Boolean,arrowPointToCenter:Boolean,arrowClass:String,arrowStyle:[String,Object],arrowWrapperClass:String,arrowWrapperStyle:[String,Object],displayDirective:String,x:Number,y:Number,flip:Boolean,overlap:Boolean,placement:String,width:[Number,String],keepAliveOnHover:Boolean,scrollable:Boolean,contentClass:String,contentStyle:[Object,String],headerClass:String,headerStyle:[Object,String],footerClass:String,footerStyle:[Object,String],internalDeactivateImmediately:Boolean,animated:Boolean,onClickoutside:Function,internalTrapFocus:Boolean,internalOnAfterLeave:Function,minWidth:Number,maxWidth:Number};function Qi({arrowClass:e,arrowStyle:t,arrowWrapperClass:n,arrowWrapperStyle:o,clsPrefix:r}){return p(),O("div",{key:"__popover-arrow__",style:Oe(o),class:_([`${r}-popover-arrow-wrapper`,n])},[de("div",{class:_([`${r}-popover-arrow`,e]),style:Oe(t)},null,6)],6)}var el=ue({name:"PopoverBody",inheritAttrs:!1,props:no,setup(e,{slots:t,attrs:n}){const{namespaceRef:o,mergedClsPrefixRef:r,inlineThemeDisabled:a,mergedRtlRef:i}=Ft(e),l=$e("Popover","-popover",Zi,Qo,e,r),s=on("Popover",i,r),x=T(null),b=ge("NPopover"),m=T(null),u=T(e.show),h=T(!1);rn(()=>{const{show:z}=e;z&&!Ni()&&!e.internalDeactivateImmediately&&(h.value=!0)});const v=W(()=>{const{trigger:z,onClickoutside:V}=e,S=[],{positionManuallyRef:{value:I}}=b;return I||(z==="click"&&!V&&S.push([Ct,L,void 0,{capture:!0}]),z==="hover"&&S.push([Ki,R])),V&&S.push([Ct,L,void 0,{capture:!0}]),(e.displayDirective==="show"||e.animated&&h.value)&&S.push([Wn,e.show]),S}),g=W(()=>{const{common:{cubicBezierEaseInOut:z,cubicBezierEaseIn:V,cubicBezierEaseOut:S},self:{space:I,spaceArrow:te,padding:$,fontSize:q,textColor:j,dividerColor:J,color:he,boxShadow:pe,borderRadius:me,arrowHeight:le,arrowOffset:we,arrowOffsetVertical:ye}}=l.value;return{"--n-box-shadow":pe,"--n-bezier":z,"--n-bezier-ease-in":V,"--n-bezier-ease-out":S,"--n-font-size":q,"--n-text-color":j,"--n-color":he,"--n-divider-color":J,"--n-border-radius":me,"--n-arrow-height":le,"--n-arrow-offset":we,"--n-arrow-offset-vertical":ye,"--n-padding":$,"--n-space":I,"--n-space-arrow":te}}),M=W(()=>{const z=e.width==="trigger"?void 0:Et(e.width),V=[];z&&V.push({width:z});const{maxWidth:S,minWidth:I}=e;return S&&V.push({maxWidth:Et(S)}),I&&V.push({maxWidth:Et(I)}),a||V.push(g.value),V}),c=a?Tt("popover",void 0,g,e):void 0;b.setBodyInstance({syncPosition:C}),We(()=>{b.setBodyInstance(null)}),fe(Z(e,"show"),z=>{e.animated||(z?u.value=!0:u.value=!1)});function C(){x.value?.syncPosition()}function P(z){e.trigger==="hover"&&e.keepAliveOnHover&&e.show&&b.handleMouseEnter(z)}function D(z){e.trigger==="hover"&&e.keepAliveOnHover&&b.handleMouseLeave(z)}function R(z){e.trigger==="hover"&&!U().contains(Gt(z))&&b.handleMouseMoveOutside(z)}function L(z){(e.trigger==="click"&&!U().contains(Gt(z))||e.onClickoutside)&&b.handleClickOutside(z)}function U(){return b.getTriggerElement()}Le(Dn,m),Le(Rn,null),Le(En,null);function Q(){if(c?.onRender(),!(e.displayDirective==="show"||e.show||e.animated&&h.value))return null;let z;const V=b.internalRenderBodyRef.value,{value:S}=r;if(V)z=V([`${S}-popover-shared`,s?.value&&`${S}-popover--rtl`,c?.themeClass.value,e.overlap&&`${S}-popover-shared--overlap`,e.showArrow&&`${S}-popover-shared--show-arrow`,e.arrowPointToCenter&&`${S}-popover-shared--center-arrow`],m,M.value,P,D);else{const{value:I}=b.extraClassRef,{internalTrapFocus:te}=e,$=!pn(t.header)||!pn(t.footer),q=()=>{const j=$?(p(),O(ie,{key:1},[F(()=>at(t.header,J=>J?(p(),O("div",{key:2,class:_([`${S}-popover__header`,e.headerClass]),style:Oe(e.headerStyle)},[F(()=>J)],6)):null)),F(()=>at(t.default,J=>J?(p(),O("div",{key:3,class:_([`${S}-popover__content`,e.contentClass]),style:Oe(e.contentStyle)},[F(()=>t.default?.())],6)):null)),F(()=>at(t.footer,J=>J?(p(),O("div",{key:4,class:_([`${S}-popover__footer`,e.footerClass]),style:Oe(e.footerStyle)},[F(()=>J)],6)):null))],64)):e.scrollable?t.default?.():(p(),O("div",{key:5,class:_([`${S}-popover__content`,e.contentClass]),style:Oe(e.contentStyle)},[F(()=>t.default?.())],6));return[e.scrollable?(p(),H(tr,{key:6,themeOverrides:l.value.peerOverrides.Scrollbar,theme:l.value.peers.Scrollbar,contentClass:$?void 0:`${S}-popover__content ${e.contentClass??""}`,contentStyle:$?void 0:e.contentStyle},{default:()=>j},1032,["themeOverrides","theme","contentClass","contentStyle"])):j,e.showArrow?Qi({arrowClass:e.arrowClass,arrowStyle:e.arrowStyle,arrowWrapperClass:e.arrowWrapperClass,arrowWrapperStyle:e.arrowWrapperStyle,clsPrefix:S}):null]};z=be("div",Be({class:[`${S}-popover`,`${S}-popover-shared`,s?.value&&`${S}-popover--rtl`,c?.themeClass.value,I.map(j=>`${S}-${j}`),{[`${S}-popover--scrollable`]:e.scrollable,[`${S}-popover--show-header-or-footer`]:$,[`${S}-popover--raw`]:e.raw,[`${S}-popover-shared--overlap`]:e.overlap,[`${S}-popover-shared--show-arrow`]:e.showArrow,[`${S}-popover-shared--center-arrow`]:e.arrowPointToCenter}],ref:m,style:M.value,onKeydown:b.handleKeydown,onMouseenter:P,onMouseleave:D},n),te?(p(),H(er,{key:7,active:e.show,autoFocus:!0},{default:q},1032,["active"])):q())}return ct(z,v.value)}return{displayed:h,namespace:o,isMounted:b.isMountedRef,zIndex:b.zIndexRef,followerRef:x,adjustedTo:Pe(e),followerEnabled:u,renderContentNode:Q}},render(){return p(),H(to,{ref:"followerRef",zIndex:this.zIndex,show:this.show,enabled:this.followerEnabled,to:this.adjustedTo,x:this.x,y:this.y,flip:this.flip,placement:this.placement,containerClass:this.namespace,overlap:this.overlap,width:this.width==="trigger"?"target":void 0,teleportDisabled:this.adjustedTo===Pe.tdkey},{_:1,default:Me(()=>this.animated?(p(),H(nn,{key:8,name:"popover-transition",appear:this.isMounted,onEnter:()=>{this.followerEnabled=!0},onAfterLeave:()=>{this.internalOnAfterLeave?.(),this.followerEnabled=!1,this.displayed=!1}},{default:this.renderContentNode},1032,["appear","onEnter","onAfterLeave"])):this.renderContentNode())},8,["zIndex","show","enabled","to","x","y","flip","placement","containerClass","overlap","width","teleportDisabled"])}});const tl={key:1,style:{position:"fixed",top:0,right:0,bottom:0,left:0}},nl=Object.keys(no),ol={focus:["onFocus","onBlur"],click:["onClick"],hover:["onMouseenter","onMouseleave"],manual:[],nested:["onFocus","onBlur","onMouseenter","onMouseleave","onClick"]};function rl(e,t,n){ol[t].forEach(o=>{e.props?e.props=Object.assign({},e.props):e.props={};const r=e.props[o],a=n[o];r?e.props[o]=(...i)=>{r(...i),a(...i)}:e.props[o]=a})}const il={show:{type:Boolean,default:void 0},defaultShow:Boolean,showArrow:{type:Boolean,default:!0},trigger:{type:String,default:"hover"},delay:{type:Number,default:100},duration:{type:Number,default:100},raw:Boolean,placement:{type:String,default:"top"},x:Number,y:Number,arrowPointToCenter:Boolean,disabled:Boolean,getDisabled:Function,displayDirective:{type:String,default:"if"},arrowClass:String,arrowStyle:[String,Object],arrowWrapperClass:String,arrowWrapperStyle:[String,Object],flip:{type:Boolean,default:!0},animated:{type:Boolean,default:!0},width:{type:[Number,String],default:void 0},overlap:Boolean,keepAliveOnHover:{type:Boolean,default:!0},zIndex:Number,to:Pe.propTo,scrollable:Boolean,contentClass:String,contentStyle:[Object,String],headerClass:String,headerStyle:[Object,String],footerClass:String,footerStyle:[Object,String],onClickoutside:Function,"onUpdate:show":[Function,Array],onUpdateShow:[Function,Array],internalDeactivateImmediately:Boolean,internalSyncTargetWithParent:Boolean,internalInheritedEventHandlers:{type:Array,default:()=>[]},internalTrapFocus:Boolean,internalExtraClass:{type:Array,default:()=>[]},onShow:[Function,Array],onHide:[Function,Array],arrow:{type:Boolean,default:void 0},minWidth:Number,maxWidth:Number},ll={...$e.props,...il,internalOnAfterLeave:Function,internalRenderBody:Function};var al=ue({name:"Popover",inheritAttrs:!1,props:ll,slots:Object,__popover__:!0,setup(e){const t=tn(),n=T(null),o=W(()=>e.show),r=T(e.defaultShow),a=Xt(o,r),i=Ae(()=>e.disabled?!1:a.value),l=()=>{if(e.disabled)return!0;const{getDisabled:$}=e;return!!$?.()},s=()=>l()?!1:a.value,x=Vn(e,["arrow","showArrow"]),b=W(()=>e.overlap?!1:x.value);let m=null;const u=T(null),h=T(null),v=Ae(()=>e.x!==void 0&&e.y!==void 0);function g($){const{"onUpdate:show":q,onUpdateShow:j,onShow:J,onHide:he}=e;r.value=$,q&&ae(q,$),j&&ae(j,$),$&&J&&ae(J,!0),$&&he&&ae(he,!1)}function M(){m&&m.syncPosition()}function c(){const{value:$}=u;$&&(window.clearTimeout($),u.value=null)}function C(){const{value:$}=h;$&&(window.clearTimeout($),h.value=null)}function P(){const $=l();if(e.trigger==="focus"&&!$){if(s())return;g(!0)}}function D(){const $=l();if(e.trigger==="focus"&&!$){if(!s())return;g(!1)}}function R(){const $=l();if(e.trigger==="hover"&&!$){if(C(),u.value!==null||s())return;const q=()=>{g(!0),u.value=null},{delay:j}=e;j===0?q():u.value=window.setTimeout(q,j)}}function L(){const $=l();if(e.trigger==="hover"&&!$){if(c(),h.value!==null||!s())return;const q=()=>{g(!1),h.value=null},{duration:j}=e;j===0?q():h.value=window.setTimeout(q,j)}}function U(){L()}function Q($){s()&&(e.trigger==="click"&&(c(),C(),g(!1)),e.onClickoutside?.($))}function z(){e.trigger==="click"&&!l()&&(c(),C(),g(!s()))}function V($){e.internalTrapFocus&&$.key==="Escape"&&(c(),C(),g(!1))}function S($){r.value=$}function I(){return n.value?.targetRef}function te($){m=$}return Le("NPopover",{getTriggerElement:I,handleKeydown:V,handleMouseEnter:R,handleMouseLeave:L,handleClickOutside:Q,handleMouseMoveOutside:U,setBodyInstance:te,positionManuallyRef:v,isMountedRef:t,zIndexRef:Z(e,"zIndex"),extraClassRef:Z(e,"internalExtraClass"),internalRenderBodyRef:Z(e,"internalRenderBody")}),rn(()=>{a.value&&l()&&g(!1)}),{binderInstRef:n,positionManually:v,mergedShowConsideringDisabledProp:i,uncontrolledShow:r,mergedShowArrow:b,getMergedShow:s,setShow:S,handleClick:z,handleMouseEnter:R,handleMouseLeave:L,handleFocus:P,handleBlur:D,syncPosition:M}},render(){const{positionManually:e,$slots:t}=this;let n,o=!1;if(!e&&(n=nr(t,"trigger"),n)){n=or(n),n=n.type===rr?be("span",[n]):n;const r={onClick:this.handleClick,onMouseenter:this.handleMouseEnter,onMouseleave:this.handleMouseLeave,onFocus:this.handleFocus,onBlur:this.handleBlur};if(n.type?.__popover__)o=!0,n.props||(n.props={internalSyncTargetWithParent:!0,internalInheritedEventHandlers:[]}),n.props.internalSyncTargetWithParent=!0,n.props.internalInheritedEventHandlers?n.props.internalInheritedEventHandlers=[r,...n.props.internalInheritedEventHandlers]:n.props.internalInheritedEventHandlers=[r];else{const{internalInheritedEventHandlers:a}=this,i=[r,...a];rl(n,a?"nested":e?"manual":this.trigger,{onBlur:l=>{i.forEach(s=>{s.onBlur(l)})},onFocus:l=>{i.forEach(s=>{s.onFocus(l)})},onClick:l=>{i.forEach(s=>{s.onClick(l)})},onMouseenter:l=>{i.forEach(s=>{s.onMouseenter(l)})},onMouseleave:l=>{i.forEach(s=>{s.onMouseleave(l)})}})}}return p(),H(Qn,{ref:"binderInstRef",syncTarget:!o,syncTargetWithParent:this.internalSyncTargetWithParent},{default:()=>{this.mergedShowConsideringDisabledProp;const r=this.getMergedShow();return[this.internalTrapFocus&&r?ct((p(),O("div",tl)),[[Ln,{enabled:r,zIndex:this.zIndex}]]):null,e?null:be(eo,null,{default:()=>n}),be(el,ir(this.$props,nl,{...this.$attrs,showArrow:this.mergedShowArrow,show:r}),{default:()=>this.$slots.default?.(),header:()=>this.$slots.header?.(),footer:()=>this.$slots.footer?.()})]}},1032,["syncTarget","syncTargetWithParent"])}});function zn(e){switch(typeof e){case"string":return e||void 0;case"number":return String(e);default:return}}function oo(e,t){t&&(Ne(()=>{const{value:n}=e;n&&Rt.registerHandler(n,t)}),fe(e,(n,o)=>{o&&Rt.unregisterHandler(o)},{deep:!1}),We(()=>{const{value:n}=e;n&&Rt.unregisterHandler(n)}))}var sl=ue({props:{onFocus:Function,onBlur:Function},setup(e){return()=>(()=>{const t=Kn("d16ead82505dc285");return p(),O("div",{style:"width: 0; height: 0",tabindex:0,onFocus:t[0]||(t[0]=n=>e.onFocus?.(n)),onBlur:t[1]||(t[1]=n=>e.onBlur?.(n))},null,32)})()}}),dl=sl,An=ue({name:"NBaseSelectGroupHeader",props:{clsPrefix:{type:String,required:!0},tmNode:{type:Object,required:!0}},setup(){const{renderLabelRef:e,renderOptionRef:t,labelFieldRef:n,nodePropsRef:o}=ge(sn);return{labelField:n,nodeProps:o,renderLabel:e,renderOption:t}},render(){const{clsPrefix:e,renderLabel:t,renderOption:n,nodeProps:o,tmNode:{rawNode:r}}=this,a=o?.(r),i=t?t(r,!1):Xe(r[this.labelField],r,!1),l=(p(),O("div",Be(a,{class:[`${e}-base-select-group-header`,a?.class]}),[F(()=>i)],16));return r.render?r.render({node:l,option:r}):n?n({node:l,option:r,selected:!1}):l}}),ul=ue({name:"Checkmark",render(){return(()=>{const e=Kn("3c84eac8ae4e1f96");return e[0]||(e[0]=de("svg",{xmlns:"http://www.w3.org/2000/svg",viewBox:"0 0 16 16"},[de("g",{fill:"none"},[de("path",{d:"M14.046 3.486a.75.75 0 0 1-.032 1.06l-7.93 7.474a.85.85 0 0 1-1.188-.022l-2.68-2.72a.75.75 0 1 1 1.068-1.053l2.234 2.267l7.468-7.038a.75.75 0 0 1 1.06.032z",fill:"currentColor"})])],-1))})()}});const cl=["onClick","onMouseenter","onMousemove"];function fl(e,t){return p(),H(nn,{name:"fade-in-scale-up-transition"},{default:()=>e?(p(),H(lr,{key:1,clsPrefix:t,class:_(`${t}-base-select-option__check`)},{default:()=>be(ul)},1032,["clsPrefix","class"])):null},1024)}var Bn=ue({name:"NBaseSelectOption",props:{clsPrefix:{type:String,required:!0},tmNode:{type:Object,required:!0}},setup(e){const{valueRef:t,pendingTmNodeRef:n,multipleRef:o,valueSetRef:r,renderLabelRef:a,renderOptionRef:i,labelFieldRef:l,valueFieldRef:s,showCheckmarkRef:x,nodePropsRef:b,handleOptionClick:m,handleOptionMouseEnter:u}=ge(sn),h=Ae(()=>{const{value:c}=n;return c?e.tmNode.key===c.key:!1});function v(c){const{tmNode:C}=e;C.disabled||m(c,C)}function g(c){const{tmNode:C}=e;C.disabled||u(c,C)}function M(c){const{tmNode:C}=e,{value:P}=h;C.disabled||P||u(c,C)}return{multiple:o,isGrouped:Ae(()=>{const{tmNode:c}=e,{parent:C}=c;return C&&C.rawNode.type==="group"}),showCheckmark:x,nodeProps:b,isPending:h,isSelected:Ae(()=>{const{value:c}=t,{value:C}=o;if(c===null)return!1;const P=e.tmNode.rawNode[s.value];if(C){const{value:D}=r;return D.has(P)}else return c===P}),labelField:l,renderLabel:a,renderOption:i,handleMouseMove:M,handleMouseEnter:g,handleClick:v}},render(){const{clsPrefix:e,tmNode:{rawNode:t},isSelected:n,isPending:o,isGrouped:r,showCheckmark:a,nodeProps:i,renderOption:l,renderLabel:s,handleClick:x,handleMouseEnter:b,handleMouseMove:m}=this,u=fl(n,e),h=s?[s(t,n),a&&u]:[Xe(t[this.labelField],t,n),a&&u],v=i?.(t),g=(p(),O("div",Be(v,{class:[`${e}-base-select-option`,t.class,v?.class,{[`${e}-base-select-option--disabled`]:t.disabled,[`${e}-base-select-option--selected`]:n,[`${e}-base-select-option--grouped`]:r,[`${e}-base-select-option--pending`]:o,[`${e}-base-select-option--show-checkmark`]:a}],style:[v?.style||"",t.style||""],onClick:Dt([x,v?.onClick]),onMouseenter:Dt([b,v?.onMouseenter]),onMousemove:Dt([m,v?.onMousemove])}),[de("div",{class:_(`${e}-base-select-option__content`)},[F(()=>h)],2)],16,cl));return t.render?t.render({node:g,option:t,selected:n}):l?l({node:g,option:t,selected:n}):g}}),hl=B("base-select-menu",`
 line-height: 1.5;
 outline: none;
 z-index: 0;
 position: relative;
 border-radius: var(--n-border-radius);
 transition:
 background-color .3s var(--n-bezier),
 box-shadow .3s var(--n-bezier);
 background-color: var(--n-color);
`,[B("scrollbar",`
 max-height: var(--n-height);
 `),B("virtual-list",`
 max-height: var(--n-height);
 `),B("base-select-option",`
 min-height: var(--n-option-height);
 font-size: var(--n-option-font-size);
 display: flex;
 align-items: center;
 `,[X("content",`
 z-index: 1;
 white-space: nowrap;
 text-overflow: ellipsis;
 overflow: hidden;
 `)]),B("base-select-group-header",`
 min-height: var(--n-option-height);
 font-size: .93em;
 display: flex;
 align-items: center;
 `),B("base-select-menu-option-wrapper",`
 position: relative;
 width: 100%;
 `),X("loading, empty",`
 display: flex;
 padding: 12px 32px;
 flex: 1;
 justify-content: center;
 `),X("loading",`
 color: var(--n-loading-color);
 font-size: var(--n-loading-size);
 `),X("header",`
 padding: 8px var(--n-option-padding-left);
 font-size: var(--n-option-font-size);
 transition: 
 color .3s var(--n-bezier),
 border-color .3s var(--n-bezier);
 border-bottom: 1px solid var(--n-action-divider-color);
 color: var(--n-action-text-color);
 `),X("action",`
 padding: 8px var(--n-option-padding-left);
 font-size: var(--n-option-font-size);
 transition: 
 color .3s var(--n-bezier),
 border-color .3s var(--n-bezier);
 border-top: 1px solid var(--n-action-divider-color);
 color: var(--n-action-text-color);
 `),B("base-select-group-header",`
 position: relative;
 cursor: default;
 padding: var(--n-option-padding);
 color: var(--n-group-header-text-color);
 `),B("base-select-option",`
 cursor: pointer;
 position: relative;
 padding: var(--n-option-padding);
 transition:
 color .3s var(--n-bezier),
 opacity .3s var(--n-bezier);
 box-sizing: border-box;
 color: var(--n-option-text-color);
 opacity: 1;
 `,[re("show-checkmark",`
 padding-right: calc(var(--n-option-padding-right) + 20px);
 `),ne("&::before",`
 content: "";
 position: absolute;
 left: 4px;
 right: 4px;
 top: 0;
 bottom: 0;
 border-radius: var(--n-border-radius);
 transition: background-color .3s var(--n-bezier);
 `),ne("&:active",`
 color: var(--n-option-text-color-pressed);
 `),re("grouped",`
 padding-left: calc(var(--n-option-padding-left) * 1.5);
 `),re("pending",[ne("&::before",`
 background-color: var(--n-option-color-pending);
 `)]),re("selected",`
 color: var(--n-option-text-color-active);
 `,[ne("&::before",`
 background-color: var(--n-option-color-active);
 `),re("pending",[ne("&::before",`
 background-color: var(--n-option-color-active-pending);
 `)])]),re("disabled",`
 cursor: not-allowed;
 `,[qe("selected",`
 color: var(--n-option-text-color-disabled);
 `),re("selected",`
 opacity: var(--n-option-opacity-disabled);
 `)]),X("check",`
 font-size: 16px;
 position: absolute;
 right: calc(var(--n-option-padding-right) - 4px);
 top: calc(50% - 7px);
 color: var(--n-option-check-color);
 transition: color .3s var(--n-bezier);
 `,[Hn({enterScale:"0.5"})])])]);const pl=["tabindex","onFocusin","onFocusout","onKeyup","onKeydown","onMousedown","onMouseenter","onMouseleave"];var vl=ue({name:"InternalSelectMenu",props:{...$e.props,clsPrefix:{type:String,required:!0},scrollable:{type:Boolean,default:!0},treeMate:{type:Object,required:!0},multiple:Boolean,size:{type:String,default:"medium"},value:{type:[String,Number,Array],default:null},autoPending:Boolean,virtualScroll:{type:Boolean,default:!0},show:{type:Boolean,default:!0},labelField:{type:String,default:"label"},valueField:{type:String,default:"value"},loading:Boolean,focusable:Boolean,renderLabel:Function,renderOption:Function,nodeProps:Function,showCheckmark:{type:Boolean,default:!0},onMousedown:Function,onScroll:Function,onFocus:Function,onBlur:Function,onKeyup:Function,onKeydown:Function,onTabOut:Function,onMouseenter:Function,onMouseleave:Function,onResize:Function,resetMenuOnOptionsChange:{type:Boolean,default:!0},inlineThemeDisabled:Boolean,scrollbarProps:Object,onToggle:Function},setup(e){const{mergedClsPrefixRef:t,mergedRtlRef:n,mergedComponentPropsRef:o}=Ft(e),r=on("InternalSelectMenu",n,t),a=$e("InternalSelectMenu","-internal-select-menu",hl,ur,e,Z(e,"clsPrefix")),i=T(null),l=T(null),s=T(null),x=W(()=>e.treeMate.getFlattenedNodes()),b=W(()=>Cr(x.value)),m=T(null);function u(){const{treeMate:y}=e;let N=null;const{value:ve}=e;ve===null?N=y.getFirstAvailableNode():(e.multiple?N=y.getNode((ve||[])[(ve||[]).length-1]):N=y.getNode(ve),(!N||N.disabled)&&(N=y.getFirstAvailableNode())),j(N||null)}function h(){const{value:y}=m;y&&!e.treeMate.getNode(y.key)&&(m.value=null)}let v;fe(()=>e.show,y=>{y?v=fe(()=>e.treeMate,()=>{e.resetMenuOnOptionsChange?(e.autoPending?u():h(),Pt(J)):h()},{immediate:!0}):v?.()},{immediate:!0}),We(()=>{v?.()});const g=W(()=>cr(a.value.self[Re("optionHeight",e.size)])),M=W(()=>st(a.value.self[Re("padding",e.size)])),c=W(()=>e.multiple&&Array.isArray(e.value)?new Set(e.value):new Set),C=W(()=>{const y=x.value;return y&&y.length===0}),P=W(()=>o?.value?.Select?.renderEmpty);function D(y){const{onToggle:N}=e;N&&N(y)}function R(y){const{onScroll:N}=e;N&&N(y)}function L(y){s.value?.sync(),R(y)}function U(){s.value?.sync()}function Q(){const{value:y}=m;return y||null}function z(y,N){N.disabled||j(N,!1)}function V(y,N){N.disabled||D(N)}function S(y){dt(y,"action")||e.onKeyup?.(y)}function I(y){dt(y,"action")||e.onKeydown?.(y)}function te(y){e.onMousedown?.(y),!e.focusable&&y.preventDefault()}function $(){const{value:y}=m;y&&j(y.getNext({loop:!0}),!0)}function q(){const{value:y}=m;y&&j(y.getPrev({loop:!0}),!0)}function j(y,N=!1){m.value=y,N&&J()}function J(){const y=m.value;if(!y)return;const N=b.value(y.key);N!==null&&(e.virtualScroll?l.value?.scrollTo({index:N}):s.value?.scrollTo({index:N,elSize:g.value}))}function he(y){i.value?.contains(y.target)&&e.onFocus?.(y)}function pe(y){i.value?.contains(y.relatedTarget)||e.onBlur?.(y)}Le(sn,{handleOptionMouseEnter:z,handleOptionClick:V,valueSetRef:c,pendingTmNodeRef:m,nodePropsRef:Z(e,"nodeProps"),showCheckmarkRef:Z(e,"showCheckmark"),multipleRef:Z(e,"multiple"),valueRef:Z(e,"value"),renderLabelRef:Z(e,"renderLabel"),renderOptionRef:Z(e,"renderOption"),labelFieldRef:Z(e,"labelField"),valueFieldRef:Z(e,"valueField")}),Le(Yn,i),Ne(()=>{const{value:y}=s;y&&y.sync()});const me=W(()=>{const{size:y}=e,{common:{cubicBezierEaseInOut:N},self:{height:ve,borderRadius:Ve,color:Ke,groupHeaderTextColor:xe,actionDividerColor:se,optionTextColorPressed:He,optionTextColor:Fe,optionTextColorDisabled:et,optionTextColorActive:tt,optionOpacityDisabled:nt,optionCheckColor:ke,actionTextColor:_e,optionColorPending:ot,optionColorActive:rt,loadingColor:it,loadingSize:Ue,optionColorActivePending:je,[Re("optionFontSize",y)]:Ie,[Re("optionHeight",y)]:f,[Re("optionPadding",y)]:E}}=a.value;return{"--n-height":ve,"--n-action-divider-color":se,"--n-action-text-color":_e,"--n-bezier":N,"--n-border-radius":Ve,"--n-color":Ke,"--n-option-font-size":Ie,"--n-group-header-text-color":xe,"--n-option-check-color":ke,"--n-option-color-pending":ot,"--n-option-color-active":rt,"--n-option-color-active-pending":je,"--n-option-height":f,"--n-option-opacity-disabled":nt,"--n-option-text-color":Fe,"--n-option-text-color-active":tt,"--n-option-text-color-disabled":et,"--n-option-text-color-pressed":He,"--n-option-padding":E,"--n-option-padding-left":st(E,"left"),"--n-option-padding-right":st(E,"right"),"--n-loading-color":it,"--n-loading-size":Ue}}),{inlineThemeDisabled:le}=e,we=le?Tt("internal-select-menu",W(()=>e.size[0]),me,e):void 0,ye={selfRef:i,next:$,prev:q,getPendingTmNode:Q};return oo(i,e.onResize),{mergedTheme:a,mergedClsPrefix:t,rtlEnabled:r,virtualListRef:l,scrollbarRef:s,itemSize:g,padding:M,flattenedNodes:x,empty:C,mergedRenderEmpty:P,virtualListContainer(){const{value:y}=l;return y?.listElRef},virtualListContent(){const{value:y}=l;return y?.itemsElRef},doScroll:R,handleFocusin:he,handleFocusout:pe,handleKeyUp:S,handleKeyDown:I,handleMouseDown:te,handleVirtualListResize:U,handleVirtualListScroll:L,cssVars:le?void 0:me,themeClass:we?.themeClass,onRender:we?.onRender,...ye}},render(){const{$slots:e,virtualScroll:t,clsPrefix:n,mergedTheme:o,themeClass:r,onRender:a}=this;return a?.(),p(),O("div",{ref:"selfRef",tabindex:this.focusable?0:-1,class:_([`${n}-base-select-menu`,`${n}-base-select-menu--${this.size}-size`,this.rtlEnabled&&`${n}-base-select-menu--rtl`,r,this.multiple&&`${n}-base-select-menu--multiple`]),style:Oe(this.cssVars),onFocusin:this.handleFocusin,onFocusout:this.handleFocusout,onKeyup:this.handleKeyUp,onKeydown:this.handleKeyDown,onMousedown:this.handleMouseDown,onMouseenter:this.onMouseenter,onMouseleave:this.onMouseleave},[F(()=>at(e.header,i=>i&&(p(),O("div",{class:_(`${n}-base-select-menu__header`),"data-header":!0,key:"header"},[F(()=>i)],2)))),this.loading?(p(),O("div",{key:0,class:_(`${n}-base-select-menu__loading`)},[(p(),H(ar,{clsPrefix:n,strokeWidth:20},null,8,["clsPrefix"]))],2)):(p(),O(ie,{key:1},[this.empty?(p(),O("div",{key:1,class:_(`${n}-base-select-menu__empty`),"data-empty":!0},[F(()=>dr(e.empty,()=>[this.mergedRenderEmpty?.()||(p(),H(xr,{theme:o.peers.Empty,themeOverrides:o.peerOverrides.Empty,size:this.size},null,8,["theme","themeOverrides","size"]))]))],2)):(p(),H(sr,Be({key:0,ref:"scrollbarRef",theme:o.peers.Scrollbar,themeOverrides:o.peerOverrides.Scrollbar,scrollable:this.scrollable,container:t?this.virtualListContainer:void 0,content:t?this.virtualListContent:void 0,onScroll:t?void 0:this.doScroll},this.scrollbarProps),{default:()=>t?(p(),H(Sr,{key:1,ref:"virtualListRef",class:_(`${n}-virtual-list`),items:this.flattenedNodes,itemSize:this.itemSize,showScrollbar:!1,paddingTop:this.padding.top,paddingBottom:this.padding.bottom,onResize:this.handleVirtualListResize,onScroll:this.handleVirtualListScroll,itemResizable:!0},{default:({item:i})=>i.isGroup?(p(),H(An,{key:i.key,clsPrefix:n,tmNode:i},null,8,["clsPrefix","tmNode"])):i.ignored?null:(p(),H(Bn,{clsPrefix:n,key:i.key,tmNode:i},null,8,["clsPrefix","tmNode"]))},1032,["class","items","itemSize","paddingTop","paddingBottom","onResize","onScroll"])):(p(),O("div",{key:4,class:_(`${n}-base-select-menu-option-wrapper`),style:Oe({paddingTop:this.padding.top,paddingBottom:this.padding.bottom})},[F(()=>this.flattenedNodes.map(i=>i.isGroup?(p(),H(An,{key:i.key,clsPrefix:n,tmNode:i},null,8,["clsPrefix","tmNode"])):(p(),H(Bn,{clsPrefix:n,key:i.key,tmNode:i},null,8,["clsPrefix","tmNode"]))))],6))},1040,["theme","themeOverrides","scrollable","container","content","onScroll"]))],64)),F(()=>at(e.action,i=>i&&[(p(),O("div",{class:_(`${n}-base-select-menu__action`),"data-action":!0,key:"action"},[F(()=>i)],2)),(p(),H(dl,{onFocus:this.onTabOut,key:"focus-detector"},null,8,["onFocus"]))]))],46,pl)}});function Mt(e){return e.type==="group"}function ro(e){return e.type==="ignored"}function Ut(e,t){try{return!!(1+t.toString().toLowerCase().indexOf(e.trim().toLowerCase()))}catch{return!1}}function gl(e,t){return{getIsGroup:Mt,getIgnored:ro,getKey(n){return Mt(n)?n.name||n.key||"key-required":n[e]},getChildren(n){return n[t]}}}function bl(e,t,n,o){if(!t)return e;function r(a){if(!Array.isArray(a))return[];const i=[];for(const l of a)if(Mt(l)){const s=r(l[o]);s.length&&i.push(Object.assign({},l,{[o]:s}))}else{if(ro(l))continue;t(n,l)&&i.push(l)}return i}return r(e)}function ml(e,t,n){const o=new Map;return e.forEach(r=>{Mt(r)?r[n].forEach(a=>{o.set(a[t],a)}):o.set(r[t],r)}),o}var wl=ne([B("base-selection",`
 --n-padding-single: var(--n-padding-single-top) var(--n-padding-single-right) var(--n-padding-single-bottom) var(--n-padding-single-left);
 --n-padding-multiple: var(--n-padding-multiple-top) var(--n-padding-multiple-right) var(--n-padding-multiple-bottom) var(--n-padding-multiple-left);
 position: relative;
 z-index: auto;
 box-shadow: none;
 width: 100%;
 max-width: 100%;
 display: inline-block;
 vertical-align: bottom;
 border-radius: var(--n-border-radius);
 min-height: var(--n-height);
 line-height: 1.5;
 font-size: var(--n-font-size);
 `,[B("base-loading",`
 color: var(--n-loading-color);
 `),B("base-selection-tags","min-height: var(--n-height);"),X("border, state-border",`
 position: absolute;
 left: 0;
 right: 0;
 top: 0;
 bottom: 0;
 pointer-events: none;
 border: var(--n-border);
 border-radius: inherit;
 transition:
 box-shadow .3s var(--n-bezier),
 border-color .3s var(--n-bezier);
 `),X("state-border",`
 z-index: 1;
 border-color: #0000;
 `),B("base-suffix",`
 cursor: pointer;
 position: absolute;
 top: 50%;
 transform: translateY(-50%);
 right: 10px;
 `,[X("arrow",`
 font-size: var(--n-arrow-size);
 color: var(--n-arrow-color);
 transition: color .3s var(--n-bezier);
 `)]),B("base-selection-overlay",`
 display: flex;
 align-items: center;
 white-space: nowrap;
 pointer-events: none;
 position: absolute;
 top: 0;
 right: 0;
 bottom: 0;
 left: 0;
 padding: var(--n-padding-single);
 transition: color .3s var(--n-bezier);
 `,[X("wrapper",`
 flex-basis: 0;
 flex-grow: 1;
 overflow: hidden;
 text-overflow: ellipsis;
 `)]),B("base-selection-placeholder",`
 color: var(--n-placeholder-color);
 `,[X("inner",`
 max-width: 100%;
 overflow: hidden;
 `)]),B("base-selection-tags",`
 cursor: pointer;
 outline: none;
 box-sizing: border-box;
 position: relative;
 z-index: auto;
 display: flex;
 padding: var(--n-padding-multiple);
 flex-wrap: wrap;
 align-items: center;
 width: 100%;
 vertical-align: bottom;
 background-color: var(--n-color);
 border-radius: inherit;
 transition:
 color .3s var(--n-bezier),
 box-shadow .3s var(--n-bezier),
 background-color .3s var(--n-bezier);
 `),B("base-selection-label",`
 height: var(--n-height);
 display: inline-flex;
 width: 100%;
 vertical-align: bottom;
 cursor: pointer;
 outline: none;
 z-index: auto;
 box-sizing: border-box;
 position: relative;
 transition:
 color .3s var(--n-bezier),
 box-shadow .3s var(--n-bezier),
 background-color .3s var(--n-bezier);
 border-radius: inherit;
 background-color: var(--n-color);
 align-items: center;
 `,[B("base-selection-input",`
 font-size: inherit;
 line-height: inherit;
 outline: none;
 cursor: pointer;
 box-sizing: border-box;
 border:none;
 width: 100%;
 padding: var(--n-padding-single);
 background-color: #0000;
 color: var(--n-text-color);
 transition: color .3s var(--n-bezier);
 caret-color: var(--n-caret-color);
 `,[X("content",`
 text-overflow: ellipsis;
 overflow: hidden;
 white-space: nowrap; 
 `)]),X("render-label",`
 color: var(--n-text-color);
 `)]),qe("disabled",[ne("&:hover",[X("state-border",`
 box-shadow: var(--n-box-shadow-hover);
 border: var(--n-border-hover);
 `)]),re("focus",[X("state-border",`
 box-shadow: var(--n-box-shadow-focus);
 border: var(--n-border-focus);
 `)]),re("active",[X("state-border",`
 box-shadow: var(--n-box-shadow-active);
 border: var(--n-border-active);
 `),B("base-selection-label","background-color: var(--n-color-active);"),B("base-selection-tags","background-color: var(--n-color-active);")])]),re("disabled","cursor: not-allowed;",[X("arrow",`
 color: var(--n-arrow-color-disabled);
 `),B("base-selection-label",`
 cursor: not-allowed;
 background-color: var(--n-color-disabled);
 `,[B("base-selection-input",`
 cursor: not-allowed;
 color: var(--n-text-color-disabled);
 `),X("render-label",`
 color: var(--n-text-color-disabled);
 `)]),B("base-selection-tags",`
 cursor: not-allowed;
 background-color: var(--n-color-disabled);
 `),B("base-selection-placeholder",`
 cursor: not-allowed;
 color: var(--n-placeholder-color-disabled);
 `)]),B("base-selection-input-tag",`
 height: calc(var(--n-height) - 6px);
 line-height: calc(var(--n-height) - 6px);
 outline: none;
 display: none;
 position: relative;
 margin-bottom: 3px;
 max-width: 100%;
 vertical-align: bottom;
 `,[X("input",`
 font-size: inherit;
 font-family: inherit;
 min-width: 1px;
 padding: 0;
 background-color: #0000;
 outline: none;
 border: none;
 max-width: 100%;
 overflow: hidden;
 width: 1em;
 line-height: inherit;
 cursor: pointer;
 color: var(--n-text-color);
 caret-color: var(--n-caret-color);
 `),X("mirror",`
 position: absolute;
 left: 0;
 top: 0;
 white-space: pre;
 visibility: hidden;
 user-select: none;
 -webkit-user-select: none;
 opacity: 0;
 `)]),["warning","error"].map(e=>re(`${e}-status`,[X("state-border",`border: var(--n-border-${e});`),qe("disabled",[ne("&:hover",[X("state-border",`
 box-shadow: var(--n-box-shadow-hover-${e});
 border: var(--n-border-hover-${e});
 `)]),re("active",[X("state-border",`
 box-shadow: var(--n-box-shadow-active-${e});
 border: var(--n-border-active-${e});
 `),B("base-selection-label",`background-color: var(--n-color-active-${e});`),B("base-selection-tags",`background-color: var(--n-color-active-${e});`)]),re("focus",[X("state-border",`
 box-shadow: var(--n-box-shadow-focus-${e});
 border: var(--n-border-focus-${e});
 `)])])]))]),B("base-selection-popover",`
 margin-bottom: -3px;
 display: flex;
 flex-wrap: wrap;
 margin-right: -8px;
 `),B("base-selection-tag-wrapper",`
 max-width: 100%;
 display: inline-flex;
 padding: 0 7px 3px 0;
 `,[ne("&:last-child","padding-right: 0;"),B("tag",`
 font-size: 14px;
 max-width: 100%;
 `,[X("content",`
 line-height: 1.25;
 text-overflow: ellipsis;
 overflow: hidden;
 `)])])]);const yl=["disabled","value","autofocus","onBlur","onFocus","onKeydown","onInput","onCompositionstart","onCompositionend"],xl=["tabindex"],Cl=["title"],Sl=["value","readonly","disabled","autofocus","onFocus","onBlur","onInput","onCompositionstart","onCompositionend"],Ml=["tabindex"],Ol=["onClick","onMouseenter","onMouseleave","onKeydown","onFocusin","onFocusout","onMousedown"];var $l=ue({name:"InternalSelection",props:{...$e.props,clsPrefix:{type:String,required:!0},bordered:{type:Boolean,default:void 0},active:Boolean,pattern:{type:String,default:""},placeholder:String,selectedOption:{type:Object,default:null},selectedOptions:{type:Array,default:null},labelField:{type:String,default:"label"},valueField:{type:String,default:"value"},multiple:Boolean,filterable:Boolean,clearable:Boolean,disabled:Boolean,size:{type:String,default:"medium"},loading:Boolean,autofocus:Boolean,showArrow:{type:Boolean,default:!0},inputProps:Object,focused:Boolean,renderTag:Function,onKeydown:Function,onClick:Function,onBlur:Function,onFocus:Function,onDeleteOption:Function,maxTagCount:[String,Number],ellipsisTagPopoverProps:Object,onClear:Function,onPatternInput:Function,onPatternFocus:Function,onPatternBlur:Function,renderLabel:Function,status:String,inlineThemeDisabled:Boolean,ignoreComposition:{type:Boolean,default:!0},onResize:Function},setup(e){const{mergedClsPrefixRef:t,mergedRtlRef:n}=Ft(e),o=on("InternalSelection",n,t),r=T(null),a=T(null),i=T(null),l=T(null),s=T(null),x=T(null),b=T(null),m=T(null),u=T(null),h=T(null),v=T(!1),g=T(!1),M=T(!1),c=$e("InternalSelection","-internal-selection",wl,hr,e,Z(e,"clsPrefix")),C=W(()=>e.clearable&&!e.disabled&&(M.value||e.active)),P=W(()=>e.selectedOption?e.renderTag?e.renderTag({option:e.selectedOption,handleClose:()=>{}}):e.renderLabel?e.renderLabel(e.selectedOption,!0):Xe(e.selectedOption[e.labelField],e.selectedOption,!0):e.placeholder),D=W(()=>{const f=e.selectedOption;if(f)return f[e.labelField]}),R=W(()=>e.multiple?!!(Array.isArray(e.selectedOptions)&&e.selectedOptions.length):e.selectedOption!==null);function L(){const{value:f}=r;if(f){const{value:E}=a;E&&(E.style.width=`${f.offsetWidth}px`,e.maxTagCount!=="responsive"&&u.value?.sync({showAllItemsBeforeCalculate:!1}))}}function U(){const{value:f}=h;f&&(f.style.display="none")}function Q(){const{value:f}=h;f&&(f.style.display="inline-block")}fe(Z(e,"active"),f=>{f||U()}),fe(Z(e,"pattern"),()=>{e.multiple&&Pt(L)});function z(f){const{onFocus:E}=e;E&&E(f)}function V(f){const{onBlur:E}=e;E&&E(f)}function S(f){const{onDeleteOption:E}=e;E&&E(f)}function I(f){const{onClear:E}=e;E&&E(f)}function te(f){const{onPatternInput:E}=e;E&&E(f)}function $(f){(!f.relatedTarget||!i.value?.contains(f.relatedTarget))&&z(f)}function q(f){i.value?.contains(f.relatedTarget)||V(f)}function j(f){I(f)}function J(){M.value=!0}function he(){M.value=!1}function pe(f){!e.active||!e.filterable||f.target!==a.value&&f.preventDefault()}function me(f){S(f)}const le=T(!1);function we(f){if(f.key==="Backspace"&&!le.value&&!e.pattern.length){const{selectedOptions:E}=e;E?.length&&me(E[E.length-1])}}let ye=null;function y(f){const{value:E}=r;E&&(E.textContent=f.target.value,L()),e.ignoreComposition&&le.value?ye=f:te(f)}function N(){le.value=!0}function ve(){le.value=!1,e.ignoreComposition&&te(ye),ye=null}function Ve(f){g.value=!0,e.onPatternFocus?.(f)}function Ke(f){g.value=!1,e.onPatternBlur?.(f)}function xe(){if(e.filterable)g.value=!1,x.value?.blur(),a.value?.blur();else if(e.multiple){const{value:f}=l;f?.blur()}else{const{value:f}=s;f?.blur()}}function se(){e.filterable?(g.value=!1,x.value?.focus()):e.multiple?l.value?.focus():s.value?.focus()}function He(){const{value:f}=a;f&&(Q(),f.focus())}function Fe(){const{value:f}=a;f&&f.blur()}function et(f){const{value:E}=b;E&&E.setTextContent(`+${f}`)}function tt(){const{value:f}=m;return f}function nt(){return a.value}let ke=null;function _e(){ke!==null&&window.clearTimeout(ke)}function ot(){e.active||(_e(),ke=window.setTimeout(()=>{R.value&&(v.value=!0)},100))}function rt(){_e()}function it(f){f||(_e(),v.value=!1)}fe(R,f=>{f||(v.value=!1)}),Ne(()=>{rn(()=>{const f=x.value;f&&(e.disabled?f.removeAttribute("tabindex"):f.tabIndex=g.value?-1:0)})}),oo(i,e.onResize);const{inlineThemeDisabled:Ue}=e,je=W(()=>{const{size:f}=e,{common:{cubicBezierEaseInOut:E},self:{fontWeight:zt,borderRadius:At,color:Bt,placeholderColor:kt,textColor:ft,paddingSingle:ht,paddingMultiple:pt,caretColor:_t,colorDisabled:It,textColorDisabled:vt,placeholderColorDisabled:gt,colorActive:d,boxShadowFocus:w,boxShadowActive:A,boxShadowHover:k,border:K,borderFocus:G,borderHover:Y,borderActive:oe,arrowColor:Ee,arrowColorDisabled:io,loadingColor:lo,colorActiveWarning:ao,boxShadowFocusWarning:so,boxShadowActiveWarning:uo,boxShadowHoverWarning:co,borderWarning:fo,borderFocusWarning:ho,borderHoverWarning:po,borderActiveWarning:vo,colorActiveError:go,boxShadowFocusError:bo,boxShadowActiveError:mo,boxShadowHoverError:wo,borderError:yo,borderFocusError:xo,borderHoverError:Co,borderActiveError:So,clearColor:Mo,clearColorHover:Oo,clearColorPressed:$o,clearSize:Po,arrowSize:Fo,[Re("height",f)]:To,[Re("fontSize",f)]:zo}}=c.value,bt=st(ht),mt=st(pt);return{"--n-bezier":E,"--n-border":K,"--n-border-active":oe,"--n-border-focus":G,"--n-border-hover":Y,"--n-border-radius":At,"--n-box-shadow-active":A,"--n-box-shadow-focus":w,"--n-box-shadow-hover":k,"--n-caret-color":_t,"--n-color":Bt,"--n-color-active":d,"--n-color-disabled":It,"--n-font-size":zo,"--n-height":To,"--n-padding-single-top":bt.top,"--n-padding-multiple-top":mt.top,"--n-padding-single-right":bt.right,"--n-padding-multiple-right":mt.right,"--n-padding-single-left":bt.left,"--n-padding-multiple-left":mt.left,"--n-padding-single-bottom":bt.bottom,"--n-padding-multiple-bottom":mt.bottom,"--n-placeholder-color":kt,"--n-placeholder-color-disabled":gt,"--n-text-color":ft,"--n-text-color-disabled":vt,"--n-arrow-color":Ee,"--n-arrow-color-disabled":io,"--n-loading-color":lo,"--n-color-active-warning":ao,"--n-box-shadow-focus-warning":so,"--n-box-shadow-active-warning":uo,"--n-box-shadow-hover-warning":co,"--n-border-warning":fo,"--n-border-focus-warning":ho,"--n-border-hover-warning":po,"--n-border-active-warning":vo,"--n-color-active-error":go,"--n-box-shadow-focus-error":bo,"--n-box-shadow-active-error":mo,"--n-box-shadow-hover-error":wo,"--n-border-error":yo,"--n-border-focus-error":xo,"--n-border-hover-error":Co,"--n-border-active-error":So,"--n-clear-size":Po,"--n-clear-color":Mo,"--n-clear-color-hover":Oo,"--n-clear-color-pressed":$o,"--n-arrow-size":Fo,"--n-font-weight":zt}}),Ie=Ue?Tt("internal-selection",W(()=>e.size[0]),je,e):void 0;return{mergedTheme:c,mergedClearable:C,mergedClsPrefix:t,rtlEnabled:o,patternInputFocused:g,filterablePlaceholder:P,label:D,selected:R,showTagsPanel:v,isComposing:le,counterRef:b,counterWrapperRef:m,patternInputMirrorRef:r,patternInputRef:a,selfRef:i,multipleElRef:l,singleElRef:s,patternInputWrapperRef:x,overflowRef:u,inputTagElRef:h,handleMouseDown:pe,handleFocusin:$,handleClear:j,handleMouseEnter:J,handleMouseLeave:he,handleDeleteOption:me,handlePatternKeyDown:we,handlePatternInputInput:y,handlePatternInputBlur:Ke,handlePatternInputFocus:Ve,handleMouseEnterCounter:ot,handleMouseLeaveCounter:rt,handleFocusout:q,handleCompositionEnd:ve,handleCompositionStart:N,onPopoverUpdateShow:it,focus:se,focusInput:He,blur:xe,blurInput:Fe,updateCounter:et,getCounter:tt,getTail:nt,renderLabel:e.renderLabel,cssVars:Ue?void 0:je,themeClass:Ie?.themeClass,onRender:Ie?.onRender}},render(){const{status:e,multiple:t,size:n,disabled:o,filterable:r,maxTagCount:a,bordered:i,clsPrefix:l,ellipsisTagPopoverProps:s,onRender:x,renderTag:b,renderLabel:m}=this;x?.();const u=a==="responsive",h=typeof a=="number",v=u||h,g=(p(),H(fr,null,{default:()=>(p(),H(pr,{clsPrefix:l,loading:this.loading,showArrow:this.showArrow,showClear:this.mergedClearable&&this.selected,onClear:this.handleClear},{default:()=>this.$slots.arrow?.()},1032,["clsPrefix","loading","showArrow","showClear","onClear"]))},1024));let M;if(t){const{labelField:c}=this,C=I=>(p(),O("div",{class:_(`${l}-base-selection-tag-wrapper`),key:I.value},[b?(p(),O(ie,{key:0},[F(()=>b({option:I,handleClose:()=>{this.handleDeleteOption(I)}}))],64)):(p(),H(Lt,{key:1,size:n,closable:!I.disabled,disabled:o,onClose:()=>{this.handleDeleteOption(I)},internalCloseIsButtonTag:!1,internalCloseFocusable:!1},{default:()=>m?m(I,!0):Xe(I[c],I,!0)},1032,["size","closable","disabled","onClose"]))],2)),P=()=>(h?this.selectedOptions.slice(0,a):this.selectedOptions).map(C),D=r?(p(),O("div",{class:_(`${l}-base-selection-input-tag`),ref:"inputTagElRef",key:"__input-tag__"},[de("input",Be(this.inputProps,{ref:"patternInputRef",tabindex:-1,disabled:o,value:this.pattern,autofocus:this.autofocus,class:`${l}-base-selection-input-tag__input`,onBlur:this.handlePatternInputBlur,onFocus:this.handlePatternInputFocus,onKeydown:this.handlePatternKeyDown,onInput:this.handlePatternInputInput,onCompositionstart:this.handleCompositionStart,onCompositionend:this.handleCompositionEnd}),null,16,yl),de("span",{ref:"patternInputMirrorRef",class:_(`${l}-base-selection-input-tag__mirror`)},[F(()=>this.pattern)],2)],2)):null,R=u?()=>(p(),O("div",{class:_(`${l}-base-selection-tag-wrapper`),ref:"counterWrapperRef"},[(p(),H(Lt,{size:n,ref:"counterRef",onMouseenter:this.handleMouseEnterCounter,onMouseleave:this.handleMouseLeaveCounter,disabled:o},null,8,["size","onMouseenter","onMouseleave","disabled"]))],2)):void 0;let L;if(h){const I=this.selectedOptions.length-a;I>0&&(L=(te=>(p(),O("div",{class:_(`${l}-base-selection-tag-wrapper`),key:"__counter__"},[(p(),H(Lt,{size:n,ref:"counterRef",onMouseenter:this.handleMouseEnterCounter,disabled:o},{default:()=>`+${I}`},1032,["size","onMouseenter","disabled"]))],2)))())}const U=u?r?(p(),H(Tn,{key:3,ref:"overflowRef",updateCounter:this.updateCounter,getCounter:this.getCounter,getTail:this.getTail,style:{width:"100%",display:"flex",overflow:"hidden"}},{default:P,counter:R,tail:()=>D},1032,["updateCounter","getCounter","getTail"])):(p(),H(Tn,{key:4,ref:"overflowRef",updateCounter:this.updateCounter,getCounter:this.getCounter,style:{width:"100%",display:"flex",overflow:"hidden"}},{default:P,counter:R},1032,["updateCounter","getCounter"])):h&&L?P().concat(L):P(),Q=v?()=>(p(),O("div",{class:_(`${l}-base-selection-popover`)},[u?(p(),O(ie,{key:0},[F(()=>P())],64)):(p(),O(ie,{key:1},[F(()=>this.selectedOptions.map(C))],64))],2)):void 0,z=v?{show:this.showTagsPanel,trigger:"hover",overlap:!0,placement:"top",width:"trigger",onUpdateShow:this.onPopoverUpdateShow,theme:this.mergedTheme.peers.Popover,themeOverrides:this.mergedTheme.peerOverrides.Popover,...s}:null,V=!this.selected&&(!this.active||!this.pattern&&!this.isComposing)?(p(),O("div",{key:5,class:_(`${l}-base-selection-placeholder ${l}-base-selection-overlay`)},[de("div",{class:_(`${l}-base-selection-placeholder__inner`)},[F(()=>this.placeholder)],2)],2)):null,S=r?(p(),O("div",{key:6,ref:"patternInputWrapperRef",class:_(`${l}-base-selection-tags`)},[F(()=>U),u?F(()=>null):(p(),O(ie,{key:1},[F(()=>D)],64)),F(()=>g)],2)):(p(),O("div",{key:7,ref:"multipleElRef",class:_(`${l}-base-selection-tags`),tabindex:o?void 0:0},[F(()=>U),F(()=>g)],10,xl));M=(I=>(p(),O(ie,{key:8},[v?(p(),H(al,Be({key:0},z,{scrollable:!0,style:"max-height: calc(var(--v-target-height) * 6.6);"}),{trigger:()=>S,default:Q},1040)):(p(),O(ie,{key:1},[F(()=>S)],64)),F(()=>V)],64)))()}else if(r){const c=this.pattern||this.isComposing,C=this.active?!c:!this.selected,P=this.active?!1:this.selected;M=(D=>(p(),O("div",{key:9,ref:"patternInputWrapperRef",class:_(`${l}-base-selection-label`),title:this.patternInputFocused?void 0:zn(this.label)},[de("input",Be(this.inputProps,{ref:"patternInputRef",class:`${l}-base-selection-input`,value:this.active?this.pattern:"",placeholder:"",readonly:o,disabled:o,tabindex:-1,autofocus:this.autofocus,onFocus:this.handlePatternInputFocus,onBlur:this.handlePatternInputBlur,onInput:this.handlePatternInputInput,onCompositionstart:this.handleCompositionStart,onCompositionend:this.handleCompositionEnd}),null,16,Sl),P?(p(),O("div",{class:_(`${l}-base-selection-label__render-label ${l}-base-selection-overlay`),key:"input"},[de("div",{class:_(`${l}-base-selection-overlay__wrapper`)},[b?(p(),O(ie,{key:0},[F(()=>b({option:this.selectedOption,handleClose:()=>{}}))],64)):(p(),O(ie,{key:1},[m?(p(),O(ie,{key:0},[F(()=>m(this.selectedOption,!0))],64)):(p(),O(ie,{key:1},[F(()=>Xe(this.label,this.selectedOption,!0))],64))],64))],2)],2)):F(()=>null),C?(p(),O("div",{class:_(`${l}-base-selection-placeholder ${l}-base-selection-overlay`),key:"placeholder"},[de("div",{class:_(`${l}-base-selection-overlay__wrapper`)},[F(()=>this.filterablePlaceholder)],2)],2)):F(()=>null),F(()=>g)],10,Cl)))()}else M=(c=>(p(),O("div",{key:10,ref:"singleElRef",class:_(`${l}-base-selection-label`),tabindex:this.disabled?void 0:0},[this.label!==void 0?(p(),O("div",{class:_(`${l}-base-selection-input`),title:zn(this.label),key:"input"},[de("div",{class:_(`${l}-base-selection-input__content`)},[b?(p(),O(ie,{key:0},[F(()=>b({option:this.selectedOption,handleClose:()=>{}}))],64)):(p(),O(ie,{key:1},[m?(p(),O(ie,{key:0},[F(()=>m(this.selectedOption,!0))],64)):(p(),O(ie,{key:1},[F(()=>Xe(this.label,this.selectedOption,!0))],64))],64))],2)],10,["title"])):(p(),O("div",{class:_(`${l}-base-selection-placeholder ${l}-base-selection-overlay`),key:"placeholder"},[de("div",{class:_(`${l}-base-selection-placeholder__inner`)},[F(()=>this.placeholder)],2)],2)),F(()=>g)],10,Ml)))();return p(),O("div",{ref:"selfRef",class:_([`${l}-base-selection`,this.rtlEnabled&&`${l}-base-selection--rtl`,this.themeClass,e&&`${l}-base-selection--${e}-status`,{[`${l}-base-selection--active`]:this.active,[`${l}-base-selection--selected`]:this.selected||this.active&&this.pattern,[`${l}-base-selection--disabled`]:this.disabled,[`${l}-base-selection--multiple`]:this.multiple,[`${l}-base-selection--focus`]:this.focused}]),style:Oe(this.cssVars),onClick:this.onClick,onMouseenter:this.handleMouseEnter,onMouseleave:this.handleMouseLeave,onKeydown:this.onKeydown,onFocusin:this.handleFocusin,onFocusout:this.handleFocusout,onMousedown:this.handleMouseDown},[F(()=>M),i?(p(),O("div",{key:0,class:_(`${l}-base-selection__border`)},null,2)):F(()=>null),i?(p(),O("div",{key:2,class:_(`${l}-base-selection__state-border`)},null,2)):F(()=>null)],46,Ol)}}),Pl=ne([B("select",`
 z-index: auto;
 outline: none;
 width: 100%;
 position: relative;
 font-weight: var(--n-font-weight);
 `),B("select-menu",`
 margin: 4px 0;
 box-shadow: var(--n-menu-box-shadow);
 `,[Hn({originalTransition:"background-color .3s var(--n-bezier), box-shadow .3s var(--n-bezier)"})])]);const Fl={...$e.props,to:Pe.propTo,bordered:{type:Boolean,default:void 0},clearable:Boolean,clearCreatedOptionsOnClear:{type:Boolean,default:!0},clearFilterAfterSelect:{type:Boolean,default:!0},options:{type:Array,default:()=>[]},defaultValue:{type:[String,Number,Array],default:null},keyboard:{type:Boolean,default:!0},value:[String,Number,Array],placeholder:String,menuProps:Object,multiple:Boolean,size:String,menuSize:{type:String},filterable:Boolean,disabled:{type:Boolean,default:void 0},remote:Boolean,loading:Boolean,filter:Function,placement:{type:String,default:"bottom-start"},widthMode:{type:String,default:"trigger"},tag:Boolean,onCreate:Function,fallbackOption:{type:[Function,Boolean],default:void 0},show:{type:Boolean,default:void 0},showArrow:{type:Boolean,default:!0},maxTagCount:[Number,String],ellipsisTagPopoverProps:Object,consistentMenuWidth:{type:Boolean,default:!0},virtualScroll:{type:Boolean,default:!0},labelField:{type:String,default:"label"},valueField:{type:String,default:"value"},childrenField:{type:String,default:"children"},renderLabel:Function,renderOption:Function,renderTag:Function,"onUpdate:value":[Function,Array],inputProps:Object,nodeProps:Function,ignoreComposition:{type:Boolean,default:!0},showOnFocus:Boolean,onUpdateValue:[Function,Array],onBlur:[Function,Array],onClear:[Function,Array],onFocus:[Function,Array],onScroll:[Function,Array],onSearch:[Function,Array],onUpdateShow:[Function,Array],"onUpdate:show":[Function,Array],displayDirective:{type:String,default:"show"},resetMenuOnOptionsChange:{type:Boolean,default:!0},status:String,showCheckmark:{type:Boolean,default:!0},scrollbarProps:Object,onChange:[Function,Array],items:Array};var Al=ue({name:"Select",props:Fl,slots:Object,setup(e){const{mergedClsPrefixRef:t,mergedBorderedRef:n,namespaceRef:o,inlineThemeDisabled:r,mergedComponentPropsRef:a}=Ft(e),i=$e("Select","-select",Pl,wr,e,t),l=T(e.defaultValue),s=Z(e,"value"),x=Xt(s,l),b=T(!1),m=T(""),u=Vn(e,["items","options"]),h=T([]),v=T([]),g=W(()=>v.value.concat(h.value).concat(u.value)),M=W(()=>{const{filter:d}=e;if(d)return d;const{labelField:w,valueField:A}=e;return(k,K)=>{if(!K)return!1;const G=K[w];if(typeof G=="string")return Ut(k,G);const Y=K[A];return typeof Y=="string"?Ut(k,Y):typeof Y=="number"?Ut(k,String(Y)):!1}}),c=W(()=>{if(e.remote)return u.value;{const{value:d}=g,{value:w}=m;return!w.length||!e.filterable?d:bl(d,M.value,w,e.childrenField)}}),C=W(()=>{const{valueField:d,childrenField:w}=e,A=gl(d,w);return Mr(c.value,A)}),P=W(()=>ml(g.value,e.valueField,e.childrenField)),D=T(!1),R=Xt(Z(e,"show"),D),L=T(null),U=T(null),Q=T(null),{localeRef:z}=gr("Select"),V=W(()=>e.placeholder??z.value.placeholder),S=[],I=T(new Map),te=W(()=>{const{fallbackOption:d}=e;if(d===void 0){const{labelField:w,valueField:A}=e;return k=>({[w]:String(k),[A]:k})}return d===!1?!1:w=>Object.assign(d(w),{value:w})});function $(d){const w=e.remote,{value:A}=I,{value:k}=P,{value:K}=te,G=[];return d.forEach(Y=>{if(k.has(Y))G.push(k.get(Y));else if(w&&A.has(Y))G.push(A.get(Y));else if(K){const oe=K(Y);oe&&G.push(oe)}}),G}const q=W(()=>{if(e.multiple){const{value:d}=x;return Array.isArray(d)?$(d):[]}return null}),j=W(()=>{const{value:d}=x;return!e.multiple&&!Array.isArray(d)?d===null?null:$([d])[0]||null:null}),J=br(e,{mergedSize:d=>{const{size:w}=e;if(w)return w;const{mergedSize:A}=d||{};if(A?.value)return A.value;const k=a?.value?.Select?.size;return k||"medium"}}),{mergedSizeRef:he,mergedDisabledRef:pe,mergedStatusRef:me}=J;function le(d,w){const{onChange:A,"onUpdate:value":k,onUpdateValue:K}=e,{nTriggerFormChange:G,nTriggerFormInput:Y}=J;A&&ae(A,d,w),K&&ae(K,d,w),k&&ae(k,d,w),l.value=d,G(),Y()}function we(d){const{onBlur:w}=e,{nTriggerFormBlur:A}=J;w&&ae(w,d),A()}function ye(){const{onClear:d}=e;d&&ae(d)}function y(d){const{onFocus:w,showOnFocus:A}=e,{nTriggerFormFocus:k}=J;w&&ae(w,d),k(),A&&xe()}function N(d){const{onSearch:w}=e;w&&ae(w,d)}function ve(d){const{onScroll:w}=e;w&&ae(w,d)}function Ve(){const{remote:d,multiple:w}=e;if(d){const{value:A}=I;if(w){const{valueField:k}=e;q.value?.forEach(K=>{A.set(K[k],K)})}else{const k=j.value;k&&A.set(k[e.valueField],k)}}}function Ke(d){const{onUpdateShow:w,"onUpdate:show":A}=e;w&&ae(w,d),A&&ae(A,d),D.value=d}function xe(){pe.value||(Ke(!0),D.value=!0,e.filterable&&pt())}function se(){Ke(!1)}function He(){m.value="",v.value=S}const Fe=T(!1);function et(){e.filterable&&(Fe.value=!0)}function tt(){e.filterable&&(Fe.value=!1,R.value||He())}function nt(){pe.value||(R.value?e.filterable?pt():se():xe())}function ke(d){Q.value?.selfRef?.contains(d.relatedTarget)||(b.value=!1,we(d),se())}function _e(d){y(d),b.value=!0}function ot(){b.value=!0}function rt(d){L.value?.$el.contains(d.relatedTarget)||(b.value=!1,we(d),se())}function it(){L.value?.focus(),se()}function Ue(d){R.value&&(L.value?.$el.contains(Gt(d))||se())}function je(d){if(!Array.isArray(d))return[];if(te.value)return Array.from(d);{const{remote:w}=e,{value:A}=P;if(w){const{value:k}=I;return d.filter(K=>A.has(K)||k.has(K))}else return d.filter(k=>A.has(k))}}function Ie(d){f(d.rawNode)}function f(d){if(pe.value)return;const{tag:w,remote:A,clearFilterAfterSelect:k,valueField:K}=e;if(w&&!A){const{value:G}=v,Y=G[0]||null;if(Y){const oe=h.value;oe.length?oe.push(Y):h.value=[Y],v.value=S}}if(A&&I.value.set(d[K],d),e.multiple){const G=je(x.value),Y=G.findIndex(oe=>oe===d[K]);if(~Y){if(G.splice(Y,1),w&&!A){const oe=E(d[K]);~oe&&(h.value.splice(oe,1),k&&(m.value=""))}}else G.push(d[K]),k&&(m.value="");le(G,$(G))}else{if(w&&!A){const G=E(d[K]);~G?h.value=[h.value[G]]:h.value=S}ht(),se(),le(d[K],d)}}function E(d){return h.value.findIndex(w=>w[e.valueField]===d)}function zt(d){R.value||xe();const{value:w}=d.target;m.value=w;const{tag:A,remote:k}=e;if(N(w),A&&!k){if(!w){v.value=S;return}const{onCreate:K}=e,G=K?K(w):{[e.labelField]:w,[e.valueField]:w},{valueField:Y,labelField:oe}=e;u.value.some(Ee=>Ee[Y]===G[Y]||Ee[oe]===G[oe])||h.value.some(Ee=>Ee[Y]===G[Y]||Ee[oe]===G[oe])?v.value=S:v.value=[G]}}function At(d){d.stopPropagation();const{multiple:w,tag:A,remote:k,clearCreatedOptionsOnClear:K}=e;!w&&e.filterable&&se(),A&&!k&&K&&(h.value=S),ye(),w?le([],[]):le(null,null)}function Bt(d){!dt(d,"action")&&!dt(d,"empty")&&!dt(d,"header")&&d.preventDefault()}function kt(d){ve(d)}function ft(d){if(!e.keyboard){d.preventDefault();return}switch(d.key){case" ":if(e.filterable)break;d.preventDefault();case"Enter":if(!L.value?.isComposing){if(R.value){const w=Q.value?.getPendingTmNode();w?Ie(w):e.filterable||(se(),ht())}else if(xe(),e.tag&&Fe.value){const w=v.value[0];if(w){const A=w[e.valueField],{value:k}=x;e.multiple&&Array.isArray(k)&&k.includes(A)||f(w)}}}d.preventDefault();break;case"ArrowUp":if(d.preventDefault(),e.loading)return;R.value&&Q.value?.prev();break;case"ArrowDown":if(d.preventDefault(),e.loading)return;R.value?Q.value?.next():xe();break;case"Escape":R.value&&(mr(d),se()),L.value?.focus()}}function ht(){L.value?.focus()}function pt(){L.value?.focusInput()}function _t(){R.value&&U.value?.syncPosition()}Ve(),fe(Z(e,"options"),Ve);const It={focus:()=>{L.value?.focus()},focusInput:()=>{L.value?.focusInput()},blur:()=>{L.value?.blur()},blurInput:()=>{L.value?.blurInput()}},vt=W(()=>{const{self:{menuBoxShadow:d}}=i.value;return{"--n-menu-box-shadow":d}}),gt=r?Tt("select",void 0,vt,e):void 0;return{...It,mergedStatus:me,mergedClsPrefix:t,mergedBordered:n,namespace:o,treeMate:C,isMounted:tn(),triggerRef:L,menuRef:Q,pattern:m,uncontrolledShow:D,mergedShow:R,adjustedTo:Pe(e),uncontrolledValue:l,mergedValue:x,followerRef:U,localizedPlaceholder:V,selectedOption:j,selectedOptions:q,mergedSize:he,mergedDisabled:pe,focused:b,activeWithoutMenuOpen:Fe,inlineThemeDisabled:r,onTriggerInputFocus:et,onTriggerInputBlur:tt,handleTriggerOrMenuResize:_t,handleMenuFocus:ot,handleMenuBlur:rt,handleMenuTabOut:it,handleTriggerClick:nt,handleToggle:Ie,handleDeleteOption:f,handlePatternInput:zt,handleClear:At,handleTriggerBlur:ke,handleTriggerFocus:_e,handleKeydown:ft,handleMenuAfterLeave:He,handleMenuClickOutside:Ue,handleMenuScroll:kt,handleMenuKeydown:ft,handleMenuMousedown:Bt,mergedTheme:i,cssVars:r?void 0:vt,themeClass:gt?.themeClass,onRender:gt?.onRender}},render(){return p(),O("div",{class:_(`${this.mergedClsPrefix}-select`)},[vr(Qn,null,{_:1,default:Me(()=>[(p(),H(eo,null,{_:1,default:Me(()=>(p(),H($l,{ref:"triggerRef",inlineThemeDisabled:this.inlineThemeDisabled,status:this.mergedStatus,inputProps:this.inputProps,clsPrefix:this.mergedClsPrefix,showArrow:this.showArrow,maxTagCount:this.maxTagCount,ellipsisTagPopoverProps:this.ellipsisTagPopoverProps,bordered:this.mergedBordered,active:this.activeWithoutMenuOpen||this.mergedShow,pattern:this.pattern,placeholder:this.localizedPlaceholder,selectedOption:this.selectedOption,selectedOptions:this.selectedOptions,multiple:this.multiple,renderTag:this.renderTag,renderLabel:this.renderLabel,filterable:this.filterable,clearable:this.clearable,disabled:this.mergedDisabled,size:this.mergedSize,theme:this.mergedTheme.peers.InternalSelection,labelField:this.labelField,valueField:this.valueField,themeOverrides:this.mergedTheme.peerOverrides.InternalSelection,loading:this.loading,focused:this.focused,onClick:this.handleTriggerClick,onDeleteOption:this.handleDeleteOption,onPatternInput:this.handlePatternInput,onClear:this.handleClear,onBlur:this.handleTriggerBlur,onFocus:this.handleTriggerFocus,onKeydown:this.handleKeydown,onPatternBlur:this.onTriggerInputBlur,onPatternFocus:this.onTriggerInputFocus,onResize:this.handleTriggerOrMenuResize,ignoreComposition:this.ignoreComposition},{_:1,arrow:Me(()=>[this.$slots.arrow?.()])},8,["inlineThemeDisabled","status","inputProps","clsPrefix","showArrow","maxTagCount","ellipsisTagPopoverProps","bordered","active","pattern","placeholder","selectedOption","selectedOptions","multiple","renderTag","renderLabel","filterable","clearable","disabled","size","theme","labelField","valueField","themeOverrides","loading","focused","onClick","onDeleteOption","onPatternInput","onClear","onBlur","onFocus","onKeydown","onPatternBlur","onPatternFocus","onResize","ignoreComposition"])))})),(p(),H(to,{ref:"followerRef",show:this.mergedShow,to:this.adjustedTo,teleportDisabled:this.adjustedTo===Pe.tdkey,containerClass:this.namespace,width:this.consistentMenuWidth?"target":void 0,minWidth:"target",placement:this.placement},{_:1,default:Me(()=>(p(),H(nn,{name:"fade-in-scale-up-transition",appear:this.isMounted,onAfterLeave:this.handleMenuAfterLeave},{_:1,default:Me(()=>this.mergedShow||this.displayDirective==="show"?(this.onRender?.(),ct((p(),H(vl,Be(this.menuProps,{ref:"menuRef",onResize:this.handleTriggerOrMenuResize,inlineThemeDisabled:this.inlineThemeDisabled,virtualScroll:this.consistentMenuWidth&&this.virtualScroll,class:[`${this.mergedClsPrefix}-select-menu`,this.themeClass,this.menuProps?.class],clsPrefix:this.mergedClsPrefix,focusable:!0,labelField:this.labelField,valueField:this.valueField,autoPending:!0,nodeProps:this.nodeProps,theme:this.mergedTheme.peers.InternalSelectMenu,themeOverrides:this.mergedTheme.peerOverrides.InternalSelectMenu,treeMate:this.treeMate,multiple:this.multiple,size:this.menuSize,renderOption:this.renderOption,renderLabel:this.renderLabel,value:this.mergedValue,style:[this.menuProps?.style,this.cssVars],onToggle:this.handleToggle,onScroll:this.handleMenuScroll,onFocus:this.handleMenuFocus,onBlur:this.handleMenuBlur,onKeydown:this.handleMenuKeydown,onTabOut:this.handleMenuTabOut,onMousedown:this.handleMenuMousedown,show:this.mergedShow,showCheckmark:this.showCheckmark,resetMenuOnOptionsChange:this.resetMenuOnOptionsChange,scrollbarProps:this.scrollbarProps}),{_:1,empty:Me(()=>[this.$slots.empty?.()]),header:Me(()=>[this.$slots.header?.()]),action:Me(()=>[this.$slots.action?.()])},16,["onResize","inlineThemeDisabled","virtualScroll","class","clsPrefix","labelField","valueField","nodeProps","theme","themeOverrides","treeMate","multiple","size","renderOption","renderLabel","value","style","onToggle","onScroll","onFocus","onBlur","onKeydown","onTabOut","onMousedown","show","showCheckmark","resetMenuOnOptionsChange","scrollbarProps"])),this.displayDirective==="show"?[[Wn,this.mergedShow],[Ct,this.handleMenuClickOutside,void 0,{capture:!0}]]:[[Ct,this.handleMenuClickOutside,void 0,{capture:!0}]])):null)},8,["appear","onAfterLeave"])))},8,["show","to","teleportDisabled","containerClass","width","placement"]))])})],2)}});export{Qn as B,al as P,vl as S,eo as V,to as a,oo as b,gl as c,$l as d,Al as e,dl as f,zn as g,Li as o,il as p,Qi as r,Pe as u};
