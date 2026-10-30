/* ══ Het lichtveld ══════════════════════════════════════════════════════════
   De grond onder het glas. Eén kleine WebGL-shader: poollichtgordijnen (de
   laag van Gerrie), een zon die op de echte stand boven Lopik staat, het licht
   van de klant waar je bent, en een rimpel van goud als er geld binnenkomt of
   als je iets goedkeurt. Kleuren komen uit de tokens (--lf-*), dus Dag en Nacht
   zijn hetzelfde veld in een ander licht.

   Zuinig: op een derde van de resolutie getekend (het veld is zacht, de browser
   schaalt het op), hooguit 30 beelden per seconde, stil buiten beeld en in een
   verborgen tabblad, en één stilstaand beeld bij "minder beweging". Zonder
   WebGL tekent CSS een benadering (.lf-fallback). */

// Zon op, zenit en zon onder (NOAA-benadering), in minuten lokale tijd
function sunTimes(date, lat = 51.97, lon = 4.94) {
  const rad = Math.PI / 180;
  const doy = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 864e5);
  const g = 2 * Math.PI / 365 * (doy - 1);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const ha = Math.acos(Math.cos(90.833 * rad) / (Math.cos(lat * rad) * Math.cos(decl)) - Math.tan(lat * rad) * Math.tan(decl)) / rad;
  const noon = 720 - 4 * lon - eqt - date.getTimezoneOffset();
  return { rise: noon - 4 * ha, noon, set: noon + 4 * ha };
}
// Waar staat de zon in het veld? x van links (op) naar rechts (onder), y als boog
function sunPlace(min, rise, set) {
  const s = (min - rise) / (set - rise);
  const up = Math.max(0, Math.min(1, (min - rise + 40) / 80)) * Math.max(0, Math.min(1, (set + 40 - min) / 80));
  const k = Math.max(-0.15, Math.min(1.15, s));
  return { x: 0.06 + 0.88 * k, y: 0.74 + 0.22 * Math.sin(Math.PI * Math.max(0, Math.min(1, k))), amt: up, s };
}

const hexRgb = h => {
  h = h.trim();
  if (h.startsWith('rgb')) { const m = h.match(/[\d.]+/g).map(Number); return [m[0] / 255, m[1] / 255, m[2] / 255]; }
  if (h.length === 4) h = '#' + [...h.slice(1)].map(c => c + c).join('');
  const n = parseInt(h.slice(1, 7), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
};
const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const easeIO = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const reducedMotion = () => document.documentElement.dataset.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches;

const LF_VERT = 'attribute vec2 a;varying vec2 vUv;void main(){vUv=a*.5+.5;gl_Position=vec4(a,0.,1.);}';
const LF_FRAG = `precision highp float;
uniform vec2 uRes;uniform float uTime;
uniform vec3 uBase,uTop,uSun,uA1,uA2,uTint;
uniform vec3 uSunPos;uniform float uTintAmt,uAurora,uDay;uniform vec4 uRip;
varying vec2 vUv;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y);}
float fbm(vec2 p){float v=0.,a=.5;mat2 r=mat2(.8,-.6,.6,.8);
  for(int i=0;i<5;i++){v+=a*noise(p);p=r*p*2.02+vec2(3.1,1.7);a*=.5;}return v;}
void main(){
  vec2 uv=vUv;float asp=uRes.x/uRes.y;vec2 p=vec2(uv.x*asp,uv.y);float t=uTime*.03;
  vec3 col=mix(uBase,uTop,smoothstep(0.,1.,uv.y));
  vec2 q=vec2(fbm(p*.9+vec2(0.,t)),fbm(p*.9+vec2(4.7,-t*.7)));
  vec2 r=vec2(fbm(vec2(p.x*1.25,p.y*.55)+3.*q+vec2(1.7,9.2)+t*.5),fbm(vec2(p.x*1.25,p.y*.55)+3.*q+vec2(8.3,2.8)-t*.4));
  float f=fbm(vec2(p.x*1.1,p.y*.6)+2.4*r);
  float curtain=smoothstep(.36,.86,f)*smoothstep(.02,.8,uv.y)*mix(.28,1.,smoothstep(.12,.78,uv.x));
  vec3 aur=mix(uA1,uA2,smoothstep(.25,.8,r.x));
  col=mix(col,aur,curtain*mix(.72,.62,uDay)*uAurora);
  col+=aur*smoothstep(.6,.7,f)*(1.-smoothstep(.7,.82,f))*.2*uAurora*(1.-uDay)*smoothstep(.3,.9,uv.y)*smoothstep(.3,.85,uv.x);
  vec2 sp=vec2(uSunPos.x*asp,uSunPos.y);float d=length(p-sp);
  float sa=(exp(-d*d*3.6)*mix(.085,.2,uDay)+exp(-d*d*30.)*mix(.1,.26,uDay))*uSunPos.z;
  vec3 warm=mix(uSun,vec3(1.,.55,.28),.35*(1.-uDay));
  col=mix(col+warm*sa*(1.-uDay)*.9,mix(col,uSun,clamp(sa*1.25,0.,1.)),uDay);
  float tm=exp(-pow(length(p-vec2(.82*asp,1.05)),2.)*1.3);
  col=mix(col,uTint,uTintAmt*(.06+.34*tm));
  if(uRip.w>0.){vec2 rp=vec2(uRip.x*asp,uRip.y);float rd=length(p-rp);
    float ring=exp(-pow((rd-uRip.z*.95)*8.,2.))*uRip.w*(1.-smoothstep(.2,1.7,uRip.z));
    col=mix(col,uSun,clamp(ring*.42,0.,1.));}
  float vig=smoothstep(1.3,.2,length((uv-vec2(.5,.6))*vec2(1.05,1.)));
  col*=mix(.8+.2*vig,1.,uDay);
  gl_FragColor=vec4(col,1.);
}`;

function createLight(host, opts = {}) {
  // host: het element waar het veld in komt; tokens worden van host gelezen
  const wrap = document.createElement('div');
  wrap.className = 'lf';
  wrap.setAttribute('aria-hidden', 'true');
  const canvas = document.createElement('canvas');
  wrap.appendChild(canvas);
  const grain = document.createElement('div');
  grain.className = 'grain';
  wrap.appendChild(grain);
  host.prepend(wrap);

  const scale = opts.scale || 0.32;
  const st = {
    pal: null, palFrom: null, palTo: null, palT: 1,
    sun: { x: .2, y: .86, amt: 1 }, sunTo: null,
    tint: [0, 0, 0], tintAmt: 0, tintFrom: 0, tintTo: 0, tintT: 1, tintC0: [0, 0, 0], tintC1: [0, 0, 0],
    aurora: opts.aurora ?? 1, auroraFrom: 1, auroraTo: 1, auroraT: 1,
    rip: null, time: (opts.seed || 7) * 13.7, running: true, visible: true, last: 0, raf: 0,
  };

  const readPal = () => {
    const cs = getComputedStyle(host);
    const g = k => hexRgb(cs.getPropertyValue(k) || '#000');
    return { base: g('--lf-base'), top: g('--lf-top'), sun: g('--lf-sun'), a1: g('--lf-a1'), a2: g('--lf-a2'), day: cs.colorScheme === 'light' || cs.getPropertyValue('color-scheme').trim() === 'light' ? 1 : 0 };
  };
  st.pal = readPal();

  let gl = null, prog = null, U = {};
  try {
    gl = canvas.getContext('webgl', { antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: !!opts.keep, powerPreference: 'low-power' });
  } catch (e) { gl = null; }
  const compile = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const setup = () => {
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, LF_VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, LF_FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link');
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    ['uRes', 'uTime', 'uBase', 'uTop', 'uSun', 'uA1', 'uA2', 'uTint', 'uSunPos', 'uTintAmt', 'uAurora', 'uDay', 'uRip'].forEach(n => { U[n] = gl.getUniformLocation(prog, n); });
  };
  if (gl) {
    try { setup(); } catch (e) { gl = null; }
  }
  if (!gl) wrap.classList.add('lf-fallback');
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); gl = null; wrap.classList.add('lf-fallback'); });

  const size = () => {
    const w = Math.max(2, Math.ceil(wrap.clientWidth * scale)), h = Math.max(2, Math.ceil(wrap.clientHeight * scale));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  };
  const ro = window.ResizeObserver ? new ResizeObserver(() => { size(); draw(true); }) : null;
  if (ro) ro.observe(wrap);

  const syncFallback = () => {
    // De CSS-terugval volgt dezelfde zon en hetzelfde klantlicht
    wrap.style.setProperty('--sx', (st.sun.x * 100).toFixed(1) + '%');
    wrap.style.setProperty('--sy', ((1 - st.sun.y) * 100).toFixed(1) + '%');
    wrap.style.setProperty('--sa', st.sun.amt.toFixed(2));
    wrap.style.setProperty('--ta', st.tintAmt.toFixed(2));
    wrap.style.setProperty('--tc', `rgb(${st.tint.map(v => Math.round(v * 255)).join(',')})`);
  };

  function step(dt) {
    if (st.palT < 1) { st.palT = Math.min(1, st.palT + dt / 900); const k = easeIO(st.palT); const a = st.palFrom, b = st.palTo; st.pal = { base: lerp3(a.base, b.base, k), top: lerp3(a.top, b.top, k), sun: lerp3(a.sun, b.sun, k), a1: lerp3(a.a1, b.a1, k), a2: lerp3(a.a2, b.a2, k), day: lerp(a.day, b.day, k) }; }
    if (st.tintT < 1) { st.tintT = Math.min(1, st.tintT + dt / 1100); const k = easeIO(st.tintT); st.tintAmt = lerp(st.tintFrom, st.tintTo, k); st.tint = lerp3(st.tintC0, st.tintC1, k); }
    if (st.auroraT < 1) { st.auroraT = Math.min(1, st.auroraT + dt / 1200); st.aurora = lerp(st.auroraFrom, st.auroraTo, easeIO(st.auroraT)); }
    if (st.sunTo) { const k = Math.min(1, dt / 500); st.sun = { x: lerp(st.sun.x, st.sunTo.x, k), y: lerp(st.sun.y, st.sunTo.y, k), amt: lerp(st.sun.amt, st.sunTo.amt, k) }; if (Math.abs(st.sun.x - st.sunTo.x) < .0005) st.sunTo = null; }
    if (st.rip) { st.rip.age += dt / 1000; if (st.rip.age > 1.8) st.rip = null; }
  }
  function draw(force) {
    syncFallback();
    if (!gl || (!force && !st.visible)) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    const p = st.pal;
    gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform1f(U.uTime, st.time);
    gl.uniform3fv(U.uBase, p.base); gl.uniform3fv(U.uTop, p.top); gl.uniform3fv(U.uSun, p.sun);
    gl.uniform3fv(U.uA1, p.a1); gl.uniform3fv(U.uA2, p.a2); gl.uniform3fv(U.uTint, st.tint);
    gl.uniform3f(U.uSunPos, st.sun.x, st.sun.y, st.sun.amt);
    gl.uniform1f(U.uTintAmt, st.tintAmt); gl.uniform1f(U.uAurora, st.aurora); gl.uniform1f(U.uDay, p.day);
    gl.uniform4f(U.uRip, st.rip ? st.rip.x : 0, st.rip ? st.rip.y : 0, st.rip ? st.rip.age : 0, st.rip ? st.rip.amt : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  function loop(now) {
    st.raf = requestAnimationFrame(loop);
    const dt = st.last ? Math.min(100, now - st.last) : 16;
    if (now - st.last < 32) return;           // ± 30 beelden per seconde
    st.last = now;
    const still = reducedMotion();
    if (!still) st.time += dt / 1000;
    step(still ? 2000 : dt);
    if (!st.visible || document.hidden) return;
    const busy = st.palT < 1 || st.tintT < 1 || st.auroraT < 1 || st.sunTo || st.rip;
    if (still && !busy && st.drewStill) return;
    st.drewStill = still;
    draw();
  }
  size(); draw(true);
  st.raf = requestAnimationFrame(loop);
  const io = window.IntersectionObserver ? new IntersectionObserver(es => { st.visible = es[0].isIntersecting; if (st.visible) { st.drewStill = false; } }) : null;
  if (io) io.observe(wrap);

  return {
    el: wrap,
    // instant: bij een thema-overgang met View Transitions moet het nieuwe beeld meteen kloppen
    retheme(instant) { st.palFrom = st.pal; st.palTo = readPal(); st.palT = instant || reducedMotion() ? 1 : 0; if (st.palT === 1) st.pal = st.palTo; st.drewStill = false; draw(true); },
    sun(x, y, amt = 1, instant) { if (instant) { st.sun = { x, y, amt }; st.sunTo = null; draw(true); } else st.sunTo = { x, y, amt }; st.drewStill = false; },
    tint(hex, amt) { st.tintC0 = st.tint; st.tintC1 = hex ? hexRgb(hex) : st.tint; st.tintFrom = st.tintAmt; st.tintTo = hex ? amt : 0; st.tintT = 0; st.drewStill = false; },
    aurora(v) { st.auroraFrom = st.aurora; st.auroraTo = v; st.auroraT = 0; st.drewStill = false; },
    ripple(x, y, amt = 1) { if (reducedMotion()) return; st.rip = { x, y, age: 0, amt }; },
    draw: () => draw(true),
    destroy() { cancelAnimationFrame(st.raf); if (ro) ro.disconnect(); if (io) io.disconnect(); wrap.remove(); },
  };
}
