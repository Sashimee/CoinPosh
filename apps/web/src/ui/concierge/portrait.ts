import type { ConciergeExpression } from '../../game/concierge/index.ts';
import { fromMarkup } from '../dom.ts';

/**
 * Augustin, drawn in code: an SVG bust whose brows, lids, moustache, mouth, cheeks and monocle
 * are separate parts, so each expression is a set of CSS poses (concierge.css) that the parts
 * spring between. Static, trusted markup only: nothing here comes from data.
 */
const PORTRAIT_MARKUP = `
<svg class="cp-concierge-portrait" viewBox="12 12 96 96" focusable="false" role="img" data-expression="pleased">
  <defs>
    <radialGradient id="cp-cg-bg" cx="50%" cy="38%" r="70%">
      <stop offset="0" stop-color="#2a4478"/>
      <stop offset="0.55" stop-color="#14264a"/>
      <stop offset="1" stop-color="#08142b"/>
    </radialGradient>
    <radialGradient id="cp-cg-halo" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#f3e5c0" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#d4af37" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="cp-cg-skin" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f6d8bf"/>
      <stop offset="1" stop-color="#e3ad8c"/>
    </linearGradient>
    <linearGradient id="cp-cg-hair" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="#f7f8fb"/>
      <stop offset="0.6" stop-color="#c9cdd6"/>
      <stop offset="1" stop-color="#959cab"/>
    </linearGradient>
    <linearGradient id="cp-cg-coat" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#22376a"/>
      <stop offset="1" stop-color="#0a1530"/>
    </linearGradient>
    <linearGradient id="cp-cg-gold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fff1c9"/>
      <stop offset="0.45" stop-color="#d4af37"/>
      <stop offset="1" stop-color="#8f6d17"/>
    </linearGradient>
    <radialGradient id="cp-cg-cheek" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#ff7f6a" stop-opacity="0.75"/>
      <stop offset="1" stop-color="#ff7f6a" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="cp-cg-eye-l"><ellipse cx="51" cy="51" rx="4.4" ry="2.9"/></clipPath>
    <clipPath id="cp-cg-eye-r"><ellipse cx="69" cy="51" rx="4.4" ry="2.9"/></clipPath>
  </defs>
  <rect width="120" height="120" fill="url(#cp-cg-bg)"/>
  <circle class="cp-cg-halo" cx="60" cy="54" r="40" fill="url(#cp-cg-halo)"/>
  <path d="M4 120 C8 99 26 91 45 87 L60 102 L75 87 C94 91 112 99 116 120 Z" fill="url(#cp-cg-coat)"/>
  <path d="M51 70 L51 88 L60 95 L69 88 L69 70 Z" fill="#d79f80"/>
  <path d="M46 86 L60 115 L74 86 Z" fill="#fbf6ec"/>
  <path d="M45 87 L60 115 L54 120 L36 120 L40 98 Z" fill="#0c1833"/>
  <path d="M75 87 L60 115 L66 120 L84 120 L80 98 Z" fill="#0c1833"/>
  <path d="M45 87 L60 115 M75 87 L60 115" stroke="url(#cp-cg-gold)" stroke-width="1.1" fill="none"/>
  <path d="M50 83 L60 92 L56 99 L46.5 88 Z M70 83 L60 92 L64 99 L73.5 88 Z" fill="#ffffff"/>
  <g class="cp-cg-bow">
    <path d="M60 93 L48.5 87.5 Q47 93 48.5 98.5 Z M60 93 L71.5 87.5 Q73 93 71.5 98.5 Z" fill="#17101a"/>
    <path d="M50 89.5 L57 92.6 M70 89.5 L63 92.6" stroke="#4a3550" stroke-width="0.7" stroke-linecap="round"/>
    <rect x="57.2" y="90.2" width="5.6" height="5.6" rx="1.6" fill="#241726"/>
  </g>
  <g class="cp-cg-keys" stroke="url(#cp-cg-gold)" stroke-width="1.3" stroke-linecap="round" fill="none">
    <path d="M40 101 L47.5 108.5 M47.5 101 L40 108.5 M45 106 L46.6 104.4 M42.5 106 L40.9 104.4"/>
    <circle cx="39.4" cy="100.4" r="1.5"/>
    <circle cx="48.1" cy="100.4" r="1.5"/>
  </g>
  <ellipse cx="39.5" cy="55" rx="3.6" ry="6.2" fill="#e8b597"/>
  <ellipse cx="80.5" cy="55" rx="3.6" ry="6.2" fill="#e8b597"/>
  <path d="M60 25 C74 25 81.5 37 81.5 52 C81.5 66.5 72 78.5 60 78.5 C48 78.5 38.5 66.5 38.5 52 C38.5 37 46 25 60 25 Z" fill="url(#cp-cg-skin)"/>
  <circle class="cp-cg-cheek" cx="46" cy="62" r="6" fill="url(#cp-cg-cheek)"/>
  <circle class="cp-cg-cheek" cx="74" cy="62" r="6" fill="url(#cp-cg-cheek)"/>
  <path d="M38.2 53 C35.5 36 44 21 60 20.5 C76.5 20 86 33 81.8 53 C80.6 45.5 78.2 40.5 74.6 37.4 C69.5 33.6 62 32.6 55 33.6 C47.8 34.7 41.8 40.4 40.2 50 Z" fill="url(#cp-cg-hair)"/>
  <path d="M38.6 50 L41.4 49 L41.8 60 L39.6 60.5 Z M81.4 50 L78.6 49 L78.2 60 L80.4 60.5 Z" fill="#b8bdc8"/>
  <path d="M50 23.6 C55 28.4 63 30.4 75 29.6" stroke="#ffffff" stroke-opacity="0.65" stroke-width="1.1" fill="none" stroke-linecap="round"/>
  <path d="M44 31 C48 27 53 25.5 57 25.2" stroke="#ffffff" stroke-opacity="0.35" stroke-width="0.8" fill="none" stroke-linecap="round"/>
  <g class="cp-cg-brow cp-cg-brow-l"><path d="M45.6 45.2 Q50.8 41.8 56.2 44.2" stroke="#5b606c" stroke-width="2.9" stroke-linecap="round" fill="none"/></g>
  <g class="cp-cg-brow cp-cg-brow-r"><path d="M63.8 44.2 Q69.2 41.8 74.4 45.2" stroke="#5b606c" stroke-width="2.9" stroke-linecap="round" fill="none"/></g>
  <g class="cp-cg-eye cp-cg-eye-l">
    <g clip-path="url(#cp-cg-eye-l)">
      <ellipse cx="51" cy="51" rx="4.4" ry="2.9" fill="#fffaf1"/>
      <g class="cp-cg-iris"><circle cx="51.3" cy="51.2" r="2.05" fill="#4a3322"/><circle cx="51.3" cy="51.2" r="0.95" fill="#120b07"/><circle cx="52" cy="50.4" r="0.55" fill="#ffffff"/></g>
      <rect class="cp-cg-lid cp-cg-lid-up" x="46" y="47.6" width="10" height="3.8" fill="#eec2a4"/>
      <rect class="cp-cg-lid cp-cg-lid-low" x="46" y="51.2" width="10" height="3" fill="#eec2a4"/>
    </g>
    <path d="M46.5 50.4 Q51 47.4 55.5 50.4" stroke="#5a4033" stroke-width="0.9" fill="none" stroke-linecap="round"/>
  </g>
  <g class="cp-cg-eye cp-cg-eye-r">
    <g clip-path="url(#cp-cg-eye-r)">
      <ellipse cx="69" cy="51" rx="4.4" ry="2.9" fill="#fffaf1"/>
      <g class="cp-cg-iris"><circle cx="68.7" cy="51.2" r="2.05" fill="#4a3322"/><circle cx="68.7" cy="51.2" r="0.95" fill="#120b07"/><circle cx="69.4" cy="50.4" r="0.55" fill="#ffffff"/></g>
      <rect class="cp-cg-lid cp-cg-lid-up" x="64" y="47.6" width="10" height="3.8" fill="#eec2a4"/>
      <rect class="cp-cg-lid cp-cg-lid-low" x="64" y="51.2" width="10" height="3" fill="#eec2a4"/>
    </g>
    <path d="M64.5 50.4 Q69 47.4 73.5 50.4" stroke="#5a4033" stroke-width="0.9" fill="none" stroke-linecap="round"/>
  </g>
  <path d="M60.4 49 C59.6 55 57.4 59.6 58.2 61.6 C59 63 61.2 63.2 62.8 62.2" stroke="#b97d60" stroke-width="1.2" fill="none" stroke-linecap="round"/>
  <path class="cp-cg-mouth cp-cg-mouth-pleased" d="M53.4 71.4 Q60 77 66.6 71.4 Q60 74 53.4 71.4 Z" fill="#8c3b33" stroke="#8c3b33" stroke-width="1.2" stroke-linejoin="round"/>
  <path class="cp-cg-mouth cp-cg-mouth-wry" d="M53.6 72.6 Q57.6 73.6 61.6 72.6 Q65 71.6 67.6 69" stroke="#8c3b33" stroke-width="1.6" fill="none" stroke-linecap="round"/>
  <ellipse class="cp-cg-mouth cp-cg-mouth-scandalised" cx="60" cy="73" rx="2.7" ry="3.4" fill="#5c1d1a"/>
  <g class="cp-cg-stache">
    <path class="cp-cg-stache-l" d="M60 66.2 C56.2 63.6 51.2 63.4 48 65.8 C46 67.3 44.2 67 43 64.6 C43.4 68.6 47 70.4 50.6 69.1 C54 67.9 57 67.5 60 68.3 Z" fill="#cfd3db" stroke="#8a909d" stroke-width="0.5"/>
    <path class="cp-cg-stache-r" d="M60 66.2 C63.8 63.6 68.8 63.4 72 65.8 C74 67.3 75.8 67 77 64.6 C76.6 68.6 73 70.4 69.4 69.1 C66 67.9 63 67.5 60 68.3 Z" fill="#cfd3db" stroke="#8a909d" stroke-width="0.5"/>
  </g>
  <path class="cp-cg-sweat" d="M84 33 C86.4 36.6 87.4 39 85.6 41 C83.8 42.6 81.4 41.2 82.2 38.6 Z" fill="#cdeef6" stroke="#7fd1c7" stroke-width="0.5"/>
  <g class="cp-cg-monocle">
    <path d="M74.6 55.6 C80 63 80.4 74 76 84 C73.6 90 71.4 97 70 106" stroke="url(#cp-cg-gold)" stroke-width="0.8" stroke-dasharray="1.4 1" fill="none"/>
    <circle cx="69" cy="51" r="6.4" fill="#ffffff" fill-opacity="0.1" stroke="url(#cp-cg-gold)" stroke-width="1.5"/>
    <path d="M65 47.6 Q67.4 45.8 70.4 46" stroke="#ffffff" stroke-opacity="0.7" stroke-width="0.8" fill="none" stroke-linecap="round"/>
  </g>
</svg>`;

export interface Portrait {
  readonly el: SVGSVGElement;
  readonly expression: ConciergeExpression;
  setExpression(expression: ConciergeExpression): void;
  /** Closes both lids for a beat. */
  blink(): void;
}

const BLINK_MS = 150;

export function createPortrait(label: (expression: ConciergeExpression) => string): Portrait {
  const el = fromMarkup(PORTRAIT_MARKUP) as SVGSVGElement;
  let expression: ConciergeExpression = 'pleased';
  let blinkTimer: ReturnType<typeof setTimeout> | null = null;
  const paint = (): void => {
    el.dataset.expression = expression;
    el.setAttribute('aria-label', label(expression));
  };
  paint();
  return {
    el,
    get expression() {
      return expression;
    },
    setExpression(next) {
      expression = next;
      paint();
    },
    blink() {
      if (blinkTimer !== null) clearTimeout(blinkTimer);
      el.classList.add('is-blinking');
      blinkTimer = setTimeout(() => {
        blinkTimer = null;
        el.classList.remove('is-blinking');
      }, BLINK_MS);
    },
  };
}
