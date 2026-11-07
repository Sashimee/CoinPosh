import type { Context } from 'hono';
import type { Env } from '../env.ts';

export interface AppEnv {
  Bindings: Env;
  Variables: { requestId: string };
}

export type AppContext = Context<AppEnv>;
