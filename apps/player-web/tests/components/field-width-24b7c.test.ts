import assert from 'node:assert/strict';
import test from 'node:test';
import { widthClassOf } from '../../src/features/admin/ui/field-width.ts';

// Part 24b-7c: a single-line field's width class comes from its real limit (stub elements; no DOM needed).
const field = (tag: string, props: { type?: string; maxLength?: number; attrs?: Record<string, string> } = {}) =>
  ({
    tagName: tag.toUpperCase(),
    type: props.type ?? 'text',
    maxLength: props.maxLength ?? -1,
    getAttribute: (name: string) => props.attrs?.[name] ?? null,
  }) as unknown as HTMLInputElement;

test('24b-7c width classes: numbers xs, codes s, names m, long limits l, selects fit, paragraphs full', () => {
  assert.equal(widthClassOf(field('input', { type: 'number' })), 'xs');
  assert.equal(widthClassOf(field('input', { maxLength: 6 })), 'xs');
  assert.equal(widthClassOf(field('input', { maxLength: 12 })), 's');
  assert.equal(widthClassOf(field('input', { maxLength: 40 })), 'm');
  assert.equal(widthClassOf(field('input', { maxLength: 60 })), 'l');
  assert.equal(widthClassOf(field('input', { type: 'email', maxLength: 254 })), 'm');
  assert.equal(widthClassOf(field('input', { type: 'date' })), 's');
  assert.equal(widthClassOf(field('select')), 'fit');
  assert.equal(widthClassOf(field('textarea')), 'full');
  assert.equal(widthClassOf(field('textarea', { maxLength: 30, attrs: { 'data-grow': 'one' } })), 'm');
  assert.equal(widthClassOf(field('input')), 'm', 'no limit stated: a name-sized field');
});
