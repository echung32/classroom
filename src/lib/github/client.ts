const GITHUB_API_BASE = "https://api.github.com";

export interface RateLimitInfo {
  remaining: number | null;
  reset: number | null;
  retryAfterSeconds: number | null;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly rateLimit: RateLimitInfo,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export interface GitHubRequestOptions {
  method?: string;
  token?: string;
  body?: unknown;
  accept?: string;
  fetchImpl?: typeof fetch;
}

export interface GitHubResponse<T> {
  data: T;
  status: number;
  rateLimit: RateLimitInfo;
}

function readRateLimit(headers: Headers): RateLimitInfo {
  const int = (name: string): number | null => {
    const value = headers.get(name);
    return value === null ? null : Number.parseInt(value, 10);
  };
  return {
    remaining: int("x-ratelimit-remaining"),
    reset: int("x-ratelimit-reset"),
    retryAfterSeconds: int("retry-after"),
  };
}

export async function githubRequest<T = unknown>(
  path: string,
  options: GitHubRequestOptions = {},
): Promise<GitHubResponse<T>> {
  const url = path.startsWith("https://") ? path : `${GITHUB_API_BASE}${path}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const method = options.method ?? "GET";

  const headers: Record<string, string> = {
    accept: options.accept ?? "application/vnd.github+json",
    "user-agent": "classroom-worker",
    "x-github-api-version": "2022-11-28",
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";

  const response = await fetchImpl(url, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const rateLimit = readRateLimit(response.headers);
  if (!response.ok) {
    // Body excerpt only; never include auth material in the message.
    const excerpt = (await response.text()).slice(0, 300);
    throw new GitHubApiError(
      `GitHub ${method} ${path} failed with ${response.status}: ${excerpt}`,
      response.status,
      rateLimit,
    );
  }

  const data = response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  return { data, status: response.status, rateLimit };
}
