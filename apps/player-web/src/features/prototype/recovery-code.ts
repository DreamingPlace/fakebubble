/** One-time recovery code UI. The code lives only in a DOM node until "我已保存"; it is never stored or logged. */
import { ProviderApiError, type ProviderApi } from '../../services/provider-api.ts';

export const recoveryCopy = {
  title: '你的恢复码',
  notice: '这是你的恢复码。换浏览器、清除数据后，用它找回你的聊天。只显示这一次，请保存好。',
  copy: '复制',
  copied: '已复制',
  copyFailed: '复制失败，请手动选中后保存',
  saved: '我已保存',
  have: '我有恢复码',
  entryLabel: '输入恢复码',
  entrySubmit: '找回聊天',
  entryBusy: '正在找回…',
  entryInvalid: '恢复码无效或已使用，请核对后再试。',
  entryNetwork: '网络不太稳定，稍后再试试',
  cancel: '取消',
  manage: '恢复码',
  regenerateNotice: '重新生成后，旧恢复码立即失效，新的恢复码只显示一次。',
  regenerate: '重新生成恢复码',
  regenerating: '正在生成…',
  regenerateFailed: '恢复码暂时没能生成，请稍后再试',
} as const;

type RecoveryApi = Pick<ProviderApi, 'regenerateRecoveryCode' | 'recoverWithRecoveryCode'>;

function dialogShell(className: string, label: string) {
  const dialog = document.createElement('dialog');
  dialog.className = `invite-dialog ${className}`;
  dialog.setAttribute('aria-label', label);
  return dialog;
}

/** Shows `code` once. The sheet has no dismiss path other than the confirm button. */
export function showRecoveryCode(code: string, done: () => void = () => {}) {
  const dialog = dialogShell('recovery-dialog', recoveryCopy.title);
  dialog.innerHTML = `<form method="dialog"><strong>${recoveryCopy.title}</strong>
    <p class="recovery-notice">${recoveryCopy.notice}</p>
    <output class="recovery-code"></output>
    <p class="invite-state recovery-state" role="status" aria-live="polite"></p>
    <div class="invite-actions"><button type="button" class="recovery-copy">${recoveryCopy.copy}</button>
    <button type="submit" class="recovery-saved">${recoveryCopy.saved}</button></div></form>`;
  const output = dialog.querySelector<HTMLElement>('.recovery-code');
  const status = dialog.querySelector<HTMLElement>('.recovery-state');
  const copy = dialog.querySelector<HTMLElement>('.recovery-copy');
  if (output) output.textContent = code;
  dialog.addEventListener('cancel', (event) => event.preventDefault());
  copy?.addEventListener('click', () => {
    const write = globalThis.navigator?.clipboard?.writeText(code);
    void Promise.resolve(write)
      .then(() => {
        if (!write) throw new Error('unavailable');
        if (status) status.textContent = recoveryCopy.copied;
      })
      .catch(() => {
        if (status) status.textContent = recoveryCopy.copyFailed;
      });
  });
  dialog.querySelector('form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (output) output.textContent = '';
    dialog.close();
    dialog.remove();
    done();
  });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

/** Enter a recovery code, restore the same principal, then show the rotated code once. */
export function openRecoveryEntry(
  api: RecoveryApi,
  restored: () => void,
  newRequestId: () => string = () => crypto.randomUUID(),
) {
  const dialog = dialogShell('recovery-entry-dialog', recoveryCopy.entryLabel);
  dialog.innerHTML = `<form method="dialog"><label for="recovery-input">${recoveryCopy.entryLabel}</label>
    <input id="recovery-input" name="recovery" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="64" required>
    <p class="invite-state recovery-state" role="status" aria-live="polite"></p>
    <div class="invite-actions"><button type="button" class="recovery-cancel">${recoveryCopy.cancel}</button>
    <button type="submit">${recoveryCopy.entrySubmit}</button></div></form>`;
  const input = dialog.querySelector<HTMLInputElement>('input');
  const status = dialog.querySelector<HTMLElement>('.recovery-state');
  const submit = dialog.querySelector<HTMLButtonElement>('button[type="submit"]');
  const close = () => {
    if (input) input.value = '';
    dialog.close();
    dialog.remove();
  };
  // A retry of the same code reuses its request id so an answered-but-lost attempt replays instead of burning the code.
  let attempt: { secret: string; requestId: string } | null = null;
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  dialog.querySelector('.recovery-cancel')?.addEventListener('click', close);
  dialog.querySelector('form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const secret = (input?.value ?? '').trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) {
      if (status) status.textContent = recoveryCopy.entryInvalid;
      return;
    }
    if (attempt?.secret !== secret) attempt = { secret, requestId: newRequestId() };
    const requestId = attempt.requestId;
    if (submit) {
      submit.disabled = true;
      submit.textContent = recoveryCopy.entryBusy;
    }
    void api
      .recoverWithRecoveryCode({ secret, requestId })
      .then((next) => {
        attempt = null;
        close();
        showRecoveryCode(next, restored);
      })
      .catch((error: unknown) => {
        if (status)
          status.textContent =
            error instanceof ProviderApiError && error.status >= 400 && error.status < 500
              ? recoveryCopy.entryInvalid
              : recoveryCopy.entryNetwork;
        if (submit) {
          submit.disabled = false;
          submit.textContent = recoveryCopy.entrySubmit;
        }
      });
  });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

/** Signed-in invited player: replace the code (the old one stops working at once) and show the new one once. */
export function openRecoveryManage(api: RecoveryApi, say: (message: string) => void = () => {}) {
  const dialog = dialogShell('recovery-manage-dialog', recoveryCopy.manage);
  dialog.innerHTML = `<form method="dialog"><strong>${recoveryCopy.manage}</strong>
    <p class="recovery-notice">${recoveryCopy.regenerateNotice}</p>
    <p class="invite-state recovery-state" role="status" aria-live="polite"></p>
    <div class="invite-actions"><button type="button" class="recovery-cancel">${recoveryCopy.cancel}</button>
    <button type="submit">${recoveryCopy.regenerate}</button></div></form>`;
  const status = dialog.querySelector<HTMLElement>('.recovery-state');
  const submit = dialog.querySelector<HTMLButtonElement>('button[type="submit"]');
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  dialog.querySelector('.recovery-cancel')?.addEventListener('click', close);
  dialog.querySelector('form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (submit) {
      submit.disabled = true;
      submit.textContent = recoveryCopy.regenerating;
    }
    void api
      .regenerateRecoveryCode()
      .then((code) => {
        close();
        showRecoveryCode(code);
      })
      .catch(() => {
        if (status) status.textContent = recoveryCopy.regenerateFailed;
        say(recoveryCopy.regenerateFailed);
        if (submit) {
          submit.disabled = false;
          submit.textContent = recoveryCopy.regenerate;
        }
      });
  });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}
