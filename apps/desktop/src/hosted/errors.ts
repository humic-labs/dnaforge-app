import { UserMessageError } from '@waypoint/user-messages';

export class HostedCapabilityError extends UserMessageError {
  readonly code = 'HOSTED_CAPABILITY_UNAVAILABLE';
  readonly diagnosticCapability: string;

  constructor(capability: string) {
    super(
      capability.startsWith('platform.trackViews.') ? 'tracks.unavailable' : 'hosted.unavailable'
    );
    this.name = 'HostedCapabilityError';
    this.diagnosticCapability = capability;
  }
}
