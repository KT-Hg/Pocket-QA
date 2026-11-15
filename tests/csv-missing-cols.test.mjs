// The "CSV missing columns" warning of Start CSV Run: only the ${names} that no
// column, no Tools tab variable and no step of the scenario gives a value.
// node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { missingCsvColumns } from '../popup/csv/csv-run.js';

const steps = [
  { type: 'input', selector: '#fullName', value: '${customer}' },
  { type: 'input', selector: '#address', value: '${houseNo} Lake Road' },
  { type: 'readdom', selector: '#orderStatus', varName: '', pattern: 'Order #${orderId} confirmed' },
  { type: 'assert', selector: '#orders', expectedValue: '${orderId}' },
  { type: 'assert', selector: '#orderStatus', expectedValue: '${expect}' },
];

test('a Tools tab variable and a name the scenario writes are not missing', () => {
  assert.deepEqual(missingCsvColumns(steps, ['customer', 'shipping', 'expect'], ['houseNo']), []);
});

test('a name nothing gives is still reported', () => {
  assert.deepEqual(missingCsvColumns(steps, ['customer'], []), ['houseNo', 'expect']);
});

test('no steps, no warning', () => {
  assert.deepEqual(missingCsvColumns(undefined, ['a'], []), []);
});
