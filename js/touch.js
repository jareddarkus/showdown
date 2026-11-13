/* Cube League — touch controls (phones/tablets). Only active on touch devices (or with ?touch=1).
 *  • Left side: a faint floating joystick. It acts exactly like the controller's left stick (roll / steer / aim).
 *  • Right side: one plain button = jump / dash (same as Space / R1).
 * Both are deliberately translucent so they don't distract. Exposes CubeTouch.state = { active, x, y } (x,y in -1..1).
 */
(function (root) {
  'use strict';
  const q = new URLSearchParams(root.location.search);
  const enabled = q.has('touch') ? q.get('touch') !== '0' : !!(root.matchMedia && root.matchMedia('(pointer: coarse)').matches);
  const state = { active: false, x: 0, y: 0 };
  const api = { enabled, state, onPress: null };
  root.CubeTouch = api;
  if (!enabled) return;

  const R = 58;                                   // joystick travel radius in px
  const css = document.createElement('style');
  css.textContent = `
    #touch { position:fixed; inset:0; pointer-events:none; z-index:5; --op:.15; -webkit-user-select:none; user-select:none; -webkit-touch-callout:none; }
    #touch * { touch-action:none; -webkit-tap-highlight-color:transparent; }
    #tzone { position:absolute; left:0; bottom:0; width:55%; height:78%; pointer-events:auto; }
    #tbase { position:absolute; width:${R * 2 + 24}px; height:${R * 2 + 24}px; margin:${-(R + 12)}px 0 0 ${-(R + 12)}px;
      border:2px solid rgba(35,35,43,var(--op)); background:rgba(35,35,43,.04); opacity:1; pointer-events:none; }
    #tknob { position:absolute; left:50%; top:50%; width:54px; height:54px; margin:-27px 0 0 -27px;
      background:rgba(35,35,43,var(--op)); pointer-events:none; }
    #tbtn { position:absolute; right:max(28px, env(safe-area-inset-right)); bottom:max(48px, env(safe-area-inset-bottom)); width:92px; height:92px;
      border:2px solid rgba(35,35,43,var(--op)); background:rgba(35,35,43,.04); pointer-events:auto; }
    #tbtn.down { background:rgba(35,35,43,var(--op)); }
    #tbase.on { border-color:rgba(35,35,43,.32); }
  `;
  document.head.appendChild(css);
  document.body.classList.add('touch');

  const root_ = document.createElement('div');
  root_.id = 'touch';
  root_.innerHTML = '<div id="tzone"></div><div id="tbase"><div id="tknob"></div></div><div id="tbtn"></div>';
  document.body.appendChild(root_);
  const zone = root_.querySelector('#tzone'), base = root_.querySelector('#tbase'), knob = root_.querySelector('#tknob'), btn = root_.querySelector('#tbtn');
  document.addEventListener('contextmenu', e => e.preventDefault());

  // Resting position of the joystick (it jumps to wherever the thumb lands, then returns).
  const home = () => ({ x: Math.max(R + 24, innerWidth * 0.12), y: innerHeight - Math.max(R + 28, innerHeight * 0.2) });
  const place = (x, y) => { base.style.left = x + 'px'; base.style.top = y + 'px'; };
  const rest = () => { const h = home(); place(h.x, h.y); knob.style.transform = 'translate(0,0)'; base.classList.remove('on'); };
  rest(); addEventListener('resize', () => { if (!state.active) rest(); });

  let joyId = null, cx = 0, cy = 0;
  const move = e => {
    let dx = e.clientX - cx, dy = e.clientY - cy;
    const d = Math.hypot(dx, dy);
    if (d > R) { dx *= R / d; dy *= R / d; }
    knob.style.transform = `translate(${dx}px,${dy}px)`;
    state.x = dx / R; state.y = dy / R;
  };
  zone.addEventListener('pointerdown', e => {
    if (joyId !== null) return;
    e.preventDefault(); joyId = e.pointerId; try { zone.setPointerCapture(joyId); } catch (err) { /* synthetic event */ }
    cx = e.clientX; cy = e.clientY; place(cx, cy); base.classList.add('on');
    state.active = true; move(e);
  });
  zone.addEventListener('pointermove', e => { if (e.pointerId === joyId) { e.preventDefault(); move(e); } });
  const end = e => { if (e.pointerId !== joyId) return; joyId = null; state.active = false; state.x = state.y = 0; rest(); };
  zone.addEventListener('pointerup', end); zone.addEventListener('pointercancel', end); zone.addEventListener('lostpointercapture', end);

  let btnId = null;
  btn.addEventListener('pointerdown', e => {
    e.preventDefault(); btnId = e.pointerId; btn.classList.add('down');
    try { btn.setPointerCapture(btnId); } catch (err) { /* synthetic event */ }
    if (api.onPress) api.onPress();
  });
  const up = e => { if (e.pointerId === btnId) { btnId = null; btn.classList.remove('down'); } };
  btn.addEventListener('pointerup', up); btn.addEventListener('pointercancel', up);
})(window);
