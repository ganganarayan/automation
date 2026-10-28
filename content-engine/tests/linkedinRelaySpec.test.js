import { describe, it, expect } from 'vitest';
import {
  isLinkedinEmail, classify, extractName, extractFirstLine, extractPostUrl,
  parseLinkedinNotification, buildWhatsappMessage,
} from '../src/utils/linkedinRelaySpec.js';

const commentEmail = {
  from: 'LinkedIn <notifications-noreply@linkedin.com>',
  subject: 'Priya Sharma commented on your post',
  text: [
    'LinkedIn',
    'Priya Sharma commented on your post',
    'This is so insightful, thank you for sharing!',
    'View comment',
    'https://www.linkedin.com/comm/feed/update/urn:li:activity:7123456789?commentUrn=abc',
    'Unsubscribe',
  ].join('\n'),
  html: '<a href="https://www.linkedin.com/comm/feed/update/urn:li:activity:7123456789?commentUrn=abc">View</a>',
};

const messageEmail = {
  from: 'Arjun Rao via LinkedIn <messaging-digest-noreply@linkedin.com>',
  subject: 'Arjun Rao sent you a message',
  text: 'Arjun Rao sent you a message\nHi, are you open to collaborating?\nhttps://www.linkedin.com/messaging/thread/xyz',
  html: '',
};

describe('isLinkedinEmail', () => {
  it('accepts LinkedIn senders, rejects others', () => {
    expect(isLinkedinEmail(commentEmail)).toBe(true);
    expect(isLinkedinEmail({ from: 'Bank <noreply@bank.com>', subject: 'Statement' })).toBe(false);
  });
});

describe('classify', () => {
  it('maps the subject to a kind', () => {
    expect(classify('Priya commented on your post')).toBe('comment');
    expect(classify('Arjun sent you a message')).toBe('message');
    expect(classify('Sam mentioned you in a comment')).toBe('mention');
    expect(classify('Dev reacted to your post')).toBe('reaction');
  });
});

describe('extractName', () => {
  it('takes the name from the subject', () => {
    expect(extractName(commentEmail)).toBe('Priya Sharma');
  });
  it('falls back to the sender display name (minus "via LinkedIn")', () => {
    expect(extractName({ from: 'Arjun Rao via LinkedIn <x@linkedin.com>', subject: 'New notification' })).toBe('Arjun Rao');
  });
});

describe('extractFirstLine', () => {
  it('returns the first meaningful comment line, skipping boilerplate', () => {
    expect(extractFirstLine(commentEmail)).toBe('This is so insightful, thank you for sharing!');
  });
});

describe('extractPostUrl', () => {
  it('prefers a feed/update permalink', () => {
    expect(extractPostUrl(commentEmail)).toContain('/comm/feed/update/urn:li:activity:7123456789');
  });
  it('falls back to any LinkedIn link', () => {
    expect(extractPostUrl(messageEmail)).toContain('linkedin.com/messaging/thread/xyz');
  });
  it('empty when no LinkedIn link', () => {
    expect(extractPostUrl({ text: 'no links here', html: '' })).toBe('');
  });
});

describe('parse + message', () => {
  it('builds a WhatsApp message with name, first line, and link', () => {
    const parsed = parseLinkedinNotification(commentEmail);
    expect(parsed).toMatchObject({ relevant: true, kind: 'comment', name: 'Priya Sharma' });
    const msg = buildWhatsappMessage(parsed);
    expect(msg).toContain('Priya Sharma');
    expect(msg).toContain('This is so insightful');
    expect(msg).toContain('linkedin.com/comm/feed/update');
    expect(msg).toContain('Reply on LinkedIn yourself.');
  });
  it('notes when no post link was found', () => {
    const parsed = parseLinkedinNotification({ from: 'x@linkedin.com', subject: 'Dev reacted to your post', text: 'Dev reacted' });
    expect(buildWhatsappMessage(parsed)).toContain('no post link found');
  });
});
