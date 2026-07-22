import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { PreviewAgentBrowser } from "./preview-agent-browser.js";

class FakeGuest extends EventEmitter {
  destroyed = false;
  executeJavaScript = vi.fn(() =>
    Promise.resolve({
      url: "https://miro.com/app/board",
      title: "Planning board",
      text: "Visible board text",
      dom: "<html><body>Visible board text</body></html>",
    }),
  );
  capturePage = vi.fn(() =>
    Promise.resolve({ toPNG: () => Buffer.from("png bytes", "utf8") }),
  );
  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

describe("PreviewAgentBrowser", () => {
  it("exposes bounded inspection data and console output for a registered live guest", async () => {
    const browser = new PreviewAgentBrowser();
    const guest = new FakeGuest();
    browser.registerGuest(
      "persist:preview:project-1:preview-1",
      guest as never,
    );
    guest.emit("console-message", {}, 1, "loaded board");

    expect(browser.isLive("project-1", "preview-1")).toBe(true);
    await expect(browser.inspect("project-1", "preview-1")).resolves.toEqual({
      url: "https://miro.com/app/board",
      title: "Planning board",
      text: "Visible board text",
      dom: "<html><body>Visible board text</body></html>",
      console: ["loaded board"],
    });
    expect(guest.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining("innerText"),
      true,
    );
  });

  it("returns PNG screenshots and removes destroyed guests", async () => {
    const browser = new PreviewAgentBrowser();
    const guest = new FakeGuest();
    browser.registerGuest("preview:project-1:preview-1", guest as never);

    await expect(browser.screenshot("project-1", "preview-1")).resolves.toEqual(
      {
        mimeType: "image/png",
        data: Buffer.from("png bytes", "utf8").toString("base64"),
      },
    );
    guest.destroy();
    expect(browser.isLive("project-1", "preview-1")).toBe(false);
    await expect(browser.inspect("project-1", "preview-1")).rejects.toThrow(
      "preview-not-live",
    );
  });

  it("keeps the primary guest when a comparison-slot guest registers afterward", async () => {
    const browser = new PreviewAgentBrowser();
    const primary = new FakeGuest();
    const comparison = new FakeGuest();
    comparison.executeJavaScript.mockResolvedValue({
      url: "https://example.com/comparison",
      title: "Comparison",
      text: "comparison",
      dom: "<html></html>",
    });
    browser.registerGuest("preview:project-1:preview-1", primary as never);
    browser.registerGuest(
      "preview:project-1:preview-1:left",
      comparison as never,
    );

    const inspection = await browser.inspect("project-1", "preview-1");
    expect(inspection.title).toBe("Planning board");
    expect(comparison.executeJavaScript).not.toHaveBeenCalled();
  });
});
