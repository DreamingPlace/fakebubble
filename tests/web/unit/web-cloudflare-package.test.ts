import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { Miniflare,type ModuleDefinition } from 'miniflare';
import { stageWebCloudflarePackage } from '../../../scripts/web-cloudflare-package.ts';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');

test('web release package excludes private files, pins player assets, stays closed and loads each production Worker',async t=>{
  const root=mkdtempSync(join(tmpdir(),'web-package-')); t.after(()=>rmSync(root,{recursive:true,force:true}));
  const assets=join(root,'assets'),output=join(root,'package'); mkdirSync(assets);
  const shell='<!doctype html><title>offline</title>';
  writeFileSync(join(assets,'index.html'),shell);
  writeFileSync(join(assets,'player-manifest.json'),JSON.stringify({version:1,files:{'index.html':hash(shell)}}));
  writeFileSync(join(assets,'.env'),'THIS_MUST_NOT_SHIP'); writeFileSync(join(assets,'private.js.map'),'THIS_MUST_NOT_SHIP');
  const result=stageWebCloudflarePackage(output,assets); assert.equal(result.workers,4);
  const manifest=JSON.parse(readFileSync(join(output,'package-manifest.json'),'utf8')) as
    { deployable:boolean;files:{path:string;source:string;sha256:string;bytes:number}[] };
  assert.equal(manifest.deployable,false); assert.equal(manifest.files.length+1,result.files);
  for(const file of manifest.files) {
    const bytes=readFileSync(join(output,file.path)); assert.equal(bytes.length,file.bytes); assert.equal(hash(bytes),file.sha256);
    assert.ok(!bytes.includes('THIS_MUST_NOT_SHIP'));
    assert.ok(!/(^|\/)(?:tests|runtime|\.env|\.secrets)(\/|$)/.test(file.source));
  }
  const allModules=manifest.files.filter(row=>row.path.startsWith('modules/')).map(row=>({
    type:row.path.endsWith('.sql')?'Text':'ESModule',path:resolve(output,row.path),contents:readFileSync(join(output,row.path),'utf8'),
  })) as ModuleDefinition[];
  let outbound=0;
  for(const name of ['edge','business','budget','generation']) {
    const config=JSON.parse(readFileSync(join(output,name+'.json'),'utf8'));
    assert.equal(config.workers_dev,false); assert.equal(config.preview_urls,false); assert.deepEqual(config.routes,[]);
    if(name==='edge') { assert.equal(config.assets.directory,'./player-assets'); assert.match(config.vars.ASSET_MANIFEST_SHA256,/^[a-f0-9]{64}$/); }
    else assert.ok(Object.values(config.vars).includes('false'));
    const modules=[...allModules].sort((a,b)=>Number(b.path===resolve(output,config.main))-Number(a.path===resolve(output,config.main)));
    const mf=new Miniflare({modules,modulesRoot:output,compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags,
      bindings:config.vars,outboundService:()=>{outbound++;return new Response(null,{status:403});}});
    try { assert.equal((await mf.dispatchFetch('https://invalid.example')).status,name==='edge'?503:404); }
    finally { await mf.dispose(); }
  }
  assert.equal(outbound,0); assert.throws(()=>stageWebCloudflarePackage(output,assets),/EEXIST/);
  writeFileSync(join(assets,'index.html'),'tampered');
  assert.throws(()=>stageWebCloudflarePackage(join(root,'bad'),assets),/WEB_PACKAGE_ASSET_INTEGRITY/);
  rmSync(join(assets,'index.html')); symlinkSync(join(assets,'.env'),join(assets,'index.html'));
  assert.throws(()=>stageWebCloudflarePackage(join(root,'linked'),assets),/WEB_PACKAGE_ASSET_INVALID/);
});
