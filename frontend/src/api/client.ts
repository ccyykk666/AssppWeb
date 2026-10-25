import { getAccessToken } from "../components/Auth/PasswordGate";
import { requestScope } from '../utils/abort';

const BASE_URL="";

async function responseError(res: Response): Promise<Error> {
  const text=await res.text();
  try {
    const payload=JSON.parse(text);
    if(typeof payload.error==='string') return new Error(payload.error);
  } catch {
    // Keep plain-text server errors, but avoid displaying proxy HTML pages.
  }
  return new Error(text.trim().startsWith('<')||!text.trim()
    ? `HTTP ${res.status}: ${res.statusText}`
    :text);
}

export function authHeaders(): Record<string,string> {
  const token=getAccessToken();
  return token? { "X-Access-Token": token }:{};
}

export async function apiGet<T>(path: string,signal?: AbortSignal): Promise<T> {
  const scope=requestScope(signal);
  try {
    const res=await fetch(`${BASE_URL}${path}`,{
      headers: authHeaders(),
      signal: scope.signal,
    });
    if(!res.ok) throw await responseError(res);
    return await res.json();
  } finally { scope.dispose(); }
}

export async function apiPost<T>(path: string,body?: any,signal?: AbortSignal,timeoutMs=30_000): Promise<T> {
  const scope=requestScope(signal,timeoutMs);
  try {
    const res=await fetch(`${BASE_URL}${path}`,{
      method: "POST",
      headers: { "Content-Type": "application/json",...authHeaders() },
      body: body? JSON.stringify(body):undefined,
      signal: scope.signal,
    });
    if(!res.ok) throw await responseError(res);
    return await res.json();
  } finally { scope.dispose(); }
}

export async function apiDelete(path: string): Promise<void> {
  const res=await fetch(`${BASE_URL}${path}`,{
    method: "DELETE",
    headers: authHeaders(),
  });
  if(!res.ok) throw await responseError(res);
}
