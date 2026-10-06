/**
 * ui/examples.js — the sample queries offered in the rail, and their menu.
 */

import { el } from './dom.js';
import { run } from './run.js';
import { saveState } from './storage.js';

export const EXAMPLES = [
  {
    labelKey: 'ui.ex.report',
    sql: `SELECT u.id, u.name, COUNT(o.id) AS order_count, SUM(o.total) AS revenue
  FROM users u
  LEFT JOIN orders o ON o.user_id = u.id
 WHERE u.age BETWEEN 18 AND 65
   AND u.country IN ('VN', 'SG')
   AND u.email LIKE '%@gmail.com'
   AND u.deleted_at IS NULL
 GROUP BY u.id, u.name
HAVING COUNT(o.id) > 3
 ORDER BY revenue DESC
 LIMIT 20 OFFSET 40`
  },
  {
    labelKey: 'ui.ex.nulls',
    sql: `SELECT c.id, c.name
  FROM customers c
  LEFT JOIN orders o ON o.customer_id = c.id
 WHERE o.status <> 'cancelled'
   AND c.id NOT IN (SELECT customer_id FROM blocked)`
  },
  {
    labelKey: 'ui.ex.decision',
    sql: `SELECT * FROM bookings
 WHERE (status = 'confirmed' OR status = 'pending')
   AND guests >= 2
   AND check_in >= '2026-01-01'
   AND cancelled_at IS NULL`
  },
  {
    labelKey: 'ui.ex.case',
    sql: `SELECT id,
       CASE WHEN score >= 90 THEN 'A'
            WHEN score >= 80 THEN 'B'
            WHEN score >= 70 THEN 'C'
       END AS grade
  FROM results
 WHERE submitted_at IS NOT NULL`
  },
  {
    labelKey: 'ui.ex.update',
    sql: `UPDATE accounts
   SET balance = balance - :amount,
       updated_at = NOW()
 WHERE id = :account_id
   AND balance >= :amount`
  },
  {
    labelKey: 'ui.ex.insert',
    sql: `INSERT INTO audit_log (user_id, action, detail, created_at)
VALUES (:user_id, 'login', NULL, NOW())`
  }
];

// ---- wiring ----------------------------------------------------------

export function initExamples() {
  const placeholder = document.createElement('option');
  placeholder.value = '';
  el.sample.append(placeholder);
  EXAMPLES.forEach((ex, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    el.sample.append(opt);
  });
  el.sample.addEventListener('change', () => {
    const ex = EXAMPLES[Number(el.sample.value)];
    if (!ex) return;
    el.sql.value = ex.sql;
    el.sample.value = '';
    saveState();
    run();
  });
}
