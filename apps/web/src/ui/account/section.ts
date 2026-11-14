import type { Account, IdentityProvider, LinkedIdentity, VenueId } from '@coinposh/shared';
import { venueKey } from '../../game/ascension/i18n.ts';
import type { InterpolationValues } from '../../i18n/index.ts';
import type {
  AccountClient,
  PreparedFlow,
  ProviderOffer,
  SessionSwap,
  SignInOutcome,
} from '../../net/index.ts';
import { makePressable } from '../components/pressable.ts';
import { feedback, type UiContext } from '../context.ts';
import { h, restartAnimation } from '../dom.ts';
import { isReducedMotion } from '../motion/reduced.ts';
import { brandMark, sealMark } from './brand.ts';
import type { ChoiceResult, ChoiceSheet } from './choice.ts';
import type { AccountKey, AccountT } from './i18n.ts';
import {
  accountProblem,
  isLastIdentity,
  linkedIdentities,
  problemKey,
  problemTone,
  providerRows,
  type AccountMode,
  type ProviderRow,
} from './model.ts';

export interface AccountSectionOptions {
  readonly ctx: UiContext;
  readonly t: AccountT;
  readonly client: () => Promise<AccountClient>;
  /** Where the progress-choice sheet mounts; its code loads only when a sign-in needs it. */
  readonly sheetHost: HTMLElement;
  /** Every account the server reported, after a load, a link, an unlink or a sign-in. */
  readonly onAccount: (account: Account) => void;
}

export interface AccountSection {
  readonly el: HTMLElement;
  /** Re-reads the account; the settings sheet calls it each time it opens. */
  refresh(): void;
  /** Scrolls the section into view and lights it, for the gentle prompt's action. */
  highlight(): void;
}

type Flow =
  | { readonly mode: 'link'; readonly prepared: PreparedFlow<Account> }
  | { readonly mode: 'signin'; readonly prepared: PreparedFlow<SignInOutcome> };

interface Pending {
  readonly provider: IdentityProvider;
  readonly phase: 'busy' | 'ready' | 'waiting';
  readonly abort: AbortController;
  readonly flow: Flow | null;
}

interface Status {
  readonly key: AccountKey;
  readonly values?: InterpolationValues;
  readonly tone: 'ok' | 'calm' | 'warn';
  readonly action?: { readonly key: AccountKey; readonly run: () => void };
}

/**
 * "Keep my progress": link Google or Apple to the guest save, sign in to a save kept on another
 * device, and unlink. Nothing here loads a provider SDK; the account client does that on the
 * tap that needs it. Live Apple opens its popup only from a second tap, so the browser lets it.
 */
export function createAccountSection(options: AccountSectionOptions): AccountSection {
  const { ctx, t } = options;
  const language = () => ctx.i18n.language;
  const providerName = (provider: IdentityProvider) => t(`provider.${provider}`);
  const venueName = (venue: VenueId) => ctx.i18n.t(venueKey(venue));

  const title = h('h3', { class: 'cp-section-title' }, sealMark(), h('span'));
  const intro = h('p', { class: 'cp-account-intro' });
  const body = h('div', { class: 'cp-account-body' });
  const googleHost = h('div', {
    class: 'cp-account-google-host',
    attrs: { 'data-testid': 'account-google-host' },
  });
  const statusLine = h('div', {
    class: 'cp-account-status',
    attrs: { role: 'status', 'aria-live': 'polite', 'data-testid': 'account-status' },
  });
  const el = h(
    'section',
    {
      class: 'cp-section cp-settings-group cp-account',
      attrs: { 'data-testid': 'account-section', 'aria-busy': 'false' },
    },
    title,
    intro,
    body,
    googleHost,
    statusLine,
  );
  const label = title.lastElementChild;
  if (label) ctx.loc.text(label, () => t('title'));

  let offers: readonly ProviderOffer[] = [];
  let account: Account | null = null;
  let loading = false;
  let loadFailed = false;
  let mode: AccountMode = 'link';
  let pending: Pending | null = null;
  let confirming: IdentityProvider | null = null;
  let unlinking: IdentityProvider | null = null;
  let status: Status | null = null;
  let choosing = false;
  let choiceSheet: Promise<ChoiceSheet> | null = null;

  const renderDisposers: (() => void)[] = [];
  const renderCtx: UiContext = { ...ctx, own: (dispose) => renderDisposers.push(dispose) };
  ctx.own(() => {
    for (const dispose of renderDisposers.splice(0)) dispose();
  });
  ctx.own(ctx.loc.bind(render));

  function render(): void {
    const focused = document.activeElement;
    const focusKey =
      focused instanceof HTMLElement && el.contains(focused) ? focused.dataset.focus : undefined;
    for (const dispose of renderDisposers.splice(0)) dispose();

    intro.textContent = t(linkedIdentities(account).length > 0 ? 'intro.linked' : 'intro.guest');
    el.setAttribute('aria-busy', String(loading));
    body.replaceChildren(...content());
    statusLine.replaceChildren(...statusContent());
    statusLine.dataset.tone = status?.tone ?? '';

    if (focusKey) {
      el.querySelector<HTMLElement>(`[data-focus="${focusKey}"]`)?.focus({ preventScroll: true });
    }
  }

  function content(): HTMLElement[] {
    if (loading && !account) return [note(t('loading'))];
    if (loadFailed && !account) {
      return [note(t('loadFailed')), button(t('retry'), 'retry', 'tap', refresh)];
    }
    const rows = providerRows(offers, account, mode);
    const parts: HTMLElement[] = [];
    if (mode === 'link') {
      const linked = linkedIdentities(account);
      if (linked.length > 0) parts.push(linkedList(linked));
    } else {
      parts.push(
        h('p', { class: 'cp-account-mode-title', text: t('switch.title') }),
        note(t('switch.hint')),
      );
    }
    if (rows.length > 0) {
      parts.push(
        h('div', { class: 'cp-account-providers' }, ...rows.map((row) => providerButton(row))),
      );
    }
    if (
      pending?.phase === 'waiting' &&
      pending.provider === 'google' &&
      !pending.flow?.prepared.demo
    ) {
      parts.push(note(t('googleHint')));
    }
    const unavailable = rows.filter((row) => row.state === 'unavailable');
    if (unavailable.length > 0 && unavailable.length === rows.length && rows.length > 1) {
      parts.push(calm(t('unavailable')));
    } else {
      for (const row of unavailable) {
        parts.push(calm(t('unavailableOne', { provider: providerName(row.provider) })));
      }
    }
    if (rows.some((row) => row.state === 'demo')) {
      parts.push(
        h(
          'p',
          { class: 'cp-account-demo-note', attrs: { 'data-testid': 'account-demo-note' } },
          h('span', { class: 'cp-account-badge', text: t('demo.badge') }),
          h('span', { text: t('demo.note') }),
        ),
      );
    }
    const usable = providerRows(offers, account, 'signin').some(
      (row) => row.state !== 'unavailable',
    );
    if (mode === 'link' && usable) {
      parts.push(
        button(
          t('switch.open'),
          'mode',
          'toggle',
          () => {
            mode = 'signin';
            status = null;
            render();
          },
          'cp-account-link',
        ),
      );
    } else if (mode === 'signin') {
      parts.push(
        button(
          t('switch.back'),
          'mode',
          'toggle',
          () => {
            mode = 'link';
            status = null;
            pending?.abort.abort();
            pending = null;
            render();
          },
          'cp-account-link',
        ),
      );
    }
    return parts;
  }

  function note(text: string): HTMLElement {
    return h('p', { class: 'cp-field-hint', text });
  }

  function calm(text: string): HTMLElement {
    return h('p', { class: 'cp-field-hint cp-account-calm', text });
  }

  function button(
    text: string,
    focus: string,
    kind: 'tap' | 'toggle' | 'confirm' | 'close',
    onPress: () => void,
    className = 'cp-account-button',
  ): HTMLButtonElement {
    const el = h('button', {
      class: className,
      text,
      attrs: { type: 'button', 'data-focus': focus, 'data-testid': `account-${focus}` },
    });
    makePressable(el, renderCtx, { feedback: kind, onPress });
    return el;
  }

  function linkedList(identities: readonly LinkedIdentity[]): HTMLElement {
    const date = new Intl.DateTimeFormat(language(), { dateStyle: 'medium' });
    return h(
      'div',
      { class: 'cp-account-linked' },
      h('p', { class: 'cp-account-mode-title', text: t('linked.heading') }),
      h(
        'ul',
        { class: 'cp-account-linked-list' },
        ...identities.map((identity) => {
          const name = providerName(identity.provider);
          const since = t('linked.since', { date: date.format(identity.linkedAt) });
          const row = h(
            'li',
            {
              class: 'cp-account-linked-row',
              attrs: { 'data-testid': `account-linked-${identity.provider}` },
            },
            h('span', { class: 'cp-account-linked-seal' }, sealMark()),
            h(
              'span',
              { class: 'cp-account-linked-text' },
              h('span', { class: 'cp-account-linked-name', text: name }),
              h('span', {
                class: 'cp-field-hint',
                text: identity.emailHint ?? since,
                attrs: { title: identity.emailHint ?? since },
              }),
            ),
          );
          if (confirming === identity.provider) {
            return h(
              'li',
              { class: 'cp-account-linked-item' },
              row,
              unlinkConfirm(identity.provider),
            );
          }
          const unlink = h('button', {
            class:
              unlinking === identity.provider
                ? 'cp-account-button is-quiet is-busy'
                : 'cp-account-button is-quiet',
            text: t('linked.unlink'),
            attrs: {
              type: 'button',
              'aria-label': t('linked.unlinkAria', { provider: name }),
              'aria-disabled': String(busy()),
              'data-focus': `unlink-${identity.provider}`,
              'data-testid': `account-unlink-${identity.provider}`,
            },
          });
          makePressable(unlink, renderCtx, {
            feedback: 'tap',
            onPress: () => {
              confirming = identity.provider;
              status = null;
              render();
              el.querySelector<HTMLElement>('[data-focus="unlink-keep"]')?.focus({
                preventScroll: true,
              });
            },
          });
          row.append(unlink);
          return h('li', { class: 'cp-account-linked-item' }, row);
        }),
      ),
    );
  }

  function unlinkConfirm(provider: IdentityProvider): HTMLElement {
    const name = providerName(provider);
    const box = h(
      'div',
      {
        class: 'cp-account-confirm',
        attrs: { role: 'group', 'aria-label': t('linked.confirm', { provider: name }) },
      },
      h('p', { class: 'cp-account-confirm-title', text: t('linked.confirm', { provider: name }) }),
      h('p', {
        class: isLastIdentity(account, provider) ? 'cp-field-hint is-warn' : 'cp-field-hint',
        text: t(isLastIdentity(account, provider) ? 'linked.confirmLast' : 'linked.confirmHint'),
      }),
      h(
        'div',
        { class: 'cp-account-confirm-actions' },
        button(t('linked.keep'), 'unlink-keep', 'close', () => {
          confirming = null;
          render();
          el.querySelector<HTMLElement>(`[data-focus="unlink-${provider}"]`)?.focus({
            preventScroll: true,
          });
        }),
        button(
          t('linked.confirmButton'),
          'unlink-confirm',
          'confirm',
          () => {
            void unlink(provider);
          },
          'cp-account-button is-danger',
        ),
      ),
    );
    restartAnimation(box, 'is-entering');
    return box;
  }

  function providerButton(row: ProviderRow): HTMLElement {
    const { provider, state } = row;
    const name = providerName(provider);
    const mine = pending?.provider === provider ? pending : null;
    const text = mine
      ? t(`button.${mine.phase}`, { provider: name })
      : state === 'demo'
        ? t(`demo.${mode}`, { provider: name })
        : t(`button.${mode}.${provider}`);
    const skin = state === 'demo' ? 'is-demo' : `is-${provider}`;
    const el = h(
      'button',
      {
        class: `cp-account-provider ${skin}${mine ? ` is-${mine.phase}` : ''}`,
        attrs: {
          type: 'button',
          'aria-disabled': String(!pressable(row)),
          'data-focus': `provider-${provider}`,
          'data-testid': `account-provider-${provider}`,
          'data-state': state,
        },
      },
      state === 'demo' ? sealMark() : brandMark(provider),
      h('span', { class: 'cp-account-provider-label', text }),
      state === 'demo' ? h('span', { class: 'cp-account-badge', text: t('demo.badge') }) : null,
    );
    makePressable(el, renderCtx, {
      feedback: 'tap',
      onPress: () => {
        press(provider);
      },
    });
    return el;
  }

  function busy(): boolean {
    return pending !== null || unlinking !== null || choosing;
  }

  function pressable(row: ProviderRow): boolean {
    if (row.state === 'unavailable' || unlinking !== null || choosing) return false;
    if (pending === null) return true;
    return pending.provider === row.provider && pending.phase !== 'busy';
  }

  function press(provider: IdentityProvider): void {
    const mine = pending?.provider === provider ? pending : null;
    if (mine?.phase === 'waiting') {
      mine.abort.abort();
      return;
    }
    if (mine?.phase === 'ready' && mine.flow) {
      if (Date.now() < mine.flow.prepared.expiresAt) {
        void complete(mine, mine.flow);
        return;
      }
      pending = null;
    }
    confirming = null;
    void start(provider, mode);
  }

  async function start(provider: IdentityProvider, flowMode: AccountMode): Promise<void> {
    const mine: Pending = { provider, phase: 'busy', abort: new AbortController(), flow: null };
    pending = mine;
    status = null;
    render();
    try {
      const client = await options.client();
      const flow: Flow =
        flowMode === 'link'
          ? { mode: 'link', prepared: await client.prepareLink(provider) }
          : { mode: 'signin', prepared: await client.prepareSignIn(provider) };
      if (pending !== mine) return;
      if (provider === 'apple' && !flow.prepared.demo) {
        pending = { ...mine, phase: 'ready', flow };
        render();
        return;
      }
      await complete(mine, flow);
    } catch (error) {
      if (pending === mine) fail(error, provider, flowMode);
    }
  }

  async function complete(from: Pending, flow: Flow): Promise<void> {
    const mine: Pending = { ...from, phase: 'waiting', flow };
    pending = mine;
    render();
    const request = { host: googleHost, signal: mine.abort.signal };
    try {
      if (flow.mode === 'link') {
        const linked = await flow.prepared.complete(request);
        if (pending !== mine) return;
        pending = null;
        adopt(linked);
        succeed('status.linked', { provider: providerName(mine.provider) });
        return;
      }
      const outcome = await flow.prepared.complete(request);
      if (pending !== mine) return;
      pending = null;
      await signedIn(outcome, mine.provider);
    } catch (error) {
      if (pending === mine || pending === null) fail(error, mine.provider, flow.mode);
    } finally {
      googleHost.replaceChildren();
    }
  }

  async function signedIn(outcome: SignInOutcome, provider: IdentityProvider): Promise<void> {
    if (outcome.kind === 'signedIn') {
      adopt(outcome.account);
      mode = 'link';
      if (outcome.swap) swapped(outcome.swap);
      else succeed('status.sameSave');
      return;
    }
    choosing = true;
    render();
    let result: ChoiceResult;
    try {
      const sheet = await loadChoice().catch((error: unknown) => {
        outcome.keepGuest();
        throw error;
      });
      result = await sheet.choose(outcome, provider, el);
    } finally {
      choosing = false;
    }
    mode = 'link';
    if (result.kind === 'account') {
      adopt(result.swap.account);
      swapped(result.swap);
      return;
    }
    status = { key: 'status.keptGuest', tone: 'calm' };
    render();
    refresh();
  }

  function swapped(swap: SessionSwap): void {
    adopt(swap.account);
    succeed('status.signedIn', { venue: venueName(swap.state.venue.id) });
  }

  async function unlink(provider: IdentityProvider): Promise<void> {
    confirming = null;
    unlinking = provider;
    status = null;
    render();
    try {
      const client = await options.client();
      const next = await client.unlink(provider);
      unlinking = null;
      adopt(next);
      succeed('status.unlinked', { provider: providerName(provider) });
    } catch (error) {
      unlinking = null;
      fail(error, provider, 'link');
    }
  }

  function loadChoice(): Promise<ChoiceSheet> {
    choiceSheet ??= import('./choice.ts')
      .then(({ createChoiceSheet }) => {
        const sheet = createChoiceSheet(ctx, t);
        options.sheetHost.append(sheet.el);
        return sheet;
      })
      .catch((error: unknown) => {
        choiceSheet = null;
        throw error;
      });
    return choiceSheet;
  }

  async function finishSwap(
    retry: () => Promise<SessionSwap>,
    provider: IdentityProvider,
  ): Promise<void> {
    status = null;
    pending = { provider, phase: 'busy', abort: new AbortController(), flow: null };
    render();
    try {
      const swap = await retry();
      pending = null;
      mode = 'link';
      swapped(swap);
    } catch (error) {
      pending = null;
      fail(error, provider, 'signin');
    }
  }

  function fail(error: unknown, provider: IdentityProvider, flowMode: AccountMode): void {
    pending = null;
    const problem = accountProblem(error);
    if (problem.kind === 'failed') {
      console.error(`CoinPosh account: the ${provider} ${flowMode} failed.`, error);
    }
    const tone = problemTone(problem);
    let action: Status['action'];
    if (problem.kind === 'inUse' && flowMode === 'link') {
      action = {
        key: 'switch.offer',
        run: () => {
          mode = 'signin';
          void start(provider, 'signin');
        },
      };
    } else if (problem.kind === 'swapFailed') {
      action = {
        key: 'finish',
        run: () => {
          void finishSwap(problem.retry, provider);
        },
      };
    }
    status = {
      key: problemKey(problem),
      values: { provider: providerName(provider) },
      tone,
      ...(action ? { action } : {}),
    };
    if (tone === 'warn') feedback(ctx, 'deny');
    render();
    restartAnimation(statusLine, 'is-landing');
  }

  function succeed(key: AccountKey, values?: InterpolationValues): void {
    status = { key, tone: 'ok', ...(values ? { values } : {}) };
    render();
    feedback(ctx, 'confirm');
    restartAnimation(statusLine, 'is-landing');
    restartAnimation(el, 'is-sealed');
  }

  function statusContent(): HTMLElement[] {
    if (!status) return [];
    const parts: HTMLElement[] = [];
    if (status.tone === 'ok') parts.push(h('span', { class: 'cp-account-stamp' }, sealMark()));
    parts.push(h('span', { class: 'cp-account-status-text', text: t(status.key, status.values) }));
    const action = status.action;
    if (action) {
      parts.push(
        button(
          t(action.key),
          'status-action',
          'tap',
          () => {
            status = null;
            action.run();
          },
          'cp-account-button is-primary',
        ),
      );
    }
    return parts;
  }

  function adopt(next: Account): void {
    account = next;
    loadFailed = false;
    options.onAccount(next);
  }

  function refresh(): void {
    if (loading || busy()) return;
    loading = true;
    loadFailed = false;
    render();
    options
      .client()
      .then((client) => {
        offers = client.offers();
        return client.get();
      })
      .then(
        (next) => {
          loading = false;
          adopt(next);
          render();
        },
        (error: unknown) => {
          loading = false;
          loadFailed = true;
          console.error('CoinPosh account: the account could not be read.', error);
          render();
        },
      );
  }

  return {
    el,
    refresh,
    highlight() {
      el.scrollIntoView({ block: 'start', behavior: isReducedMotion() ? 'auto' : 'smooth' });
      restartAnimation(el, 'is-beckoned');
      el.querySelector<HTMLElement>('.cp-account-provider:not([aria-disabled="true"])')?.focus({
        preventScroll: true,
      });
    },
  };
}
