import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedController } from '../lib/isolated.js'
const directory = mkdtempSync(join(tmpdir(), 'dsh-relay-isolation-'))
const live = new Map(), calls = [], rows = [{ sessionId: 'ordinary', running: false }]
const base = {
 async create(request) { const id = request.sessionId || 'root'; live.set(id, { id }); calls.push(['root', request]); return { sessionId: id } },
 async list() { return { items: rows } }, async page(request) { calls.push(['page', request]); return { records: [], hasMore: false } }, async inspect() { return {} },
}
const agents = {
 get: id=>live.get(id),
 async create(spec) { calls.push(['create',spec]); return this.make(spec,spec.sessionId) },
 async resume(spec) { calls.push(['resume',spec]); return this.make(spec,spec.resumeSessionId) },
 async make(spec,id) { const agent={id,session:{append:(...x)=>calls.push(['event',...x])},followup:x=>calls.push(['followup',id,x]),steer:x=>calls.push(['steer',id,x]),cancel:(...x)=>calls.push(['cancel',id,...x])}; await spec.setup({on:()=>{}},agent);live.set(id,agent);rows.push({sessionId:id,origin:spec.meta?.origin||'subagent',running:true});return {agent,dispose:async()=>{}} },
}
const ctx={get:key=>({agents,llm:{resolveCallConfig:async x=>x},agentDefaultModel:{currentSelection:()=>({provider:'deepseek-account',model:'deepseek-flash'})}})[key]}
try {
 let api=isolatedController(ctx,base,directory)
 const a=await api.controller.create({cwd:process.cwd()})
 await api.controller.selectModel({sessionId:a.sessionId,provider:'deepseek-account',model:'deepseek-flash',reasoningEffort:'high'})
 await api.controller.prompt({sessionId:a.sessionId,requestId:'r1',content:[{type:'text',text:'review'}]})
 const created=calls.find(x=>x[0]==='create')[1]
 assert.equal(created.meta.origin,'subagent','native UI must exclude agent from ordinary conversations')
 assert.equal(created.meta.parentSession,'root')
 assert.equal(created.agentOptions.model,'deepseek-flash')
 assert.equal((await api.controller.list()).items.length,1,'ordinary conversations must be excluded')
 await api.controller.page({address:{kind:'session',sessionId:a.sessionId},throughSeq:8})
 assert.equal(calls.at(-1)[1].address.kind,'subagent','history must use child addressing')
 live.delete(a.sessionId)
 api=isolatedController(ctx,base,directory)
 await api.controller.prompt({sessionId:a.sessionId,requestId:'r2',content:[{type:'text',text:'continue'}]})
 assert.equal(calls.filter(x=>x[0]==='resume').length,1,'cold reload resumes same child directly, without a parent model result route')
 assert.equal(calls.at(-1)[1],a.sessionId)
 await api.controller.cancel({sessionId:a.sessionId})
 await assert.rejects(api.controller.cancel({sessionId:'ordinary'}),/not owned/)
 await assert.rejects(api.controller.selectModel({sessionId:a.sessionId,provider:'other',model:'other'}),/new task/)
 assert.equal(calls.filter(x=>x[0]==='root').length,1)
 assert.ok(calls.filter(x=>x[0]==='followup').every(x=>x[1]===a.sessionId),'the control parent is never prompted')
 console.log('PASS native isolation, no parent model, scoped history, persisted cold continuation, scoped cancellation, model isolation')
} finally {rmSync(directory,{recursive:true,force:true})}
