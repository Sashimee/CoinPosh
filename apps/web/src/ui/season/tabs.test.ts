import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBus } from '../../app/bus.ts';
import { defaultSettings } from '../../app/settings.ts';
import { initialUiState, type FeedbackKind, type UiEvents } from '../../app/state.ts';
import { createStore } from '../../app/store.ts';
import type { ImpactEvent } from '../../audio/index.ts';
import { BUNDLED_RESOURCES, createI18n } from '../../i18n/index.ts';
import type { UiContext } from '../context.ts';
import { Localizer } from '../localize.ts';
import { setMotionPreference } from '../motion/reduced.ts';
import { playSeasonCue, seasonCuePlan } from './juice.ts';
import { wireSeasonTabs } from './tabs.ts';

type Tab = 'quests' | 'season';

/** Just enough of an element for makePressable and the tab list's key handler. */
class FakeButton extends EventTarget {
  readonly style: Record<string, string> = {};
  readonly classList = { add: (): void => undefined, remove: (): void => undefined };
  focused = 0;
  getAttribute(): string | null {
    return null;
  }
  focus(): void {
    this.focused += 1;
  }
}

function pointer(type: string): Event {
  return Object.assign(new Event(type), { button: 0 });
}

function key(name: string): Event {
  return Object.assign(new Event('keydown', { cancelable: true }), { key: name });
}

function mountTabs(reduced = true) {
  const i18n = createI18n({ language: 'en', resources: BUNDLED_RESOURCES });
  const bus = createBus<UiEvents>();
  const emits: FeedbackKind[] = [];
  bus.on('ui:feedback', ({ kind }) => emits.push(kind));
  const chimes: ImpactEvent[] = [];
  const ctx: UiContext = {
    i18n,
    loc: new Localizer(i18n),
    store: createStore(initialUiState(defaultSettings('en'))),
    bus,
    own: () => undefined,
  };
  const buttons = { quests: new FakeButton(), season: new FakeButton() };
  const list = new FakeButton();
  let tab: Tab = 'quests';
  wireSeasonTabs<Tab>(ctx, {
    buttons: buttons as unknown as Record<Tab, HTMLElement>,
    list: list as unknown as HTMLElement,
    order: ['quests', 'season'],
    current: () => tab,
    select: (next, withBus) => {
      if (next === tab) return;
      tab = next;
      playSeasonCue(ctx, seasonCuePlan('tab', reduced), withBus, {
        audio: { playImpact: (impact) => chimes.push(impact) },
        later: (_ms, run) => {
          run();
        },
      });
    },
  });
  return { buttons, list, emits, chimes, cues: () => emits.length + chimes.length, tab: () => tab };
}

describe('season tabs send one press cue per switch', () => {
  beforeEach(() => {
    setMotionPreference('reduced');
  });
  afterEach(() => {
    setMotionPreference('system');
  });

  it.each([true, false])('one pointer press is exactly one cue (reduced=%s)', (reduced) => {
    const tabs = mountTabs(reduced);
    tabs.buttons.season.dispatchEvent(pointer('pointerdown'));
    tabs.buttons.season.dispatchEvent(pointer('pointerup'));
    tabs.buttons.season.dispatchEvent(new Event('click'));
    expect(tabs.tab()).toBe('season');
    expect(tabs.emits).toEqual(['toggle']);
    expect(tabs.cues()).toBe(1);
  });

  it.each([true, false])('one arrow key press is exactly one cue (reduced=%s)', (reduced) => {
    const tabs = mountTabs(reduced);
    tabs.list.dispatchEvent(key('ArrowRight'));
    expect(tabs.tab()).toBe('season');
    expect(tabs.emits).toEqual(['toggle']);
    expect(tabs.cues()).toBe(1);
  });

  it('a click with no pointer (Enter or Space) also emits once', () => {
    const tabs = mountTabs();
    tabs.buttons.season.dispatchEvent(new Event('click'));
    expect(tabs.emits).toEqual(['toggle']);
    expect(tabs.cues()).toBe(1);
  });

  it('each arrow key switch emits once, from the tab cue', () => {
    const tabs = mountTabs();
    const right = key('ArrowRight');
    tabs.list.dispatchEvent(right);
    expect(right.defaultPrevented).toBe(true);
    expect(tabs.tab()).toBe('season');
    expect(tabs.buttons.season.focused).toBe(1);
    tabs.list.dispatchEvent(key('Home'));
    expect(tabs.tab()).toBe('quests');
    expect(tabs.emits).toEqual(['toggle', 'toggle']);
    expect(tabs.cues()).toBe(2);
  });

  it('pressing the tab already shown plays only the press cue', () => {
    const tabs = mountTabs();
    tabs.buttons.quests.dispatchEvent(pointer('pointerdown'));
    tabs.buttons.quests.dispatchEvent(new Event('click'));
    expect(tabs.emits).toEqual(['toggle']);
    expect(tabs.cues()).toBe(1);
  });

  it('ignores keys that do not move between tabs', () => {
    const tabs = mountTabs();
    const enter = key('Enter');
    tabs.list.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(tabs.emits).toEqual([]);
  });
});
