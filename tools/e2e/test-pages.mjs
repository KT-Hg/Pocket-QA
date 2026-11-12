/**
 * tools/e2e/test-pages.mjs — e2e: the test pages the e2e server serves. Run by tools/e2e.mjs.
 */



export const TEST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>e2e</title>
<style>.menu { display: none } .menu.open { display: block } li, [id], .xp { padding: 4px }</style></head>
<body>
<div id="dd" name="ddtrigger">Choose…</div>
<ul id="menu" class="menu"><li>One</li><li>Two</li><li>Three</li></ul>
<div id="vdd">Pick from 1000…</div>
<div id="vlist" class="menu" role="listbox" style="height:150px;overflow-y:auto"><div id="vinner" style="position:relative"></div></div>
<select id="sel"><option>a</option><option>b</option><option>c</option></select>
<div id="2nd:dd">id that needs escaping</div>
<div class="xp">known only by XPath</div>
<input id="out"><input id="big">
<button id="bg1">bg1</button><button id="bg2">bg2</button>
<label for="agree" id="agreeLabel">Agree</label><input type="checkbox" id="agree"><label id="plainLabel">Just text</label>
<input type="file" id="upload">
<button id="choiceA">choiceA</button><button id="choiceB">choiceB</button>
<div id="forms"><input id="formText"><select id="multiSel" multiple><option>m1</option></select></div>
<div data-ext-overlay="test"><button id="overlayBtn">overlay</button><input id="overlayNote"></div>
<table id="people"><tbody>
  <tr><td id="aliceCell">Alice</td><td><button id="edit1" class="edit">Edit</button></td></tr>
  <tr><td id="johnCell">John</td><td><button id="edit2" class="edit special">Edit</button></td></tr>
</tbody></table>
<input name="nick">
<button id="ctDisabled" disabled>ctDisabled</button>
<span style="position:relative;display:inline-block"><button id="ctCovered">ctCovered</button><span id="ctCover" style="position:absolute;inset:0"></span></span>
<input id="ctReadonly" readonly><button id="ctHidden" style="display:none">ctHidden</button>
<input type="file" id="ctFileDisabled" disabled><input type="file" id="ctFileHidden" style="display:none">
<script>
  window.__log = [];
  document.getElementById('ctCovered').addEventListener('click', () => __log.push('ctCovered'));
  // background-tab: #bg1 adds #late a moment later; every click logs whether the tab was visible.
  const logClick = (el) => el.addEventListener('click', () => __log.push(el.id + ' ' + document.visibilityState));
  logClick(document.getElementById('bg1'));
  logClick(document.getElementById('bg2'));
  logClick(document.getElementById('choiceA'));
  logClick(document.getElementById('choiceB'));
  // shadow-dom (?shadow only): buttons in a shadow root, one added late, and a
  // ticker that keeps the light DOM changing as a busy app does.
  if (location.search.includes('shadow')) {
    customElements.define('shadow-box', class extends HTMLElement {
      constructor() { super(); this.attachShadow({ mode: 'open' }); }
    });
    const host = document.createElement('shadow-box');
    document.body.append(host);
    const addShadowButton = (id) => {
      const b = document.createElement('button');
      b.id = id;
      b.addEventListener('click', () => __log.push('shadow ' + id));
      host.shadowRoot.append(b);
    };
    addShadowButton('shadowBtn');
    setTimeout(() => addShadowButton('lateShadowBtn'), 700);
    const ticker = document.createElement('span');
    document.body.append(ticker);
    setInterval(() => { ticker.textContent = String(Date.now() % 1000); }, 50);
  }
  // hotkeys: every Alt+key the page sees, and whether the extension kept it.
  window.addEventListener('keydown', (e) => { if (e.altKey) __log.push('key ' + e.code + ' ' + (e.defaultPrevented ? 'prevented' : 'free')); });
  // select-type: which element under #forms a Child Condition clicked.
  document.getElementById('forms').addEventListener('click', (e) => __log.push('forms ' + e.target.id));
  // child-condition: which element under #people a Child Condition clicked.
  document.getElementById('people').addEventListener('click', (e) => __log.push('people ' + (e.target.id || e.target.tagName)));
  document.getElementById('bg1').addEventListener('click', () => setTimeout(() => {
    const late = document.createElement('button');
    late.id = 'late';
    logClick(late);
    document.body.append(late);
  }, 500));
  const dd = document.getElementById('dd'), menu = document.getElementById('menu');
  dd.addEventListener('click', () => { menu.classList.add('open'); __log.push('dd open'); });
  menu.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => {
    dd.textContent = li.textContent; menu.classList.remove('open'); __log.push('picked ' + li.textContent);
  }));
  // A list of 1000 that renders only the rows in view (and a few more), as react-window does;
  // ?mixed: 120 rows of 30 and 40 px by turns.
  const vdd = document.getElementById('vdd'), vlist = document.getElementById('vlist'), vinner = document.getElementById('vinner');
  const mixed = location.search.includes('mixed');
  const heights = Array.from({ length: mixed ? 120 : 1000 }, (_, i) => (mixed && i % 2 ? 40 : 30));
  const tops = heights.map((_, i) => heights.slice(0, i).reduce((a, h) => a + h, 0));
  vinner.style.height = (tops[tops.length - 1] + heights[heights.length - 1]) + 'px';
  const vrender = () => {
    let first = 0;
    while (first < tops.length - 1 && tops[first + 1] <= vlist.scrollTop) first++;
    const last = Math.min(tops.length - 1, first + 7);
    vinner.replaceChildren(...Array.from({ length: last - first + 1 }, (_, k) => {
      const row = document.createElement('div');
      row.setAttribute('role', 'option');
      row.textContent = 'Item ' + (first + k + 1);
      row.style.cssText = 'position:absolute;left:0;right:0;height:' + heights[first + k] + 'px;top:' + tops[first + k] + 'px';
      row.addEventListener('click', () => { vdd.textContent = row.textContent; vlist.classList.remove('open'); });
      return row;
    }));
  };
  vlist.addEventListener('scroll', vrender);
  vdd.addEventListener('click', () => { vlist.classList.add('open'); vlist.scrollTop = 0; vrender(); });
  document.getElementById('2nd:dd').addEventListener('click', () => __log.push('id dropdown clicked'));
  document.querySelector('.xp').addEventListener('click', () => __log.push('xpath dropdown clicked'));
</script></body></html>`;

/**
 * The page EXPORT_PAGE frames (same origin): a field and a button whose click its
 * parent marks, and for the CDP steps a file input, a drop zone, a dropdown and a
 * box of known size to capture.
 */
export const FRAME_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>frame</title></head>
<body><input id="fName"><button id="fGo">go</button>
<input type="file" id="fFiles" multiple><div id="fZone">frame drop</div>
<div id="fDd">frame choose</div><ul id="fMenu" style="display:none"><li>fa</li><li>fb</li></ul>
<span id="fShot" style="display:inline-block;width:57px;height:23px;background:#f80"></span>
<script>
  const frameMark = (m) => { try { parent.frameMark(m); } catch (e) { /* another origin: nothing to tell */ } };
  document.getElementById('fGo').addEventListener('click', () => frameMark('frame go ' + document.getElementById('fName').value));
  const fFiles = document.getElementById('fFiles');
  fFiles.addEventListener('change', () => frameMark('frame files ' + [...fFiles.files].map((f) => f.name).join(',')));
  const fZone = document.getElementById('fZone');
  for (const t of ['dragenter', 'dragover']) fZone.addEventListener(t, (e) => e.preventDefault());
  fZone.addEventListener('drop', (e) => { e.preventDefault(); frameMark('frame zone ' + [...e.dataTransfer.files].map((f) => f.name).join(',')); });
  const fMenu = document.getElementById('fMenu');
  document.getElementById('fDd').addEventListener('click', (e) => { fMenu.style.display = 'block'; frameMark('frame dd ' + (e.isTrusted ? 'trusted' : 'untrusted')); });
  fMenu.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => { fMenu.style.display = 'none'; frameMark('frame picked ' + li.textContent); }));
</script></body></html>`;
