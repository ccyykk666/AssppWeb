import { appleRequest, type AppleResponse } from "./request";
import { buildPlist, parsePlist } from "./plist";
import { extractAndMergeCookies } from "./cookies";
import { purchaseAPIHost } from "./config";
import i18n from "../i18n";
import type { Account, Software } from "../types";

const LICENSE_ALREADY_EXISTS_FAILURE_TYPE = '5002';

export class PurchaseError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "PurchaseError";
  }
}

export type PurchaseStatus = 'acquired' | 'alreadyOwned';

export interface PurchaseResult {
  updatedCookies: Account['cookies'];
  status: PurchaseStatus;
}

export async function purchaseApp(
  account: Account,
  app: Software,
): Promise<PurchaseResult> {
  if ((app.price ?? 0) > 0) {
    throw new PurchaseError(i18n.t("errors.purchase.paidNotSupported"));
  }

  const preferredParameters = app.primaryGenreId === 6014 ? "GAME" : "STDQ";
  const fallbackParameters = preferredParameters === "GAME" ? "STDQ" : "GAME";
  try {
    return await purchaseWithParams(account, app, preferredParameters);
  } catch (e) {
    // Rely on error code instead of translated message string to prevent matching issues
    if (e instanceof PurchaseError && e.code === "2059") {
      return await purchaseWithParams(account, app, fallbackParameters);
    }
    throw e;
  }
}

async function purchaseWithParams(
  account: Account,
  app: Software,
  pricingParameters: string,
): Promise<PurchaseResult> {
  const deviceId = account.deviceIdentifier;
  const host = purchaseAPIHost(account.pod);
  const path = "/WebObjects/MZFinance.woa/wa/buyProduct";

  const payload: Record<string, any> = {
    appExtVrsId: "0",
    hasAskedToFulfillPreorder: "true",
    buyWithoutAuthorization: "true",
    hasDoneAgeCheck: "true",
    guid: deviceId,
    needDiv: "0",
    origPage: `Software-${app.id}`,
    origPageLocation: "Buy",
    price: "0",
    pricingParameters,
    productType: "C",
    salableAdamId: app.id,
  };

  const plistBody = buildPlist(payload);

  const headers: Record<string, string> = {
    "Content-Type": "application/x-apple-plist",
    "iCloud-DSID": account.directoryServicesIdentifier,
    "X-Dsid": account.directoryServicesIdentifier,
    "X-Apple-Store-Front": `${account.store}-1`,
    "X-Token": account.passwordToken,
  };

  let cookies = account.cookies;
  let response: AppleResponse | undefined;
  let dict: Record<string, any> | undefined;
  // Free license acquisition is idempotent (5002 means already owned).
  // Retry a temporary edge error once, never a valid Apple business response.
  for (let attempt = 0; attempt < 2; attempt++) {
    response = await appleRequest({
      method: 'POST', host, path, headers, body: plistBody, cookies,
    });
    cookies = extractAndMergeCookies(response.rawHeaders, cookies);
    try {
      const value = parsePlist(response.body);
      dict = value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
    } catch {
      dict = undefined;
    }
    const edgeFailure = response.status === 404 || response.status === 429 || response.status >= 500;
    if (attempt === 0 && edgeFailure && !dict) {
      // Do not retry sooner than an explicit server-requested delay. Longer
      // rate limits are reported to the user rather than blocking the control.
      const retryAfter = response.headers['retry-after'];
      const delay = retryAfter ? Number(retryAfter) * 1000 : 1000;
      if (Number.isFinite(delay) && delay >= 0 && delay <= 3000) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(delay, 1000)));
        continue;
      }
    }
    break;
  }

  if (!response || response.status !== 200) {
    const status = response?.status ?? 0;
    throw new PurchaseError(i18n.t('errors.purchase.httpFailed', { status }), `HTTP_${status}`);
  }
  if (!dict) {
    throw new PurchaseError(i18n.t('errors.purchase.invalidResponse'), 'INVALID_RESPONSE');
  }

  const updatedCookies = cookies;

  if (dict.failureType) {
    const failureType = String(dict.failureType);
    const customerMessage = dict.customerMessage as string | undefined;
    switch (failureType) {
      case LICENSE_ALREADY_EXISTS_FAILURE_TYPE:
        return { updatedCookies, status: 'alreadyOwned' };
      case "2059":
        throw new PurchaseError(i18n.t("errors.purchase.unavailable"), "2059");
      case "2034":
      case "2042":
        throw new PurchaseError(
          i18n.t("errors.purchase.passwordExpired"),
          failureType,
        );
      default: {
        if (customerMessage === "Your password has changed.") {
          throw new PurchaseError(
            i18n.t("errors.purchase.passwordExpired"),
            failureType,
          );
        }
        if (customerMessage === "Subscription Required") {
          throw new PurchaseError(
            i18n.t("errors.purchase.subscriptionRequired"),
            failureType,
          );
        }
        // Check for terms page action
        const action = dict.action as Record<string, any> | undefined;
        if (action) {
          const actionUrl = (action.url || action.URL) as string | undefined;
          if (actionUrl && actionUrl.endsWith("termsPage")) {
            throw new PurchaseError(
              i18n.t("errors.purchase.termsRequired", { url: actionUrl }),
              failureType,
            );
          }
        }

        // Handle unknown error specific fallback mappings
        let msg = customerMessage;
        if (
          msg === "An unknown error has occurred" ||
          msg === "An unknown error has occurred."
        ) {
          msg = i18n.t("errors.purchase.unknownError");
        }

        throw new PurchaseError(
          msg ?? i18n.t("errors.purchase.failed", { failureType }),
          failureType,
        );
      }
    }
  }

  const jingleDocType = dict.jingleDocType as string | undefined;
  const status = dict.status as number | undefined;

  if (jingleDocType !== "purchaseSuccess" || status !== 0) {
    throw new PurchaseError(i18n.t("errors.purchase.failedGeneral"));
  }

  return { updatedCookies, status: 'acquired' };
}
