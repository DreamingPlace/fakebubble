import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync,mkdtempSync,readFileSync,rmSync,statSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webOperatorArguments,webOperatorConfig,prepareWebOperation,runWebOperator } from '../../../scripts/web-cloudflare-operator.ts';

test('private web operator pins only new workers/account, requires explicit arguments and validates private assets',t=>{
  const dir=mkdtempSync(join(tmpdir(),'web-operator-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const receipt=join(dir,'receipt.jsonl');
  for(const action of ['status','budget-summary','business-object-id','budget-object-id','invite-grants'] as const) {
    const config=webOperatorConfig(action, 'a'.repeat(32));
    assert.equal(config.account_id,'a'.repeat(32));
    assert.equal(config.workers_dev,false);assert.equal(config.preview_urls,false);assert.deepEqual(config.routes,[]);
    assert.equal(config.services.length,1);assert.equal(config.services[0]!.remote,true);
    assert.match(config.services[0]!.service,/^fakebubble-(business|budget)$/);
    assert.match(config.services[0]!.entrypoint,/^Web(Budget)?OperatorService$/);
  }
  assert.throws(()=>webOperatorArguments(['--action=status']),/WEB_OPERATOR_RECEIPT_REQUIRED/);
  assert.throws(()=>webOperatorArguments(['--action=status',`--receipt-file=${receipt}`,'--worker=bubble-beta-business']),/WEB_OPERATOR_ARGUMENT_INVALID/);
  assert.throws(()=>webOperatorArguments(['--action=business-object-id',`--receipt-file=${receipt}`]),/WEB_OPERATOR_NAME_REQUIRED/);
  assert.throws(()=>webOperatorArguments(['--action=invite-grants',`--receipt-file=${receipt}`]),/WEB_OPERATOR_NAME_REQUIRED/);
  assert.throws(()=>webOperatorArguments(['--action=admin-recovery-grant',`--receipt-file=${receipt}`]),/WEB_OPERATOR_NAME_REQUIRED/);
  assert.throws(()=>webOperatorArguments(['--action=invite-grants',`--receipt-file=${receipt}`,'--name=bad/id']),/WEB_OPERATOR_NAME_REQUIRED/);
  const bytes=Buffer.from('offline fixture bytes'),path=join(dir,'voice.wav'),input=join(dir,'input.json');
  writeFileSync(path,bytes,{mode:0o600});
  const asset={kind:'welcome',characterId:'jojo',path,byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  writeFileSync(input,JSON.stringify(asset),{mode:0o600});
  const args=webOperatorArguments(['--action=asset',`--receipt-file=${receipt}`,`--input-file=${input}`]);
  assert.deepEqual(prepareWebOperation(args).asset,{kind:'welcome',characterId:'jojo',bytes});
  chmodSync(input,0o644);assert.throws(()=>prepareWebOperation(args),/WEB_OPERATOR_PRIVATE_FILE_REQUIRED/);chmodSync(input,0o600);
  writeFileSync(path,'tampered');assert.throws(()=>prepareWebOperation(args),/WEB_OPERATOR_ASSET_INTEGRITY/);
});

test('operator durably records before RPC, keeps secret grants only in 0600 receipt and never auto-retries unknown outcomes',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'web-operator-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const receipt=join(dir,'receipt.jsonl'),args=webOperatorArguments(['--action=admin-grant',`--receipt-file=${receipt}`]);
  let calls=0,disposed=0;
  const operator={objectId:async()=>'',initialize:async()=>null,importFixed:async()=>null,status:async()=>null,summary:async()=>null,
    inviteGrants:async(id:string)=>{assert.equal(id,'test-invite');return [{grantId:'test-grant'}];},
    adminGrant:async()=>{calls++;return {token:'SYNTHETIC_PRIVATE_GRANT'};},
    adminRecoveryGrant:async(id:string)=>{assert.equal(id,'member-id');return {token:'SYNTHETIC_RECOVERY_GRANT'};}};
  const proxy=async(options:any)=>{
    assert.deepEqual(options,{configPath:'/offline/config.json',envFiles:[],persist:false,remoteBindings:true});
    assert.equal(JSON.parse(readFileSync(receipt,'utf8').trim()).state,'prepared');
    return {env:{OPERATOR:operator},dispose:async()=>{disposed++;}};
  };
  const result=await runWebOperator(prepareWebOperation(args),proxy,'/offline/config.json');
  assert.deepEqual(result,{action:'admin-grant',receiptFile:receipt});assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_GRANT'));
  assert.equal(statSync(receipt).mode&0o777,0o600);assert.equal(calls,1);assert.equal(disposed,1);
  assert.equal(JSON.parse(readFileSync(receipt,'utf8').trim().split('\n').at(-1)!).detail.token,'SYNTHETIC_PRIVATE_GRANT');
  await assert.rejects(runWebOperator(prepareWebOperation(args),proxy,'/offline/config.json'),/EEXIST/);assert.equal(calls,1);
  const unknown=join(dir,'unknown.jsonl');
  await assert.rejects(runWebOperator(prepareWebOperation({...args,receiptFile:unknown}),async()=>({env:{OPERATOR:{...operator,
    adminGrant:async()=>{calls++;throw new Error('OFFLINE_RESPONSE_LOST');}}},dispose:async()=>{disposed++;}}),'/offline/config.json'),/WEB_OPERATOR_FAILED/);
  assert.equal(calls,2);assert.equal(disposed,2);
  assert.equal(JSON.parse(readFileSync(unknown,'utf8').trim().split('\n').at(-1)!).state,'unknown');
  const lookup=join(dir,'lookup.jsonl');
  await runWebOperator(prepareWebOperation(webOperatorArguments(['--action=invite-grants','--name=test-invite',`--receipt-file=${lookup}`])),
    async()=>({env:{OPERATOR:operator},dispose:async()=>{}}),'/offline/config.json');
  assert.deepEqual(JSON.parse(readFileSync(lookup,'utf8').trim().split('\n').at(-1)!).detail,[{grantId:'test-grant'}]);
  assert.equal(statSync(lookup).mode&0o777,0o600);
  const recovery=join(dir,'recovery.jsonl');
  await runWebOperator(prepareWebOperation(webOperatorArguments(['--action=admin-recovery-grant','--name=member-id',`--receipt-file=${recovery}`])),
    async()=>({env:{OPERATOR:operator},dispose:async()=>{}}),'/offline/config.json');
  assert.equal(JSON.parse(readFileSync(recovery,'utf8').trim().split('\n').at(-1)!).detail.token,'SYNTHETIC_RECOVERY_GRANT');
  assert.equal(statSync(recovery).mode&0o777,0o600);
});

test('private operator accepts explicit production authorization but rejects mixed test grants and implicit unlimited',t=>{
  const dir=mkdtempSync(join(tmpdir(),'web-operator-budget-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const input=join(dir,'budget.json'),receipt=join(dir,'receipt.jsonl');
  const target={accountId:'a'.repeat(32),namespaceId:'b'.repeat(32),objectId:'c'.repeat(64)};
  const grants=(['deepseek','fish'] as const).map(provider=>({...target,version:2,id:`prod-${provider}`,provider,
    purpose:'production',limit:'unlimited',createdAt:1}));
  const args=webOperatorArguments(['--action=budget-initialize',`--input-file=${input}`,`--receipt-file=${receipt}`]);
  const write=(v:unknown)=>writeFileSync(input,JSON.stringify(v),{mode:0o600});
  write(grants);assert.deepEqual(prepareWebOperation(args).input,grants);
  write(grants.map(g=>({...g,limit:null})));assert.throws(()=>prepareWebOperation(args),/AUTHORIZATION_INVALID/);
  write([grants[0],{...target,version:1,id:'test',provider:'fish',micros:3_000_000,priorSpentMicros:0,priorHeldMicros:0,createdAt:1}]);
  assert.throws(()=>prepareWebOperation(args),/WEB_OPERATOR_GRANTS_INVALID/);
});
