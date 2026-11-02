import { afterEach, describe, expect, it, vi } from 'vitest';
import { mdToHtml, rtl, sendHtml, splitMarkdown } from '../src/telegram';
import { json, mockFetch, telegramCalls, testEnv } from './helpers';

afterEach(() => vi.restoreAllMocks());

describe('mdToHtml', () => {
  it('converts the Markdown Claude writes into Telegram HTML', () => {
    const html = mdToHtml('# Plan\n**Top 3** and *focus* `a<b`\n- first [link](https://x.org/a?b=1&c=2)\n---\nend');
    expect(html).toContain('<b>Plan</b>');
    expect(html).toContain('<b>Top 3</b> and <i>focus</i> <code>a&lt;b</code>');
    expect(html).toContain('• first <a href="https://x.org/a?b=1&amp;c=2">link</a>');
    expect(html).not.toContain('---');
  });

  it('escapes HTML and leaves snake_case alone', () => {
    expect(mdToHtml('<script> my_var_name 2*3*4')).toBe('&lt;script&gt; my_var_name 2*3*4');
  });

  it('turns tables and code fences into <pre>', () => {
    const html = mdToHtml('| a | b |\n|---|---|\n| 1 | 2 |\n\n```\nx < y\n```');
    expect(html).toBe('<pre>| a | b |\n| 1 | 2 |</pre>\n\n<pre>x &lt; y</pre>');
  });

  it('marks Persian lines right-to-left', () => {
    expect(rtl('سلام /T3').startsWith('‏')).toBe(true);
    expect(rtl('hello')).toBe('hello');
    expect(mdToHtml('- خرید نان').startsWith('‏')).toBe(true);
  });
});

describe('splitMarkdown', () => {
  it('splits at paragraph breaks under the limit and never inside a fence', () => {
    const para = 'word '.repeat(30).trim();
    const md = [para, para, '```\nline one\n\nline two\n```', para].join('\n\n');
    const chunks = splitMarkdown(md, 200);
    expect(chunks.every(c => c.length <= 200)).toBe(true);
    expect(chunks.some(c => c.includes('line one\n\nline two'))).toBe(true);
    expect(chunks.join('\n\n')).toBe(md);
  });

  it('hard-splits a single huge paragraph', () => {
    const chunks = splitMarkdown('x'.repeat(9000), 3500);
    expect(chunks.map(c => c.length)).toEqual([3500, 3500, 2000]);
  });
});

describe('sendHtml', () => {
  it('falls back to plain text when Telegram rejects the entities', async () => {
    let first = true;
    const calls = mockFetch(c => {
      if (c.url.endsWith('/sendMessage') && first) {
        first = false;
        return json({ ok: false, error_code: 400, description: "Bad Request: can't parse entities: unclosed tag" }, 400);
      }
      return undefined;
    });
    await sendHtml(testEnv(), '<b>broken');
    const sends = telegramCalls(calls);
    expect(sends).toHaveLength(2);
    expect(sends[1]?.body.parse_mode).toBeUndefined();
    expect(sends[1]?.body.text).toBe('broken');
  });
});
