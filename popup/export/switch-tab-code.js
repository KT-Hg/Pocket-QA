/**
 * export/switch-tab-code.js — ↗ / ↩ Switch tab (bg/playback/steps/switch-tab.js)
 * in exported code: a new tab is one the test has not seen before, waited for up
 * to the step's time; going back returns to the tab the test came from, closing
 * the one it leaves when the step says so. A Bookmarklet cannot follow a tab.
 *
 * Pure — no chrome.*.
 */

// How long a ↗ step waits for its tab, in whole seconds, as playback waits (`timeout` ms, else 10 s).
export const SWITCH_TAB_SECONDS = 10;

export function switchTabWaitSeconds(action) {
  const ms = Number(action?.timeout);
  return ms > 0 ? Math.max(1, Math.round(ms / 1000)) : SWITCH_TAB_SECONDS;
}

/** Playwright: the helpers (the test watches its context's pages from its start). */
export const PW_TABS_HELPER = `// ↗ Switch tab, as the extension plays it: a page the context opened that no step has taken
// yet, waited for; ↩ back to the page a step came from, closing the one left when asked.
function _watchTabs(context) {
  const tabs = { stack: [], opened: [], used: new Set() };
  context.on('page', (p) => tabs.opened.push(p));
  return tabs;
}
async function _newTab(tabs, page, seconds) {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const p = tabs.opened.find((o) => !tabs.used.has(o) && !o.isClosed());
    if (p) {
      tabs.used.add(p);
      tabs.stack.push(page);
      await p.waitForLoadState();
      await p.bringToFront();
      return p;
    }
    if (Date.now() > end) throw new Error(\`No new tab opened by this one within \${seconds} s\`);
    await new Promise((r) => setTimeout(r, 150));
  }
}
async function _backTab(tabs, page, close) {
  const back = tabs.stack.pop();
  if (!back) throw new Error('No tab to go back to: the test is on the tab it started on');
  if (close && !page.isClosed()) await page.close();
  await back.bringToFront();
  return back;
}`;

/** Playwright: the step's line. */
export const pwSwitchTabLine = (a) => (a.tabTarget === 'back'
  ? `page = await _backTab(_tabs, page, ${a.closeTab ? 'true' : 'false'});`
  : `page = await _newTab(_tabs, page, ${switchTabWaitSeconds(a)});`);

/** Selenium Python: the helpers; `_tabs["seen"]` is filled right after the browser starts. */
export const PY_TABS_HELPER = [
  '_tabs = {"stack": [], "seen": set()}',
  '',
  '',
  'def _new_tab(driver, timeout):',
  '    """↗ Switch tab: a tab the test has not seen before, waited for up to timeout s; the steps after play there."""',
  '    end = time.time() + timeout',
  '    while True:',
  '        new = [h for h in driver.window_handles if h not in _tabs["seen"]]',
  '        if new:',
  '            _tabs["seen"].add(new[0])',
  '            _tabs["stack"].append(driver.current_window_handle)',
  '            driver.switch_to.window(new[0])',
  '            return',
  '        if time.time() > end:',
  '            raise Exception(f"No new tab opened by this one within {timeout} s")',
  '        time.sleep(0.15)',
  '',
  '',
  'def _back_tab(driver, close):',
  '    """↩ Switch tab: back to the tab the test came from, closing this one first when asked."""',
  '    if not _tabs["stack"]:',
  '        raise Exception("No tab to go back to: the test is on the tab it started on")',
  '    back = _tabs["stack"].pop()',
  '    if close:',
  '        try:',
  '            driver.close()',
  '        except Exception:',
  '            pass  # the page closed it already',
  '    driver.switch_to.window(back)',
];

export const pySwitchTabLine = (a) => (a.tabTarget === 'back'
  ? `_back_tab(driver, ${a.closeTab ? 'True' : 'False'})`
  : `_new_tab(driver, ${switchTabWaitSeconds(a)})`);

/** Robot Framework: the two keywords (`@{PQA_TABS}` holds the tabs the test came from). */
export const ROBOT_TABS_KEYWORDS = `Switch To New Tab
    [Documentation]    ↗ Switch tab, as the extension plays it: the tab the page opened, waited for up to \${seconds} s.
    [Arguments]    \${seconds}
    \${prev}=    Wait Until Keyword Succeeds    \${seconds}s    0.2s    Switch Window    NEW
    Evaluate    $PQA_TABS.append($prev)

Switch Back Tab
    [Documentation]    ↩ Switch tab: back to the tab the test came from, closing this one first when asked.
    [Arguments]    \${close}
    IF    not $PQA_TABS    Fail    No tab to go back to: the test is on the tab it started on
    \${back}=    Evaluate    $PQA_TABS.pop()
    IF    $close    Run Keyword And Ignore Error    Close Window
    Switch Window    \${back}`;

export const robotSwitchTabLine = (a) => (a.tabTarget === 'back'
  ? `Switch Back Tab    \${${a.closeTab ? 'True' : 'False'}}`
  : `Switch To New Tab    ${switchTabWaitSeconds(a)}`);

/** Selenium Java: the helpers; seenTabs is filled right after the browser starts. */
export const JAVA_TABS_HELPER = `    final java.util.Deque<String> tabStack = new java.util.ArrayDeque<>();
    final java.util.Set<String> seenTabs = new java.util.HashSet<>();

    /** ↗ Switch tab: a tab the test has not seen before, waited for up to the seconds given; the steps after play there. */
    void newTab(int seconds) throws InterruptedException {
        long end = System.currentTimeMillis() + seconds * 1000L;
        while (true) {
            for (String h : driver.getWindowHandles()) {
                if (seenTabs.add(h)) {
                    tabStack.push(driver.getWindowHandle());
                    driver.switchTo().window(h);
                    return;
                }
            }
            if (System.currentTimeMillis() > end) throw new IllegalStateException("No new tab opened by this one within " + seconds + " s");
            Thread.sleep(150);
        }
    }

    /** ↩ Switch tab: back to the tab the test came from, closing this one first when asked. */
    void backTab(boolean close) {
        if (tabStack.isEmpty()) throw new IllegalStateException("No tab to go back to: the test is on the tab it started on");
        String back = tabStack.pop();
        if (close) {
            try {
                driver.close();
            } catch (WebDriverException e) {
                // the page closed it already
            }
        }
        driver.switchTo().window(back);
    }`;

export const javaSwitchTabLine = (a) => (a.tabTarget === 'back'
  ? `backTab(${a.closeTab ? 'true' : 'false'});`
  : `newTab(${switchTabWaitSeconds(a)});`);
