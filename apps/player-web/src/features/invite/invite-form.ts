/** UI-only port. The adapter may return accepted only after trusted identity/bootstrap installation. */
export type InviteFormResult =
  | { kind: 'accepted'; principalId: string; grantId: string }
  | { kind: 'uncertain' }
  | { kind: 'rejected'; code: string };

export type InviteFormInput = { code: string; requestId: string };
export type InviteFormPort = {
  redeem(input: InviteFormInput): Promise<InviteFormResult>;
  recover(input: InviteFormInput): Promise<InviteFormResult>;
};

export type InviteFormDeps = {
  port: InviteFormPort;
  newRequestId?: () => string;
  /** Only invoked after the port confirms trusted identity installation. */
  onAccepted?: () => void | Promise<void>;
  /** Must be true in injected previews; no real redemption is implied. */
  synthetic: boolean;
};

type Phase = 'entry' | 'redeeming' | 'uncertain' | 'recovering' | 'accepted' | 'blocked' | 'abandoned';

export function startInviteForm(root: HTMLElement, deps: InviteFormDeps): () => void {
  root.innerHTML = `<section class="invite-form" aria-label="邀请码">
    <p class="invite-form-demo" ${deps.synthetic ? '' : 'hidden'}>合成界面演示 · 未连接真实兑换服务</p>
    <h2>输入邀请码</h2>
    <form class="invite-form-fields" autocomplete="off">
      <label for="invite-code">邀请码</label>
      <input id="invite-code" name="invite-code" type="text" autocomplete="off" autocapitalize="off"
        autocorrect="off" spellcheck="false" inputmode="text" required>
      <div class="invite-form-actions">
        <button class="invite-form-submit" type="submit">确认邀请码</button>
        <button class="invite-form-recover" type="button" hidden>核对原请求</button>
        <button class="invite-form-cancel" type="button">取消</button>
      </div>
    </form>
    <p class="invite-form-status" role="status" aria-live="polite" tabindex="-1"></p>
  </section>`;

  const form = root.querySelector<HTMLFormElement>('.invite-form-fields')!;
  const codeInput = root.querySelector<HTMLInputElement>('#invite-code')!;
  const submit = root.querySelector<HTMLButtonElement>('.invite-form-submit')!;
  const recover = root.querySelector<HTMLButtonElement>('.invite-form-recover')!;
  const cancel = root.querySelector<HTMLButtonElement>('.invite-form-cancel')!;
  const status = root.querySelector<HTMLElement>('.invite-form-status')!;
  let phase: Phase = 'entry';
  let intent: InviteFormInput | null = null;
  let generation = 0;
  let composing = false;
  let disposed = false;

  const render = () => {
    const active = phase === 'entry';
    codeInput.readOnly = !active;
    codeInput.disabled = phase === 'accepted' || phase === 'blocked' || phase === 'abandoned';
    submit.hidden = !active;
    submit.disabled = !active || composing || !codeInput.value.trim();
    recover.hidden = phase !== 'uncertain';
    recover.disabled = phase !== 'uncertain';
    cancel.hidden = phase === 'accepted' || phase === 'blocked' || phase === 'abandoned';
    cancel.disabled = false;
    form.setAttribute('aria-busy', String(phase === 'redeeming' || phase === 'recovering'));
  };
  const setStatus = (message: string) => { status.textContent = message; };
  const clearCode = () => { codeInput.value = ''; intent = null; };
  const applyResult = (result: InviteFormResult, ticket: number) => {
    if (disposed || ticket !== generation) return;
    if (result.kind === 'accepted' && typeof result.principalId === 'string' && result.principalId &&
        typeof result.grantId === 'string' && result.grantId) {
      phase = 'accepted'; clearCode();
      setStatus('邀请码已确认，可以继续体验。');
      try {
        void Promise.resolve(deps.onAccepted?.()).catch(() => {
          if (!disposed && ticket === generation)
            setStatus('邀请码已确认；页面未能切换，请刷新后继续。');
        });
      } catch {
        setStatus('邀请码已确认；页面未能切换，请刷新后继续。');
      }
    } else if (result.kind === 'accepted') {
      phase = 'blocked'; clearCode();
      setStatus('无法确认兑换后的可信身份，请停止重试并联系管理员核对。');
    } else if (result.kind === 'uncertain') {
      phase = 'uncertain';
      setStatus('兑换结果尚未确认。只能核对这一次请求，不要重新兑换。');
      queueMicrotask(() => { if (!disposed && ticket === generation) recover.focus({ preventScroll: true }); });
    } else if (result.code === 'lost-session' || result.code === 'recovery-unavailable') {
      phase = 'blocked'; clearCode();
      setStatus(result.code === 'lost-session' ?
        '原会话已失效，无法证明兑换结果。请勿再次使用该码，联系管理员核对。' :
        '本次兑换回执无法恢复。请勿再次使用该码，联系管理员核对。');
    } else {
      phase = 'entry'; intent = null;
      setStatus('邀请码未通过，请检查后再试。');
      queueMicrotask(() => { if (!disposed && ticket === generation) codeInput.focus({ preventScroll: true }); });
    }
    render();
  };
  const run = (kind: 'redeem' | 'recover') => {
    if (disposed || !intent) return;
    const ticket = ++generation;
    phase = kind === 'redeem' ? 'redeeming' : 'recovering';
    setStatus(kind === 'redeem' ? '正在确认邀请码…' : '正在核对原请求…');
    render();
    void deps.port[kind]({ ...intent }).then(result => applyResult(result, ticket)).catch(() => {
      if (disposed || ticket !== generation) return;
      phase = 'uncertain';
      setStatus('连接中断，结果未确认。请只核对原请求，不要重新兑换。');
      render();
    });
  };
  const onSubmit = (event: SubmitEvent) => {
    event.preventDefault();
    if (disposed || phase !== 'entry' || composing) return;
    const code = codeInput.value.trim();
    if (!code) return;
    intent = { code, requestId: (deps.newRequestId ?? (() => crypto.randomUUID()))() };
    run('redeem');
  };
  const onRecover = () => { if (phase === 'uncertain' && intent) run('recover'); };
  const onCancel = () => {
    if (disposed || phase === 'accepted' || phase === 'blocked' || phase === 'abandoned') return;
    const submitted = intent !== null;
    generation++;
    clearCode();
    phase = submitted ? 'abandoned' : 'entry';
    setStatus(submitted ? '已清空本页邀请码；这不撤销可能已提交的兑换。请联系管理员核对。' : '已清空。');
    render();
    if (!submitted) codeInput.focus({ preventScroll: true });
  };
  const onInput = () => render();
  const onCompositionStart = () => { composing = true; render(); };
  const onCompositionEnd = () => { composing = false; render(); };
  form.addEventListener('submit', onSubmit);
  recover.addEventListener('click', onRecover);
  cancel.addEventListener('click', onCancel);
  codeInput.addEventListener('input', onInput);
  codeInput.addEventListener('compositionstart', onCompositionStart);
  codeInput.addEventListener('compositionend', onCompositionEnd);
  render();
  return () => {
    disposed = true; generation++; clearCode();
    form.removeEventListener('submit', onSubmit);
    recover.removeEventListener('click', onRecover);
    cancel.removeEventListener('click', onCancel);
    codeInput.removeEventListener('input', onInput);
    codeInput.removeEventListener('compositionstart', onCompositionStart);
    codeInput.removeEventListener('compositionend', onCompositionEnd);
    root.replaceChildren();
  };
}
