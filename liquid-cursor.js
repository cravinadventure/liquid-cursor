/*!
 * liquid-cursor v1.0.0
 * A GPU fluid cursor trail in one file. No dependencies.
 * https://github.com/cravinadventure/liquid-cursor
 *
 * Built by Cravin' Adventure Studios - https://cravinadventure.com
 * Fluid solver technique after Pavel Dobryakov's WebGL-Fluid-Simulation (MIT).
 * Released under the MIT License.
 */
(function (global) {
  "use strict";

  var DEFAULTS = {
    target: null,       // element or selector. null = fixed, behind the whole page
    gain: 0.19,         // dye brightness. higher blows out toward white
    dyeFade: 0.72,      // lower = colour lingers longer
    motionFade: 0.55,   // higher = motion settles sooner
    curl: 20,           // swirl strength (vorticity confinement)
    radius: 0.24,       // splat size
    force: 2200,        // how hard pointer motion pushes the fluid
    drift: 0,           // ambient splats per second when idle. 0 = pointer only
    simRes: 140,        // velocity grid
    dyeRes: 512,        // colour grid
    dpr: 1.5,           // device pixel ratio ceiling
    colors: [[0.55, 0.29, 0.97], [0.84, 0.36, 0.96], [0.31, 0.39, 0.94],
             [0.72, 0.22, 0.92], [0.42, 0.32, 1.00]]
  };

  function LiquidCursor(opt) {
    var o = {}, k;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    for (k in (opt || {})) if (opt[k] !== undefined) o[k] = opt[k];

    var host = typeof o.target === "string" ? document.querySelector(o.target) : o.target;
    var full = !host;

    var cv = document.createElement("canvas");
    cv.style.cssText = "display:block;width:100%;height:100%;border:0;pointer-events:none;" +
      (full ? "position:fixed;inset:0;z-index:-1;" : "position:absolute;inset:0;z-index:0;");
    if (full) document.body.appendChild(cv);
    else {
      if (getComputedStyle(host).position === "static") host.style.position = "relative";
      host.insertBefore(cv, host.firstChild);
    }

    var p = { alpha: false, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false };
    var gl = cv.getContext("webgl", p) || cv.getContext("experimental-webgl", p);
    var hf = gl && gl.getExtension("OES_texture_half_float");
    if (!gl || !hf) { cv.style.display = "none"; return null; }
    var HALF = hf.HALF_FLOAT_OES;
    var FILTER = gl.getExtension("OES_texture_half_float_linear") ? gl.LINEAR : gl.NEAREST;
    var reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

    /* ---- shaders ---- */

    function sh(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
      return s;
    }

    // Shared vertex stage: fullscreen quad plus the four neighbour taps every
    // finite-difference pass needs.
    var VS = sh(gl.VERTEX_SHADER,
      "precision highp float;attribute vec2 a;varying vec2 uv,L,R,T,B;uniform vec2 px;" +
      "void main(){uv=a*0.5+0.5;L=uv-vec2(px.x,0.);R=uv+vec2(px.x,0.);T=uv+vec2(0.,px.y);B=uv-vec2(0.,px.y);" +
      "gl_Position=vec4(a,0.,1.);}");

    var H = "precision highp float;varying vec2 uv,L,R,T,B;";

    function prog(src) {
      var pr = gl.createProgram();
      gl.attachShader(pr, VS); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, H + src));
      gl.bindAttribLocation(pr, 0, "a"); gl.linkProgram(pr);
      var u = {}, n = gl.getProgramParameter(pr, gl.ACTIVE_UNIFORMS);
      for (var i = 0; i < n; i++) { var nm = gl.getActiveUniform(pr, i).name; u[nm] = gl.getUniformLocation(pr, nm); }
      return { p: pr, u: u, bind: function () { gl.useProgram(pr); } };
    }

    var CLEAR = prog("uniform sampler2D t;uniform float v;void main(){gl_FragColor=v*texture2D(t,uv);}");

    var SPLAT = prog("uniform sampler2D t;uniform float ar,rad;uniform vec3 col;uniform vec2 pt;" +
      "void main(){vec2 d=uv-pt;d.x*=ar;gl_FragColor=vec4(texture2D(t,uv).xyz+exp(-dot(d,d)/rad)*col,1.);}");

    // Semi-Lagrangian advection: walk backwards along the velocity, sample there.
    var ADV = prog("uniform sampler2D vel,src;uniform vec2 px;uniform float dt,dis;" +
      "void main(){gl_FragColor=texture2D(src,uv-dt*texture2D(vel,uv).xy*px)/(1.+dis*dt);}");

    var DIV = prog("uniform sampler2D vel;void main(){" +
      "float l=texture2D(vel,L).x,r=texture2D(vel,R).x,t=texture2D(vel,T).y,b=texture2D(vel,B).y;" +
      "vec2 c=texture2D(vel,uv).xy;" +
      "if(L.x<0.)l=-c.x; if(R.x>1.)r=-c.x; if(T.y>1.)t=-c.y; if(B.y<0.)b=-c.y;" +
      "gl_FragColor=vec4(0.5*(r-l+t-b),0.,0.,1.);}");

    var CURL = prog("uniform sampler2D vel;void main(){" +
      "gl_FragColor=vec4(0.5*(texture2D(vel,R).y-texture2D(vel,L).y-texture2D(vel,T).x+texture2D(vel,B).x),0.,0.,1.);}");

    // Vorticity confinement: feed energy back into the small swirls the grid eats.
    var VORT = prog("uniform sampler2D vel,cur;uniform float curl,dt;void main(){" +
      "float l=texture2D(cur,L).x,r=texture2D(cur,R).x,t=texture2D(cur,T).x,b=texture2D(cur,B).x,c=texture2D(cur,uv).x;" +
      "vec2 f=0.5*vec2(abs(t)-abs(b),abs(r)-abs(l));f/=length(f)+1e-4;f*=curl*c;f.y*=-1.;" +
      "gl_FragColor=vec4(clamp(texture2D(vel,uv).xy+f*dt,-1000.,1000.),0.,1.);}");

    var PRESS = prog("uniform sampler2D pr,dv;void main(){" +
      "gl_FragColor=vec4((texture2D(pr,L).x+texture2D(pr,R).x+texture2D(pr,B).x+texture2D(pr,T).x-texture2D(dv,uv).x)*0.25,0.,0.,1.);}");

    var GRAD = prog("uniform sampler2D pr,vel;void main(){" +
      "gl_FragColor=vec4(texture2D(vel,uv).xy-vec2(texture2D(pr,R).x-texture2D(pr,L).x,texture2D(pr,T).x-texture2D(pr,B).x),0.,1.);}");

    // Screen pass: ceiling the dye, vignette, lift the empty areas off pure black.
    var DISP = prog("uniform sampler2D t;void main(){vec3 c=min(texture2D(t,uv).rgb,vec3(0.72));" +
      "c*=mix(0.55,1.,smoothstep(1.25,0.3,length(uv-0.5)*1.2));" +
      "c+=vec3(0.020,0.031,0.043)*(1.-min(1.,(c.r+c.g+c.b)*3.));gl_FragColor=vec4(c,1.);}");

    /* ---- buffers ---- */

    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, 1, 1, -1, -1, -1]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);

    function blit(f) { gl.bindFramebuffer(gl.FRAMEBUFFER, f ? f.fbo : null); gl.drawArrays(gl.TRIANGLES, 0, 6); }

    function fbo(w, h, filter) {
      gl.activeTexture(gl.TEXTURE0);
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, HALF, null);
      var f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.viewport(0, 0, w, h); gl.clear(gl.COLOR_BUFFER_BIT);
      return { fbo: f, width: w, height: h, tx: 1 / w, ty: 1 / h,
        attach: function (i) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, tex); return i; } };
    }

    function dbl(w, h, filter) {
      var a = fbo(w, h, filter), b = fbo(w, h, filter);
      return { width: w, height: h, tx: a.tx, ty: a.ty, read: a, write: b,
        swap: function () { var t = this.read; this.read = this.write; this.write = t; } };
    }

    var dye, vel, div, cur, pre;

    function res(r) {
      var ar = gl.drawingBufferWidth / gl.drawingBufferHeight;
      if (ar < 1) ar = 1 / ar;
      var lo = Math.round(r), hi = Math.round(r * ar);
      return gl.drawingBufferWidth > gl.drawingBufferHeight ? [hi, lo] : [lo, hi];
    }

    function build() {
      var s = res(o.simRes), d = res(o.dyeRes);
      dye = dbl(d[0], d[1], FILTER);
      vel = dbl(s[0], s[1], FILTER);
      div = fbo(s[0], s[1], gl.NEAREST);
      cur = fbo(s[0], s[1], gl.NEAREST);
      pre = dbl(s[0], s[1], gl.NEAREST);
    }

    function size() {
      var r = Math.min(devicePixelRatio || 1, o.dpr);
      var w = Math.max(1, Math.floor((full ? innerWidth : host.clientWidth) * r));
      var h = Math.max(1, Math.floor((full ? innerHeight : host.clientHeight) * r));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; build(); }
    }

    /* ---- input ---- */

    function color() {
      var c = o.colors[(Math.random() * o.colors.length) | 0];
      return [c[0] * o.gain, c[1] * o.gain, c[2] * o.gain];
    }

    function splat(x, y, dx, dy, c) {
      SPLAT.bind();
      gl.viewport(0, 0, vel.width, vel.height);
      gl.uniform1i(SPLAT.u.t, vel.read.attach(0));
      gl.uniform1f(SPLAT.u.ar, cv.width / cv.height);
      gl.uniform2f(SPLAT.u.pt, x, y);
      gl.uniform1f(SPLAT.u.rad, o.radius / 100);
      gl.uniform3f(SPLAT.u.col, dx, dy, 0);
      blit(vel.write); vel.swap();
      gl.viewport(0, 0, dye.width, dye.height);
      gl.uniform1i(SPLAT.u.t, dye.read.attach(0));
      gl.uniform3f(SPLAT.u.col, c[0], c[1], c[2]);
      blit(dye.write); dye.swap();
    }

    var lx = 0.5, ly = 0.5, have = false;

    function move(cx, cy) {
      var r = cv.getBoundingClientRect();
      if (cx < r.left - 60 || cx > r.right + 60 || cy < r.top - 60 || cy > r.bottom + 60) { have = false; return; }
      var x = (cx - r.left) / r.width, y = 1 - (cy - r.top) / r.height;
      if (!have) { lx = x; ly = y; have = true; return; }
      var dx = (x - lx) * o.force, dy = (y - ly) * o.force;
      lx = x; ly = y;
      if (dx * dx + dy * dy < 0.5) return;
      splat(x, y, dx, dy, color());
    }

    addEventListener("pointermove", function (e) { move(e.clientX, e.clientY); }, { passive: true });
    addEventListener("pointerdown", function (e) { have = false; move(e.clientX, e.clientY); }, { passive: true });

    /* ---- step ---- */

    function step(dt) {
      gl.disable(gl.BLEND);
      gl.viewport(0, 0, vel.width, vel.height);

      CURL.bind();
      gl.uniform2f(CURL.u.px, vel.tx, vel.ty);
      gl.uniform1i(CURL.u.vel, vel.read.attach(0)); blit(cur);

      VORT.bind();
      gl.uniform2f(VORT.u.px, vel.tx, vel.ty);
      gl.uniform1i(VORT.u.vel, vel.read.attach(0));
      gl.uniform1i(VORT.u.cur, cur.attach(1));
      gl.uniform1f(VORT.u.curl, o.curl); gl.uniform1f(VORT.u.dt, dt);
      blit(vel.write); vel.swap();

      DIV.bind();
      gl.uniform2f(DIV.u.px, vel.tx, vel.ty);
      gl.uniform1i(DIV.u.vel, vel.read.attach(0)); blit(div);

      CLEAR.bind();
      gl.uniform1i(CLEAR.u.t, pre.read.attach(0));
      gl.uniform1f(CLEAR.u.v, 0.8);
      blit(pre.write); pre.swap();

      PRESS.bind();
      gl.uniform2f(PRESS.u.px, vel.tx, vel.ty);
      for (var i = 0; i < 18; i++) {
        gl.uniform1i(PRESS.u.dv, div.attach(0));
        gl.uniform1i(PRESS.u.pr, pre.read.attach(1));
        blit(pre.write); pre.swap();
      }

      GRAD.bind();
      gl.uniform2f(GRAD.u.px, vel.tx, vel.ty);
      gl.uniform1i(GRAD.u.pr, pre.read.attach(0));
      gl.uniform1i(GRAD.u.vel, vel.read.attach(1));
      blit(vel.write); vel.swap();

      ADV.bind();
      gl.uniform2f(ADV.u.px, vel.tx, vel.ty);
      gl.uniform1i(ADV.u.vel, vel.read.attach(0));
      gl.uniform1i(ADV.u.src, vel.read.attach(0));
      gl.uniform1f(ADV.u.dt, dt);
      gl.uniform1f(ADV.u.dis, o.motionFade);
      blit(vel.write); vel.swap();

      gl.viewport(0, 0, dye.width, dye.height);
      gl.uniform1i(ADV.u.vel, vel.read.attach(0));
      gl.uniform1i(ADV.u.src, dye.read.attach(1));
      gl.uniform1f(ADV.u.dis, o.dyeFade);
      blit(dye.write); dye.swap();
    }

    /* ---- run ---- */

    size();
    addEventListener("resize", size);

    for (var i = 0; i < 16; i++) {
      var ang = Math.random() * 6.283;
      splat(Math.random(), Math.random(), Math.cos(ang) * 110, Math.sin(ang) * 110, color());
    }

    var run = true, acc = 0, last = performance.now();

    function loop(now) {
      if (!run) return;
      var dt = Math.min((now - last) / 1000, 0.016);
      last = now;
      size();
      if (!reduced) {
        if (o.drift > 0) {
          acc += dt;
          if (acc > 1 / o.drift) {
            acc = 0;
            var an = Math.random() * 6.283, mg = 45 + Math.random() * 120;
            splat(Math.random(), Math.random(), Math.cos(an) * mg, Math.sin(an) * mg, color());
          }
        }
        step(0.010);
      }
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      DISP.bind();
      gl.uniform1i(DISP.u.t, dye.read.attach(0));
      blit(null);
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);

    // Stop drawing while the canvas is off screen.
    if (window.IntersectionObserver) {
      new IntersectionObserver(function (en) {
        en.forEach(function (e) {
          if (e.isIntersecting && !run) { run = true; last = performance.now(); requestAnimationFrame(loop); }
          else if (!e.isIntersecting) run = false;
        });
      }, { threshold: 0.01 }).observe(cv);
    }

    return {
      canvas: cv,
      options: o,
      splat: function (x, y, dx, dy) { splat(x, y, dx || 0, dy || 0, color()); },
      set: function (kv) { for (var q in kv) o[q] = kv[q]; },
      destroy: function () { run = false; cv.remove(); }
    };
  }

  LiquidCursor.defaults = DEFAULTS;
  global.LiquidCursor = LiquidCursor;

  // Auto-start unless the tag says otherwise. Options come off the script tag:
  // <script src="liquid-cursor.js" data-target="#hero" data-curl="30"></script>
  var tag = document.currentScript;
  if (tag && !tag.hasAttribute("data-manual")) {
    var cfg = {}, d = tag.dataset, key;
    for (key in d) {
      if (key === "manual") continue;
      var v = d[key];
      cfg[key] = (key === "target") ? v : (v === "true" ? true : v === "false" ? false : parseFloat(v));
    }
    var boot = function () { LiquidCursor(cfg); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
  }
})(window);
