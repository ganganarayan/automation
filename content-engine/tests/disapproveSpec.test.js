import { describe, it, expect } from 'vitest';
import { canDisapprove, appDriveFiles } from '../src/utils/disapproveSpec.js';

const A = 'A'.repeat(25);
const B = 'B'.repeat(25);
const C = 'C'.repeat(25);
const P = 'P'.repeat(25);

describe('canDisapprove', () => {
  it('takes anything still waiting, failed or in progress', () => {
    for (const status of ['image_review', 'video_review', 'script_review', 'final_review', 'failed', 'running', 'draft']) {
      expect(canDisapprove({ id: 'x', status })).toBe(true);
    }
  });
  it('refuses what is approved, out, locked or being posted', () => {
    for (const status of ['approved', 'scheduled', 'posted', 'partial', 'disapproved']) expect(canDisapprove({ id: 'x', status })).toBe(false);
    expect(canDisapprove({ id: 'x', status: 'image_review', locked: true })).toBe(false);
    expect(canDisapprove({ id: 'x', status: 'draft', post_status: 'posting' })).toBe(false);
  });
});

describe('appDriveFiles', () => {
  const steps = [
    { key: 'images', artifacts: {
      image: { url: `https://drive.google.com/uc?export=download&id=${A}`, driveId: A },
      render: { videoIds: { portrait: B, feed: C }, videos: { portrait: 'https://pfm.example/v.mp4' } },
      festival: { imageUrl: `https://drive.google.com/uc?export=download&id=${P}`, driveId: P },
      approvalId: '123e4567-e89b-12d3-a456-426614174000',
    } },
    { key: 'publish', artifacts: { channels: [{ id: 'spc_abcdefghijklmnopqrstu' }] } },
  ];
  it('finds the pictures and videos the app made, not the shared festival picture', () => {
    expect(appDriveFiles({ source_type: 'festival' }, steps).sort()).toEqual([A, B, C].sort());
  });
  it('never touches a ready video (its original is yours)', () => {
    expect(appDriveFiles({ source_type: 'drive_folder' }, steps)).toEqual([]);
  });
});

describe('the record reads Disapproved', async () => {
  const { statusText } = await import('../src/utils/libraryStatus.js');
  it('in red', () => expect(statusText('disapproved')).toBe('🔴 Disapproved'));
});
