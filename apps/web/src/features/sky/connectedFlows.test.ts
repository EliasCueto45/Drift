// @vitest-environment jsdom
import { createElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Cloud, Message } from "@/lib/contracts";
import { CloudCreator, outlineProblem } from "./CloudCreator";
import { DeleteCloudButton } from "./DeleteCloudButton";
import { PostItem } from "@/features/composer/PostItem";
import { Composer } from "@/features/composer/Composer";
import { CloudSheet } from "./CloudSheet";
import type { CloudWithPreviews } from "@/lib/contracts";
import { DriftApiError } from "@/lib/api/client";

const mocks = vi.hoisted(() => ({
  api: {
    createCloud: vi.fn(),
    createMessage: vi.fn(),
    messages: vi.fn(),
    messagesById: vi.fn(),
  },
  auth: {
    ready: true,
    userId: "user_alice",
    signedIn: true,
    mode: "clerk",
    signIn: vi.fn(),
  },
  posts: {
    created: {} as Record<string, Message[]>,
    syncVotes: vi.fn(),
    removed: new Set<string>(),
    vote: vi.fn(() => ({
      voteCount: 0,
      viewerHasUpvoted: false,
      pending: false,
    })),
    toggleVote: vi.fn(),
    deletePost: vi.fn(),
    deleteCloud: vi.fn(),
    notify: vi.fn(),
  },
}));
vi.mock("@/lib/api/ApiProvider", () => ({ useApi: () => mocks.api }));
vi.mock("@/lib/auth/DriftAuth", () => ({ useDriftAuth: () => mocks.auth }));
vi.mock("@/features/composer/posts", () => ({
  usePosts: () => mocks.posts,
  timeAgo: () => "just now",
  linkLabel: () => "Song",
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.userId = "user_alice";
  mocks.auth.signedIn = true;
  mocks.posts.removed.clear();
  mocks.posts.created = {};
});
const post = {
  id: "post",
  cloudId: "cloud",
  authorId: "user_alice",
  body: "Hello sky",
  kind: "text",
  author: { id: "user_alice", displayName: "Alice", avatarUrl: null },
  voteCount: 0,
  viewerHasUpvoted: false,
  createdAt: "2026-11-08T00:00:00Z",
} as Message;

describe("connected author and cloud controls", () => {
  it("shows the latest tracked displacement beside the post age", () => {
    const view = render(createElement(PostItem, { message: { ...post, driftDistanceM: 1234 } }));
    expect(screen.getByText("drifted ~1.2 km").parentElement?.textContent).toContain("just now");
    view.rerender(createElement(PostItem, { message: { ...post, driftDistanceM: null } }));
    expect(screen.getByText("drift unavailable")).toBeTruthy();
  });
  it("posts anonymously without opening sign-up", async () => {
    mocks.auth.signedIn = false;
    mocks.auth.userId = "anon_browser";
    mocks.api.createMessage.mockResolvedValueOnce({ data: { ...post, authorId: "anon_browser" } });
    const onPublished = vi.fn();
    const anchor = { longitude: -73, latitude: 42 };
    render(createElement(Composer, {
      item: { cloud: { id: "cloud", version: 1 }, previews: [] } as unknown as CloudWithPreviews,
      anchor, viewer: anchor, onPublished, onCancel: vi.fn(), onStale: vi.fn(), onDraft: vi.fn(), onMoveSpot: vi.fn(),
    }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Hello anonymously" } });
    fireEvent.click(screen.getByRole("button", { name: "Post anonymously" }));
    await waitFor(() => expect(onPublished).toHaveBeenCalled());
    expect(mocks.auth.signIn).not.toHaveBeenCalled();
  });
  it.each([
    ["lost response", new Error("offline")],
    ["expired session", new DriftApiError(401, "UNAUTHENTICATED", "Sign in again")],
    ["held original", new DriftApiError(410, "CONTENT_UNAVAILABLE", "Original post held")],
  ])("keeps the text post retry key after %s", async (_name, failure) => {
    const onPublished = vi.fn(),
      viewer = { longitude: -73, latitude: 42 };
    mocks.api.createMessage
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ data: post });
    const item = {
      cloud: { id: "cloud", version: 1 },
      previews: [],
    } as unknown as CloudWithPreviews;
    const props = {
      item,
      anchor: viewer,
      viewer,
      onPublished,
      onCancel: vi.fn(),
      onStale: vi.fn(),
      onDraft: vi.fn(),
      onMoveSpot: vi.fn(),
    };
    const view = render(createElement(Composer, props));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Hello sky" },
    });
    fireEvent.click(screen.getByText("Post to the cloud"));
    await screen.findByRole("alert");
    const key = mocks.api.createMessage.mock.calls[0]![2];
    view.rerender(
      createElement(Composer, {
        ...props,
        item: { ...item, cloud: { ...item.cloud, version: 2 } },
      }),
    );
    fireEvent.click(screen.getByText("Post to the cloud"));
    await waitFor(() => expect(onPublished).toHaveBeenCalled());
    expect(mocks.api.createMessage.mock.calls[1]![2]).toBe(key);
    expect(mocks.api.createMessage.mock.calls[1]![1].expectedCloudVersion).toBe(
      1,
    );
  });

  it("uses main's 50 km policy for cached posts and revalidates loaded rows", async () => {
    const viewer = { longitude: -73, latitude: 42 };
    const distant = {
      ...post,
      id: "distant",
      body: "Post beyond the former 25 km boundary",
      anchor: { longitude: -73, latitude: 42.229 },
    };
    const live = { ...post, anchor: viewer };
    const cloud = {
      id: "cloud",
      version: 1,
      kind: "observed",
      wind: { altitudeM: 2000 },
    } as Cloud;
    const item: CloudWithPreviews = { cloud, previews: [] };
    mocks.posts.created = { cloud: [distant] };
    mocks.api.messages.mockResolvedValue({ data: [live], nextCursor: null });
    mocks.api.messagesById.mockResolvedValue({ data: [] });
    const view = render(
      createElement(CloudSheet, { item, viewer, onClose: vi.fn() }),
    );
    expect(screen.getByText(distant.body!)).toBeTruthy();
    await screen.findByText("Hello sky");
    expect(mocks.api.messages.mock.calls[0]![1].radiusM).toBe(50000);
    view.rerender(
      createElement(CloudSheet, {
        item: { ...item, cloud: { ...cloud, version: 2 } },
        viewer,
        onClose: vi.fn(),
      }),
    );
    await waitFor(() => expect(screen.queryByText("Hello sky")).toBeNull());
  });
  it("shows public authors and offers deletion only to the signed-in author", async () => {
    mocks.auth.userId = "user_bob";
    const view = render(createElement(PostItem, { message: post }));
    expect(screen.getByText(/Alice/)).toBeTruthy();
    expect(screen.queryByText("Delete post")).toBeNull();
    mocks.auth.userId = "user_alice";
    view.rerender(createElement(PostItem, { message: post }));
    fireEvent.click(screen.getByText("Delete post"));
    expect(mocks.posts.deletePost).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(mocks.posts.deletePost).toHaveBeenCalledWith("post"),
    );
  });
  it("requires confirmation for creator-only cloud deletion", async () => {
    const cloud = {
      id: "cloud",
      kind: "created",
      creatorId: "user_alice",
    } as Cloud;
    mocks.auth.userId = "user_bob";
    const view = render(createElement(DeleteCloudButton, { cloud }));
    expect(screen.queryByText("Delete your cloud")).toBeNull();
    mocks.auth.userId = "user_alice";
    view.rerender(createElement(DeleteCloudButton, { cloud }));
    fireEvent.click(screen.getByText("Delete your cloud"));
    expect(mocks.posts.deleteCloud).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete cloud" }));
    await waitFor(() =>
      expect(mocks.posts.deleteCloud).toHaveBeenCalledWith("cloud"),
    );
  });
  it("publishes a closed geographic outline in the displayed dataset and retries with the same key", async () => {
    const onCreated = vi.fn();
    mocks.api.createCloud
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ data: { id: "new-cloud" } });
    render(
      createElement(CloudCreator, {
        viewer: { longitude: -73.69, latitude: 42.72 },
        datasetId: "fx-clear",
        onCreated,
        onClose: vi.fn(),
      }),
    );
    const map = screen.getByRole("application");
    vi.spyOn(map, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 340,
      height: 300,
      right: 340,
      bottom: 300,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    for (const [clientX, clientY] of [
      [120, 100],
      [220, 100],
      [170, 220],
    ])
      fireEvent.click(map, { clientX, clientY });
    fireEvent.click(screen.getByText("Publish cloud"));
    await screen.findByRole("alert");
    const [body, key] = mocks.api.createCloud.mock.calls[0]!;
    expect(body.datasetId).toBe("fx-clear");
    expect(body.outline.coordinates[0][0]).toEqual(
      body.outline.coordinates[0].at(-1),
    );
    expect(body.outline.coordinates[0][0][0]).toBeLessThan(-70);
    fireEvent.click(screen.getByText("Publish cloud"));
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith({ id: "new-cloud" }),
    );
    expect(mocks.api.createCloud.mock.calls[1]![1]).toBe(key);
  });
  it("rejects incomplete and oversized outlines before requesting publication", () => {
    expect(outlineProblem([])).toMatch(/three/);
    expect(
      outlineProblem([
        { longitude: -73, latitude: 42 },
        { longitude: -72, latitude: 42 },
        { longitude: -73, latitude: 43 },
      ]),
    ).toMatch(/10 km/);
  });
});
