import type { D1Migration } from 'cloudflare:test';
import type { Env as WorkerEnv } from '../env.ts';
import type * as MainModule from '../index.ts';

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      readonly TEST_MIGRATIONS: D1Migration[];
    }
    interface GlobalProps {
      mainModule: typeof MainModule;
      durableNamespaces: 'PlayerDO';
    }
  }
}
