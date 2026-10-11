import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { serveLocalStatic } from '../../apps/server/platform/web-local-static.ts';
import { syntheticProviderBootstrap } from '../../packages/contracts/web-provider.ts';
const root = resolve(process.argv[2] || 'apps/player-web/dist');
// Test-only server shaping: 150 ms latency, shared 1.6 Mbps payload budget, no production changes.
const queue: Array<{res:any; bytes:Buffer; offset:number}> = [];
setInterval(()=>{ const job=queue.shift(); if(!job)return; const end=Math.min(job.offset+2000,job.bytes.length); job.res.write(job.bytes.subarray(job.offset,end)); job.offset=end; if(end===job.bytes.length) job.res.finish(); else queue.push(job); },10).unref();
const server = createServer((req,res)=>{
 const finish=res.end.bind(res); (res as any).finish=finish;
 res.end=((data:any)=>{ setTimeout(()=>queue.push({res,bytes:Buffer.from(data || ''),offset:0}),150); return res; }) as any;
 const u = new URL(req.url!, 'http://127.0.0.1:18530');
 const scenario = new URL(req.headers.referer || u.href).searchParams.get('scenario');
 if (u.pathname.startsWith('/api/')) {
  const view = syntheticProviderBootstrap(); view.fixture = false;
  view.access.canSend = scenario !== 'exhausted';
  view.access.remainingReplies = scenario === 'exhausted' ? 0 : 3;
  for (const c of view.characters) { c.availability = {state:'available',personaVersion:1}; c.welcome.text='你好，今天过得怎么样？'; c.welcome.version="synthetic-v1"; }
  const data = u.pathname.endsWith('/bootstrap') ? view : u.pathname.endsWith('/account') ? (scenario === 'signed-in' ? {signupEnabled:true,signedIn:true,hasLogin:true,canBind:false,kind:'guest',nickname:'合成测试昵称',emailMasked:'t***@example.test'} : {signupEnabled:true,signedIn:false}) : {error:{code:'NOT_FOUND'}};
  res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}); res.end(JSON.stringify(data)); return;
 }
 if (!serveLocalStatic(req,res,root)) {res.writeHead(404);res.end();}
});
server.listen(Number(process.argv[3] || 18530),'127.0.0.1',()=>console.log('Part15 synthetic preview on 18530; no providers or real accounts'));
