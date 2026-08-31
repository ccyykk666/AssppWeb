import { PassThrough, type Readable } from 'stream';
import bplistParser from 'bplist-parser';
import plist from 'plist';
import { fromReader, Reader } from 'yauzl-promise';
import { validateDownloadURL } from './downloadManager.js';

const RANGE_BLOCK_SIZE = 512 * 1024;
const MAX_RANGE_BYTES = 4 * 1024 * 1024;
const MAX_INFO_PLIST_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export interface IpaVersionMetadata {
  displayVersion: string;
  releaseDate: string;
  releaseDateSource: 'plist' | 'archive';
}

class HttpRangeReader extends Reader {
  private readonly blocks = new Map<number, Promise<Buffer>>();

  constructor(
    private readonly url: string,
    private readonly totalSize: number,
  ) {
    super();
  }

  async _read(start: number, length: number): Promise<Buffer> {
    if (
      length > MAX_RANGE_BYTES ||
      start < 0 ||
      start + length > this.totalSize
    ) {
      throw new Error('Invalid IPA range request');
    }

    const firstBlock = Math.floor(start / RANGE_BLOCK_SIZE) * RANGE_BLOCK_SIZE;
    const end = start + length;
    const chunks: Buffer[] = [];

    for (
      let blockStart = firstBlock;
      blockStart < end;
      blockStart += RANGE_BLOCK_SIZE
    ) {
      chunks.push(await this.getBlock(blockStart));
    }

    const combined = Buffer.concat(chunks);
    const offset = start - firstBlock;
    const result = combined.subarray(offset, offset + length);
    if (result.length !== length) {
      throw new Error('Unexpected end of IPA range');
    }
    return result;
  }

  _createReadStream(start: number, length: number): Readable {
    const stream = new PassThrough();
    void this._read(start, length).then(
      (buffer) => stream.end(buffer),
      (error) => stream.destroy(error as Error),
    );
    return stream;
  }

  async _open(): Promise<{}> {
    return {};
  }

  async _close(): Promise<{}> {
    this.blocks.clear();
    return {};
  }

  private getBlock(start: number): Promise<Buffer> {
    let request = this.blocks.get(start);
    if (!request) {
      const length = Math.min(RANGE_BLOCK_SIZE, this.totalSize - start);
      request = fetchRange(this.url, start, length);
      this.blocks.set(start, request);
    }
    return request;
  }
}

async function fetchRange(
  url: string,
  start: number,
  length: number,
): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/octet-stream',
        'Accept-Encoding': 'identity',
        Range: `bytes=${start}-${start + length - 1}`,
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    if (response.status !== 206) {
      await response.body?.cancel();
      throw new Error(
        `Apple CDN did not honor range request (${response.status})`,
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length !== length) {
      throw new Error('Apple CDN returned an incomplete range');
    }
    return buffer;
  } finally {
    clearTimeout(timeout);
  }
}

async function probeSize(url: string): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/octet-stream',
        'Accept-Encoding': 'identity',
        Range: 'bytes=0-0',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    try {
      if (response.status !== 206) {
        throw new Error(`Apple CDN did not honor size probe (${response.status})`);
      }
      const contentRange = response.headers.get('content-range');
      const match = contentRange?.match(/^bytes\s+0-0\/(\d+)$/i);
      const totalSize = match ? Number(match[1]) : Number.NaN;
      if (!Number.isSafeInteger(totalSize) || totalSize <= 0) {
        throw new Error('Apple CDN returned an invalid IPA size');
      }
      return totalSize;
    } finally {
      await response.body?.cancel();
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function streamToBuffer(
  stream: Readable,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      stream.destroy();
      throw new Error('Info.plist is too large');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseInfoPlist(buffer: Buffer): Record<string, unknown> {
  if (buffer.subarray(0, 6).toString('ascii') === 'bplist') {
    const parsed = bplistParser.parseBuffer(buffer)[0];
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Invalid binary Info.plist');
    }
    return parsed as Record<string, unknown>;
  }

  const parsed = plist.parse(buffer.toString('utf8'));
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid XML Info.plist');
  }
  return parsed as Record<string, unknown>;
}

function normalizeReleaseDate(value: unknown): string | null {
  let date: Date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    date = new Date(value < 10_000_000_000 ? value * 1000 : value);
  } else if (typeof value === 'string' && value.trim()) {
    date = new Date(value);
  } else {
    return null;
  }
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function readVersionMetadataFromIpa(
  downloadUrl: string,
): Promise<IpaVersionMetadata> {
  validateDownloadURL(downloadUrl);
  const totalSize = await probeSize(downloadUrl);
  const reader = new HttpRangeReader(downloadUrl, totalSize);
  const zip = await fromReader(reader, totalSize);

  try {
    for await (const entry of zip) {
      const parts = entry.filename.split('/');
      const isMainInfoPlist =
        parts.length === 3 &&
        parts[0] === 'Payload' &&
        parts[1].endsWith('.app') &&
        parts[2] === 'Info.plist';
      if (!isMainInfoPlist) continue;

      if (entry.uncompressedSize > MAX_INFO_PLIST_BYTES) {
        throw new Error('Info.plist is too large');
      }
      const info = parseInfoPlist(
        await streamToBuffer(await entry.openReadStream(), MAX_INFO_PLIST_BYTES),
      );
      const displayVersion = String(
        info.CFBundleShortVersionString ?? info.bundleShortVersionString ?? '',
      ).trim();
      if (!displayVersion) {
        throw new Error('Info.plist has no display version');
      }

      const plistDate = normalizeReleaseDate(
        info.releaseDate ?? info.ReleaseDate,
      );
      return {
        displayVersion,
        releaseDate: plistDate ?? entry.getLastMod().toISOString(),
        releaseDateSource: plistDate ? 'plist' : 'archive',
      };
    }
    throw new Error('IPA has no main application Info.plist');
  } finally {
    await zip.close();
  }
}
