import { describe, it, expect } from 'vitest';
import { buildOooPrompt, parseOooResult, suggestionsToCsv } from './oooScanner.js';

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

describe('suggestionsToCsv', () => {
  it('emits a header and one row per moved sender, preferring the new email', () => {
    const csv = suggestionsToCsv([{
      category: 'left_or_moved', person_name: 'Jane Doe', person_email: 'jane@old.com',
      new_email: 'jane@new.com', new_company: 'NewCo', role: 'Editor', alt_contacts: [],
      from_email: 'jane@old.com', subject: 'Automatic reply', message_date: '2026-03-14T09:26:00Z',
      confidence: 0.9, source_quote: 'I have left Old.',
    }]);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('"name","email","company","role","change_type","source_sender","source_subject","source_date","confidence","quote"');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"Jane Doe"');
    expect(lines[1]).toContain('"jane@new.com"');
    expect(lines[1]).toContain('"moved / new address"');
    expect(lines[1]).toContain('"2026-03-14"');
    expect(lines[1]).toContain('"0.90"');
  });

  it('emits one row per mentioned alternate contact', () => {
    const csv = suggestionsToCsv([{
      category: 'mentions_alt_contact', person_name: null, person_email: 'x@firm.com',
      new_email: null, new_company: null, role: null,
      alt_contacts: [
        { name: 'Tom Reed', email: 'tom@firm.com', role: 'Press', company: 'Firm' },
        { name: 'Amy Lo', email: 'amy@firm.com', role: null, company: null },
      ],
      from_email: 'x@firm.com', subject: 'Out of office', message_date: null, confidence: null, source_quote: 'contact Tom or Amy',
    }]);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(3); // header + 2 contacts
    expect(lines[1]).toContain('"Tom Reed"');
    expect(lines[2]).toContain('"Amy Lo"');
    expect(lines[1]).toContain('"mentioned contact"');
  });

  it('escapes quotes and commas in fields', () => {
    const csv = suggestionsToCsv([{
      category: 'left_or_moved', person_name: 'Doe, Jane', person_email: null,
      new_email: 'j@n.com', new_company: 'A "big" firm', role: null, alt_contacts: [],
      from_email: null, subject: null, message_date: null, confidence: null, source_quote: null,
    }]);
    const row = csv.trim().split('\r\n')[1];
    expect(row).toContain('"Doe, Jane"');
    expect(row).toContain('"A ""big"" firm"');
  });

  it('returns just the header for no rows', () => {
    expect(suggestionsToCsv([]).trim().split('\r\n')).toHaveLength(1);
    expect(suggestionsToCsv(null).trim().split('\r\n')).toHaveLength(1);
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
