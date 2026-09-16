export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface RequestContext {
  requestId: string;
  startedAt: number;
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export async function readJson<T>(request: Request, maxBytes = 64 * 1024): Promise<T> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > maxBytes) throw new HttpError(413, "payload_too_large", "Request body is too large");
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maxBytes) {
    throw new HttpError(413, "payload_too_large", "Request body is too large");
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON");
  }
}

export function errorResponse(error: unknown, requestId: string): Response {
  if (error instanceof HttpError) {
    return json({ error: { code: error.code, message: error.message, details: error.details }, requestId }, { status: error.status });
  }
  console.error(JSON.stringify({ level: "error", requestId, message: "Unhandled request error", error: String(error) }));
  return json({ error: { code: "internal_error", message: "An unexpected error occurred" }, requestId }, { status: 500 });
}

export function withRequestId(response: Response, context: RequestContext): Response {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", context.requestId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
