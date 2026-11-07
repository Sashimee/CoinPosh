import { createAudioEngine, isAudioSupported } from './audio/index.ts';
import type * as RivieraModule from './scene/venues/riviera/index.ts';
import type { RivieraVenue } from './scene/venues/riviera/index.ts';
import type { Stage } from './stage.ts';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

const canvas = document.querySelector<HTMLCanvasElement>('#stage');
if (!canvas) {
  throw new Error('CoinPosh boot failed: <canvas id="stage"> is missing from index.html');
}

bootAudio().catch((error: unknown) => {
  console.error('CoinPosh audio failed to start; the game continues without sound.', error);
});

void bootScene(canvas);

// The music loop is rendered offline now, before any gesture, so the first tap only has to
// unlock the context and the track starts without a render hitch.
async function bootAudio(): Promise<void> {
  if (!isAudioSupported()) {
    console.warn('[CoinPosh] Web Audio is unavailable in this browser; playing without sound.');
    return;
  }
  const audio = createAudioEngine();
  await audio.startMusic();
}

async function bootScene(target: HTMLCanvasElement): Promise<void> {
  let stage: Stage;
  let riviera: typeof RivieraModule;
  try {
    const [stageModule, venueModule] = await Promise.all([
      import('./stage.ts'),
      import('./scene/venues/riviera/index.ts'),
    ]);
    riviera = venueModule;
    stage = await stageModule.createStage(target);
  } catch (error) {
    console.error('CoinPosh boot failed: the renderer could not start.', error);
    return;
  }
  try {
    const venue = await riviera.createRivieraVenue(stage.scene, stage.renderer);
    attachVenue(stage, venue, riviera.applyCameraPreset);
  } catch (error) {
    console.error('CoinPosh boot failed: the Riviera venue could not load.', error);
  }
}

function attachVenue(
  stage: Stage,
  venue: RivieraVenue,
  applyCameraPreset: typeof RivieraModule.applyCameraPreset,
): void {
  stage.observeSize((width, height) => {
    applyCameraPreset(stage.camera, venue.cameraPreset(width / height));
  });
  stage.onFrame((deltaSeconds) => {
    venue.update(deltaSeconds);
  });
  if (typeof matchMedia === 'function') {
    matchMedia(REDUCED_MOTION_QUERY).addEventListener('change', (event) => {
      venue.setReducedMotion(event.matches);
    });
  }
}
