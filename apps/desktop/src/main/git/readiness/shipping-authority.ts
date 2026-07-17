import {
  gitDeliverySourceFingerprintsEqual,
  type GitDeliveryReadinessTarget,
  type GitDeliveryReadinessView,
} from '../../../shared/git/readiness/index.js';
import type {
  GitShippingReadinessAuthority,
  GitShippingReadinessBinding,
} from '../shipping/git-shipping-service.js';
import type { DeliveryReadinessService } from './service.js';

type ShippingReadinessOperations = Pick<DeliveryReadinessService, 'get' | 'revalidate'>;

/** Adapts exact immutable-while-retained human evidence to the Git shipping admission contract. */
export class DeliveryReadinessShippingAuthority implements GitShippingReadinessAuthority {
  public constructor(private readonly readiness: ShippingReadinessOperations) {}

  public async bind(target: GitDeliveryReadinessTarget): Promise<GitShippingReadinessBinding> {
    const discovery = await this.readiness.get({ target });
    const candidate = discovery.readiness;
    if (candidate === null || !candidate.evaluation.ready) {
      throw new Error(
        'Run every required delivery check and record human quality approval before delivery.',
      );
    }
    const approval = exactHumanApproval(candidate);
    if (approval === undefined) {
      throw new Error('Delivery readiness has no exact durable human approval.');
    }
    const view = await this.readiness.revalidate({ approvalId: approval.approvalId, target });
    assertSameReadyEvidence(candidate, view);
    return { approvalId: approval.approvalId, view };
  }

  public async revalidate(
    target: GitDeliveryReadinessTarget,
    binding: GitShippingReadinessBinding,
  ): Promise<GitDeliveryReadinessView> {
    assertTarget(binding.view, target);
    const boundApproval = binding.view.approvals.find(
      (approval) => approval.approvalId === binding.approvalId,
    );
    if (
      boundApproval?.authority !== 'human' ||
      boundApproval.evidenceFingerprint !== binding.view.evidenceFingerprint ||
      !gitDeliverySourceFingerprintsEqual(
        boundApproval.sourceFingerprint,
        binding.view.sourceFingerprint,
      )
    ) {
      throw new Error('The shipping plan is not bound to exact human readiness evidence.');
    }
    const current = await this.readiness.revalidate({
      approvalId: binding.approvalId,
      target,
    });
    assertSameReadyEvidence(binding.view, current);
    return current;
  }
}

function exactHumanApproval(view: GitDeliveryReadinessView) {
  return view.approvals.find(
    (approval) =>
      approval.authority === 'human' &&
      approval.evidenceFingerprint === view.evidenceFingerprint &&
      gitDeliverySourceFingerprintsEqual(approval.sourceFingerprint, view.sourceFingerprint),
  );
}

function assertSameReadyEvidence(
  expected: GitDeliveryReadinessView,
  current: GitDeliveryReadinessView,
): void {
  if (
    !current.evaluation.ready ||
    current.readinessId !== expected.readinessId ||
    current.evidenceFingerprint !== expected.evidenceFingerprint ||
    !gitDeliverySourceFingerprintsEqual(current.sourceFingerprint, expected.sourceFingerprint)
  ) {
    throw new Error(
      'Delivery readiness changed. Run the required checks and approve quality again.',
    );
  }
}

function assertTarget(view: GitDeliveryReadinessView, target: GitDeliveryReadinessTarget): void {
  if (
    view.target.kind !== target.kind ||
    view.target.projectId !== target.projectId ||
    view.target.runId !== target.runId
  ) {
    throw new Error('The shipping readiness binding belongs to another managed run.');
  }
}
