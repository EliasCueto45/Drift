// @vitest-environment jsdom
import { createElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWithPreviews, Message } from "@/lib/contracts";
import { PostProvider, usePosts } from "./posts";

const mocks = vi.hoisted(() => ({
  auth: {
    userId: "user_alice" as string | null,
    signedIn: true,
    signIn: vi.fn(),
  },
  api: {
    messagesById: vi.fn(),
    deleteMessage: vi.fn(),
    deleteCloud: vi.fn(),
    setUpvote: vi.fn(),
  },
}));
vi.mock("@/lib/api/ApiProvider", () => ({ useApi: () => mocks.api }));
vi.mock("@/lib/auth/DriftAuth", () => ({ useDriftAuth: () => mocks.auth }));
const message = {
  id: "post",
  cloudId: "origin",
  authorId: "user_alice",
  anchor: { longitude: -73, latitude: 42 },
  version: 1,
  expiredAt: null,
  voteCount: 0,
  viewerHasUpvoted: false,
} as Message;
function Probe() {
  const store = usePosts();
  return createElement(
    "div",
    null,
    createElement(
      "output",
      { "data-testid": "created" },
      JSON.stringify(store.created),
    ),
    createElement(
      "output",
      { "data-testid": "vote" },
      JSON.stringify(store.vote(message)),
    ),
    createElement(
      "button",
      { onClick: () => store.addCreated(message) },
      "Add",
    ),
    createElement(
      "button",
      { onClick: () => void store.reconcile([]) },
      "Refresh",
    ),
    createElement(
      "button",
      { onClick: () => void store.deletePost(message.id) },
      "Delete",
    ),
    createElement(
      "button",
      { onClick: () => void store.toggleVote(message) },
      "Vote",
    ),
    createElement(
      "button",
      {
        onClick: () =>
          void store.reconcile([
            {
              cloud: { id: "origin" },
              previews: [message],
            } as CloudWithPreviews,
          ]),
      },
      "Refresh votes",
    ),
  );
}
function tree() {
  return createElement(PostProvider, null, createElement(Probe));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.userId = "user_alice";
  mocks.auth.signedIn = true;
  mocks.api.messagesById.mockResolvedValue({ data: [] });
  mocks.api.deleteMessage.mockResolvedValue({
    data: { id: "post", expired: true },
  });
});

describe("live post store", () => {
  it("reassigns moved posts and removes held/expired entries after successful revalidation", async () => {
    render(tree());
    fireEvent.click(screen.getByText("Add"));
    mocks.api.messagesById.mockResolvedValueOnce({
      data: [{ ...message, version: 2, cloudId: "successor" }],
    });
    fireEvent.click(screen.getByText("Refresh"));
    await waitFor(() =>
      expect(screen.getByTestId("created").textContent).toContain("successor"),
    );
    fireEvent.click(screen.getByText("Refresh"));
    await waitFor(() =>
      expect(screen.getByTestId("created").textContent).toBe("{}"),
    );
  });
  it("does not restore deleted posts from a late in-flight response", async () => {
    const response = deferred<{ data: Message[] }>();
    render(tree());
    fireEvent.click(screen.getByText("Add"));
    mocks.api.messagesById.mockReturnValueOnce(response.promise);
    fireEvent.click(screen.getByText("Refresh"));
    fireEvent.click(screen.getByText("Delete"));
    await waitFor(() =>
      expect(screen.getByTestId("created").textContent).toBe("{}"),
    );
    await act(async () => response.resolve({ data: [message] }));
    expect(screen.getByTestId("created").textContent).toBe("{}");
  });
  it("clears account state and ignores responses from the previous account", async () => {
    const response = deferred<{ data: Message[] }>();
    const view = render(tree());
    fireEvent.click(screen.getByText("Add"));
    mocks.api.messagesById.mockReturnValueOnce(response.promise);
    fireEvent.click(screen.getByText("Refresh"));
    mocks.auth.userId = "user_bob";
    view.rerender(tree());
    expect(screen.getByTestId("created").textContent).toBe("{}");
    await act(async () => response.resolve({ data: [message] }));
    expect(screen.getByTestId("created").textContent).toBe("{}");
  });
  it("serializes rapid vote clicks and clears settled overrides on a fresh read", async () => {
    const response = deferred<{
      data: { voteCount: number; viewerHasUpvoted: boolean };
    }>();
    mocks.api.setUpvote.mockReturnValueOnce(response.promise);
    render(tree());
    fireEvent.click(screen.getByText("Vote"));
    fireEvent.click(screen.getByText("Vote"));
    expect(mocks.api.setUpvote).toHaveBeenCalledTimes(1);
    await act(async () =>
      response.resolve({ data: { voteCount: 1, viewerHasUpvoted: true } }),
    );
    expect(screen.getByTestId("vote").textContent).toContain('"voteCount":1');
    fireEvent.click(screen.getByText("Refresh votes"));
    await waitFor(() =>
      expect(screen.getByTestId("vote").textContent).toContain('"voteCount":0'),
    );
  });
});
