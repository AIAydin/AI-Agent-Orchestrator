import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { CdpPipeClient } from "./cdp-pipe.js";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdio: unknown[] };
  child.stdio = [
    null,
    null,
    new PassThrough(),
    new PassThrough(),
    new PassThrough(),
  ];
  return child;
}

describe("CdpPipeClient", () => {
  it("sends null-delimited commands over fd 3 and resolves responses from fd 4", async () => {
    const child = fakeChild();
    const input = child.stdio[3] as PassThrough;
    const output = child.stdio[4] as PassThrough;
    input.once("data", (chunk: Buffer) => {
      const command = JSON.parse(
        chunk.toString("utf8").replace(/\0$/u, ""),
      ) as {
        id: number;
        method: string;
        sessionId: string;
      };
      expect(command).toMatchObject({
        method: "Page.enable",
        sessionId: "session-1",
      });
      output.write(
        `${JSON.stringify({ id: command.id, result: { enabled: true } })}\0`,
      );
    });

    const client = new CdpPipeClient(child as never);
    await expect(client.send("Page.enable", {}, "session-1")).resolves.toEqual({
      enabled: true,
    });
  });

  it("forwards protocol events and rejects pending commands when Chrome exits", async () => {
    const child = fakeChild();
    const output = child.stdio[4] as PassThrough;
    const client = new CdpPipeClient(child as never);
    const listener = vi.fn();
    client.onEvent(listener);
    output.write(
      `${JSON.stringify({ method: "Runtime.consoleAPICalled", params: { args: [] }, sessionId: "s" })}\0`,
    );
    expect(listener).toHaveBeenCalledWith({
      method: "Runtime.consoleAPICalled",
      params: { args: [] },
      sessionId: "s",
    });

    const pending = client.send("Browser.getVersion");
    child.emit("exit", 0, null);
    await expect(pending).rejects.toThrow("Chrome closed");
  });
});
