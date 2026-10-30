import { useEffect, useRef } from 'react';
import { sunTimes } from '../lib/sun';
import { onLight } from '../lib/stroomBus';

/**
 * Het lichtveld van Stroom: de grond onder het glas.
 *
 * Eén kleine WebGL-shader met poollichtgordijnen (de laag van Gerrie, van
 * rechts), een zon die op zijn echte stand boven Nederland staat (links, als
 * gloed), het licht van de klant waar je bent (rechtsboven) en een rimpel van
 * goud als je akkoord geeft. De kleuren komen uit de tokens (--lf-* in
 * stroom.css), dus Dag en Nacht zijn hetzelfde veld in een ander licht.
 *
 * Zuinig: op een derde van de resolutie getekend (het veld is zacht, de
 * browser schaalt het op), hooguit 30 beelden per seconde, stil in een
 * verborgen tabblad. Bij minder beweging, databesparing of een bijna lege
 * batterij tekent CSS dezelfde kleuren (.sl-field.is-css) en draait er niets.
 *
 * Contrast: de zon staat links en het poollicht komt van rechts, weg van de
 * koppen; tekst op het glas haalt AA boven het felste licht dat eronder mag
 * komen (gemeten in het voorstel: Nacht ≥ 5,32:1, Dag ≥ 6,78:1).
 */

const VERT = 'attribute vec2 a;varying vec2 vUv;void main(){vUv=a*.5+.5;gl_Position=vec4(a,0.,1.);}';
const FRAG = `precision highp float;
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

type Rgb = [number, number, number];
interface Palette { base: Rgb; top: Rgb; sun: Rgb; a1: Rgb; a2: Rgb; day: number }

function toRgb(value: string): Rgb {
  const v = value.trim();
  if (v.startsWith('rgb')) {
    const parts = (v.match(/[\d.]+/g) ?? ['0', '0', '0']).map(Number);
    return [parts[0] / 255, parts[1] / 255, parts[2] / 255];
  }
  let hex = v.startsWith('#') ? v.slice(1) : v;
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const n = Number.parseInt(hex.slice(0, 6) || '0', 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mix3 = (a: Rgb, b: Rgb, t: number): Rgb => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Waar staat de zon in het veld? Links bij zon op, rechts bij zon onder, als
 *  boog. `amount` is 0 's nachts en loopt rond zon op en onder in 80 minuten. */
export function sunInField(minute: number, rise: number, set: number): { x: number; y: number; amount: number } {
  const span = Math.max(1, set - rise);
  const k = Math.max(-0.15, Math.min(1.15, (minute - rise) / span));
  const up = Math.max(0, Math.min(1, (minute - rise + 40) / 80)) * Math.max(0, Math.min(1, (set + 40 - minute) / 80));
  // In Stroom staat de zon links (weg van het poollicht en de koppen): hij
  // reist over de linkerhelft in plaats van over het hele veld.
  return { x: 0.05 + 0.42 * k, y: 0.74 + 0.22 * Math.sin(Math.PI * Math.max(0, Math.min(1, k))), amount: up };
}

function readPalette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const get = (name: string) => toRgb(style.getPropertyValue(name) || '#000');
  return {
    base: get('--lf-base'), top: get('--lf-top'), sun: get('--lf-sun'), a1: get('--lf-a1'), a2: get('--lf-a2'),
    day: document.documentElement.getAttribute('data-theme') === 'light' ? 1 : 0,
  };
}

/** Geen WebGL-veld bij minder beweging of databesparing: dan tekent CSS. */
function prefersCss(): boolean {
  if (typeof window === 'undefined') return true;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return true;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return Boolean(connection?.saveData);
}

export function LightField() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    const state = {
      palette: readPalette(),
      from: null as Palette | null,
      to: null as Palette | null,
      paletteT: 1,
      sun: { x: 0.2, y: 0.86, amount: 1 },
      tint: [0, 0, 0] as Rgb, tintAmount: 0,
      tintFrom: 0, tintTo: 0, tintT: 1, tintC0: [0, 0, 0] as Rgb, tintC1: [0, 0, 0] as Rgb,
      ripple: null as null | { x: number; y: number; age: number; amount: number },
      time: 7 * 13.7, last: 0, raf: 0, stillDrawn: false,
    };

    let gl: WebGLRenderingContext | null = null;
    const uniforms: Record<string, WebGLUniformLocation | null> = {};
    let css = prefersCss();

    const useCss = (on: boolean) => {
      css = on;
      wrap.classList.toggle('is-css', on);
    };

    function setup(): boolean {
      try {
        gl = canvas!.getContext('webgl', { antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'low-power' });
      } catch { gl = null; }
      if (!gl) return false;
      const compile = (type: number, source: string) => {
        const shader = gl!.createShader(type)!;
        gl!.shaderSource(shader, source);
        gl!.compileShader(shader);
        if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) throw new Error(gl!.getShaderInfoLog(shader) ?? 'shader');
        return shader;
      };
      try {
        const program = gl.createProgram()!;
        gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
        gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('link');
        gl.useProgram(program);
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        const location = gl.getAttribLocation(program, 'a');
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
        for (const name of ['uRes', 'uTime', 'uBase', 'uTop', 'uSun', 'uA1', 'uA2', 'uTint', 'uSunPos', 'uTintAmt', 'uAurora', 'uDay', 'uRip']) {
          uniforms[name] = gl.getUniformLocation(program, name);
        }
        return true;
      } catch {
        gl = null;
        return false;
      }
    }

    function syncCss() {
      // De CSS-terugval volgt dezelfde zon en hetzelfde klantlicht.
      wrap!.style.setProperty('--sx', `${(state.sun.x * 100).toFixed(1)}%`);
      wrap!.style.setProperty('--sy', `${((1 - state.sun.y) * 100).toFixed(1)}%`);
      wrap!.style.setProperty('--sa', state.sun.amount.toFixed(2));
      wrap!.style.setProperty('--ta', state.tintAmount.toFixed(2));
      wrap!.style.setProperty('--tc', `rgb(${state.tint.map(v => Math.round(v * 255)).join(',')})`);
    }

    function size() {
      const scale = 0.33;
      const width = Math.max(2, Math.ceil(wrap!.clientWidth * scale));
      const height = Math.max(2, Math.ceil(wrap!.clientHeight * scale));
      if (canvas!.width !== width || canvas!.height !== height) { canvas!.width = width; canvas!.height = height; }
    }

    function draw() {
      syncCss();
      if (css || !gl) return;
      const p = state.palette;
      gl.viewport(0, 0, canvas!.width, canvas!.height);
      gl.uniform2f(uniforms.uRes, canvas!.width, canvas!.height);
      gl.uniform1f(uniforms.uTime, state.time);
      gl.uniform3fv(uniforms.uBase, p.base); gl.uniform3fv(uniforms.uTop, p.top); gl.uniform3fv(uniforms.uSun, p.sun);
      gl.uniform3fv(uniforms.uA1, p.a1); gl.uniform3fv(uniforms.uA2, p.a2); gl.uniform3fv(uniforms.uTint, state.tint);
      gl.uniform3f(uniforms.uSunPos, state.sun.x, state.sun.y, state.sun.amount);
      gl.uniform1f(uniforms.uTintAmt, state.tintAmount); gl.uniform1f(uniforms.uAurora, 1); gl.uniform1f(uniforms.uDay, p.day);
      const rip = state.ripple;
      gl.uniform4f(uniforms.uRip, rip ? rip.x : 0, rip ? rip.y : 0, rip ? rip.age : 0, rip ? rip.amount : 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    function step(dt: number) {
      if (state.paletteT < 1 && state.from && state.to) {
        state.paletteT = Math.min(1, state.paletteT + dt / 900);
        const k = easeInOut(state.paletteT);
        const a = state.from, b = state.to;
        state.palette = { base: mix3(a.base, b.base, k), top: mix3(a.top, b.top, k), sun: mix3(a.sun, b.sun, k), a1: mix3(a.a1, b.a1, k), a2: mix3(a.a2, b.a2, k), day: lerp(a.day, b.day, k) };
      }
      if (state.tintT < 1) {
        state.tintT = Math.min(1, state.tintT + dt / 1100);
        const k = easeInOut(state.tintT);
        state.tintAmount = lerp(state.tintFrom, state.tintTo, k);
        state.tint = mix3(state.tintC0, state.tintC1, k);
      }
      if (state.ripple) {
        state.ripple.age += dt / 1000;
        if (state.ripple.age > 1.8) state.ripple = null;
      }
    }

    function loop(now: number) {
      state.raf = requestAnimationFrame(loop);
      if (now - state.last < 32) return; // ± 30 beelden per seconde
      const dt = state.last ? Math.min(100, now - state.last) : 16;
      state.last = now;
      if (document.hidden || css) return;
      state.time += dt / 1000;
      step(dt);
      draw();
    }

    function placeSun() {
      const now = new Date();
      const { rise, set } = sunTimes(now);
      const sun = sunInField(now.getHours() * 60 + now.getMinutes(), rise, set);
      state.sun = { x: sun.x, y: sun.y, amount: sun.amount };
    }

    function retheme() {
      const next = readPalette();
      if (css || !gl) { state.palette = next; draw(); return; }
      state.from = state.palette;
      state.to = next;
      state.paletteT = 0;
    }

    placeSun();
    if (!css && !setup()) useCss(true);
    else useCss(css);
    size();
    draw();
    state.raf = requestAnimationFrame(loop);

    const onLost = (event: Event) => { event.preventDefault(); gl = null; useCss(true); };
    canvas.addEventListener('webglcontextlost', onLost);

    const resize = new ResizeObserver(() => { size(); draw(); });
    resize.observe(wrap);

    // Dag en Nacht: het veld loopt in 0,9 s mee met het thema.
    const themeWatch = new MutationObserver(() => retheme());
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    const sunTimer = window.setInterval(() => { placeSun(); if (css) syncCss(); }, 60_000);

    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const onMotion = () => {
      const wantCss = prefersCss();
      if (wantCss) useCss(true);
      else if (gl || setup()) { useCss(false); state.palette = readPalette(); }
      draw();
    };
    motion?.addEventListener?.('change', onMotion);

    // Een bijna lege batterij die niet laadt: dan ook CSS. Alleen waar de
    // browser de batterij laat zien (Chromium); elders blijft WebGL aan.
    type Battery = { charging: boolean; level: number; addEventListener: (type: string, cb: () => void) => void; removeEventListener: (type: string, cb: () => void) => void };
    let battery: Battery | null = null;
    const onBattery = () => {
      if (!battery) return;
      const low = !battery.charging && battery.level <= 0.2;
      if (low) useCss(true);
      else if (!prefersCss() && (gl || setup())) useCss(false);
      draw();
    };
    const nav = navigator as Navigator & { getBattery?: () => Promise<Battery> };
    nav.getBattery?.().then(b => {
      battery = b;
      b.addEventListener('levelchange', onBattery);
      b.addEventListener('chargingchange', onBattery);
      onBattery();
    }).catch(() => { /* geen batterij-informatie: niets aan de hand */ });

    const stopLight = onLight(command => {
      if (command.kind === 'ripple') {
        if (css) return;
        // Het veld rekent van linksonder; het scherm van linksboven.
        state.ripple = { x: command.x, y: 1 - command.y, age: 0, amount: command.amount };
        return;
      }
      state.tintC0 = state.tint;
      state.tintC1 = command.color ? toRgb(command.color) : state.tint;
      state.tintFrom = state.tintAmount;
      state.tintTo = command.color ? 1 : 0;
      state.tintT = css ? 1 : 0;
      if (css) { state.tint = state.tintC1; state.tintAmount = state.tintTo; draw(); }
    });

    return () => {
      cancelAnimationFrame(state.raf);
      canvas.removeEventListener('webglcontextlost', onLost);
      resize.disconnect();
      themeWatch.disconnect();
      window.clearInterval(sunTimer);
      motion?.removeEventListener?.('change', onMotion);
      if (battery) { battery.removeEventListener('levelchange', onBattery); battery.removeEventListener('chargingchange', onBattery); }
      stopLight();
      const lose = gl?.getExtension('WEBGL_lose_context');
      lose?.loseContext();
    };
  }, []);

  return <div ref={wrapRef} className="sl-field" aria-hidden="true">
    <canvas ref={canvasRef} />
    <div className="sl-grain" />
  </div>;
}
