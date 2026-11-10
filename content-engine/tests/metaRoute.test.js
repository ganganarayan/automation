import { describe, it, expect } from 'vitest';
import { idOwners, splitByTenant, claimedIds } from '../src/utils/metaRoute.js';
import { comparisonFor } from '../src/utils/comparisonSpec.js';

describe('Meta webhook routing', () => {
  const owners = idOwners([
    { tenantId: 'default', ids: ['111', 'shared'] },
    { tenantId: 'acme', ids: ['222', ' 333 ', 'shared'] },
  ]);

  it('maps each claimed id to its tenant; an id claimed twice belongs to nobody', () => {
    expect(owners.get('111')).toBe('default');
    expect(owners.get('333')).toBe('acme');
    expect(owners.get('shared')).toBe(null);
  });

  it('splits one delivery into one body per tenant, keeping the shape', () => {
    const body = { object: 'instagram', entry: [{ id: '222', changes: [1] }, { id: '111', changes: [2] }, { id: '999' }, { id: 'shared' }] };
    const out = splitByTenant(body, owners, 'default');
    expect(Object.keys(out).sort()).toEqual(['acme', 'default']);
    expect(out.acme).toEqual({ object: 'instagram', entry: [{ id: '222', changes: [1] }] });
    expect(out.default.entry.map((e) => e.id)).toEqual(['111', '999', 'shared']);
  });

  it('a body with no entries stays with the request tenant', () => {
    expect(splitByTenant({ object: 'page' }, owners, 'default')).toEqual({ default: { object: 'page' } });
  });

  it('a tenant claims its own account ids and page-token ids', () => {
    expect(claimedIds({ selfIds: ['1', '2'], pageTokens: { 2: 't', 3: 't' } }).sort()).toEqual(['1', '2', '3']);
    expect(claimedIds({})).toEqual([]);
  });
});

describe('the built-in Assess360 comparison list is the owner\'s only', () => {
  it('another tenant with no list of its own gets no comparison', () => {
    expect(comparisonFor({ settings: { builtIn: false }, name: 'Assess360 vs LeadQuizzes.mp4' })).toBe(null);
  });
});
