import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

test('one communication entry opens VS Code through the authenticated POST; no inline reader or export controls', async()=>{
  let current, plugin, settingsRender, legacyBackend=false
  const calls=[],effects=[],cleanups=[],state=[];let index=0
  const react={
    createElement:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)}),
    useState(initial){const n=index++;if(!(n in state))state[n]=initial;return[state[n],v=>{state[n]=v}]},
    useEffect(fn){const n=index++;if(!(n in state)){state[n]=true;effects.push(fn)}},
  }
  const fetch=async(path,init)=>{
    calls.push({path,init});let data
    if(path.endsWith('/ui-config'))data={token:'secret',preferences:{selection:null}}
    else if(path.endsWith('/models'))data={providers:[]}
    else if(path.endsWith('/tasks'))data=[{sessionId:'s1',title:'子代理：测试',cwd:'D:\\project'}]
    else if(path.endsWith('/open-communications')){
      if(legacyBackend)return{ok:false,status:404,json:async()=>({ok:false,error:'unknown route'})}
      data={opened:true}
    }
    else throw Error('Unexpected request: '+path)
    return{ok:true,json:async()=>({ok:true,data})}
  }
  runInNewContext(readFileSync(new URL('../lib/client.js',import.meta.url),'utf8'),{
    window:{__ModuleLoader__:{load(def){plugin=def.factory(()=>react)}}},fetch,
    setInterval(){return 1},clearInterval(){},console,
  })
  const ctx={slots:{inject(_name,fn){fn()},register(_def,render){settingsRender=render}},uiWorkspace:{openSession(){}}}
  plugin.apply(ctx);const component=settingsRender({})
  const render=()=>{index=0;return component.type(component.props)}
  const nodes=n=>n&&typeof n==='object'?[n,...(n.children||[]).flatMap(nodes)]:[]
  render();for(const fn of effects.splice(0))cleanups.push(fn())
  for(let n=0;n<5;n++)await new Promise(done=>setImmediate(done))
  const tree=render(),all=nodes(tree)
  const labels=all.filter(n=>n.type==='button').flatMap(n=>n.children.filter(x=>typeof x==='string'))
  assert.ok(labels.includes('打开对话'));assert.ok(labels.includes('通信记录'))
  for(const label of ['复制全部','导出文本','显示工具事件','刷新记录','关闭记录'])assert.ok(!labels.includes(label))
  assert.ok(!all.some(n=>n.type==='article'||n.type==='pre'||n.type==='input'))
  await all.find(n=>n.type==='button'&&n.children.includes('通信记录')).props.onClick()
  const call=calls.find(c=>c.path.endsWith('/open-communications'))
  assert.equal(call.init.method,'POST');assert.equal(call.init.headers['x-dsh-relay-token'],'secret')
  assert.equal(JSON.parse(call.init.body).sessionId,'s1')
  assert.ok(!calls.some(c=>c.path.includes('/communications?')||c.path.includes('/poll')))
  legacyBackend=true
  await nodes(render()).find(n=>n.type==='button'&&n.children.includes('通信记录')).props.onClick()
  const alert=nodes(render()).find(n=>n.props.role==='alert')
  assert.ok(alert.children[0].includes('后台尚未加载新版'))
  assert.ok(alert.children[0].includes('子代理结束后'))
  assert.ok(!alert.children[0].includes('unknown route'))
  for(const fn of cleanups)fn?.()
})
