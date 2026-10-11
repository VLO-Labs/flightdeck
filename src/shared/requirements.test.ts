import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_TEMPLATE, PRD_TEMPLATE, checkRevision, featureSlug, isDocPath, nextId, parseRequirements } from './requirements.ts';

const PRD = `# Shop — Product requirements

## Business rules

### BR-001 · Orders need a payment
An order is placed only once its payment is authorised.

Even for staff.

### ~~BR-002~~ Free shipping over 50 (retired)
Replaced by BR-003.

### BR-003: Shipping is quoted at checkout

## Notes
\`\`\`
### BR-099 · inside a code block, not a rule
\`\`\`
- **AC-001** Given a cart, when paying, then the order exists
  and is confirmed by email.
- AC-002 Retired criterion (retired)
- not a criterion BR-004
`;

test('ids at the start of headings and list items, with what they cover', () => {
  const p = parseRequirements(PRD);
  assert.equal(p.title, 'Shop — Product requirements');
  assert.deepEqual(p.items.map(i => [i.id, i.kind, i.retired]), [
    ['BR-001', 'heading', false], ['BR-002', 'heading', true], ['BR-003', 'heading', false],
    ['AC-001', 'item', false], ['AC-002', 'item', true],
  ]);
  const br1 = p.items[0]!;
  assert.equal(br1.title, 'Orders need a payment');
  assert.equal(br1.text, '### BR-001 · Orders need a payment\nAn order is placed only once its payment is authorised.\n\nEven for staff.');
  assert.equal(p.items[1]!.title, 'Free shipping over 50');
  assert.equal(p.items[2]!.title, 'Shipping is quoted at checkout');
  assert.equal(p.items[3]!.text, '- **AC-001** Given a cart, when paying, then the order exists\n  and is confirmed by email.');
  assert.deepEqual(p.outline.map(o => o.level), [1, 2, 3, 3, 3, 2]);
  assert.equal(p.outline[2]!.id, 'BR-001');
  assert.deepEqual(p.duplicates, []);
});

test('templates carry no ids of their own (the examples are in comments)', () => {
  assert.deepEqual(parseRequirements(PRD_TEMPLATE('X')).items, []);
  assert.deepEqual(parseRequirements(FEATURE_TEMPLATE('Checkout')).items, []);
  assert.ok(parseRequirements(PRD_TEMPLATE('X')).outline.some(o => o.title === 'Business rules'));
});

test('a revision may not drop, duplicate or steal an id', () => {
  const p = parseRequirements(PRD);
  assert.deepEqual(checkRevision(p, ['BR-001', 'BR-002'], []), []);
  const dropped = parseRequirements(PRD.replace(/### ~~BR-002~~[^\n]*\n/, ''));
  assert.match(checkRevision(dropped, ['BR-001', 'BR-002'], []).join(), /Removed: BR-002/);
  // Moved to another document: fine.
  assert.deepEqual(checkRevision(dropped, ['BR-002'], ['BR-002']), []);
  const dup = parseRequirements('### BR-001 · a\n### BR-001 · b\n');
  assert.match(checkRevision(dup, [], []).join(), /Duplicate id: BR-001/);
  assert.match(checkRevision(p, [], ['AC-001']).join(), /another document: AC-001/);
});

test('next id: one above the highest ever used', () => {
  assert.equal(nextId('BR', ['BR-001', 'BR-007', 'AC-020', 'BR-003']), 'BR-008');
  assert.equal(nextId('AC', []), 'AC-001');
  assert.equal(nextId('BR', ['BR-999']), 'BR-1000');
});

test('document paths: the PRD and features/<slug>.md, nothing else', () => {
  assert.ok(isDocPath('PRD.md') && isDocPath('features/checkout-flow.md'));
  for (const bad of ['../PRD.md', 'features/../PRD.md', 'features/a/b.md', 'features/.md', 'features/X.md', 'other.md', '/etc/passwd', 'features/a.md/'])
    assert.ok(!isDocPath(bad), bad);
  assert.equal(featureSlug('  Checkout & Payment! '), 'checkout-payment');
});
