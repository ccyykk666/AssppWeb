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
  it("uses a valid password token without authenticating again", async () => {
    const purchase = vi.fn().mockResolvedValue(purchased);
    const renew = vi.fn();
    const updateAccount = vi.fn().mockResolvedValue(undefined);

    await expect(
      purchaseWithTokenRefresh(account, app, updateAccount, {
        purchase,
        renew,
      }),
    ).resolves.toBe(purchased);

    expect(purchase).toHaveBeenCalledOnce();
    expect(renew).not.toHaveBeenCalled();
    expect(updateAccount).toHaveBeenCalledOnce();
    expect(updateAccount).toHaveBeenCalledWith({
      ...account,
      cookies: purchased.updatedCookies,
    });
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
      ).resolves.toBe(purchased);

      expect(purchase).toHaveBeenNthCalledWith(1, account, app);
      expect(renew).toHaveBeenCalledWith(
        account.email,
        account.password,
        undefined,
        account.cookies,
        account.deviceIdentifier,
      );
      expect(purchase).toHaveBeenNthCalledWith(2, renewed, app);
      expect(updateAccount).toHaveBeenNthCalledWith(1, renewed);
      expect(updateAccount).toHaveBeenNthCalledWith(2, {
        ...renewed,
        cookies: purchased.updatedCookies,
      });
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
