import { describe, expect, it, vi } from "vitest";

import {
  OutboundActionGate,
  type OutboundActionDisclosure,
} from "./outbound-action-gate.js";

const PLAN_ID = "10000000-0000-4000-8000-000000000001";

function disclosure(
  resource = "registry.private.example/team/agent:1",
): OutboundActionDisclosure {
  return {
    action: "docker-image-pull",
    title: "Pull Docker image",
    summary: `Allow Docker to pull ${resource}?`,
    confirmLabel: "Pull image",
    destination: {
      kind: "container-registry",
      endpoint: "registry.private.example",
      resource,
      transport: "Docker Registry API",
    },
    details: [
      { label: "Docker executable", value: "/usr/local/bin/docker" },
      { label: "Expected container executable", value: "/usr/local/bin/codex" },
    ],
    warning: "This contacts the disclosed registry.",
  };
}

function harness(now = new Date("2026-07-15T16:00:00.000Z")) {
  const appendAudit = vi.fn();
  let current = now;
  const gate = new OutboundActionGate(
    { appendAudit },
    {
      now: () => current,
      createId: () => PLAN_ID,
      approvalTtlMs: 60_000,
    },
  );
  const advance = (ms: number): void => {
    current = new Date(current.getTime() + ms);
  };
  return {
    gate,
    appendAudit,
    advance,
  };
}

describe("OutboundActionGate", () => {
  it("accepts the declared voice-model download action and model registry destination", () => {
    const { gate } = harness();
    expect(() =>
      gate.prepare("voice:42", {
        ...disclosure("onnx-community/whisper-tiny.en@pinned-revision"),
        action: "voice-model-download",
        destination: {
          kind: "model-registry",
          endpoint: "huggingface.co",
          resource: "onnx-community/whisper-tiny.en@pinned-revision",
          transport: "HTTPS",
        },
      }),
    ).not.toThrow();
  });

  it("keeps native cancellation before revalidation or any network-capable action", async () => {
    const { gate, appendAudit } = harness();
    const plan = gate.prepare("web-contents:42", disclosure());
    const currentDisclosure = vi.fn(() => disclosure());
    const execute = vi.fn(() => Promise.resolve("pulled"));

    await expect(
      gate.confirmAndExecute({
        ownerId: "web-contents:42",
        planId: plan.id,
        confirmation: {
          confirm: vi.fn(() => Promise.resolve<"denied">("denied")),
        },
        currentDisclosure,
        execute,
      }),
    ).resolves.toEqual({ outcome: "denied" });

    expect(currentDisclosure).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(appendAudit).toHaveBeenCalledWith(
      "external-send",
      "docker-image-pull",
      "denied",
      expect.objectContaining({
        actionKind: "docker-image-pull",
        destinationKind: "container-registry",
        reason: "native-confirmation-cancelled",
      }),
    );
    const auditJson = JSON.stringify(appendAudit.mock.calls);
    expect(auditJson).not.toContain("registry.private.example");
    expect(auditJson).not.toContain("team/agent");
    expect(auditJson).not.toContain("/usr/local/bin");
  });

  it("binds a plan to one owner without letting another owner consume it", async () => {
    const { gate, appendAudit } = harness();
    const plan = gate.prepare("owner-a", disclosure());
    const execute = vi.fn();
    const input = {
      planId: plan.id,
      confirmation: {
        confirm: vi.fn(() => Promise.resolve<"denied">("denied")),
      },
      currentDisclosure: () => disclosure(),
      execute,
    };

    await expect(
      gate.confirmAndExecute({ ...input, ownerId: "owner-b" }),
    ).rejects.toThrow(/belongs to another owner/u);
    await expect(
      gate.confirmAndExecute({ ...input, ownerId: "owner-a" }),
    ).resolves.toEqual({
      outcome: "denied",
    });
    await expect(
      gate.confirmAndExecute({ ...input, ownerId: "owner-a" }),
    ).rejects.toThrow(/already used/u);
    expect(input.confirmation.confirm).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(appendAudit).toHaveBeenCalledWith(
      "external-send",
      "docker-image-pull",
      "denied",
      expect.objectContaining({ reason: "consume-owner-mismatch" }),
    );
    expect(appendAudit).toHaveBeenCalledWith(
      "external-send",
      "approval-plan",
      "denied",
      expect.objectContaining({ reason: "consume-plan-not-found" }),
    );
  });

  it("cancels only the matching owner plan without revealing cross-owner state", async () => {
    const { gate, appendAudit } = harness();
    const plan = gate.prepare("owner-a", disclosure());
    const confirmation = {
      confirm: vi.fn(() => Promise.resolve<"denied">("denied")),
    };

    gate.cancel("owner-b", plan.id);
    await expect(
      gate.confirmAndExecute({
        ownerId: "owner-a",
        planId: plan.id,
        confirmation,
        currentDisclosure: () => disclosure(),
        execute: vi.fn(),
      }),
    ).resolves.toEqual({ outcome: "denied" });
    expect(confirmation.confirm).toHaveBeenCalledTimes(1);

    const cancelled = gate.prepare("owner-a", disclosure());
    gate.cancel("owner-a", cancelled.id);
    await expect(
      gate.confirmAndExecute({
        ownerId: "owner-a",
        planId: cancelled.id,
        confirmation,
        currentDisclosure: () => disclosure(),
        execute: vi.fn(),
      }),
    ).rejects.toThrow(/missing|already used/iu);
    expect(confirmation.confirm).toHaveBeenCalledTimes(1);
    expect(appendAudit).toHaveBeenCalledWith(
      "external-send",
      "docker-image-pull",
      "denied",
      expect.objectContaining({ reason: "cancel-owner-mismatch" }),
    );
    expect(appendAudit).toHaveBeenCalledWith(
      "external-send",
      "docker-image-pull",
      "denied",
      expect.objectContaining({ reason: "renderer-plan-cancelled" }),
    );
  });

  it("revokes only the closing owner plans and audits their exact ownership boundary", async () => {
    const appendAudit = vi.fn();
    const ids = [
      "10000000-0000-4000-8000-000000000011",
      "10000000-0000-4000-8000-000000000012",
    ];
    const gate = new OutboundActionGate(
      { appendAudit },
      { createId: () => ids.shift()!, approvalTtlMs: 60_000 },
    );
    const ownerA = gate.prepare("owner-a", disclosure());
    const ownerB = gate.prepare("owner-b", disclosure());

    gate.discardOwner("owner-a");
    await expect(
      gate.confirmAndExecute({
        ownerId: "owner-a",
        planId: ownerA.id,
        confirmation: { confirm: () => Promise.resolve<"denied">("denied") },
        currentDisclosure: () => disclosure(),
        execute: vi.fn(),
      }),
    ).rejects.toThrow(/missing|already used/iu);
    await expect(
      gate.confirmAndExecute({
        ownerId: "owner-b",
        planId: ownerB.id,
        confirmation: { confirm: () => Promise.resolve<"denied">("denied") },
        currentDisclosure: () => disclosure(),
        execute: vi.fn(),
      }),
    ).resolves.toEqual({ outcome: "denied" });

    expect(appendAudit).toHaveBeenCalledWith(
      "external-send",
      "docker-image-pull",
      "denied",
      expect.objectContaining({ reason: "owner-closed" }),
    );
    const auditJson = JSON.stringify(appendAudit.mock.calls);
    expect(auditJson).not.toContain("owner-a");
    expect(auditJson).not.toContain("owner-b");
  });

  it("expires per-use plans and never reaches confirmation after expiry", async () => {
    const { gate, advance, appendAudit } = harness();
    const plan = gate.prepare("owner-a", disclosure());
    advance(60_001);
    const confirmation = {
      confirm: vi.fn(() => Promise.resolve<"approved">("approved")),
    };

    await expect(
      gate.confirmAndExecute({
        ownerId: "owner-a",
        planId: plan.id,
        confirmation,
        currentDisclosure: () => disclosure(),
        execute: vi.fn(),
      }),
    ).rejects.toThrow(/expired/u);
    expect(confirmation.confirm).not.toHaveBeenCalled();
    expect(appendAudit).toHaveBeenCalledWith(
      "external-send",
      "docker-image-pull",
      "denied",
      expect.objectContaining({
        reason: "approval-expired-before-confirmation",
      }),
    );
  });

  it("refuses an approval that arrives after its disclosed expiry", async () => {
    const { gate, advance, appendAudit } = harness();
    const plan = gate.prepare("owner-a", disclosure());
    const currentDisclosure = vi.fn(() => disclosure());
    const execute = vi.fn();

    await expect(
      gate.confirmAndExecute({
        ownerId: "owner-a",
        planId: plan.id,
        confirmation: {
          confirm: () => {
            advance(60_001);
            return Promise.resolve<"approved">("approved");
          },
        },
        currentDisclosure,
        execute,
      }),
    ).resolves.toEqual({ outcome: "denied" });
    expect(currentDisclosure).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(appendAudit).toHaveBeenLastCalledWith(
      "external-send",
      "docker-image-pull",
      "denied",
      expect.objectContaining({
        reason: "approval-expired-after-confirmation",
      }),
    );
  });

  it("revalidates exact disclosure after approval and fails closed on destination drift", async () => {
    const { gate, appendAudit } = harness();
    const plan = gate.prepare("owner-a", disclosure());
    const execute = vi.fn();

    await expect(
      gate.confirmAndExecute({
        ownerId: "owner-a",
        planId: plan.id,
        confirmation: { confirm: () => Promise.resolve("approved") },
        currentDisclosure: () =>
          disclosure("registry.private.example/team/agent:2"),
        execute,
      }),
    ).rejects.toThrow(/changed after approval/u);
    expect(execute).not.toHaveBeenCalled();
    expect(appendAudit).toHaveBeenLastCalledWith(
      "external-send",
      "docker-image-pull",
      "failed",
      expect.objectContaining({ failureKind: "approved-disclosure-changed" }),
    );
  });

  it("refuses execution when disclosure revalidation crosses the approval expiry", async () => {
    const { gate, advance, appendAudit } = harness();
    const plan = gate.prepare("owner-a", disclosure());
    const execute = vi.fn();

    await expect(
      gate.confirmAndExecute({
        ownerId: "owner-a",
        planId: plan.id,
        confirmation: { confirm: () => Promise.resolve("approved") },
        currentDisclosure: () => {
          advance(60_001);
          return Promise.resolve(disclosure());
        },
        execute,
      }),
    ).resolves.toEqual({ outcome: "denied" });
    expect(execute).not.toHaveBeenCalled();
    expect(appendAudit).toHaveBeenLastCalledWith(
      "external-send",
      "docker-image-pull",
      "denied",
      expect.objectContaining({
        reason: "approval-expired-after-revalidation",
      }),
    );
  });

  it("executes exactly once after approval and records only redacted allowed metadata", async () => {
    const { gate, appendAudit } = harness();
    const plan = gate.prepare("owner-a", disclosure());
    const execute = vi.fn(() => Promise.resolve({ imageId: "sha256:abc" }));

    await expect(
      gate.confirmAndExecute({
        ownerId: "owner-a",
        planId: plan.id,
        confirmation: { confirm: () => Promise.resolve("approved") },
        currentDisclosure: () => disclosure(),
        execute,
      }),
    ).resolves.toEqual({
      outcome: "allowed",
      value: { imageId: "sha256:abc" },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(appendAudit).toHaveBeenLastCalledWith(
      "external-send",
      "docker-image-pull",
      "allowed",
      expect.objectContaining({
        approvalMode: "single-use",
      }),
    );
    const metadata = appendAudit.mock.lastCall?.[3] as
      | Record<string, unknown>
      | undefined;
    expect(metadata?.disclosureSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(metadata?.destinationSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(metadata?.phase).toBe("authorized-before-execution");
  });

  it("persists authorization before execution and never runs when that audit append fails", async () => {
    const { gate, appendAudit } = harness();
    const plan = gate.prepare("owner-a", disclosure());
    const execute = vi.fn();
    appendAudit.mockImplementationOnce(() => {
      throw new Error("audit storage unavailable");
    });

    await expect(
      gate.confirmAndExecute({
        ownerId: "owner-a",
        planId: plan.id,
        confirmation: { confirm: () => Promise.resolve("approved") },
        currentDisclosure: () => disclosure(),
        execute,
      }),
    ).rejects.toThrow("audit storage unavailable");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not copy secret-bearing action errors into failed audit metadata", async () => {
    const { gate, appendAudit } = harness();
    const plan = gate.prepare("owner-a", disclosure());
    const unsafeError = new Error("token=do-not-log registry.private.example");
    unsafeError.name = "SecretTokenName";

    await expect(
      gate.confirmAndExecute({
        ownerId: "owner-a",
        planId: plan.id,
        confirmation: { confirm: () => Promise.resolve("approved") },
        currentDisclosure: () => disclosure(),
        execute: () => Promise.reject(unsafeError),
      }),
    ).rejects.toThrow("do-not-log");
    const auditJson = JSON.stringify(appendAudit.mock.calls);
    expect(auditJson).not.toContain("do-not-log");
    expect(auditJson).not.toContain("registry.private.example");
    expect(appendAudit).toHaveBeenLastCalledWith(
      "external-send",
      "docker-image-pull",
      "failed",
      expect.objectContaining({
        failureKind: "outbound-action-failed",
        errorKind: "Error",
      }),
    );
  });
});
