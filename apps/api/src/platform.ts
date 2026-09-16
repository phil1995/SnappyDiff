export interface D1Result<T = Record<string, unknown>> {
  results?: T[];
  success: boolean;
  meta?: Record<string, unknown>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(): Promise<T[]>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

export interface R2Bucket {
  get(key: string): Promise<unknown | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | string, options?: unknown): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
}

export interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  ASSETS: Fetcher;
  APP_ENV: "local" | "staging" | "production";
  APP_ORIGIN: string;
  WORKOS_CLIENT_ID: string;
  WORKOS_REDIRECT_URI: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_SLUG: string;
  WORKOS_API_KEY?: string;
  WORKOS_WEBHOOK_SECRET?: string;
  WORKOS_COOKIE_PASSWORD?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  TOKEN_PEPPER?: string;
}
