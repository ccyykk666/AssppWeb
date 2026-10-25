import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChunkedDownloader, DownloadURLExpiredError } from "../src/services/chunkedDownloader.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.promises.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("ChunkedDownloader", () => {
  it('treats a CDN 403 as an expired link without retrying it as a normal transfer', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    vi.stubGlobal('fetch', fetch);
    const downloader = new ChunkedDownloader('https://cdn.apple.com/expired.ipa', 'unused.ipa');
    await expect(downloader.download(new AbortController().signal)).rejects.toBeInstanceOf(DownloadURLExpiredError);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('resumes completed ranges and waits for aborted writers to close', async () => {
    const source = Buffer.from('abcdefghijklmnopqrstuvwxyz012345');
    const ranges: string[] = [];
    let first = true;
    const controller = new AbortController();
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'asspp-resume-test-'));
    temporaryDirectories.push(directory);
    const destination = path.join(directory, 'package.ipa');
    const downloader = new ChunkedDownloader('https://cdn.apple.com/package.ipa', destination, { threads: 1 });
    // Small synthetic chunks let the test pause after one verified range.
    (downloader as any).splitChunks = () => [
      { index: 0, start: 0, end: 15 }, { index: 1, start: 16, end: 31 },
    ];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { headers: {
        'Accept-Ranges': 'bytes', 'Content-Length': String(source.length), ETag: '"same-package"',
      } });
      const range = new Headers(init?.headers).get('range')!;
      ranges.push(range);
      if (range === 'bytes=16-31' && first) {
        first = false;
        downloader.pause(); controller.abort();
        throw new DOMException('Paused', 'AbortError');
      }
      const [, start, end] = range.match(/bytes=(\d+)-(\d+)/)!;
      return new Response(source.subarray(Number(start), Number(end) + 1), { status: 206 });
    }));
    await expect(downloader.download(controller.signal)).rejects.toThrow();
    expect(fs.existsSync(destination)).toBe(true);
    await downloader.download(new AbortController().signal);
    expect(ranges.filter((r) => r === 'bytes=0-15')).toHaveLength(1);
    await expect(fs.promises.readFile(destination)).resolves.toEqual(source);
  });
  it("writes ranges directly into the final file without part files", async () => {
    const source = Buffer.alloc(1024 * 1024 + 137);
    for (let index = 0; index < source.length; index++) {
      source[index] = index % 251;
    }

    const ranges: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: {
              "Accept-Ranges": "bytes",
              "Content-Length": String(source.length),
            },
          });
        }

        const range = new Headers(init?.headers).get("range");
        const match = range?.match(/^bytes=(\d+)-(\d+)$/);
        if (!match) return new Response(null, { status: 416 });
        ranges.push(range as string);
        const start = Number(match[1]);
        const end = Number(match[2]);
        return new Response(source.subarray(start, end + 1), { status: 206 });
      }),
    );

    const directory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "asspp-chunked-test-"),
    );
    temporaryDirectories.push(directory);
    const destination = path.join(directory, "package.ipa");

    await new ChunkedDownloader("https://cdn.apple.com/package.ipa", destination, {
      threads: 4,
    }).download(new AbortController().signal);

    await expect(fs.promises.readFile(destination)).resolves.toEqual(source);
    expect(ranges).toHaveLength(4);
    await expect(fs.promises.readdir(directory)).resolves.toEqual([
      "package.ipa",
    ]);
  });

  it("removes an incomplete final file when a range fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: {
              "Accept-Ranges": "bytes",
              "Content-Length": String(1024 * 1024),
            },
          });
        }
        return new Response(null, { status: 500 });
      }),
    );

    const directory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "asspp-chunked-test-"),
    );
    temporaryDirectories.push(directory);
    const destination = path.join(directory, "package.ipa");

    await expect(
      new ChunkedDownloader("https://cdn.apple.com/package.ipa", destination, {
        threads: 4,
      }).download(new AbortController().signal),
    ).rejects.toThrow("HTTP 500");
    expect(fs.existsSync(destination)).toBe(false);
  });
});
