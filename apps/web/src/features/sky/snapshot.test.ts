// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cameraCrop, captureSkyImage, shareSnapshot } from "./snapshot";
import { SnapshotButton } from "./SnapshotButton";
import { captureSkyScreenshot } from "./screenshot";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("clean snapshot composition", () => {
  it("uses the same center crop as the portrait camera rather than stretching landscape video", () => {
    const crop = cameraCrop(1920, 1080, 390, 844);
    expect(crop.sh).toBe(1080);
    expect(crop.sw / crop.sh).toBeCloseTo(390 / 844);
    expect(crop.sx * 2 + crop.sw).toBeCloseTo(1920);
    expect(crop.sy).toBe(0);
  });

  it("draws camera pixels before the clean sky/notes painter and produces a PNG", async () => {
    const order: string[] = [];
    const ctx = { setTransform: vi.fn(), drawImage: vi.fn(() => order.push("camera")) };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const png = new Blob(["png"], { type: "image/png" });
    const encoder = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb, type) => { expect(type).toBe("image/png"); cb(png); });
    const video = { readyState: 2, videoWidth: 1920, videoHeight: 1080 } as HTMLVideoElement;
    expect(await captureSkyImage({ width: 390, height: 844, pixelRatio: 2, video, draw: () => order.push("notes") })).toBe(png);
    expect(order).toEqual(["camera", "notes"]);
    expect(ctx.drawImage).toHaveBeenCalledWith(video, expect.any(Number), 0, expect.any(Number), 1080, 0, 0, 390, 844);
    expect((encoder.mock.instances[0] as HTMLCanvasElement).width).toBe(780);
  });

  it("rejects an unready camera and failed encodes instead of exporting a blank photo", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ setTransform: vi.fn() } as unknown as CanvasRenderingContext2D);
    const source = { width: 390, height: 844, pixelRatio: 2, video: null, draw: vi.fn() };
    expect(() => captureSkyImage({ ...source, video: { readyState: 0 } as HTMLVideoElement })).toThrow(/camera/);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb) => cb(null));
    await expect(captureSkyImage(source)).rejects.toThrow(/create the snapshot/);
  });
});

describe("phone file sharing", () => {
  it("reports capture failures through the existing screenshot handoff", async () => {
    const notify = vi.fn();
    await expect(captureSkyScreenshot({ capture: null, notify })).rejects.toThrow(/sky to appear/);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/sky to appear/));
  });
  it("calls native sharing immediately with the prepared PNG", async () => {
    const file = new File(["png"], "sky.png", { type: "image/png" });
    const nav = { share: vi.fn().mockResolvedValue(undefined), canShare: vi.fn().mockReturnValue(true) };
    const pending = shareSnapshot(file, nav);
    expect(nav.share).toHaveBeenCalledWith({ files: [file], title: "Sky notes" });
    expect(await pending).toBe("shared");
  });
  it("treats cancellation as cancellation and unsupported file sharing as a fallback", async () => {
    const file = new File(["png"], "sky.png", { type: "image/png" });
    const nav = { share: vi.fn().mockRejectedValue(new DOMException("Cancelled", "AbortError")), canShare: vi.fn().mockReturnValue(true) };
    expect(await shareSnapshot(file, nav)).toBe("cancelled");
    nav.canShare.mockReturnValue(false);
    nav.share.mockClear();
    expect(await shareSnapshot(file, nav)).toBe("unsupported");
    expect(nav.share).not.toHaveBeenCalled();
  });
});

describe("snapshot preview", () => {
  const nativeShare = vi.fn();
  const canShare = vi.fn();
  beforeEach(() => {
    nativeShare.mockReset().mockResolvedValue(undefined);
    canShare.mockReset().mockReturnValue(true);
    vi.stubGlobal("navigator", { share: nativeShare, canShare });
    URL.createObjectURL = vi.fn().mockReturnValue("blob:sky-preview");
    URL.revokeObjectURL = vi.fn();
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    HTMLDialogElement.prototype.close = function () { this.open = false; };
  });
  it("prepares a preview first and shares only on an explicit second tap", async () => {
    const capture = vi.fn().mockResolvedValue(new Blob(["image"], { type: "image/png" }));
    render(createElement(SnapshotButton, { capture }));
    fireEvent.click(screen.getByRole("button", { name: "Take a sky snapshot" }));
    await screen.findByRole("dialog", { name: "Your sky snapshot" });
    expect(nativeShare).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => expect(nativeShare).toHaveBeenCalledTimes(1));
    expect(nativeShare.mock.calls[0]![0].files[0].type).toBe("image/png");
    fireEvent.click(screen.getByRole("button", { name: "Close snapshot preview" }));
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:sky-preview"));
  });
  it("offers save without native sharing and reports capture errors", async () => {
    canShare.mockReturnValue(false);
    const capture = vi.fn().mockRejectedValueOnce(new Error("Camera not ready")).mockResolvedValue(new Blob(["image"]));
    render(createElement(SnapshotButton, { capture }));
    fireEvent.click(screen.getByRole("button", { name: "Take a sky snapshot" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Camera not ready");
    fireEvent.click(screen.getByRole("button", { name: "Take a sky snapshot" }));
    await screen.findByRole("dialog", { name: "Your sky snapshot" });
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save image" })).toBeTruthy();
  });
});
