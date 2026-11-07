const canvas = document.querySelector<HTMLCanvasElement>('#stage');
if (!canvas) {
  throw new Error('CoinPosh boot failed: <canvas id="stage"> is missing from index.html');
}

import('./stage.ts')
  .then(({ createStage }) => createStage(canvas))
  .catch((error: unknown) => {
    console.error('CoinPosh boot failed: the renderer could not start.', error);
  });
