// Runs kbsync generation in a Web Worker. Credentials never leave the
// browser: the worker only receives the device GUID bytes and the account DSID.

import { toBase64 } from './bytes';
import { loadKBSyncAssets } from './assets';
import { requestScope,throwIfAborted,waitFor } from '../../utils/abort';

// Bounds asset loading plus the emulated StoreAgent calls.
const GENERATION_TIMEOUT_MS=6*60*1000;

let wasmBinary: Promise<ArrayBuffer>|null=null;

function loadWasm(): Promise<ArrayBuffer> {
  if(!wasmBinary) {
    const url=new URL('./vendor/unicorn.wasm',import.meta.url);
    const scope=requestScope(undefined,30_000);
    wasmBinary=fetch(url,{ signal: scope.signal }).then(async (response) => {
      if(!response.ok) {
        throw new Error(`Unicorn wasm download failed: HTTP ${response.status}`);
      }
      return await response.arrayBuffer();
    }).finally(scope.dispose);
    wasmBinary.catch(() => {
      wasmBinary=null;
    });
  }
  return wasmBinary;
}

export function hardwareIDFromDeviceIdentifier(deviceIdentifier: string): Uint8Array {
  if(!/^[0-9a-fA-F]{12}$/.test(deviceIdentifier)) {
    throw new Error('kbsync requires a six-byte hexadecimal device identifier');
  }
  return Uint8Array.from(deviceIdentifier.match(/../g)!,(byte) => parseInt(byte,16));
}

/** Generates a base64 kbsync blob for this account and device. */
export async function generateKBSync(
  deviceIdentifier: string,
  dsid: number,
  onProgress?: (loadedBytes: number,totalBytes: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const scope=requestScope(signal,GENERATION_TIMEOUT_MS);
  let worker: Worker|undefined;
  try {
    const hardwareID=hardwareIDFromDeviceIdentifier(deviceIdentifier);
    const [assets,wasm]=await Promise.all([loadKBSyncAssets(onProgress,scope.signal),waitFor(loadWasm(),scope.signal)]);
    throwIfAborted(scope.signal);

    worker=new Worker(new URL('./worker.ts',import.meta.url),{ type: 'module' });
    const kbsync=await waitFor(new Promise<ArrayBuffer>((resolve,reject) => {
      worker!.onmessage=(event: MessageEvent<{ type: string; kbsync?: ArrayBuffer; message?: string }>) => {
        if(event.data.type==='result'&&event.data.kbsync) {
          resolve(event.data.kbsync);
        } else {
          reject(new Error(event.data.message??'kbsync generation failed'));
        }
      };
      worker!.onerror=(event) => {
        reject(new Error(event.message||'kbsync worker failed'));
      };
      const binaries={
        commerceKit: assets.commerceKit.buffer as ArrayBuffer,
        commerceCore: assets.commerceCore.buffer as ArrayBuffer,
        coreFP: assets.coreFP.buffer as ArrayBuffer,
        coreFPICXS: assets.coreFPICXS.buffer as ArrayBuffer,
        storeAgent: assets.storeAgent.buffer as ArrayBuffer,
      };
      const wasmCopy=wasm.slice(0);
      worker!.postMessage({
        assets: binaries,
        wasmBinary: wasmCopy,
        hardwareID: hardwareID.buffer,
        dsid,
      },[...Object.values(binaries),wasmCopy,hardwareID.buffer]);
    }),scope.signal);
    return toBase64(new Uint8Array(kbsync));
  } finally {
    // The guest heap is large; release it as soon as generation finishes.
    worker?.terminate();
    scope.cancel();
    scope.dispose();
  }
}
