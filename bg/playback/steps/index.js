/**
 * playback/steps/index.js — the action types playback knows, one step function each.
 */

import { runNavigate } from './navigate.js';
import { runWait } from './wait.js';
import { runDropdown } from './dropdown.js';
import { runScript } from './script.js';
import { runElementScreenshot, runScreenshotToVar, runScreenshot } from './screenshot.js';
import { runReadDom } from './readdom.js';
import { runCondition } from './condition.js';
import { runSwitch } from './switch.js';
import { runUploadFile } from './upload.js';

export { runOnPage } from './dom.js';
export { STOP } from './flow.js';

/**
 * A step is `async (ctx, i, action) => next`. `action` has the run's variables
 * applied; `ctx` is the run (see playActionsOnTab in bg/playback.js). `next` is
 * the index the loop carries on from — its i++ then moves past it, so i - 1 runs
 * action i again (retry) — or STOP to end the run. A type not in this map is
 * played by the content script (runOnPage).
 */
export const STEPS = new Map([
  ['navigate', runNavigate],
  ['wait', runWait],
  ['dropdown', runDropdown],
  ['script', runScript],
  ['screenshot_element', runElementScreenshot],
  ['screenshot_tovar', runScreenshotToVar],
  ['screenshot', runScreenshot],
  ['screenshot_full', runScreenshot],
  ['readdom', runReadDom],
  ['condition', runCondition],
  ['switch', runSwitch],
  ['uploadFile', runUploadFile],
]);
