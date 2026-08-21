# liquid-cursor

A GPU fluid cursor trail in one file. No dependencies, no build step. 9 KB minified, 3.7 KB gzipped.

Your pointer does not draw a line. It injects velocity into a real fluid simulation, and the color gets carried by the flow.

**[Live demo](https://cravinadventure.github.io/liquid-cursor/)**

---

## Install

One tag. It starts itself and paints behind your content.

```html
<script src="https://cdn.jsdelivr.net/gh/cravinadventure/liquid-cursor@1.0.1/liquid-cursor.min.js"></script>
```

In full page mode the canvas sits at `z-index:-1`, so your `body` needs a transparent background or it will cover the effect. Put the color on `html` instead:

```css
html { background: #050308; }
body { background: transparent; }
```

## One section only

Point it at an element and it fills that element rather than the page:

```html
<script src="…/liquid-cursor.js" data-target="#hero"></script>
```

The element gets `position: relative` if it does not have one, and the canvas is inserted as its first child at `z-index:0`. Give your content inside that section a higher `z-index`.

## Configure

Any option works as a `data-` attribute on the script tag:

```html
<script src="…/liquid-cursor.js" data-target="#hero" data-curl="34" data-drift="0.5"></script>
```

Or take control yourself with `data-manual`:

```html
<script src="…/liquid-cursor.js" data-manual></script>
<script>
  const fluid = LiquidCursor({
    target: "#hero",
    curl: 34,
    gain: 0.3,
    colors: [[0.1, 0.9, 0.7], [0.2, 0.6, 1.0]]
  });
</script>
```

### Options

| Option | Default | What it does |
| --- | --- | --- |
| `target` | `null` | Element or selector. `null` fills the whole page. |
| `gain` | `0.19` | Dye brightness. Past ~0.4 overlaps blow out to white. |
| `dyeFade` | `0.72` | Lower makes the color hang in the air longer. |
| `motionFade` | `0.55` | Higher makes the motion settle sooner. |
| `curl` | `20` | Swirl strength (vorticity confinement). The knob that makes it feel alive. |
| `radius` | `0.24` | Size of each splat. |
| `force` | `2200` | How hard pointer motion pushes the fluid. |
| `drift` | `0` | Ambient splats per second while idle. `0` is pointer only. |
| `colors` | 5 violets | Array of `[r, g, b]` in 0 to 1, picked at random per splat. |
| `simRes` | `140` | Velocity grid resolution. Raise for detail, at a cost. |
| `dyeRes` | `512` | Color grid resolution. |
| `dpr` | `1.5` | Device pixel ratio ceiling. |

### Returned handle

```js
const fluid = LiquidCursor({ target: "#hero" });

fluid.splat(0.5, 0.5, 400, 200);   // x, y in 0..1, then a velocity push
fluid.set({ curl: 40, gain: 0.35 });  // change parameters live
fluid.destroy();                    // stop and remove
```

## How it works

Each frame runs the standard incompressible fluid pipeline on the GPU:

```
curl → vorticity confinement → divergence → 18-step Jacobi pressure solve
     → gradient subtract → advect velocity → advect dye
```

Two ping-pong half-float render targets hold the velocity field (140 px grid) and the dye field (512 px grid). A pointer move adds a Gaussian velocity splat plus a Gaussian dye splat at the cursor. Everything after that is the solver moving the dye around.

## Notes

- Needs WebGL with the `OES_texture_half_float` extension. Without it the canvas hides itself and your page is unaffected.
- Honors `prefers-reduced-motion`: the simulation stops stepping, nothing animates.
- Pauses while the canvas is scrolled off screen (IntersectionObserver).
- The canvas is `pointer-events: none`, so it never eats clicks.

## Credit

Built by [Cravin' Adventure Studios](https://cravinadventure.com).

Fluid solver technique after Pavel Dobryakov's [WebGL-Fluid-Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation), MIT.

## License

MIT. See [LICENSE](LICENSE).
