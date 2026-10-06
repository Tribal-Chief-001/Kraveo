import { describe, expect, it } from 'vitest';
import { decisionToast, isSessionRejected, reassignFailureMessage, sessionRetryDelayMs } from './adminMessages';

describe('WEB-04 reassignFailureMessage', () => {
  it('turns the rider error codes into plain sentences without API jargon', () => {
    const offline = reassignFailureMessage('RIDER_OFFLINE', 'That rider is offline. Send force: true to assign them anyway.');
    const busy = reassignFailureMessage('RIDER_BUSY', 'That rider already has an active order. Finish or move it first.');
    expect(offline).toMatch(/offline/);
    expect(offline).not.toMatch(/force/i);
    expect(busy).toMatch(/already has an active order/);
  });
  it('passes other messages through', () => {
    expect(reassignFailureMessage('ORDER_NOT_FOUND', 'Order not found.')).toBe('Order not found.');
    expect(reassignFailureMessage(undefined, 'Boom')).toBe('Boom');
  });
});

describe('WEB-10 decisionToast', () => {
  it('reactivating a suspended restaurant says it stays closed', () => {
    const [title, text] = decisionToast({ kind: 'VENDOR', status: 'SUSPENDED' }, 'APPROVED', 'Sharma Dhaba');
    expect(title).toBe('Reactivated');
    expect(text).toContain('closed until the restaurant opens it');
  });
  it('approving a pending restaurant and the other decisions keep their wording', () => {
    expect(decisionToast({ kind: 'VENDOR', status: 'PENDING' }, 'APPROVED', 'X')).toEqual(['Approved', 'X can start working now.']);
    expect(decisionToast({ kind: 'DRIVER', status: 'APPROVED' }, 'SUSPENDED', 'Ravi')[0]).toBe('Suspended');
    expect(decisionToast({ kind: 'DRIVER', status: 'PENDING' }, 'REJECTED', 'Ravi')[0]).toBe('Rejected');
  });
  it('reactivating a rider does not talk about a closed restaurant', () => {
    expect(decisionToast({ kind: 'DRIVER', status: 'SUSPENDED' }, 'APPROVED', 'Ravi')[1]).not.toMatch(/closed/);
  });
});

describe('WEB-07 session check', () => {
  it('only 401 and 403 reject the stored session', () => {
    expect(isSessionRejected({ status: 401 })).toBe(true);
    expect(isSessionRejected({ status: 403 })).toBe(true);
    for (const status of [0, 429, 500, 502, 503, 504, 404]) expect(isSessionRejected({ status })).toBe(false);
    expect(isSessionRejected(new Error('network'))).toBe(false);
    expect(isSessionRejected(null)).toBe(false);
  });
  it('retries back off from 2 s to a 30 s ceiling', () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(sessionRetryDelayMs)).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });
});
