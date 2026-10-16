import { describe, expect, it } from 'vitest';
import { diffFields, diffText } from '../../src/proposals/diff.js';
import { summarizeContent } from '../../src/mcp/tools/intelligence.js';

describe('field diffing', () => {
  it('reports only the metadata fields that changed', () => {
    const changes = diffFields(
      { title: 'Old', description: 'same', type: 'published' },
      { title: 'New', description: 'same', type: 'published' }
    );
    expect(changes.filter((change) => change.changed).map((change) => change.field)).toEqual(['title']);
  });

  it('ignores fields the caller did not propose', () => {
    const changes = diffFields({ title: 'Old' }, { description: 'only this' });
    expect(changes.map((change) => change.field)).toEqual(['description']);
  });

  it('flags a whitespace-only change', () => {
    const [change] = diffFields({ title: 'Title' }, { title: '  Title  ' });
    expect(change?.changed).toBe(true);
    expect(change?.whitespaceOnly).toBe(true);
  });

  it('normalizes arrays and missing values for comparison', () => {
    const changes = diffFields({ tags: ['a', 'b'] }, { tags: ['a', 'b'] });
    expect(changes[0]?.changed).toBe(false);
    expect(changes[0]?.before).toBe('a, b');
  });

  it('does not include the body, which is diffed as text', () => {
    expect(diffFields({}, { content: 'x' }).map((change) => change.field)).not.toContain('content');
  });
});

describe('text diffing', () => {
  it('reports identical text without a patch', () => {
    const result = diffText('a\nb', 'a\nb');
    expect(result.identical).toBe(true);
    expect(result.patch).toBe('');
  });

  it('shows added and removed lines with context', () => {
    const result = diffText('one\ntwo\nthree', 'one\nTWO\nthree');
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.patch).toContain('-two');
    expect(result.patch).toContain('+TWO');
    expect(result.patch).toContain(' one');
  });

  it('handles a pure append', () => {
    const result = diffText('a\nb', 'a\nb\nc');
    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
  });

  it('falls back to whole-block replacement for a very large rewrite', () => {
    const before = Array.from({ length: 2000 }, (_, i) => `old ${i}`).join('\n');
    const after = Array.from({ length: 2000 }, (_, i) => `new ${i}`).join('\n');
    const result = diffText(before, after);
    expect(result.added).toBe(2000);
    expect(result.removed).toBe(2000);
  });

  it('truncates a very long patch rather than returning it whole', () => {
    const before = Array.from({ length: 800 }, (_, i) => `line ${i}`).join('\n');
    const after = Array.from({ length: 800 }, (_, i) => `changed ${i}`).join('\n');
    const result = diffText(before, after, 50);
    expect(result.truncated).toBe(true);
    expect(result.patch).toContain('patch truncated');
  });
});

describe('content summaries', () => {
  it('counts words, headings, links and images', () => {
    const summary = summarizeContent({
      key: 'p',
      title: 'T',
      description: 'D',
      contentRaw: '# Heading\n\nSome words here.\n\n## Sub\n\n[link](https://x.test) and ![img](https://x.test/i.png)\n'
    });
    expect(summary.headings).toEqual([
      { level: 1, text: 'Heading' },
      { level: 2, text: 'Sub' }
    ]);
    expect(summary.links).toBe(1);
    expect(summary.images).toBe(1);
    expect(summary.hasDescription).toBe(true);
  });

  it('warns about a missing description, missing headings and short content', () => {
    const summary = summarizeContent({ key: 'p', title: 'T', description: '', contentRaw: 'tiny' });
    expect(summary.warnings).toEqual(
      expect.arrayContaining(['No description set.', 'No Markdown headings found.', 'Content is short (under 80 words).'])
    );
  });

  it('flags template-looking braces', () => {
    const summary = summarizeContent({ key: 'p', title: 'T', description: 'd', contentRaw: 'Hello {{name}}' });
    expect(summary.warnings).toContain('Content contains template-like braces.');
  });

  it('estimates reading time at a round number of minutes', () => {
    const long = Array.from({ length: 400 }, () => 'word').join(' ');
    expect(summarizeContent({ key: 'p', title: 'T', description: 'd', contentRaw: long }).readingMinutes).toBe(2);
  });
});
