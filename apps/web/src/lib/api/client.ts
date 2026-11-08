import type {
  Anchor,
  CloudDetail,
  CreateMessageRequest,
  CreateCloudRequest,
  Cloud,
  Message,
  SkyData,
  VoteState,
} from "@/lib/contracts";
import type { PostingStreak } from "@/lib/contracts/generated";
import { browserTimeZone } from "@/lib/auth/useAnonymousSession";

/** Error envelope `{error:{code,message,requestId}}`, or a network failure (status 0). */
export class DriftApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "DriftApiError";
  }
}

export type TokenSource = () => Promise<string | null>;

export interface Page<T> {
  data: T;
  nextCursor: string | null;
}

/**
 * Thin client for `/api/v1`. Next forwards `/api/*` to FastAPI (or the synthetic mock),
 * so requests stay same-origin. Writes carry the Clerk session token as a Bearer header.
 */
export class DriftApi {
  constructor(
    private readonly getToken: TokenSource = async () => null,
    private readonly base = "/api/v1",
    private readonly ensureAnonymous?: () => Promise<string>,
  ) {}

  private async request<T>(
    path: string,
    init: RequestInit & { auth?: boolean; anonymous?: boolean } = {},
  ): Promise<Page<T>> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    headers.set("X-Drift-Time-Zone", browserTimeZone());
    if (init.body) headers.set("content-type", "application/json");
    const token = await this.getToken();
    if (init.auth && !token) {
      if (init.anonymous && this.ensureAnonymous) await this.ensureAnonymous();
      else throw new DriftApiError(401, "UNAUTHENTICATED", "Sign in to continue");
    }
    if (token) headers.set("authorization", `Bearer ${token}`);
    let response: Response;
    try {
      response = await fetch(this.base + path, {
        ...init,
        headers,
        cache: "no-store",
        credentials: "same-origin",
      });
    } catch {
      throw new DriftApiError(
        0,
        "NETWORK",
        "Can't reach Drift. Check your connection.",
      );
    }
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // Non-JSON body (proxy error page); handled below.
    }
    if (!response.ok) {
      const error = (
        payload as {
          error?: { code?: string; message?: string; requestId?: string };
        } | null
      )?.error;
      throw new DriftApiError(
        response.status,
        error?.code ??
          (response.status === 404 ? "NOT_FOUND" : "HTTP_" + response.status),
        error?.message ??
          (response.status >= 500
            ? "Drift's server is unavailable."
            : "Request failed"),
        error?.requestId ?? null,
      );
    }
    const body = payload as { data: T; nextCursor?: string | null };
    return { data: body.data, nextCursor: body.nextCursor ?? null };
  }

  sky(
    params: {
      at: Anchor;
      radiusM: number;
      datasetId: string;
      cursor?: string | null;
    },
    signal?: AbortSignal,
  ) {
    const query = new URLSearchParams({
      lat: String(params.at.latitude),
      lng: String(params.at.longitude),
      radiusM: String(Math.round(params.radiusM)),
      datasetId: params.datasetId,
    });
    if (params.cursor) query.set("cursor", params.cursor);
    return this.request<SkyData>(`/sky?${query}`, { signal });
  }

  cloud(id: string, signal?: AbortSignal) {
    return this.request<CloudDetail>(`/clouds/${encodeURIComponent(id)}`, {
      signal,
    });
  }

  messages(
    cloudId: string,
    params: {
      scope: "nearby" | "all";
      at?: Anchor;
      radiusM?: number;
      cursor?: string | null;
      limit?: number;
    },
    signal?: AbortSignal,
  ) {
    const query = new URLSearchParams({ scope: params.scope });
    if (params.scope === "nearby" && params.at) {
      query.set("lat", String(params.at.latitude));
      query.set("lng", String(params.at.longitude));
    }
    if (params.radiusM)
      query.set("radiusM", String(Math.round(params.radiusM)));
    if (params.limit) query.set("limit", String(params.limit));
    if (params.cursor) query.set("cursor", params.cursor);
    return this.request<Message[]>(
      `/clouds/${encodeURIComponent(cloudId)}/messages?${query}`,
      { signal },
    );
  }

  createMessage(
    cloudId: string,
    body: CreateMessageRequest,
    key = crypto.randomUUID(),
  ) {
    return this.request<Message>(
      `/clouds/${encodeURIComponent(cloudId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify(body),
        auth: true,
        anonymous: true,
        headers: { "Idempotency-Key": key },
      },
    );
  }

  createCloud(body: CreateCloudRequest, key = crypto.randomUUID()) {
    return this.request<Cloud>("/clouds", {
      method: "POST",
      body: JSON.stringify(body),
      auth: true,
      anonymous: true,
      headers: { "Idempotency-Key": key },
    });
  }

  deleteCloud(id: string) {
    return this.request<{ id: string; expired: boolean }>(
      `/clouds/${encodeURIComponent(id)}`,
      { method: "DELETE", auth: true, anonymous: true },
    );
  }

  messagesById(ids: string[], signal?: AbortSignal) {
    const query = new URLSearchParams();
    for (const id of ids) query.append("id", id);
    return this.request<Message[]>(`/messages?${query}`, { signal });
  }

  setUpvote(messageId: string, active: boolean) {
    return this.request<VoteState>(
      `/messages/${encodeURIComponent(messageId)}/upvote`,
      {
        method: "PUT",
        body: JSON.stringify({ active }),
        auth: true,
      },
    );
  }

  deleteMessage(messageId: string) {
    return this.request<{ id: string; expired: boolean }>(
      `/messages/${encodeURIComponent(messageId)}`,
      {
        method: "DELETE",
        auth: true,
        anonymous: true,
      },
    );
  }

  streak(signal?: AbortSignal) {
    return this.request<PostingStreak>("/me/streak", { signal });
  }
}

/** Composer refresh cases: version conflict, retired (successors), expired, unavailable. */
export function isStaleCloudError(error: unknown): error is DriftApiError {
  return (
    error instanceof DriftApiError &&
    [
      "VERSION_CONFLICT",
      "CLOUD_RETIRED",
      "CLOUD_EXPIRED",
      "CLOUD_UNAVAILABLE",
    ].includes(error.code)
  );
}
