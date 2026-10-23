import type { OverviewView } from '../../../../../packages/contracts/web-system.ts';
import { h } from '../cocreation/h.ts';
import { dollars } from './system-format.ts';
import { rmb } from './costs-view.ts';
import { statusBadge } from './ui/status-badge.ts';

/** The one-line summary of the 系统状态 warnings; null when there is nothing to say. */
export function warningLine(warnings: OverviewView['warnings']) {
  const parts = [
    warnings.priceExpiring > 0 ? `${warnings.priceExpiring} 项价格即将到期` : null,
    warnings.retentionFailing > 0 ? `${warnings.retentionFailing} 位玩家的清理失败` : null,
    warnings.unknownNew > 0 ? `近 24 小时新增 ${warnings.unknownNew} 个 UNKNOWN 调用` : null,
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * 概览 (everyone who can log in): today in UTC - replies, voice replies, failed replies and the spend so far at list price -,
 * the 系统状态 warnings in one line and a link to each section this administrator may open. No data of its own.
 */
export function overviewView(
  root: HTMLElement,
  deps: {
    load: () => Promise<OverviewView>;
    links: () => ReadonlyArray<{ page: string; label: string }>;
    go: (page: string) => void;
    run: (work: () => Promise<void>) => Promise<void>;
    disposed: () => boolean;
  },
) {
  const cards = h('div', { class: 'overview-cards' });
  // Part 22c: yesterday and this month, only for the owner and stats.read (the server sends null to everyone else).
  const yesterday = h('div', { class: 'overview-cards' });
  const warnings = h('p', { class: 'overview-warnings', attrs: { role: 'status' } });
  const links = h('ul', { class: 'overview-links' });
  const reload = h('button', { class: 'admin-secondary', text: '刷新', attrs: { type: 'button' } });
  root.replaceChildren(
    h('h2', { text: '概览' }),
    cards,
    yesterday,
    warnings,
    h('h3', { text: '进入' }),
    links,
    h('div', { class: 'models-actions' }, reload),
  );
  const card = (label: string, value: string) =>
    h(
      'div',
      { class: 'overview-card' },
      h('span', { class: 'overview-label', text: label }),
      h('strong', { text: value }),
    );
  const paintLinks = () => {
    links.replaceChildren(
      ...deps.links().map(({ page, label }) => {
        const anchor = h('a', { text: label, attrs: { href: `#/${page}` } });
        anchor.addEventListener('click', (event) => {
          const click = event as MouseEvent;
          if (click.metaKey || click.ctrlKey || click.shiftKey || click.button === 1) return;
          event.preventDefault();
          deps.go(page);
        });
        return h('li', {}, anchor);
      }),
    );
  };
  async function load() {
    const view = await deps.load();
    if (deps.disposed()) return;
    cards.replaceChildren(
      card(`今日回复（UTC ${view.day}）`, String(view.today.replies)),
      card('其中语音回复', String(view.today.voiceReplies)),
      card('失败回复', String(view.today.failedReplies)),
      card('今日花费（列表价）', view.today.spendMicros === null ? '—' : dollars(view.today.spendMicros)),
    );
    yesterday.replaceChildren(
      ...(view.stats
        ? [
            card(`昨日新注册（UTC ${view.stats.yesterday.day}）`, String(view.stats.yesterday.signups)),
            card('昨日活跃', String(view.stats.yesterday.active)),
            card('昨日回复', String(view.stats.yesterday.replies)),
            card('本月花费（列表价，约）', rmb(view.stats.monthListCostRmbFen)),
          ]
        : []),
    );
    const line = warningLine(view.warnings);
    warnings.replaceChildren(
      line ? statusBadge('需要留意', 'warn') : statusBadge('正常', 'ok'),
      ' ',
      line ?? '价格、清理和 UNKNOWN 都没有异常。',
    );
    paintLinks();
  }
  reload.addEventListener('click', () => void deps.run(load));
  return {
    load,
    clear() {
      cards.replaceChildren();
      yesterday.replaceChildren();
      warnings.replaceChildren();
      links.replaceChildren();
    },
  };
}
