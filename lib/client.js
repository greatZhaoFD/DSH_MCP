window.__ModuleLoader__.load({id:'dsh_mcp',factory:require=>{
 const R=require('react'),h=R.createElement,{useState,useEffect}=R;
 const control={padding:'9px 12px',color:'inherit',background:'transparent',border:'1px solid #8993a555',borderRadius:8,font:'inherit',maxWidth:'100%'};
 function Settings({ctx,close}){
  const[token,T]=useState(''),[catalog,C]=useState(null),[tasks,J]=useState([]),[key,K]=useState(''),[effort,E]=useState(''),[notice,N]=useState(''),[error,X]=useState(''),[busy,B]=useState(false);
  const[opening,O]=useState(null);
  async function api(path,body,secret=token){const response=await fetch('/dsh-relay'+path,{method:body?'POST':'GET',headers:secret?{'x-dsh-relay-token':secret,...(body?{'Content-Type':'application/json'}:{})}:{'x-dsh-relay-ui':'1'},...(body?{body:JSON.stringify(body)}:{}),cache:'no-store'});const result=await response.json();if(!response.ok||!result.ok)throw Error(result.error||`HTTP ${response.status}`);return result.data}
  useEffect(()=>{let active=true,timer;(async()=>{try{const boot=await api('/ui-config',undefined,'');const[models,jobs]=await Promise.all([api('/models',undefined,boot.token),api('/tasks',undefined,boot.token)]);if(!active)return;T(boot.token);C(models);J(jobs);const s=boot.preferences.selection;K(s?JSON.stringify([s.provider,s.model]):'');E(s?.reasoningEffort||'');timer=setInterval(async()=>{try{const jobs=await api('/tasks',undefined,boot.token);if(active)J(jobs)}catch{}},10000)}catch(e){if(active)X(e.message)}})();return()=>{active=false;clearInterval(timer)}},[]);
  const selected=key?JSON.parse(key):null,model=selected&&catalog?.providers.find(x=>x.id===selected[0])?.models.find(x=>x.id===selected[1]);
  async function save(){B(true);X('');N('');try{await api('/preferences',{selection:selected?{provider:selected[0],model:selected[1],...(effort?{reasoningEffort:effort}:{})}:null});N('已保存，新建代理任务时生效')}catch(e){X(e.message)}finally{B(false)}}
  async function openRecords(task){O(task.sessionId);X('');try{await api('/open-communications',{sessionId:task.sessionId})}catch(e){X(e.message==='unknown route'?'DSH 后台尚未加载新版通信记录接口。请在运行中的子代理结束后，重载 DSH_MCP 插件并刷新页面；仅刷新页面不会更新后台。':e.message)}finally{O(null)}}
  async function open(task){try{ctx.uiWorkspace.openSession(task.sessionId);close?.()}catch(e){X(e.message)}}
  return h('div',{style:{maxWidth:920,padding:'12px 4px',lineHeight:1.6}},
   h('h2',{style:{margin:'0 0 8px'}},'DSH_MCP'),h('p',{style:{opacity:.7}},'代理对话显示在对应项目工作区，以“子代理：任务名”命名。直接打开即可使用正常聊天界面继续交流。'),
   h('div',{style:{border:'1px solid #8993a533',borderRadius:12,padding:20,margin:'20px 0'}},
    h('h3',{style:{marginTop:0}},'新建代理的默认模型'),h('p',{style:{opacity:.65,fontSize:13}},catalog?`当前 DSH：${catalog.providers.length} 个提供方，${catalog.providers.reduce((n,p)=>n+p.models.length,0)} 个模型`:'正在读取 DSH 模型目录…'),
    h('label',{style:{display:'block',margin:'12px 0 5px'}},'模型'),h('select',{style:{...control,width:'100%'},value:key,disabled:!catalog,onChange:e=>{K(e.target.value);E('');N('')}},h('option',{value:''},'跟随 DSH 默认模型'),...(catalog?.providers||[]).map(p=>h('optgroup',{key:p.id,label:p.name||p.id},...p.models.map(m=>h('option',{key:m.id,value:JSON.stringify([p.id,m.id])},`${m.name||m.id} · ${m.id}`))))),
    h('label',{style:{display:'block',margin:'16px 0 5px'}},'推理强度'),h('select',{style:{...control,minWidth:220},value:effort,disabled:!model?.reasoning,onChange:e=>{E(e.target.value);N('')}},h('option',{value:''},model?.reasoning?.defaultEffort?`模型默认（${model.reasoning.defaultEffort}）`:'模型默认'),...(model?.reasoning?.efforts||[]).map(x=>h('option',{key:x.id,value:x.id},x.name||x.id))),
    h('div',{style:{display:'flex',alignItems:'center',gap:12,marginTop:20}},h('button',{style:control,disabled:busy||!catalog,onClick:save},busy?'保存中…':'保存默认值'),h('span',{style:{color:'#14865d',fontSize:13}},notice))),
   error&&h('p',{role:'alert',style:{color:'#d35a50',whiteSpace:'pre-wrap'}},error),h('h3',null,'工作区中的代理对话'),
   !tasks.length&&h('p',{style:{opacity:.65}},'首次委派后，对话会出现在这里和对应工作区中。'),
   ...tasks.slice().sort((a,b)=>(b.updatedAt||b.createdAt)-(a.updatedAt||a.createdAt)).map(t=>h('div',{key:t.sessionId},h('div',{style:{borderBottom:'1px solid #8993a533',padding:'14px 0',display:'flex',gap:12,alignItems:'center',flexWrap:'wrap'}},h('div',{style:{flex:1,minWidth:180}},h('div',{style:{fontWeight:600}},t.title||'子代理：准备任务'),h('div',{style:{opacity:.6,fontSize:12,overflowWrap:'anywhere'}},t.cwd),t.migrationPending&&h('div',{style:{color:'#d35a50',fontSize:12}},t.migrationPending)),h('span',{style:{opacity:.6,fontSize:12}},t.running?'运行中':'可继续对话'),h('button',{style:control,onClick:()=>open(t)},'打开对话'),h('button',{style:control,disabled:Boolean(opening),onClick:()=>openRecords(t)},opening===t.sessionId?'正在打开…':'通信记录')))));
 }
 return{inject:['slots','uiWorkspace'],apply(ctx){ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'DSH_MCP',order:66,label:()=>'DSH_MCP'},props=>h(Settings,{ctx,close:props.close})))}};
}});

