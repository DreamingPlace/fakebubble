/** UI boundary only. The adapter owns admin cookie, CSRF and the server-generated code. */
export type InviteAdminPort = {
  login(token: string): Promise<unknown>;
  restore(): Promise<unknown>;
  issue(input: {
    requestId: string;
    redeemBy: number;
    batch: string;
    note: string | null;
  }): Promise<{ code: string | null; duplicate: boolean }>;
  logout(): Promise<void>;
};

export function startInviteAdminPage(
  root: HTMLElement,
  deps: {
    port: InviteAdminPort;
    newRequestId?: () => string;
    synthetic: boolean;
    label?: string;
  },
): () => void {
  root.innerHTML = `<main class="invite-admin-page">
    <p class="invite-admin-demo">${
      deps.label ?? (deps.synthetic ? '合成管理界面 · 未连接真实发码服务' : '本机合成管理 · 仅供测试使用')
    }</p>
    <h1>邀请码管理</h1>
    <form class="invite-admin-login" autocomplete="off">
      <label for="invite-admin-token">管理员一次性登录凭据</label>
      <input id="invite-admin-token" type="password" autocomplete="off" required>
      <button type="submit">登录</button>
    </form>
    <form class="invite-admin-issue" hidden>
      <label for="invite-admin-batch">批次标识</label>
      <input id="invite-admin-batch" type="text" autocomplete="off" required>
      <label for="invite-admin-note">备注（可选）</label>
      <input id="invite-admin-note" type="text" autocomplete="off">
      <label for="invite-admin-redeem-by">兑换截止时间（本机时区）</label>
      <input id="invite-admin-redeem-by" type="datetime-local" required>
      <p>这是邀请码的兑换截止，不是受邀后的体验访问期限。</p>
      <button type="submit">手动生成邀请码</button>
    </form>
    <div class="invite-admin-result" hidden><span>本次生成的邀请码（仅此处显示）</span>
      <strong class="invite-admin-code"></strong></div>
    <button class="invite-admin-logout" type="button" hidden>退出管理</button>
    <p class="invite-admin-status" role="status" aria-live="polite"></p>
  </main>`;
  const loginForm = root.querySelector<HTMLFormElement>('.invite-admin-login')!;
  const token = root.querySelector<HTMLInputElement>('#invite-admin-token')!;
  const issueForm = root.querySelector<HTMLFormElement>('.invite-admin-issue')!;
  const redeemBy = root.querySelector<HTMLInputElement>('#invite-admin-redeem-by')!;
  const batch = root.querySelector<HTMLInputElement>('#invite-admin-batch')!;
  const note = root.querySelector<HTMLInputElement>('#invite-admin-note')!;
  const result = root.querySelector<HTMLElement>('.invite-admin-result')!;
  const code = root.querySelector<HTMLElement>('.invite-admin-code')!;
  const logout = root.querySelector<HTMLButtonElement>('.invite-admin-logout')!;
  const status = root.querySelector<HTMLElement>('.invite-admin-status')!;
  let phase: 'restoring' | 'login' | 'logging-in' | 'issue' | 'issuing' | 'shown' | 'unknown' | 'logging-out' =
    'restoring';
  let generation = 0;
  let disposed = false;

  const render = () => {
    loginForm.hidden = phase !== 'login' && phase !== 'logging-in';
    issueForm.hidden = phase !== 'issue' && phase !== 'issuing';
    result.hidden = phase !== 'shown';
    logout.hidden = phase === 'restoring' || phase === 'login' || phase === 'logging-in';
    token.readOnly = phase === 'logging-in';
    redeemBy.readOnly = phase === 'issuing';
    batch.readOnly = phase === 'issuing';
    note.readOnly = phase === 'issuing';
    loginForm.querySelector('button')!.disabled = phase === 'logging-in';
    issueForm.querySelector('button')!.disabled = phase === 'issuing';
    logout.disabled = phase === 'logging-out';
  };
  const clearSecrets = () => {
    token.value = '';
    code.textContent = '';
  };
  const onLogin = (event: SubmitEvent) => {
    event.preventDefault();
    if (disposed || phase !== 'login' || !token.value) return;
    const loginToken = token.value,
      ticket = ++generation;
    phase = 'logging-in';
    status.textContent = '正在验证管理员身份…';
    render();
    void deps.port
      .login(loginToken)
      .then(() => {
        if (disposed || ticket !== generation) return;
        token.value = '';
        phase = 'issue';
        status.textContent = '已登录。请明确填写兑换截止时间。';
        render();
      })
      .catch(() => {
        if (disposed || ticket !== generation) return;
        token.value = '';
        phase = 'login';
        status.textContent = '登录未完成，请重新获取有效管理员凭据。';
        render();
      });
  };
  const onIssue = (event: SubmitEvent) => {
    event.preventDefault();
    if (disposed || phase !== 'issue') return;
    const deadline = new Date(redeemBy.value).getTime();
    const batchValue = batch.value.trim(),
      noteValue = note.value.trim();
    if (!batchValue) {
      status.textContent = '请填写批次标识。';
      return;
    }
    if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) {
      status.textContent = '请填写未来的兑换截止时间。';
      return;
    }
    const ticket = ++generation,
      requestId = (deps.newRequestId ?? (() => crypto.randomUUID()))();
    phase = 'issuing';
    status.textContent = '正在手动生成邀请码…';
    render();
    void deps.port
      .issue({ requestId, redeemBy: deadline, batch: batchValue, note: noteValue || null })
      .then((receipt) => {
        if (disposed || ticket !== generation) return;
        if (receipt.duplicate || !receipt.code) {
          phase = 'unknown';
          status.textContent = '该请求已处理，原码无法再次显示；请核对管理员记录。';
          render();
          return;
        }
        code.textContent = receipt.code;
        phase = 'shown';
        status.textContent = '邀请码已生成。请现在安全记录；离开此页后不再显示。';
        render();
      })
      .catch(() => {
        if (disposed || ticket !== generation) return;
        code.textContent = '';
        phase = 'unknown';
        status.textContent = '发码结果未确认。请勿再次点击生成；先核对管理员记录。';
        render();
      });
  };
  const onLogout = () => {
    if (disposed || phase === 'login' || phase === 'logging-in' || phase === 'logging-out') return;
    const ticket = ++generation;
    clearSecrets();
    redeemBy.value = '';
    batch.value = '';
    note.value = '';
    phase = 'logging-out';
    status.textContent = '正在退出管理…';
    render();
    void deps.port
      .logout()
      .then(() => {
        if (disposed || ticket !== generation) return;
        phase = 'login';
        status.textContent = '已退出。';
        render();
      })
      .catch(() => {
        if (disposed || ticket !== generation) return;
        phase = 'unknown';
        status.textContent = '退出结果未确认；本页已清除邀请码，请关闭页面。';
        render();
      });
  };
  loginForm.addEventListener('submit', onLogin);
  issueForm.addEventListener('submit', onIssue);
  logout.addEventListener('click', onLogout);
  render();
  const restoreTicket = ++generation;
  void deps.port
    .restore()
    .then(() => {
      if (disposed || restoreTicket !== generation) return;
      phase = 'issue';
      status.textContent = '已恢复管理会话。请明确填写兑换截止时间。';
      render();
    })
    .catch(() => {
      if (disposed || restoreTicket !== generation) return;
      phase = 'login';
      status.textContent = '请输入管理员凭据。';
      render();
    });
  return () => {
    disposed = true;
    generation++;
    clearSecrets();
    redeemBy.value = '';
    batch.value = '';
    note.value = '';
    loginForm.removeEventListener('submit', onLogin);
    issueForm.removeEventListener('submit', onIssue);
    logout.removeEventListener('click', onLogout);
    root.replaceChildren();
  };
}
