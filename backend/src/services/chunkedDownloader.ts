import fs from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import {
  DOWNLOAD_THREADS,
  CHUNK_RETRY_COUNT,
  CHUNK_RETRY_DELAY_MS,
  MAX_DOWNLOAD_SIZE,
} from "../config.js";

interface ChunkRange {
  index: number;
  start: number;
  end: number; // inclusive
}

interface ProgressInfo {
  downloaded: number;
  total: number;
  speed: string;
}

const TARGET_CHUNK_SIZE = 32 * 1024 * 1024;

type ProgressCallback = (info: ProgressInfo) => void;

export class DownloadURLExpiredError extends Error {
  constructor() { super('Download URL expired'); this.name = 'DownloadURLExpiredError'; }
}

/**
 * Multi-threaded HTTP downloader using Range requests.
 * Falls back to single-stream when the server doesn't support Range.
 */
export class ChunkedDownloader {
  private url: string;
  private readonly destPath: string;
  private readonly threads: number;
  private readonly onProgress?: ProgressCallback;

  private abortControllers = new Set<AbortController>();
  private aborted = false;
  private chunkBytes: number[] = [];
  private totalSize = 0;
  private paused = false;
  private checkpoint?: { size: number; validator: string; chunks: ChunkRange[] };
  private lastProgressTime = 0;
  private lastProgressBytes = 0;

  constructor(
    url: string,
    destPath: string,
    options?: { threads?: number; onProgress?: ProgressCallback },
  ) {
    this.url = url;
    this.destPath = destPath;
    this.threads = options?.threads ?? DOWNLOAD_THREADS;
    this.onProgress = options?.onProgress;
  }

  /** Probe the server for Range support and content length. */
  private async probe(signal: AbortSignal): Promise<{
    supportsRange: boolean;
    contentLength: number;
    validator: string;
  }> {
    const res = await fetch(this.url, {
      method: "HEAD",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      redirect: "follow",
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new DownloadURLExpiredError();
      throw new Error(`HEAD failed: HTTP ${res.status}`);
    }

    const acceptRanges = res.headers.get("accept-ranges");
    const contentLength = parseInt(
      res.headers.get("content-length") || "0",
      10,
    );
    const supportsRange = acceptRanges === "bytes" && contentLength > 0;

    const etag = res.headers.get('etag');
    const validator = etag && !etag.startsWith('W/') ? etag : res.headers.get('last-modified') ?? '';
    return { supportsRange, contentLength, validator };
  }

  /** Split total size into chunk ranges. */
  private splitChunks(totalSize: number): ChunkRange[] {
    // Keep all workers busy, but use more chunks for large files so a single
    // slow connection cannot hold the entire download at the tail.
    const desiredChunks = Math.max(
      this.threads,
      Math.ceil(totalSize / TARGET_CHUNK_SIZE),
    );
    const chunkSize = Math.ceil(totalSize / desiredChunks);
    const chunks: ChunkRange[] = [];
    for (let i = 0; i < desiredChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize - 1, totalSize - 1);
      if (start > totalSize - 1) break;
      chunks.push({ index: i, start, end });
    }
    return chunks;
  }

  /** Download a single chunk with retries, writing to a .part file. */
  private async downloadChunk(
    chunk: ChunkRange,
    signal: AbortSignal,
  ): Promise<void> {
    const expectedBytes = chunk.end - chunk.start + 1;
    let lastErr: Error | undefined;

    for (let attempt = 0; attempt < CHUNK_RETRY_COUNT; attempt++) {
      if (this.aborted || signal.aborted) throw new DOMException('Aborted', 'AbortError');

      const ac = new AbortController();
      this.abortControllers.add(ac);
      const onAbort = () => ac.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) ac.abort();
      let idleTimer = setTimeout(() => ac.abort(), 60_000);

      try {
        this.chunkBytes[chunk.index] = 0;
        const res = await fetch(this.url, {
          signal: ac.signal,
          redirect: "follow",
          headers: {
            Range: `bytes=${chunk.start}-${chunk.end}`,
            ...(this.checkpoint?.validator ? { 'If-Range': this.checkpoint.validator } : {}),
          },
        });

        if (res.status !== 206) {
          await res.body?.cancel();
          if (res.status === 401 || res.status === 403) throw new DownloadURLExpiredError();
          throw new Error(`Chunk ${chunk.index}: HTTP ${res.status}`);
        }
        if (!res.body) {
          throw new Error(`Chunk ${chunk.index}: no body`);
        }
        const contentRange = res.headers.get('content-range');
        if (contentRange && contentRange !== `bytes ${chunk.start}-${chunk.end}/${this.totalSize}`) {
          await res.body.cancel();
          throw new Error('CDN returned a different byte range');
        }

        const ws = fs.createWriteStream(this.destPath, {
          flags: "r+",
          start: chunk.start,
        });
        const reader = res.body.getReader();
        const chunkBytesRef = this.chunkBytes;
        const chunkIndex = chunk.index;
        let chunkDownloaded = 0;

        const readable = new Readable({
          async read() {
            try {
              const { done, value } = await reader.read();
              clearTimeout(idleTimer);
              idleTimer = setTimeout(() => ac.abort(), 60_000);
              if (done) {
                this.push(null);
                return;
              }
              chunkDownloaded += value.byteLength;
              if (chunkDownloaded > expectedBytes) {
                this.destroy(
                  new Error(`Chunk ${chunkIndex}: exceeded expected size`),
                );
                return;
              }
              chunkBytesRef[chunkIndex] = chunkDownloaded;
              this.push(Buffer.from(value));
            } catch (err) {
              this.destroy(err instanceof Error ? err : new Error(String(err)));
            }
          },
        });

        try {
          await pipeline(readable, ws);
        } catch (error) {
          // Only complete, length-checked ranges are retained as checkpoints.
          this.chunkBytes[chunk.index] = 0;
          throw error;
        }
        if (chunkDownloaded !== expectedBytes) {
          throw new Error(
            `Chunk ${chunk.index}: expected ${expectedBytes} bytes, received ${chunkDownloaded}`,
          );
        }
        return; // success
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (lastErr.name === "AbortError" || this.aborted || lastErr instanceof DownloadURLExpiredError) throw lastErr;
        if (attempt < CHUNK_RETRY_COUNT - 1) {
          await new Promise((r) => setTimeout(r, CHUNK_RETRY_DELAY_MS));
        }
      } finally {
        clearTimeout(idleTimer);
        signal.removeEventListener("abort", onAbort);
        this.abortControllers.delete(ac);
      }
    }

    throw lastErr ?? new Error(`Chunk ${chunk.index} failed after retries`);
  }

  private cleanDestination(): void {
    try {
      if (fs.existsSync(this.destPath)) fs.unlinkSync(this.destPath);
    } catch {
      // best-effort cleanup
    }
  }

  /** Single-stream fallback download. */
  private async downloadSingleStream(signal: AbortSignal): Promise<void> {
    const res = await fetch(this.url, { signal, redirect: "follow" });
    if (!res.ok) {
      await res.body?.cancel();
      if (res.status === 401 || res.status === 403) throw new DownloadURLExpiredError();
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    if (!res.body) throw new Error("No response body");

    const contentLength = parseInt(
      res.headers.get("content-length") || "0",
      10,
    );
    if (contentLength > MAX_DOWNLOAD_SIZE) {
      throw new Error(
        `File too large: ${contentLength} bytes exceeds ${MAX_DOWNLOAD_SIZE} byte limit`,
      );
    }

    this.totalSize = contentLength;
    let downloaded = 0;
    let lastTime = Date.now();
    let lastBytes = 0;

    const ws = fs.createWriteStream(this.destPath);
    const reader = res.body.getReader();

    const readable = new Readable({
      async read() {
        try {
          const { done, value } = await reader.read();
          if (done) {
            this.push(null);
            return;
          }
          downloaded += value.byteLength;
          if (downloaded > MAX_DOWNLOAD_SIZE) {
            this.destroy(new Error("Download exceeded maximum size"));
            return;
          }
          this.push(Buffer.from(value));
        } catch (err) {
          this.destroy(err instanceof Error ? err : new Error(String(err)));
        }
      },
    });

    const progressInterval = setInterval(() => {
      const now = Date.now();
      const elapsed = now - lastTime;
      if (elapsed >= 500) {
        const bytesPerSec = ((downloaded - lastBytes) / elapsed) * 1000;
        lastTime = now;
        lastBytes = downloaded;
        this.onProgress?.({
          downloaded,
          total: this.totalSize,
          speed: formatSpeed(bytesPerSec),
        });
      }
    }, 500);

    try {
      await pipeline(readable, ws);
    } finally {
      clearInterval(progressInterval);
    }

    this.onProgress?.({ downloaded, total: this.totalSize, speed: "0 B/s" });
  }

  /**
   * Execute the download.
   * Probes for Range support, then either downloads in parallel chunks
   * or falls back to single-stream.
   */
  async download(signal: AbortSignal): Promise<void> {
    this.aborted = false;
    this.paused = false;
    let supportsRange = false;
    let contentLength = 0;
    let validator = '';
    try {
      const probeResult = await this.probe(signal);
      supportsRange = probeResult.supportsRange;
      contentLength = probeResult.contentLength;
      validator = probeResult.validator;
    } catch (error) {
      if (error instanceof DownloadURLExpiredError || signal.aborted) throw error;
      // HEAD failed — fall back to single-stream
    }

    if (contentLength > MAX_DOWNLOAD_SIZE) {
      throw new Error(
        `File too large: ${contentLength} bytes exceeds ${MAX_DOWNLOAD_SIZE} byte limit`,
      );
    }

    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!supportsRange) {
      this.checkpoint = undefined;
      try {
        await this.downloadSingleStream(signal);
      } catch (error) {
        this.cleanDestination();
        throw error;
      }
      return;
    }

    this.totalSize = contentLength;
    const reusable = Boolean(validator && this.checkpoint?.size === contentLength &&
      this.checkpoint.validator === validator && fs.existsSync(this.destPath) &&
      fs.statSync(this.destPath).size === contentLength);
    const chunks = reusable ? this.checkpoint!.chunks : this.splitChunks(contentLength);
    if (!reusable) this.chunkBytes = new Array(chunks.length).fill(0);
    this.checkpoint = { size: contentLength, validator, chunks };

    // Preallocate the final IPA. Range workers write directly to their own
    // offsets, eliminating the previous full-file merge and duplicate disk IO.
    const file = await fs.promises.open(this.destPath, reusable ? 'r+' : 'w');
    try {
      await file.truncate(contentLength);
    } finally {
      await file.close();
    }

    this.lastProgressTime = Date.now();
    this.lastProgressBytes = this.chunkBytes.reduce((sum, bytes) => sum + bytes, 0);
    this.onProgress?.({ downloaded: this.lastProgressBytes, total: contentLength, speed: '0 B/s' });
    const progressInterval = setInterval(() => {
      const now = Date.now();
      const totalDownloaded = this.chunkBytes.reduce((a, b) => a + b, 0);
      const elapsed = now - this.lastProgressTime;

      let speed = "0 B/s";
      if (elapsed > 0) {
        const bytesPerSec =
          ((totalDownloaded - this.lastProgressBytes) / elapsed) * 1000;
        speed = formatSpeed(bytesPerSec);
      }
      this.lastProgressTime = now;
      this.lastProgressBytes = totalDownloaded;

      this.onProgress?.({
        downloaded: totalDownloaded,
        total: this.totalSize,
        speed,
      });
    }, 500);

    try {
      let nextChunkIndex = 0;
      const worker = async () => {
        while (true) {
          const index = nextChunkIndex++;
          if (index >= chunks.length) return;
          if (this.chunkBytes[index] === chunks[index].end - chunks[index].start + 1) continue;
          await this.downloadChunk(chunks[index], signal);
        }
      };
      const workers = Array.from(
          { length: Math.min(this.threads, chunks.length) },
          () => worker(),
        );
      try { await Promise.all(workers); }
      catch (error) {
        // Close every writer before a resume may reuse this file.
        for (const controller of this.abortControllers) controller.abort();
        await Promise.allSettled(workers);
        throw error;
      }

      clearInterval(progressInterval);

      this.onProgress?.({
        downloaded: this.totalSize,
        total: this.totalSize,
        speed: "0 B/s",
      });
    } catch (err) {
      clearInterval(progressInterval);
      this.aborted = true;
      for (const controller of this.abortControllers) controller.abort();
      this.abortControllers.clear();
      if (!this.paused && !(err instanceof DownloadURLExpiredError)) {
        this.checkpoint = undefined; this.cleanDestination();
      }
      throw err;
    }
  }

  /** Abort all active connections and clean up temporary files. */
  pause(): void {
    this.paused = true;
    this.aborted = true;
    for (const controller of this.abortControllers) controller.abort();
  }

  replaceURL(url: string): void { this.url = url; }

  abort(): void {
    this.checkpoint = undefined;
    this.aborted = true;
    for (const ac of this.abortControllers) {
      try {
        ac.abort();
      } catch {
        // ignore
      }
    }
    this.abortControllers.clear();

    this.cleanDestination();
  }
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1024 * 1024)
    return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}
