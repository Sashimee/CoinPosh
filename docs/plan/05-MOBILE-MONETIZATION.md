# CoinPosh: Path to the App Store, Play Store and Monetization

## Why Capacitor
One web build ships to GitHub Pages, iOS and Android. WebGPU is available in
Safari/WKWebView (iOS 26+) and Chrome WebView. The WebGL2 fallback covers
everything else. Native plugins provide what the web can't: haptics, motion
sensors without permission prompts, push, attestation and IAP.

## Store checklist (M7)
- Bundle IDs, signing, CI lanes (fastlane) for TestFlight and Play internal testing.
- **Age rating 12+**: simulated gambling = "infrequent/mild" (cosmetic-only
  rewards keep it there; no cash-out ever).
- **Loot box disclosure**: odds visible before every purchase or open
  (Apple 3.1.1, Google Play payments policy). Already built in M2.
- Privacy nutrition labels: guest ID, device key, gameplay data. No ad tracking
  until ads are on (ATT prompt only then).
- Account deletion in-app (an Apple requirement) via `DELETE /v1/account`.
- Offline/airplane-mode behaviour reviewed (Demo-style provisional play).

## Monetization switch-on plan (later, behind `flags.monetization`)
1. **Cosmetics + premium season track**: lowest regulatory risk, highest player goodwill.
2. **Rewarded ads**: opt-in only (2× offline vault, extra crate, Golden Hour +5 min).
3. **Ad-free + starter packs**: one-time purchases.
4. **Pearl IAP**: Pearls buy deterministic items freely. Random items
   bought with *paid* Pearls are disabled in BE/NL and show odds and pity
   everywhere. RevenueCat for receipts, with server-side receipt validation.
5. Server-side catalog + remote config lets prices and offers change without a store update.
