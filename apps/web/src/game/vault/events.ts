export interface VaultEvents {
  /** The return screen opened on a server settlement. */
  'vault:opened': { readonly coins: number; readonly capped: boolean };
  /** The odometer landed on the full amount. */
  'vault:counted': { readonly coins: number };
  /** The player tapped Collect; main wiring now shows the server wallet in the HUD. */
  'vault:collected': { readonly coins: number };
}
