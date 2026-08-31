import { spawn, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import { config } from "../config.js";

const START_TIMEOUT_MS = 15_000;
const SIGN_TIMEOUT_MS = 10 * 60 * 1000;
const HEALTH_RETRY_MS = 100;

export interface SAPSignInput {
  guid: string;
  setupURL: string;
  certificateURL: string;
  version: number;
  body: string;
}

interface SAPSignOutput {
  signature?: unknown;
}

let signerProcess: ChildProcess | undefined;
let startPromise: Promise<void> | undefined;
const internalToken = randomBytes(32).toString("hex");

export function signerBaseURL(
  address: string = config.sapSignerAddress,
): string {
  const url = new URL(`http://${address}`);
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (
    !loopbackHosts.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('SAP signer address must be loopback-only');
  }
  return url.origin;
}

async function signerHealthOK(): Promise<boolean> {
  try {
    const response = await fetch(`${signerBaseURL()}/healthz`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForSigner(): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await signerHealthOK()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_RETRY_MS));
  }
  throw new Error("bundled SAP signer did not become ready");
}

async function startSigner(): Promise<void> {
  if (await signerHealthOK()) {
    return;
  }
  if (!config.sapSignerBinary) {
    throw new Error("bundled SAP signer is not configured");
  }

  signerProcess = spawn(config.sapSignerBinary, [], {
    env: {
      ...process.env,
      ASSPSAP_ADDR: config.sapSignerAddress,
      ASSPSAP_TOKEN: internalToken,
    },
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  signerProcess.once("exit", () => {
    signerProcess = undefined;
    startPromise = undefined;
  });
  signerProcess.once("error", () => {
    signerProcess = undefined;
    startPromise = undefined;
  });

  await waitForSigner();
}

async function ensureSigner(): Promise<void> {
  if (!startPromise) {
    startPromise = startSigner().catch((error) => {
      startPromise = undefined;
      throw error;
    });
  }
  await startPromise;
}

export async function signSAPAction(input: SAPSignInput): Promise<string> {
  await ensureSigner();

  const response = await fetch(`${signerBaseURL()}/v1/sign`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${internalToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(SIGN_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`SAP signer returned HTTP ${response.status}`);
  }

  const result = (await response.json()) as SAPSignOutput;
  if (typeof result.signature !== "string" || !result.signature) {
    throw new Error("SAP signer returned an invalid signature");
  }
  return result.signature;
}

export function stopSAPSigner(): void {
  if (signerProcess && !signerProcess.killed) {
    signerProcess.kill();
  }
  signerProcess = undefined;
  startPromise = undefined;
}

process.once("exit", stopSAPSigner);
