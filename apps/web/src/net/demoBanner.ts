import { rivieraTokens } from '../scene/venues/riviera/palette.ts';
import { NET_I18N_KEYS, type NetI18nKey } from './i18nKeys.ts';

export type Translate = (key: NetI18nKey) => string;

export const DEMO_BANNER_ID = 'coinposh-demo-banner';
const STYLE_ID = `${DEMO_BANNER_ID}-style`;

const STYLE = `
#${DEMO_BANNER_ID} {
  position: fixed;
  top: calc(env(safe-area-inset-top, 0px) + 12px);
  left: 50%;
  z-index: 10;
  display: flex;
  align-items: baseline;
  gap: 10px;
  max-width: min(560px, calc(100vw - 32px));
  padding: 8px 16px;
  border: 1px solid ${rivieraTokens['gold-brushed']};
  border-radius: 16px;
  background: color-mix(in srgb, ${rivieraTokens['navy-lacquer']} 72%, transparent);
  backdrop-filter: blur(14px) saturate(140%);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
  color: ${rivieraTokens.ivory};
  font: 500 13px/1.35 system-ui, sans-serif;
  box-shadow: 0 6px 24px rgb(0 0 0 / 0.28);
  pointer-events: none;
  transform: translate(-50%, 0);
  animation: coinposh-demo-banner-in 420ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
#${DEMO_BANNER_ID} strong {
  flex: none;
  color: ${rivieraTokens.champagne};
  font: italic 600 15px/1 Georgia, 'Times New Roman', serif;
  letter-spacing: 0.04em;
}
#${DEMO_BANNER_ID} span { opacity: 0.86; }
@keyframes coinposh-demo-banner-in {
  from { opacity: 0; transform: translate(-50%, -12px) scale(0.96); }
  to { opacity: 1; transform: translate(-50%, 0) scale(1); }
}
@keyframes coinposh-demo-banner-fade { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  #${DEMO_BANNER_ID} { animation: coinposh-demo-banner-fade 200ms ease-out both; }
}
@media (max-width: 420px) {
  #${DEMO_BANNER_ID} { flex-direction: column; gap: 2px; }
}
`;

/** Shows the Demo Mode notice (replacing any earlier one); the returned function removes it. */
export function mountDemoBanner(doc: Document, translate: Translate): () => void {
  doc.getElementById(DEMO_BANNER_ID)?.remove();
  doc.getElementById(STYLE_ID)?.remove();
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  const banner = doc.createElement('aside');
  banner.id = DEMO_BANNER_ID;
  banner.setAttribute('role', 'status');
  const title = doc.createElement('strong');
  title.textContent = translate(NET_I18N_KEYS.demoBanner);
  const detail = doc.createElement('span');
  detail.textContent = translate(NET_I18N_KEYS.demoBannerDetail);
  banner.append(title, detail);
  doc.head.append(style);
  doc.body.append(banner);
  return () => {
    banner.remove();
    style.remove();
  };
}
