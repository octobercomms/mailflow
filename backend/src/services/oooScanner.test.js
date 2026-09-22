import { describe, it, expect } from 'vitest';
import { buildOooPrompt, parseOooResult } from './oooScanner.js';

describe('parseOooResult', () => {
  it('returns null on non-JSON', () => {
    expect(parseOooResult('sorry, I cannot help')).toBe(null);
    expect(parseOooResult(null)).toBe(null);
    expect(parseOooResult(42)).toBe(null);
  });

  it('strips ```json code fences', () => {
    const r = parseOooResult('```json\n{"category":"vacation","person":null,"alt_contacts":[],"source_quote":"back monday","confidence":0.9}\n```');
    expect(r).not.toBe(null);
    expect(r.category).toBe('vacation');
    expect(r.person).toBe(null);
    expect(r.alt_contacts).toEqual([]);
  });

  it('extracts a moved sender with a new email, lowercased', () => {
    const r = parseOooResult(JSON.stringify({
      category: 'left_or_moved',
      person: { name: 'Jane Doe', new_email: 'Jane@NewCo.COM', new_company: 'NewCo', role: 'Editor' },
      alt_contacts: [],
      source_quote: 'I have left and can be reached at jane@newco.com',
      confidence: 0.8,
    }));
    expect(r.category).toBe('left_or_moved');
    expect(r.person.new_email).toBe('jane@newco.com');
    expect(r.person.new_company).toBe('NewCo');
  });

  it('drops invented/invalid emails but keeps the contact name', () => {
    const r = parseOooResult(JSON.stringify({
      category: 'mentions_alt_contact',
      person: null,
      alt_contacts: [{ name: 'Rick Mager', email: 'not-an-email', role: 'Assistant', company: null }],
      source_quote: 'please contact Rick',
      confidence: 0.5,
    }));
    expect(r.alt_contacts).toHaveLength(1);
    expect(r.alt_contacts[0].name).toBe('Rick Mager');
    expect(r.alt_contacts[0].email).toBe(null);
  });

  it('clamps an out-of-range confidence to null', () => {
    const r = parseOooResult(JSON.stringify({ category: 'other', person: null, alt_contacts: [], source_quote: '', confidence: 5 }));
    expect(r.confidence).toBe(null);
  });
});

describe('buildOooPrompt', () => {
  it('produces a system+user message pair and trims the body', () => {
    const msgs = buildOooPrompt({ subject: 'Out of Office', from: 'a@b.com', body: 'x'.repeat(5000) });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toContain('a@b.com');
    // Body is trimmed well under the raw 5000 chars.
    expect(msgs[1].content.length).toBeLessThan(2500);
  });
});
