import type { AccountAdminApi } from '../../services/account-admin-api.ts';
import type { InviteAdminPermission } from '../../../../../packages/contracts/web-admin-permissions.ts';
const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
const date=(value:number|null)=>value===null?'未设置':new Date(value).toLocaleString();

/** Metadata only; neither bearer codes nor a player's identity/chat is requested or rendered. */
export function inviteRecords(root:HTMLElement, port:Pick<AccountAdminApi,'inviteRecords'|'revokeInvite'>,
  can:(permission:InviteAdminPermission)=>boolean, run:(work:()=>Promise<void>)=>Promise<void>, disposed:()=>boolean) {
  let cursor:string|null=null;
  const list=el('div'),more=el('button','下一页'),refresh=el('button','刷新邀请记录');
  more.type=refresh.type='button';more.hidden=true;root.replaceChildren(refresh,list,more);
  const load=async(before:string|null=null)=>{
    if(!can('invites.read')){clear();return;}
    const result=await port.inviteRecords(before);if(disposed()||!can('invites.read'))return;
    list.replaceChildren();cursor=result.next;more.hidden=!cursor;
    if(!result.records.length)list.append(el('p','尚无邀请记录。生成邀请码后，记录会显示在这里。'));
    for(const record of result.records){
      const section=el('section');section.className='admin-invite-record';
      section.append(el('h3',record.batch),el('p',record.note??'无备注'));
      const used=record.redeemed===1,expired=record.redeemBy!==null&&record.redeemBy<=Date.now();
      section.append(el('p',`邀请码：${used?'已兑换':record.status==='revoked'?'已撤销':expired?'已过期':'待兑换'} · 生成于 ${date(record.createdAt)}`),
        el('p',`兑换截止：${date(record.redeemBy)}${used?` · 体验授权：${record.accessRevokedAt!==null?'已撤销':record.accessExpiresAt!==null&&record.accessExpiresAt<=Date.now()?'已过期':'有效'}`:''}`));
      const metadata=el('details');metadata.append(el('summary','记录标识'),el('p',`邀请码记录：${record.inviteId}`));
      if(record.grantId)section.append(el('p',`体验截止：${record.accessExpiresAt===null?'不限时':date(record.accessExpiresAt)}`));
      if(record.grantId)metadata.append(el('p',`体验授权记录：${record.grantId}`));section.append(metadata);
      const action=(kind:'code'|'grant',id:string,label:string,help:string)=>{
        const confirm=el('details'),button=el('button',`确认${label}`);button.type='button';
        confirm.className='admin-confirm';confirm.append(el('summary',label),el('p',help),button);section.append(confirm);
        button.addEventListener('click',()=>{void run(async()=>{await port.revokeInvite(kind,id);await load(before);});});
      };
      if(can('invites.revoke-code')&&!used&&record.status==='active'&&!expired)action('code',record.inviteId,'撤销此邀请码','此码将不能兑换。不会改变其他邀请码或已兑换的体验授权。');
      if(can('invites.revoke-access')&&record.grantId&&record.accessRevokedAt===null)action('grant',record.grantId,'撤销此体验授权','对应玩家将不能继续体验；账号、当前登录和已有聊天保留。此操作不是删除玩家。');
      list.append(section);
    }
  };
  function clear(){list.replaceChildren();cursor=null;more.hidden=true;}
  refresh.addEventListener('click',()=>{void run(()=>load());});
  more.addEventListener('click',()=>{if(cursor)void run(()=>load(cursor));});
  return {load,clear};
}
