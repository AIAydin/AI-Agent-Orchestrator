import { describe, expect, it, vi } from "vitest";

import type { WorkshopNode, WorkshopNodeData } from "../canvas/CanvasNode.js";
import { matchParameterizedVoiceIntent } from "./parameterized-intents.js";

describe("parameterized voice intents", () => {
  it("binds free-form prompt text to an exact live Agent title and requires confirmation", () => {
    const promptAgent = vi.fn();
    const match = matchParameterizedVoiceIntent({
      transcript: "Forgeboard, please tell Hermes to review the failing tests",
      nodes: [node("agent-1", "Hermes", "agent")],
      promptAgent,
      connectNodes: vi.fn(),
    });

    expect(match?.action).toMatchObject({
      voiceSafety: "confirm",
      section: "Voice · Agent",
    });
    match?.action.run();
    expect(promptAgent).toHaveBeenCalledWith(
      "agent-1",
      "review the failing tests",
    );
  });

  it("connects two exact live node titles and requires confirmation", () => {
    const connectNodes = vi.fn();
    const match = matchParameterizedVoiceIntent({
      transcript: "connect Hermes to Walkthrough",
      nodes: [
        node("agent-1", "Hermes", "agent"),
        node("video-1", "Walkthrough", "video"),
      ],
      promptAgent: vi.fn(),
      connectNodes,
    });

    expect(match?.action).toMatchObject({
      label: "Connect Hermes to Walkthrough",
      voiceSafety: "confirm",
    });
    match?.action.run();
    expect(connectNodes).toHaveBeenCalledWith("agent-1", "video-1");
  });

  it("preserves free-form prompt casing and punctuation", () => {
    const promptAgent = vi.fn();
    const match = matchParameterizedVoiceIntent({
      transcript: "Please ask Hermes to Fix APIClient.ts, then run Vitest.",
      nodes: [node("agent-1", "Hermes", "agent")],
      promptAgent,
      connectNodes: vi.fn(),
    });
    match?.action.run();
    expect(promptAgent).toHaveBeenCalledWith(
      "agent-1",
      "Fix APIClient.ts, then run Vitest.",
    );
  });

  it("rejects ambiguous duplicate names and unrelated instructions", () => {
    const base = {
      promptAgent: vi.fn(),
      connectNodes: vi.fn(),
    };
    expect(
      matchParameterizedVoiceIntent({
        ...base,
        transcript: "tell Hermes to run tests",
        nodes: [
          node("agent-1", "Hermes", "agent"),
          node("agent-2", "Hermes", "agent"),
        ],
      }),
    ).toBeNull();
    expect(
      matchParameterizedVoiceIntent({
        ...base,
        transcript: "delete every file",
        nodes: [node("agent-1", "Hermes", "agent")],
      }),
    ).toBeNull();
  });
});

function node(
  id: string,
  title: string,
  kind: "agent" | "video",
): WorkshopNode {
  return {
    id,
    type: "workshop",
    position: { x: 0, y: 0 },
    data: {
      kind,
      title,
      description: "",
      status: "idle",
      locked: false,
      collapsed: false,
      color: "#445566",
    } as WorkshopNodeData,
  };
}
