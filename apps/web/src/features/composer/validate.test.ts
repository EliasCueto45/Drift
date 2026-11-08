import { describe, expect, it } from "vitest";
import { validateLink, validateText } from "./Composer";

// Mirrors apps/web/src/server/drift_api/validation.py::message_input so the composer
// rejects what the server would, with a message the user can act on.
describe("composer validation", () => {
  it("requires non-blank text within 2,000 characters", () => {
    expect(validateText("   ")).toMatch(/Write something/);
    expect(validateText("a".repeat(2000))).toBeNull();
    expect(validateText("a".repeat(2001))).toMatch(/2,000/);
  });

  it("accepts only https links on the backend's music allowlist", () => {
    expect(validateLink("https://open.spotify.com/track/abc")).toBeNull();
    expect(validateLink("https://youtu.be/xyz")).toBeNull();
    expect(validateLink("http://open.spotify.com/track/abc")).toMatch(/https/);
    expect(validateLink("https://example.com/song")).toMatch(/Spotify/);
    expect(validateLink("https://user:pw@open.spotify.com/x")).toMatch(/password/);
    expect(validateLink("not a url")).toMatch(/https:\/\//);
    expect(validateLink("https://open.spotify.com/" + "a".repeat(2048))).toMatch(/2,048/);
  });
});
