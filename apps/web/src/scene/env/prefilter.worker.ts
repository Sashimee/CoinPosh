import { prefilterRadianceFile, type PrefilterReply, type PrefilterRequest } from './prefilter.ts';

interface WorkerScope {
  postMessage(message: PrefilterReply, transfer: Transferable[]): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<PrefilterRequest>) => void,
  ): void;
}

// apps/web compiles against the DOM lib, which types `self` as a Window; inside this module it
// is a DedicatedWorkerGlobalScope, whose postMessage takes a transfer list.
const scope = globalThis as unknown as WorkerScope;

async function prefilter(url: string): Promise<PrefilterReply> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`fetching ${url} answered HTTP ${String(response.status)}`);
  }
  const { width, height, levels } = prefilterRadianceFile(await response.arrayBuffer());
  return { ok: true, width, height, levels: [...levels] };
}

scope.addEventListener('message', (event) => {
  prefilter(event.data.url).then(
    (reply) => {
      scope.postMessage(reply, reply.ok ? reply.levels.map((level) => level.buffer) : []);
    },
    (error: unknown) => {
      scope.postMessage(
        { ok: false, message: error instanceof Error ? error.message : String(error) },
        [],
      );
    },
  );
});
