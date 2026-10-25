import { describe, expect, it, vi } from "vitest";
import { PurchaseError, type PurchaseResult } from "../../src/apple/purchase";
import { VersionHistoryError } from "../../src/apple/versionFinder";
import {
  listVersionsWithLicense,
  purchaseWithTokenRefresh,
} from "../../src/hooks/useDownloadAction";
import type { Account, Software } from "../../src/types";

vi.mock("../../src/apple/request", () => ({ appleRequest: vi.fn() }));

const account = {
  email: "test@example.com",
  password: "password",
  cookies: [],
  deviceIdentifier: "AABBCCDDEEFF",
  passwordToken: "old-token",
} as unknown as Account;
const app = { id: 123, name: "Test" } as Software;
const purchased: PurchaseResult = {
  status: "acquired",
  updatedCookies: [
    {
      name: "session",
      value: "new",
      path: "/",
      httpOnly: true,
      secure: true,
    },
  ],
};

describe("purchaseWithTokenRefresh", () => {
  it('shares a single renewal when two actions discover the same expired session', async () => {
    const renewed = { ...account, passwordToken: 'fresh-token' };
    const renew = vi.fn().mockResolvedValue(renewed);
    const save = vi.fn().mockResolvedValue(undefined);
    const purchase = vi.fn(async (current: Account) => {
      if (current.passwordToken === account.passwordToken) throw new PurchaseError('expired', '2034');
      return purchased;
    });
    const results = await Promise.all([
      purchaseWithTokenRefresh(account, app, save, { purchase, renew }),
      purchaseWithTokenRefresh(account, app, save, { purchase, renew }),
    ]);
    expect(renew).toHaveBeenCalledOnce();
    expect(results.every((result) => result.updatedAccount?.passwordToken === 'fresh-token')).toBe(true);
  });
  it("uses a valid password token without authenticating again", async () => {
    const purchase = vi.fn().mockResolvedValue(purchased);
    const renew = vi.fn();
    const updateAccount = vi.fn().mockResolvedValue(undefined);

    await expect(
      purchaseWithTokenRefresh(account, app, updateAccount, {
        purchase,
        renew,
      }),
    ).resolves.toMatchObject(purchased);

    expect(purchase).toHaveBeenCalledOnce();
    expect(renew).not.toHaveBeenCalled();
    expect(updateAccount).toHaveBeenCalledOnce();
    expect(updateAccount).toHaveBeenCalledWith({
      ...account,
      cookies: purchased.updatedCookies,
    }, account);
  });

  it.each(["2034", "2042"])(
    "renews and retries once after Apple reports expired token %s",
    async (code) => {
      const renewed = { ...account, passwordToken: "renewed-token" };
      const purchase = vi
        .fn()
        .mockRejectedValueOnce(new PurchaseError("expired", code))
        .mockResolvedValueOnce(purchased);
      const renew = vi.fn().mockResolvedValue(renewed);
      const updateAccount = vi.fn().mockResolvedValue(undefined);

      await expect(
        purchaseWithTokenRefresh(account, app, updateAccount, {
          purchase,
          renew,
        }),
      ).resolves.toMatchObject(purchased);

      expect(purchase).toHaveBeenNthCalledWith(1, account, app);
      expect(renew).toHaveBeenCalledWith(
        account.email,
        account.password,
        undefined,
        account.cookies,
        account.deviceIdentifier,
      );
      expect(purchase).toHaveBeenNthCalledWith(2, renewed, app);
      expect(updateAccount).toHaveBeenNthCalledWith(1, renewed, account);
      expect(updateAccount).toHaveBeenNthCalledWith(2, {
        ...renewed,
        cookies: purchased.updatedCookies,
      }, renewed);
    },
  );

  it("does not hide unrelated purchase errors", async () => {
    const error = new PurchaseError("unavailable", "2059");
    const purchase = vi.fn().mockRejectedValue(error);
    const renew = vi.fn();
    const updateAccount = vi.fn().mockResolvedValue(undefined);

    await expect(
      purchaseWithTokenRefresh(account, app, updateAccount, {
        purchase,
        renew,
      }),
    ).rejects.toBe(error);

    expect(renew).not.toHaveBeenCalled();
    expect(updateAccount).not.toHaveBeenCalled();
  });
});

describe("listVersionsWithLicense", () => {
  it.each(['2034', '2042'])('renews an expired version session %s exactly once and preserves its new token', async (code) => {
    const renewed = { ...account, passwordToken: 'new-token', pod: '30' };
    const list = vi.fn().mockRejectedValueOnce(new VersionHistoryError('expired', code))
      .mockResolvedValueOnce({ versions: ['123'], updatedCookies: purchased.updatedCookies });
    const session = { renew: vi.fn().mockResolvedValue(renewed), updateAccount: vi.fn().mockResolvedValue(undefined) };
    const result = await listVersionsWithLicense(account, app, vi.fn(), list, session);
    expect(session.renew).toHaveBeenCalledOnce();
    expect(list).toHaveBeenNthCalledWith(2, renewed, app);
    expect(result.updatedAccount).toMatchObject({ passwordToken: 'new-token', pod: '30', cookies: purchased.updatedCookies });
    expect(session.updateAccount).toHaveBeenLastCalledWith(result.updatedAccount, renewed);
  });

  it('does not loop when refreshed credentials are rejected again', async () => {
    const error = new VersionHistoryError('expired', '2034');
    const list = vi.fn().mockRejectedValue(error);
    const session = { renew: vi.fn().mockResolvedValue(account), updateAccount: vi.fn().mockResolvedValue(undefined) };
    await expect(listVersionsWithLicense(account, app, vi.fn(), list, session)).rejects.toBe(error);
    expect(session.renew).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('does not treat an unclassified HTTP 403 as permission to repeatedly sign in', async () => {
    const error = new VersionHistoryError('HTTP 403', 'HTTP_403');
    const session = { renew: vi.fn(), updateAccount: vi.fn() };
    await expect(listVersionsWithLicense(account, app, vi.fn(), vi.fn().mockRejectedValue(error), session)).rejects.toBe(error);
    expect(session.renew).not.toHaveBeenCalled();
  });

  it('uses a renewed purchase session instead of restoring its expired snapshot', async () => {
    const renewed = { ...account, passwordToken: 'new-token', pod: '30', cookies: purchased.updatedCookies };
    const list = vi.fn().mockRejectedValueOnce(new VersionHistoryError('license required', '9610'))
      .mockResolvedValueOnce({ versions: ['123'], updatedCookies: purchased.updatedCookies });
    const acquire = vi.fn().mockResolvedValue({ ...purchased, updatedAccount: renewed });
    const result = await listVersionsWithLicense(account, app, acquire, list);
    expect(list).toHaveBeenNthCalledWith(2, renewed, app);
    expect(result.updatedAccount.passwordToken).toBe('new-token');
  });
  it("acquires a free app license and retries version history once", async () => {
    const licenseRequired = new VersionHistoryError("license required", "9610");
    const list = vi
      .fn()
      .mockRejectedValueOnce(licenseRequired)
      .mockResolvedValueOnce({ versions: ["123"], updatedCookies: purchased.updatedCookies });
    const acquireLicense = vi.fn().mockResolvedValue(purchased);

    await expect(
      listVersionsWithLicense(account, app, acquireLicense, list),
    ).resolves.toMatchObject({ versions: ["123"] });

    expect(acquireLicense).toHaveBeenCalledOnce();
    expect(list).toHaveBeenNthCalledWith(2, {
      ...account,
      cookies: purchased.updatedCookies,
    }, app);
  });

  it("does not acquire a license for unrelated errors", async () => {
    const error = new Error("network failed");
    const list = vi.fn().mockRejectedValue(error);
    const acquireLicense = vi.fn();

    await expect(
      listVersionsWithLicense(account, app, acquireLicense, list),
    ).rejects.toBe(error);
    expect(acquireLicense).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledOnce();
  });

  it("does not attempt automatic purchase for paid apps", async () => {
    const paidApp = { ...app, price: 1 };
    const error = new VersionHistoryError("license required", "9610");
    const list = vi.fn().mockRejectedValue(error);
    const acquireLicense = vi.fn();

    await expect(
      listVersionsWithLicense(account, paidApp, acquireLicense, list),
    ).rejects.toBe(error);
    expect(acquireLicense).not.toHaveBeenCalled();
  });
});
