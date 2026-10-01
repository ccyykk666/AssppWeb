import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChunkedDownloader } from "../src/services/chunkedDownloader.js";

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
