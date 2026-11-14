import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSheetFocus, type FocusDocument, type SheetFocusHandle } from './sheetFocus.ts';

const CLOSE_ANIMATION_MS = 800;

class FakeNode {
  #inert = false;

  constructor(
    readonly name: string,
    private readonly doc: FakeDocument,
    readonly parent: FakeNode | null = null,
  ) {}

  get inert(): boolean {
    return this.#inert;
  }

  /** As in a browser: going inert drops focus held inside onto the body. */
  set inert(value: boolean) {
    this.#inert = value;
    if (value && this.contains(this.doc.activeElement)) this.doc.activeElement = this.doc.body;
  }

  focus(): void {
    if (this.withinInert()) return;
    this.doc.activeElement = this;
  }

  private withinInert(): boolean {
    return this.inert || (this.parent?.withinInert() ?? false);
  }

  contains(node: unknown): boolean {
    for (let at = node as FakeNode | null; at; at = at.parent) if (at === this) return true;
    return false;
  }
}

class FakeDocument {
  activeElement: FakeNode | null = null;
  readonly body = new FakeNode('body', this);
  readonly listeners = new Set<(event: KeyboardEvent) => void>();

  addEventListener(_type: 'keydown', listener: (event: KeyboardEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'keydown', listener: (event: KeyboardEvent) => void): void {
    this.listeners.delete(listener);
  }

  press(key: string): boolean {
    let prevented = false;
    const event = {
      key,
      get defaultPrevented() {
        return prevented;
      },
      preventDefault() {
        prevented = true;
      },
    };
    for (const listener of this.listeners) listener(event as KeyboardEvent);
    return prevented;
  }
}

type PanelId = 'upgrades' | 'settings';

/** Mirrors how the HUD drives sheets: one store slot, dismiss clears it, close animates. */
function setup() {
  const doc = new FakeDocument();
  const coordinator = createSheetFocus(doc as unknown as FocusDocument);
  const dock = new FakeNode('dock', doc, doc.body);
  let panel: PanelId | null = null;

  const makeSheet = (id: PanelId) => {
    const layer = new FakeNode(`${id}-layer`, doc, doc.body);
    const panel = new FakeNode(`${id}-panel`, doc, layer);
    const controls = new FakeNode(`${id}-content`, doc, panel);
    const sheet = {
      trigger: new FakeNode(`dock-${id}`, doc, dock),
      layer,
      panel,
      controls,
      closeButton: new FakeNode(`${id}-close`, doc, controls),
      buyButton: new FakeNode(`${id}-buy`, doc, controls),
      hidden: true,
      open: false,
      generation: 0,
      focus: null as unknown as SheetFocusHandle,
    };
    sheet.focus = coordinator.register(
      layer,
      () => {
        setPanel(null);
      },
      controls,
    );
    return sheet;
  };
  const sheets = { upgrades: makeSheet('upgrades'), settings: makeSheet('settings') };

  function setPanel(next: PanelId | null): void {
    panel = next;
    for (const [id, sheet] of Object.entries(sheets)) {
      if (id === panel) {
        if (sheet.open) continue;
        sheet.open = true;
        sheet.generation++;
        sheet.hidden = false;
        sheet.focus.opened();
        sheet.panel.focus();
      } else if (sheet.open) {
        sheet.open = false;
        const closing = ++sheet.generation;
        const restore = sheet.focus.closing(sheet.trigger);
        setTimeout(() => {
          if (closing !== sheet.generation) return;
          restore();
          sheet.hidden = true;
        }, CLOSE_ANIMATION_MS);
      }
    }
  }

  const tapDock = (id: PanelId): void => {
    sheets[id].trigger.focus();
    setPanel(panel === id ? null : id);
  };

  return { doc, sheets, tapDock, setPanel, coordinator };
}

describe('sheet focus and Escape ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['upgrades', 'settings', 100],
    ['settings', 'upgrades', 100],
    ['upgrades', 'settings', CLOSE_ANIMATION_MS],
    ['settings', 'upgrades', CLOSE_ANIMATION_MS],
  ] as const)(
    'Escape on %s, open %s 100 ms later, Escape %i ms after: both hide, focus on second trigger',
    (first, second, escapeDelay) => {
      const { doc, sheets, tapDock } = setup();
      tapDock(first);
      expect(doc.activeElement).toBe(sheets[first].panel);

      expect(doc.press('Escape')).toBe(true);
      vi.advanceTimersByTime(100);
      tapDock(second);
      expect(doc.activeElement).toBe(sheets[second].panel);

      vi.advanceTimersByTime(escapeDelay);
      expect(doc.activeElement).toBe(sheets[second].panel);
      expect(doc.press('Escape')).toBe(true);
      vi.advanceTimersByTime(CLOSE_ANIMATION_MS * 2);

      expect(sheets[first].hidden).toBe(true);
      expect(sheets[second].hidden).toBe(true);
      expect(doc.activeElement).toBe(sheets[second].trigger);
    },
  );

  it('keeps focus on the newly opened sheet when the old one finishes closing', () => {
    const { doc, sheets, tapDock } = setup();
    tapDock('upgrades');
    doc.press('Escape');
    vi.advanceTimersByTime(100);
    tapDock('settings');
    vi.advanceTimersByTime(CLOSE_ANIMATION_MS * 2);

    expect(sheets.upgrades.hidden).toBe(true);
    expect(sheets.settings.hidden).toBe(false);
    expect(doc.activeElement).toBe(sheets.settings.panel);
  });

  it('lets the open sheet own Escape even when focus sits outside it', () => {
    const { doc, sheets, tapDock } = setup();
    tapDock('settings');
    sheets.upgrades.trigger.focus();

    expect(doc.press('Escape')).toBe(true);
    vi.advanceTimersByTime(CLOSE_ANIMATION_MS);
    expect(sheets.settings.hidden).toBe(true);
  });

  it('ignores Escape with no sheet open or when something else already handled it', () => {
    const { doc, sheets, tapDock } = setup();
    expect(doc.press('Escape')).toBe(false);

    tapDock('settings');
    const overlay = vi.fn((event: KeyboardEvent) => {
      event.preventDefault();
    });
    const sheetListeners = [...doc.listeners];
    doc.listeners.clear();
    doc.listeners.add(overlay);
    for (const listener of sheetListeners) doc.listeners.add(listener);
    expect(doc.press('Escape')).toBe(true);
    expect(overlay).toHaveBeenCalledOnce();
    expect(sheets.settings.open).toBe(true);
  });

  it('closing with the X button still returns focus to the trigger', () => {
    const { doc, sheets, tapDock, setPanel } = setup();
    tapDock('upgrades');
    sheets.upgrades.closeButton.focus();
    setPanel(null);
    vi.advanceTimersByTime(CLOSE_ANIMATION_MS);

    expect(sheets.upgrades.hidden).toBe(true);
    expect(doc.activeElement).toBe(sheets.upgrades.trigger);
  });

  it('closing from the backdrop (focus on body) still returns focus to the trigger', () => {
    const { doc, sheets, tapDock, setPanel } = setup();
    tapDock('settings');
    doc.body.focus();
    setPanel(null);
    vi.advanceTimersByTime(CLOSE_ANIMATION_MS);

    expect(sheets.settings.hidden).toBe(true);
    expect(doc.activeElement).toBe(sheets.settings.trigger);
  });

  it('does not restore from body once another sheet has opened since the close', () => {
    const { doc, sheets, tapDock, setPanel } = setup();
    tapDock('upgrades');
    setPanel(null);
    tapDock('settings');
    doc.body.focus();
    vi.advanceTimersByTime(CLOSE_ANIMATION_MS);

    expect(doc.activeElement).toBe(doc.body);
    expect(sheets.settings.open).toBe(true);
  });

  it('makes a closing sheet inert and gives focus to its trigger synchronously on close', () => {
    const { doc, sheets, tapDock, setPanel } = setup();
    const { upgrades } = sheets;
    tapDock('upgrades');
    expect(upgrades.controls.inert).toBe(false);
    upgrades.buyButton.focus();
    expect(doc.activeElement).toBe(upgrades.buyButton);

    setPanel(null);

    expect(upgrades.hidden).toBe(false);
    expect(upgrades.controls.inert).toBe(true);
    expect(doc.activeElement).toBe(upgrades.trigger);
    upgrades.buyButton.focus();
    expect(doc.activeElement, 'nothing in the shrinking sheet can take focus').toBe(
      upgrades.trigger,
    );
    vi.advanceTimersByTime(CLOSE_ANIMATION_MS);
    expect(upgrades.hidden).toBe(true);
    expect(doc.activeElement).toBe(upgrades.trigger);
  });

  it('hands focus back at once on Escape and leaves the trigger focused through the close', () => {
    const { doc, sheets, tapDock } = setup();
    tapDock('settings');
    sheets.settings.closeButton.focus();

    expect(doc.press('Escape')).toBe(true);
    expect(sheets.settings.controls.inert).toBe(true);
    expect(doc.activeElement).toBe(sheets.settings.trigger);
    vi.advanceTimersByTime(60);
    expect(doc.activeElement).toBe(sheets.settings.trigger);
  });

  it('keeps every sheet inert until it first opens', () => {
    const { sheets } = setup();
    expect(sheets.upgrades.controls.inert).toBe(true);
    expect(sheets.settings.controls.inert).toBe(true);
  });

  it('reopening a closing sheet makes it live again and keeps it open (P-257)', () => {
    const { doc, sheets, tapDock } = setup();
    const { upgrades } = sheets;
    tapDock('upgrades');
    doc.press('Escape');
    expect(upgrades.controls.inert).toBe(true);
    vi.advanceTimersByTime(100);

    tapDock('upgrades');
    expect(upgrades.controls.inert).toBe(false);
    expect(doc.activeElement).toBe(upgrades.panel);
    vi.advanceTimersByTime(CLOSE_ANIMATION_MS * 2);

    expect(upgrades.open).toBe(true);
    expect(upgrades.hidden).toBe(false);
    upgrades.buyButton.focus();
    expect(doc.activeElement).toBe(upgrades.buyButton);
  });

  it('a sheet without controls to guard still hands focus back synchronously', () => {
    const { doc, coordinator } = setup();
    const root = new FakeNode('screen', doc, doc.body);
    const trigger = new FakeNode('screen-trigger', doc, doc.body);
    const inside = new FakeNode('screen-button', doc, root);
    const handle = coordinator.register(root, () => undefined);
    handle.opened();
    inside.focus();

    const settle = handle.closing(trigger);
    expect(root.inert).toBe(false);
    expect(doc.activeElement).toBe(trigger);
    settle();
    expect(doc.activeElement).toBe(trigger);
    handle.dispose();
  });

  it('removes its document listener once every sheet is disposed', () => {
    const { doc, sheets } = setup();
    expect(doc.listeners.size).toBe(1);
    sheets.upgrades.focus.dispose();
    sheets.upgrades.focus.dispose();
    expect(doc.listeners.size).toBe(1);
    sheets.settings.focus.dispose();
    expect(doc.listeners.size).toBe(0);
  });
});
