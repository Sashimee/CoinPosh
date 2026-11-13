import { createBus, type Bus } from '../../app/bus.ts';
import type { UiApp, UiAudio } from '../../app/index.ts';
import { bindUpgrades, type BindUpgradesOptions, type UpgradeUi } from './controller.ts';
import type { UpgradeEvents } from './events.ts';
import { bindUpgradeFeedback } from './feedback.ts';
import { registerUpgradeStrings } from './i18n.ts';
import { createUpgradeNotice } from './notice.ts';

export { netUpgradeApi } from './api.ts';
export { bindUpgrades, classifyRejection } from './controller.ts';
export type { BindUpgradesOptions, UpgradeApi, UpgradeUi } from './controller.ts';
export type { UpgradeEvents, UpgradeRejection } from './events.ts';
export { bindUpgradeFeedback, PURCHASE_CHIME } from './feedback.ts';
export { registerUpgradeStrings, UPGRADES_NAMESPACE } from './i18n.ts';
export { isUpgradeLineV1, UPGRADE_LINE_IDS_V1, UPGRADE_LINES_V1 } from './lines.ts';

export interface UpgradesGame {
  readonly events: Bus<UpgradeEvents>;
  dispose(): void;
}

export interface MountUpgradesOptions extends Omit<BindUpgradesOptions, 'events' | 'ui'> {
  readonly ui: UpgradeUi & Pick<UiApp, 'i18n' | 'bannerSlot'>;
  readonly audio: () => Pick<UiAudio, 'playImpact'> | null;
}

/** Boot wiring: purchases, their chime and the rejection notice, sharing one event bus. */
export function mountUpgrades(options: MountUpgradesOptions): UpgradesGame {
  registerUpgradeStrings(options.ui.i18n);
  const events = createBus<UpgradeEvents>();
  const notice = createUpgradeNotice(options.ui.bannerSlot);
  const unbindFeedback = bindUpgradeFeedback({
    events,
    i18n: options.ui.i18n,
    audio: options.audio,
    notify: (message) => {
      notice.show(message);
    },
  });
  const unbind = bindUpgrades({ ...options, events });
  return {
    events,
    dispose() {
      unbind();
      unbindFeedback();
      notice.dispose();
    },
  };
}
