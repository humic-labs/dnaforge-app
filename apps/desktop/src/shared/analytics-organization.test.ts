import { describe, expect, it } from 'vitest';
import { analyticsOrganizationId } from './analytics-organization';

const ORG_A = '018f3fd0-0000-7000-8000-000000000031';
const ORG_B = '018f3fd0-0000-7000-8000-000000000032';

describe('analyticsOrganizationId', () => {
  it('groups only an account with exactly one UUID organization', () => {
    expect(analyticsOrganizationId([{ orgId: ORG_A }])).toBe(ORG_A);
    expect(analyticsOrganizationId([{ orgId: ORG_A }, { orgId: ORG_A }])).toBe(ORG_A);
    expect(analyticsOrganizationId([{ orgId: ORG_A }, { orgId: ORG_B }])).toBeNull();
    expect(analyticsOrganizationId([])).toBeNull();
    expect(analyticsOrganizationId([{ orgId: 'example-lab' }])).toBeNull();
  });
});
