import { expect, test } from 'bun:test';
import { boardPage } from '../src/page';

const skip = '<a class="skip-link" href="#main">Skip to content</a>';

test('the skip link is the first focusable element in the body', () => {
  const html = boardPage();
  expect(html).toContain(`<body>${skip}`);
  expect(html.indexOf(skip)).toBeLessThan(html.indexOf('<main id="main">'));
});

test('the main content is the skip link target', () => {
  const html = boardPage('', { title: 'Job', description: 'Detail', canonical: 'https://jobs.test/job/abc', view: '<p>Content</p>' });
  expect(html).toContain(skip);
  expect(html).toContain('<main id="main">');
  expect(html).toContain('<p>Content</p>');
});

test('the skip link is hidden until focused', () => {
  const html = boardPage();
  expect(html).toContain('.skip-link{position:absolute;left:-9999px');
  expect(html).toContain('.skip-link:focus{left:12px;top:12px');
});
