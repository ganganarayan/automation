import { describe, it, expect } from 'vitest';
import { routerClash } from '../src/utils/routerSpec.js';

const day = { id: 1, lane: 'ready_video', instance_id: 7 };

describe('routerClash: a hand-scheduled post on a day the router filled', () => {
  it('no clash when the router has nothing for that day', () => {
    expect(routerClash(null, null, { instanceId: 9 })).toBeNull();
    expect(routerClash({ id: 1, lane: 'none', instance_id: null }, null, { instanceId: 9 })).toBeNull();
  });

  it('no clash with itself (same instance or same video)', () => {
    expect(routerClash(day, { id: 7, status: 'draft' }, { instanceId: 7 })).toBeNull();
    expect(routerClash(day, { id: 7, status: 'draft', source_ref: 'abc' }, { instanceId: 9, driveId: 'abc' })).toBeNull();
  });

  it('no clash when the router pick failed or was replaced', () => {
    expect(routerClash(day, { id: 7, status: 'failed' }, { instanceId: 9 })).toBeNull();
    expect(routerClash(day, { id: 7, status: 'superseded' }, { instanceId: 9 })).toBeNull();
  });

  it('a pick waiting for approval can be replaced', () => {
    expect(routerClash(day, { id: 7, status: 'video_review', source_type: 'drive_folder', source_ref: 'x' }, { instanceId: 9, driveId: 'y' })).toEqual({ canReplace: true });
    expect(routerClash(day, { id: 7, status: 'image_review', source_type: 'sheet' }, { instanceId: 9 })).toEqual({ canReplace: true });
  });

  it('a pick already scheduled with Post for Me can only be posted alongside', () => {
    expect(routerClash(day, { id: 7, status: 'scheduled', source_type: 'drive_folder' }, { instanceId: 9 })).toEqual({ canReplace: false });
  });
});
