export interface ComputeSubmissionAdmission {
  phase: 'queued' | 'checking-consent' | 'retaining' | 'submitting' | 'settled';
}

interface ProviderSubmissionOwner extends ComputeSubmissionAdmission {
  settled: Promise<void>;
  release(): void;
}

const owners = new Map<string, ProviderSubmissionOwner>();

export async function withComputeSubmissionAdmission<T>(
  providerId: string,
  submit: (owner: ComputeSubmissionAdmission) => Promise<T>
): Promise<T> {
  const previous = owners.get(providerId);
  let release!: () => void;
  const owner: ProviderSubmissionOwner = {
    phase: 'queued',
    settled: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
  owners.set(providerId, owner);
  await previous?.settled;
  owner.phase = 'checking-consent';
  try {
    return await submit(owner);
  } finally {
    owner.phase = 'settled';
    owner.release();
    if (owners.get(providerId) === owner) owners.delete(providerId);
  }
}
