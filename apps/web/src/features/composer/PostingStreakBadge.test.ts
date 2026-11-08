// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PostingStreakBadge } from "./PostingStreakBadge";

const mocks = vi.hoisted(() => ({
  auth: { ready: true, userId: "anon_one" as string | null },
  posts: { postingRevision: 0 },
  api: { streak: vi.fn() },
}));
vi.mock("@/lib/api/ApiProvider", () => ({ useApi: () => mocks.api }));
vi.mock("@/lib/auth/DriftAuth", () => ({ useDriftAuth: () => mocks.auth }));
vi.mock("./posts", () => ({ usePosts: () => mocks.posts }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("refreshes after posting and keeps the previous principal's streak private", async () => {
  const data = { currentDays: 2, longestDays: 4, timeZone: "America/New_York", postedToday: true, nextResetAt: new Date(Date.now() + 3600000).toISOString() };
  mocks.api.streak.mockResolvedValue({ data });
  const view = render(createElement(PostingStreakBadge));
  expect(await screen.findByText("2-day posting streak ✓")).toBeTruthy();
  expect(screen.getByText("2-day posting streak ✓").title).toContain("America/New_York");
  mocks.api.streak.mockResolvedValue({ data: { ...data, currentDays: 3 } });
  mocks.posts.postingRevision++;
  view.rerender(createElement(PostingStreakBadge));
  await screen.findByText("3-day posting streak ✓");
  mocks.auth.userId = null;
  view.rerender(createElement(PostingStreakBadge));
  expect(screen.getByText("Start a posting streak")).toBeTruthy();
  await waitFor(() => expect(mocks.api.streak).toHaveBeenCalledTimes(2));
});
