import { apiPost } from "../api/client";
import type { SAPConfiguration } from "./bag";

interface SAPSignResponse {
  signature: string;
}

function base64FromString(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export async function signSAPAction(
  guid: string,
  configuration: SAPConfiguration,
  body: string,
): Promise<string> {
  const result = await apiPost<SAPSignResponse>("/api/sap/sign", {
    guid,
    setupURL: configuration.setupURL,
    certificateURL: configuration.certificateURL,
    version: configuration.version,
    body: base64FromString(body),
  });
  if (typeof result.signature !== "string" || !result.signature) {
    throw new Error("SAP signer returned an invalid signature");
  }
  return result.signature;
}
