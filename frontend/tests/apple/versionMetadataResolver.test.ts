import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCachedVersionMetadata, putCachedVersionMetadata } from "../../src/apple/versionMetadataCache";
import { getVersionMetadata } from "../../src/apple/versionLookup";
import { resolveVersionMetadata } from "../../src/apple/versionMetadataResolver";
import type { Account, Software, VersionMetadata } from "../../src/types";

vi.mock("../../src/apple/versionMetadataCache", () => ({
  getCachedVersionMetadata: vi.fn(),
  putCachedVersionMetadata: vi.fn(),
}));
vi.mock("../../src/apple/versionLookup", () => ({
  getVersionMetadata: vi.fn(),
}));
vi.mock('../../src/apple/accountSession', () => ({ currentAccount: (account: Account) => account }));

const account = {
  email: "cache@example.com",
  cookies: [],
} as unknown as Account;
const app = { id: 123 } as Software;
const metadata: VersionMetadata = {
  displayVersion: "2.0",
  releaseDate: "2026-10-01T00:00:00.000Z",
};

describe("version metadata resolver", () => {
  it('lets a second CDN lookup finish while the first lookup remains slow', async () => {
    vi.mocked(getCachedVersionMetadata).mockResolvedValue(undefined);
    let finish!: (result: { metadata: VersionMetadata; updatedCookies: [] }) => void;
    vi.mocked(getVersionMetadata)
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce({ metadata, updatedCookies: [] });
    const slow = resolveVersionMetadata(account, app, 'slow');
    const fast = resolveVersionMetadata(account, app, 'fast');
    await expect(fast).resolves.toMatchObject({ metadata });
    finish({ metadata, updatedCookies: [] });
    await slow;
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(putCachedVersionMetadata).mockResolvedValue(undefined);
  });

  it("returns a cached historical version without contacting Apple", async () => {
    vi.mocked(getCachedVersionMetadata).mockResolvedValue(metadata);

    await expect(resolveVersionMetadata(account, app, "456")).resolves.toEqual({
      metadata,
      updatedCookies: [],
    });
    expect(getVersionMetadata).not.toHaveBeenCalled();
  });

  it("deduplicates an uncached request and stores the resolved metadata", async () => {
    vi.mocked(getCachedVersionMetadata).mockResolvedValue(undefined);
    vi.mocked(getVersionMetadata).mockResolvedValue({
      metadata,
      updatedCookies: [],
    });

    const [first, second] = await Promise.all([
      resolveVersionMetadata(account, app, "new-version"),
      resolveVersionMetadata(account, app, "new-version"),
    ]);

    expect(first.metadata).toEqual(metadata);
    expect(second.metadata).toEqual(metadata);
    expect(getVersionMetadata).toHaveBeenCalledTimes(1);
    expect(putCachedVersionMetadata).toHaveBeenCalledWith(
      app,
      "new-version",
      metadata,
    );
  });
});
