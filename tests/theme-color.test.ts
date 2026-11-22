import { expect, test } from 'bun:test';
import { boardPage } from '../src/page';

test('the page declares light and dark theme colors', () => {
  const html = boardPage();
  expect(html).toContain('<meta name="theme-color" content="#eeece5">');
  expect(html).toContain('<meta name="theme-color" content="#121210" media="(prefers-color-scheme: dark)">');
});
