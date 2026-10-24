import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import test from 'node:test'
import { openTemporaryViewer } from '../lib/temporary-viewer.mjs'
const deferred = () => { let resolve, reject; const promise = new Promise((a,b)=>{resolve=a;reject=b}); return {promise,resolve,reject} }
const text = value => ({type:'text',text:value})
const event = (seq,type,data) => ({event:{seq,time:seq,type,data}})

test('opens one immutable Markdown snapshot; includes reports/intermediate replies; removes only generated files when its tab closes', async () => {
  const root=mkdtempSync(join(process.cwd(),'.temporary-test-'))
  const native=join(root,'native.jsonl');writeFileSync(native,'original')
  const waiter=deferred();let pages=0, reportReads=0, launched
  const page = [event(1,'user/message',{source:{kind:'user',rpcId:'relay-123-1'},content:[text('TASK')]}),
    event(2,'assistant/message',{message:{content:[text('INTERMEDIATE'),{type:'reasoning',text:'PRIVATE'},{type:'tool-call',name:'read'}]}}),
    event(3,'tool/call',{name:'read',arguments:{path:'secret-tools'}}),
    event(4,'tool/result',{message:{content:[text('TOOL OUTPUT')]}}),
    event(5,'user/message',{source:{kind:'user',rpcId:'human'},content:[text('HUMAN INPUT')]}),
    event(6,'system/message',{message:{content:[text('SYSTEM')]}})]
  try {
    const view=await openTemporaryViewer({temporaryRoot:root,task:{sessionId:'test'},
      readPage:async()=>{pages++;return{records:page,cursor:6,hasMore:false}},
      readReports:async()=>{reportReads++;return[{id:'report:1',seq:1,time:7,type:'report/mailbox',role:'report',label:'DSH → Codex 后台报告',message:'REPORT',basis:'mailbox'}]},
      launcher:file=>{launched=file;return{started:Promise.resolve(),closed:waiter.promise}}})
    assert.equal(view.file,launched)
    assert.deepEqual(readdirSync(dirname(view.file)),['通信记录.md'])
    const content=readFileSync(view.file,'utf8')
    for(const value of ['TASK','INTERMEDIATE','SYSTEM','REPORT'])assert.ok(content.includes(value))
    for(const value of ['PRIVATE','TOOL OUTPUT','secret-tools','HUMAN INPUT'])assert.ok(!content.includes(value))
    page.push(event(7,'assistant/message',{message:{content:[text('NEW LIVE OUTPUT')]}}))
    await new Promise(done=>setTimeout(done,40))
    assert.equal(pages,1);assert.equal(reportReads,1)
    assert.equal(readFileSync(view.file,'utf8'),content,'open view never refreshes')
    waiter.resolve();await view.closed
    assert.equal(existsSync(view.file),false)
    assert.equal(existsSync(dirname(view.file)),false)
    assert.equal(readFileSync(native,'utf8'),'original')
  }finally{rmSync(root,{recursive:true,force:true})}
})

test('startup failure cleans the temporary MD and directory', async()=>{
  const root=mkdtempSync(join(process.cwd(),'.temporary-failure-'))
  try{
    await assert.rejects(openTemporaryViewer({temporaryRoot:root,task:{sessionId:'test'},
      readPage:async()=>({records:[],cursor:0,hasMore:false}),readReports:async()=>[],launcher:()=>{throw Error('no editor')}}),/no editor/)
    assert.deepEqual(readdirSync(root),[])
  }finally{rmSync(root,{recursive:true,force:true})}
})
