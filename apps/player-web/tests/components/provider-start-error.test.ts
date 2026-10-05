import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderApiError } from '../../src/services/provider-api.ts';
import { providerStartFailure, renderProviderStartError } from '../../src/features/prototype/provider-start-error.ts';

test('startup distinguishes expired guest, protected identity and network failure without exposing raw errors', () => {
  const guest=providerStartFailure(new ProviderApiError(401,'GUEST_SESSION_EXPIRED'));
  assert.equal(guest.action,'重新进入访客页面'); assert.match(guest.detail,/不会重置/);
  for(const code of ['SESSION_EXPIRED','SESSION_ROTATED_RECOVERABLE']) {
    const identity=providerStartFailure(new ProviderApiError(401,code));
    assert.equal(identity.title,'访问会话需要恢复'); assert.match(identity.detail,/没有将受邀身份替换/);
  }
  const network=providerStartFailure(new Error('private debug data'));
  assert.equal(network.action,'重新连接'); assert.ok(!JSON.stringify(network).includes('private debug data'));
});

test('startup recovery never reloads automatically and the explicit button is single-flight', t => {
  class Element { className='';textContent='';type='';disabled=false;children:Element[]=[]; click:()=>void=()=>{};
    append(...children:Element[]){this.children.push(...children);} replaceChildren(...children:Element[]){this.children=children;}
    addEventListener(_name:string,fn:()=>void){this.click=fn;}}
  const original=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>new Element()}});
  t.after(()=>{if(original)Object.defineProperty(globalThis,'document',original);else Reflect.deleteProperty(globalThis,'document');});
  const root=new Element();let reloads=0;
  renderProviderStartError(root as unknown as HTMLElement,new ProviderApiError(401,'GUEST_SESSION_EXPIRED'),()=>reloads++);
  assert.equal(reloads,0); const button=root.children[0]!.children[2]!; assert.equal(button.type,'button');
  button.click();button.click();assert.equal(reloads,1);assert.equal(button.disabled,true);
});
