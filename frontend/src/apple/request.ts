import { libcurl,initLibcurl } from "./libcurl-init";
import { buildCookieHeader } from "./cookies";
import { userAgent } from "./config";
import i18n from '../i18n';
import { requestScope,throwIfAborted,waitFor } from '../utils/abort';
import type { Cookie } from "../types";

export interface AppleRequestOptions {
  host: string;
  path: string;
  method: string;
  headers?: Record<string,string>;
  body?: string;
  cookies?: Cookie[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AppleResponse {
  status: number;
  statusText: string;
  headers: Record<string,string>;
  rawHeaders: [string,string][];
  body: string;
}

export async function appleRequest(
  opts: AppleRequestOptions,
): Promise<AppleResponse> {
  const scope=requestScope(opts.signal,opts.timeoutMs??30_000);
  try {
    throwIfAborted(scope.signal);
    await waitFor(initLibcurl(),scope.signal);
    throwIfAborted(scope.signal);

    const url=`https://${opts.host}${opts.path}`;
    const headers: Record<string,string>={
      "User-Agent": userAgent,
      ...opts.headers,
    };

    if(opts.cookies?.length) {
      const cookieHeader=buildCookieHeader(opts.cookies,url);
      if(cookieHeader) {
        headers["Cookie"]=cookieHeader;
      }
    }

    const resp=await libcurl.fetch(url,{
      method: opts.method,
      headers,
      body: opts.body,
      redirect: "manual",
      _libcurl_http_version: 1.1,
      signal: scope.signal,
    });

    const responseHeaders: Record<string,string>={};
    for(const [key,value] of resp.raw_headers) {
      responseHeaders[key.toLowerCase()]=value;
    }

    const body=await resp.text();

    return {
      status: resp.status,
      statusText: resp.statusText,
      headers: responseHeaders,
      rawHeaders: resp.raw_headers,
      body,
    };
  } catch(error) {
    if(scope.signal.aborted) {
      if(opts.signal?.aborted) throw opts.signal.reason??new DOMException('Cancelled','AbortError');
      throw new DOMException(i18n.t('errors.messages.timedOut'),'TimeoutError');
    }
    throw error;
  } finally {
    scope.dispose();
  }
}
