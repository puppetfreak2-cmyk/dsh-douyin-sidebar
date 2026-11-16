/**
 * dsh-douyin-sidebar — client half.
 *
 * One button in the already-declared `sidebar.footer.action` slot (the sidebar
 * foot, next to the settings gear). Pressing it mounts a real Electron
 * `<webview>` pointed at https://www.douyin.com/ into a fixed panel pinned to
 * the bottom-left corner of the window.
 *
 * ## Why a webview and not an iframe
 *
 * douyin.com refuses to be framed: the response carries `X-Frame-Options: DENY`
 * and a CSP whose `frame-ancestors` list is
 * `https://pc.xgo.bytedance.net … https://*.douyin.com …` — 127.0.0.1 is not in
 * it. A plain `<iframe>` is therefore rejected before a single byte of the page
 * is parsed. An Electron `<webview>` is a separate guest with its own renderer,
 * so `frame-ancestors` does not apply to it. That is the whole reason this
 * plugin exists.
 *
 * ## The lease protocol this plugin must obey
 *
 * The desktop host's `DesktopBrowserGuests` manages guest leases.
 * A webview may attach only when ALL of the following
 * hold, checked in `will-attach-webview`:
 *
 *   - `params.src` starts with `about:blank#` and the remainder is a lease id
 *     the main process issued to THIS window (`params.src.slice(12)` is the id);
 *   - `params.partition` equals the partition minted for that lease;
 *   - the lease has not already been attached.
 *
 * Anything else gets `event.preventDefault()` and no guest at all. So the
 * element is created with `src="about:blank#<lease>"` and
 * `partition="<partition>"` and is never handed a real URL through `src`; the
 * real navigation happens after `dom-ready`, through `element.loadURL(...)`.
 * On the way in, `will-attach-webview` also wipes every preference the page
 * could have set and forces `nodeIntegration:false`, `contextIsolation:true`,
 * `sandbox:true`, `webSecurity:true`, `webviewTag:false`, `devTools` off in a
 * packaged app.
 *
 * `allowedNavigation` (same file) permits only `http:`/`https:` URLs with no
 * credentials that are NOT the DSH host itself — douyin.com passes, the local
 * host does not. The lease's session is hardened before use: every permission
 * request is denied, downloads are cancelled, and `onBeforeRequest` cancels any
 * protocol outside http/https/ws/wss (plus about/data/blob).
 *
 * ## Why leases die, and why this plugin re-mounts
 *
 * `bind()` installs, on the main window's `webContents`:
 *   `owner.on("did-start-navigation", (_e, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) releaseAll(); })`
 * plus `render-process-gone` and `destroyed` → `releaseAll()`. So a window
 * reload (F5 / Ctrl+R) silently destroys every guest on that window, and the
 * webview element's `destroyed` event is the only notice we get. The handler
 * below therefore re-`acquire`s and re-mounts — up to 3 consecutive times, so a
 * permanently broken window cannot spin forever.
 *
 * `releaseAll` drops leases but keeps `partitions`, which are keyed by the
 * workspace string. Re-acquiring with the same workspace therefore reuses the
 * same partition; login persistence still depends on the site and session.
 *
 * ## Why the panel is built with raw DOM
 *
 * The dock is appended to `document.body`, not rendered inside the sidebar. The
 * sidebar's collapse animation is a transform, and a `transform` on any ancestor
 * turns `position: fixed` into "fixed relative to that ancestor" — the panel
 * would then be clipped by the sidebar instead of pinned to the window corner.
 * This is the same reason dsh-douyin appends its own dock host to `document.body`
 * (`node_modules/dsh-douyin/lib/client.js:1219-1220`). Keeping the dock out of
 * React's tree also guarantees the reconciler never touches the webview node the
 * main process has leased.
 *
 * ## Packaging contract
 *
 * `window.__ModuleLoader__.load({ id, factory })`; the factory's exports become
 * the client module face, so `apply` and `inject` live on `exports`. `react` is
 * a seed name in the shell's static table and needs no `dsh.client.external`
 * declaration. `apply` is defensive about `slots` being present rather than
 * throwing the whole bundle away.
 */
window.__ModuleLoader__.load({
  id: 'dsh-douyin-sidebar',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const h = react.createElement;

    const SLOT = 'sidebar.footer.action';
    const ID = 'douyin-sidebar';
    const HOME = 'https://www.douyin.com/';
    // Keep the existing guest workspace; this plugin does not configure its proxy.
    const WORKSPACE = 'dsh-douyin-sidebar';
    const STYLE_ID = 'dsh-douyin-sidebar-style';
    const MAX_REMOUNTS = 3;
    /* 
                                                          
      
                                                    
                                                                             
                                                                                    
                                                                                     
                                                                                 
                                                                                 
                                                                  
     */
    /**
     * Width douyin's desktop layout is designed for. The guest is always scaled
     * by `panelWidth / FIT_WIDTH`, so a 500px panel renders the 1024px layout at
     * 47% instead of clipping its right-hand column.
     */
    const FIT_WIDTH = 1024;
    /* 
                                                              
                                                                                     
                            
     */
    const FOOT_LIFT = 5;

    /**
     * The desktop browser bridge, or null where it does not exist.
     *
     * `lib/preload-app.cjs` injects `dshDesktop` only when
     * `location.protocol === "dsh-app:" && location.hostname === "app" && process.isMainFrame`.
     * A plain browser tab on http://127.0.0.1:19387 has neither the bridge nor a
     * `<webview>` tag, so the panel says so instead of drawing an empty frame.
     */
    function desktopBrowser() {
      const bridge = globalThis.dshDesktop?.browser;
      if (bridge === null || typeof bridge !== 'object') return null;
      if (typeof bridge.acquire !== 'function' || typeof bridge.release !== 'function') return null;
      return bridge;
    }

    const CSS = `
/*                                                                        
                                                                                    
                                                                                         
                                                                                         
                                                                                     
                                                                                  
               

                                                                   
                                                                                       
                                                                                     
                                                                                        
                                                                                        
                                                                                        
                                                                                          
                                                                                    
                                                                         */
/*                                                                        
                                                                                                     
                                                                                                   
                                                                                                      
                                                                                                 
                                                                                                 
                                     */
.dyw-toggle{display:grid;place-items:center;width:28px;height:28px;margin-left:auto;padding:0;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;transition:background .15s}
.dyw-toggle:hover{background:rgba(127,127,127,.16)}
.dyw-toggle[data-open="true"]{background:rgba(127,127,127,.16)}
.dyw-dock{--dyw-sidebar-w:264px;--dyw-bar-h:30px;--dyw-w:min(500px,calc(100vw - 16px));--dyw-h:calc(var(--dyw-w) * 9 / 16 + var(--dyw-bar-h));position:fixed;left:0;top:0;width:var(--dyw-w);height:var(--dyw-h);/*                                                                
                                                                                            
                                                                                         
                                                                                             
                                                                                        
                                                                                           
                                                                                            
                                                                                            
                                          */
margin:0;padding:0;right:auto;bottom:auto;color:inherit;overflow:hidden;z-index:890;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,rgba(16,16,20,.72));border:1px solid var(--dsw-alias-border-l2,#2b2b2b);box-shadow:0 18px 44px rgba(0,0,0,.32)}
.dyw-dock[data-size="3"]{--dyw-w:min(calc(100vw - 16px),calc((var(--dyw-avail-h,calc(100vh - 16px)) - var(--dyw-bar-h)) * 16 / 9))}
/*                                                                           
                                                                               
                                                                                 
                                                                              
                                                                
                                    */
/*                                                             
                                                                                             
                                                                                            
                                                                                          
                                                                           
                                                               */
.dyw-dock[data-size="3"] .dyw-bar{background:var(--dsw-alias-bg-layer-1,#111)}

/*                                                           
                                       
                                                                      
                                                                              
                                                                               
                                                          */
.dyw-dock[data-size="3"]{background:var(--dsh-dream-skin-composer-base,var(--dsw-alias-bg-base,#050505))}

/* Magnetism: the snap transition only exists for the 180ms after a drag ends. */
.dyw-dock[data-snapping="true"]{transition:left .18s ease,top .18s ease}
.dyw-dock[data-dragging="true"]{transition:none}
/*                                                        
                                                                                             
                                                                                           
                                                                                    */
.dyw-dock[data-behind="true"]{z-index:-1;pointer-events:none;visibility:hidden}
/* A guest swallows pointer moves over itself, which would freeze the drag the
   moment the cursor crossed the video. This overlay keeps hit-testing inside the
   parent renderer for as long as the drag lasts. */
.dyw-dock[data-dragging="true"] .dyw-body::after{content:"";position:absolute;inset:0;z-index:3}
/*                                                                            
                                                                                
                                                                                 
                                                                                 
                                                                             
                                                       
                                                                         
                                                                    
                                                                                           
                                                                                          
                                                                                           
                                                                                   
                                                                                          */
.bt-menu,.bt-react-strip,.bt-drop,.bt-newchat,.bt-avedit,.bt-update-pop{z-index:955!important}
.dyw-bar{flex:0 0 auto;display:flex;align-items:center;justify-content:flex-end;gap:6px;height:var(--dyw-bar-h);padding:0 6px;background:transparent;color:var(--dsw-alias-label-primary,#e8e8e8);cursor:grab;touch-action:none;font:12px/1 system-ui,-apple-system,"Segoe UI",sans-serif}
/*                                                         
                                                                                         
                                                                                     
                                                                                  */
.dyw-dock[data-dragging="true"] .dyw-bar{cursor:grabbing}
/*                                                           
                                                                              
                                                                                            
                                   
                                                                                              
                                                                                    
                                                                                         
                                                                                   
                                                                                     */
.dyw-bar-gap{flex:1}
.dyw-bar-dot{flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:#3a3a3a}
.dyw-dock[data-phase="ready"] .dyw-bar-dot{background:#39c76a}
.dyw-bar-size{flex:0 0 auto;padding:0 6px;border-radius:4px;background:transparent;color:var(--dsw-alias-label-primary,#e8e8e8);opacity:.7;font:13px/19px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.4px}
.dyw-bar-size:hover{opacity:1;background:rgba(255,255,255,.12)}
.dyw-bar-btn{flex:0 0 auto;width:22px;height:22px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary,#e8e8e8);cursor:pointer;font-size:14px;line-height:1;opacity:.7}
.dyw-bar-btn:hover{opacity:1;background:rgba(255,255,255,.12)}
.dyw-bar-btn:disabled{opacity:.3;cursor:default}
.dyw-body{position:relative;flex:1 1 auto;min-height:0;background:#000}
.dyw-host{position:absolute;inset:0}
/* Electron's webview is a shadow-DOM host whose inner iframe is sized by
   flex:1 against the host's UA display. Forcing display:block here made that
   iframe fall back to its intrinsic 150px height: the page rendered in a
   letterbox strip at the top of the panel and the rest stayed black. Keep the
   host a flex container so the guest actually fills it. */
.dyw-frame{width:100%;height:100%;border:0;display:flex;flex-direction:column;background:#000}
.dyw-hint{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;gap:10px;padding:20px;box-sizing:border-box;color:#cfcfcf;font:12px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center}
.dyw-hint b{color:#fe2c55;font-weight:600;font-size:13px}
.dyw-hint code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.5;opacity:.7;word-break:break-word}
.dyw-hint[hidden]{display:none}
`;

    function installStyle() {
      if (typeof document === 'undefined') return;
      const existing = document.getElementById(STYLE_ID);
      // Refresh rather than skip: a hot module swap re-runs `apply` while the old
      // <style> element is still in the document, and a skip-on-exists check would
      // silently keep serving the previous CSS.
      if (existing !== null) {
        if (existing.textContent !== CSS) existing.textContent = CSS;
        return;
      }
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      (document.head ?? document.documentElement).appendChild(style);
    }

    function glyph() {
      return h(
        'svg',
        { width: 20, height: 20, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M14.2 3h3.1c.3 2.05 1.62 3.55 3.7 3.86v3.02c-1.45-.03-2.72-.44-3.85-1.2v6.5a5.72 5.72 0 1 1-5.72-5.72c.3 0 .6.02.9.07v3.15a2.6 2.6 0 1 0 1.87 2.5V3z',
          fill: 'currentColor',
        }),
      );
    }

    /**
     * The dock chrome, built with raw DOM so it can live on `document.body`.
     *
     * `onGeometry` fires after every move or resize so the caller can re-fit the
     * guest's zoom to the new width.
     */
    function createDockDom(onClose, onGeometry) {
      const dock = document.createElement('div');
      dock.className = 'dyw-dock';
      dock.setAttribute('data-phase', 'idle');
      // Hidden until placed: the CSS default corner is (0,0) and one frame of a
      // black panel there is plainly visible.
      dock.style.visibility = 'hidden';

      const bar = document.createElement('div');
      bar.className = 'dyw-bar';

                                                                                
                                                                                
                                                                                 
                                                                              
      const SIZES = [
        ['1', '小窗口'],
        ['3', '大窗口'],
      ];
                                                    
                                                                                    
                                                                              
                                                             
      dock.setAttribute('data-size', '3');

      const size = document.createElement('span');
      size.className = 'dyw-bar-size';
                                                                                 
                                                                                   
                                                                     
                                                          
                                                                                
                                                                            
      const nextSize = (value) => SIZES[(SIZES.findIndex(([id]) => id === value) + 1) % SIZES.length];
      size.textContent = '切换' + nextSize(dock.getAttribute('data-size'))[1];
      size.title = '点击切换尺寸（小窗口 / 大窗口）';
      size.style.cursor = 'pointer';
      size.addEventListener('click', () => {
        const next = nextSize(dock.getAttribute('data-size'));
        // Switching size used to re-clamp from wherever the panel happened to be
        // *after* the box changed, so "大 → 小" landed somewhere new every time:
        // the larger box had already been pushed away from the edge and the small
        // box kept that pushed corner. Each step now owns a fixed corner instead:
        // small bottom-left, large top-right (see homeCorner).
        // The new step's own corner, read *after* the attribute flips: homeCorner
        // reads both data-size and the current rect, so computing it first would
        // send the panel to the corner of the step it is leaving.
        dock.setAttribute('data-size', next[0]);
        size.textContent = '切换' + nextSize(next[0])[1];
        measure();
        const home = homeCorner(dock.getBoundingClientRect());
        const back = clamp(dock.getBoundingClientRect(), home.x, home.y);
        place(back.x, back.y, true);
        onGeometry?.();
      });

                                                                                
                                                                                   
                                                                                
                                                                                
                                                                               
                                                                              
                                                                        
      const gap = document.createElement('span');
      gap.className = 'dyw-bar-gap';

      const dot = document.createElement('span');
      dot.className = 'dyw-bar-dot';
      dot.title = '抖音网页正在加载';

      const sourceStatus = document.createElement('span');
      sourceStatus.textContent = '来源：未知 · 状态不确定';
      const showStatus = document.createElement('button');
      showStatus.type = 'button';
      showStatus.textContent = '显示状态';
      showStatus.hidden = true;
      showStatus.addEventListener('click', () => { dom.viewing = false; hint.hidden = false; showStatus.hidden = true; });

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'dyw-bar-btn';
      close.title = '收起';
      close.textContent = '×';
      close.addEventListener('click', onClose);

      const body = document.createElement('div');
      body.className = 'dyw-body';

      const host = document.createElement('div');
      host.className = 'dyw-host';

      const hint = document.createElement('div');
      hint.className = 'dyw-hint';

      bar.append(size, gap, dot, sourceStatus, showStatus, close);
      body.append(host, hint);
      dock.append(bar, body);
      document.body.appendChild(dock);
      /*                                                     
                                                                                       
                                                    */
      {

      /*                                                          
                                                                   
                                                         
                                        
                                                                               
                                                                                  
                                                 
                                                         
                                                                                       
                         */
      const topmostDock = (target) => {
        if (target === null || target === undefined) return;
        try { if (target.matches(':popover-open')) target.hidePopover(); } catch (e) {}
        try { if (target.hasAttribute('popover')) target.removeAttribute('popover'); } catch (e2) {}
      };
      globalThis.__dsDockTopmost = topmostDock;
      topmostDock(dock);
      }

      // --- placement: magnetic drag ---------------------------------------------
      // The rail is a *magnetic* edge, not a wall. It used to be a hard left
      // limit, which made the panel impossible to move toward the sidebar and
      // collapsed its horizontal range to a single x whenever the window was
      // barely wider than the panel. Now the panel may sit anywhere in the
      // window and magnetism parks it flush against the rail when it is dropped
      // near it — the bottom-left default is still "beside the rail".
      /**
       * Top edge of the sidebar's foot row — the settings button and this plugin's
       * own toggle. The panel used to be clamped to the window's bottom edge, which
       * parked its bottom-left corner on top of the douyin launch icon: the icon
       * was covered, so the second click that closes the panel never landed.
       * Reserving the foot keeps the toggle reachable.
       */
      function footTop() {
        const rect = document.querySelector('.dyw-toggle')?.getBoundingClientRect();
                                                            
                                                                                   
                                                       
        if (rect !== undefined && rect.height > 0) return rect.top - FOOT_LIFT;
        return window.innerHeight - 44 - FOOT_LIFT;
      }

      /**
       * Bottom edge of the window's title bar. On win32 the shell draws its window
       * buttons as a `titleBarOverlay` of `--dsh-windows-titlebar-height` px over
       * the top of the page, so a panel parked at y=8 lands on them and they stop
       * responding. 8px is the fallback where no overlay exists.
       */
      function topInset() {
        const raw = globalThis.getComputedStyle?.(document.documentElement).getPropertyValue('--dsh-windows-titlebar-height');
        const parsed = Number.parseFloat(raw);
        return Number.isFinite(parsed) && parsed > 0 ? parsed + 4 : 8;
      }

      /**
       * Publish the vertical space the panel may actually use, then let CSS size the
       * "large" step from it. Without this the large step asks for a 16:9 box as
       * tall as the whole viewport, which covers the window buttons.
       */
      function measure() {
        // No bottom margin on purpose: the large step must end exactly where the
        // sidebar's foot row starts. A 16px reserve left a visible strip under the
        // panel that the user read as "still not maximised".
        const available = Math.max(160, footTop() - topInset());
        dock.style.setProperty('--dyw-avail-h', `${Math.round(available)}px`);
      }

      /**
       * The canonical corner of each step. The small panel's bottom-left corner is
       * the *sidebar's* bottom-left corner — x=0, bottom edge resting on the foot
       * row (the user: "我要的是贴近侧边栏的左下角哦"), which is also the empty
       * area this plugin was originally asked to fill. The large one hugs the
       * top-right (under the title bar, flush to the right edge). Both a size
       * switch and every window state change send the panel here, so the rule
       * "小的在左下角，大的在右上角" holds no matter where it was dragged to.
       */
      function homeCorner(rect) {
        if (dock.getAttribute('data-size') === '3') {
          return { x: window.innerWidth - rect.width, y: topInset() };
        }
        return { x: 0, y: footTop() - rect.height };
      }

      function bounds(rect) {
        const rail = sidebarWidth(dock) + 8;
        const top = topInset();
        // Flush edges, no 8px reserve: homeCorner parks the small step on the
        // window's bottom-left corner and a clamp that pulled it 8px back would
        // undo that. minX is 0, not 8, for the same reason — the panel is allowed
        // to sit over the sidebar's empty lower half.
        const maxX = Math.max(0, window.innerWidth - rect.width);
        // The large step is maximised: it already spans every pixel between the
        // title bar and the foot row, so a vertical drag has nowhere to go. Pin it
        // to the top instead of letting it slide inside an 8px sliver (the user:
        // "大窗口的时候怎么还能上下移动？"). Horizontal freedom stays.
        const maximised = dock.getAttribute('data-size') === '3';
        return {
          minX: 0,
          rail: rail <= maxX ? rail : null,
          maxX,
          minY: top,
          maxY: maximised ? top : Math.max(top, footTop() - rect.height),
        };
      }

      function clamp(rect, x, y) {
        const box = bounds(rect);
        return {
          x: Math.min(Math.max(box.minX, x), box.maxX),
          y: Math.min(Math.max(box.minY, y), box.maxY),
        };
      }

      /** Magnetic: an axis only sticks once it is within SNAP px of an edge. */
      function snap(rect, x, y) {
        const SNAP = 48;
        const box = bounds(rect);
        const stick = (value, edges) => {
          const clamped = Math.min(Math.max(box.minX, value), box.maxX);
          let best = clamped;
          let bestGap = SNAP + 1;
          for (const edge of edges) {
            if (typeof edge !== 'number') continue;
            const gap = Math.abs(value - edge);
            if (gap <= SNAP && gap < bestGap) {
              best = edge;
              bestGap = gap;
            }
          }
          return best;
        };
        return {
          x: stick(x, [box.minX, box.rail, box.maxX]),
          y: stick(y, [box.minY, box.maxY]),
        };
      }

      function place(x, y, animate) {
        const point = clamp(dock.getBoundingClientRect(), x, y);
        if (animate) {
          dock.setAttribute('data-snapping', 'true');
          window.setTimeout(() => dock.removeAttribute('data-snapping'), 200);
        }
        dock.style.left = `${Math.round(point.x)}px`;
        dock.style.top = `${Math.round(point.y)}px`;
        return point;
      }

      /** Re-clamp after a size change, then re-fit the guest. */
      function settle(animate) {
        measure();
        const rect = dock.getBoundingClientRect();
        place(rect.left, rect.top, animate);
        onGeometry?.();
      }

      let drag = null;
      bar.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        if (event.target instanceof Element && event.target.closest('button, .dyw-bar-size') !== null) return;
        const rect = dock.getBoundingClientRect();
        drag = { id: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
        dock.setAttribute('data-dragging', 'true');
        try {
          bar.setPointerCapture(event.pointerId);
        } catch {
          /* capture is best-effort; the drag overlay keeps the moves coming */
        }
        event.preventDefault();
      });
      bar.addEventListener('pointermove', (event) => {
        if (drag === null || event.pointerId !== drag.id) return;
        place(event.clientX - drag.dx, event.clientY - drag.dy, false);
      });
      const endDrag = (event) => {
        if (drag === null || event.pointerId !== drag.id) return;
        drag = null;
        dock.removeAttribute('data-dragging');
        const rect = dock.getBoundingClientRect();
        const stuck = snap(rect, rect.left, rect.top);
        place(stuck.x, stuck.y, true);
        onGeometry?.();
      };
      bar.addEventListener('pointerup', endDrag);
      bar.addEventListener('pointercancel', endDrag);

      // A window state change (maximise, restore, a resize, the rail collapsing)
      // sends each step back to its canonical corner instead of clamping it in
      // place. Self-unsubscribes once the dock is gone.
      const onResize = () => {
        if (!dock.isConnected) {
          window.removeEventListener('resize', onResize);
          return;
        }
        measure();
        const home = homeCorner(dock.getBoundingClientRect());
        const back = clamp(dock.getBoundingClientRect(), home.x, home.y);
        place(back.x, back.y, false);
        onGeometry?.();
      };
      window.addEventListener('resize', onResize);
      // Escape is handled inside the guest by the shim, which owns the in-panel
      // fullscreen state; the dock itself has nothing to un-expand.

      // First paint: the canonical corner of the starting step (「大」 ⇒ top-right).
      // The avail-height has to be measured *before* the first rect is read,
      // otherwise that step would size itself off the fallback (the whole viewport)
      // and reach up into the title bar.
      measure();
      const rect = dock.getBoundingClientRect();
      const home = homeCorner(rect);
      const start = clamp(rect, home.x, home.y);
      dock.style.left = `${Math.round(start.x)}px`;
      dock.style.top = `${Math.round(start.y)}px`;
      dock.style.visibility = '';

      const dom = { dock, size, dot, sourceStatus, showStatus, host, hint, reclamp: () => settle(false) };
      return dom;
    }

    /** The rail width, read from the CSS variable that already tracks collapse. */
    function sidebarWidth(dock) {
      const raw = globalThis.getComputedStyle?.(dock).getPropertyValue('--dyw-sidebar-w');
      const parsed = Number.parseFloat(raw);
      return Number.isFinite(parsed) ? parsed : 264;
    }

    /** Repaint the dock chrome from one state snapshot. */
    function paintDock(dom, state) {
      dom.dock.setAttribute('data-phase', state.phase);
      const ready = state.phase === 'ready';
      // The bar dot reads off data-phase through CSS; only its tooltip needs text.
      dom.dot.title = ready
        ? '抖音网页已就绪'
        : state.phase === 'error' || state.phase === 'unsupported'
          ? '抖音网页没有就绪'
          : '抖音网页正在加载';
      if (ready) dom.viewing = false;
      if (state.phase === 'uncertain' && dom.lastPhase !== 'uncertain') dom.viewing = true;
      dom.lastPhase = state.phase;
      dom.showStatus.hidden = !dom.viewing;
      dom.sourceStatus.textContent = `来源：${state.pageSource?.kind === 'douyin' ? '抖音' : state.pageSource?.kind === 'other' ? '非抖音' : '未知'}${state.pageSource?.origin ? ` · ${state.pageSource.origin}` : ''} · ${ready ? '已就绪' : '状态不确定'}`;
      dom.hint.hidden = ready || !!dom.viewing;
      if (ready) return;
      dom.hint.textContent = '';
      const source = state.pageSource?.kind === 'douyin' ? '抖音' : state.pageSource?.kind === 'other' ? '非抖音' : '未知';
      dom.dot.title = `来源：${source}；状态不确定`;
      const actions = () => {
        const retry = el('button', { type: 'button' }, '重试');
        retry.addEventListener('click', () => { dom.viewing = false; dom.onRetry?.(); });
        const view = el('button', { type: 'button' }, '查看网页');
        view.addEventListener('click', () => { dom.viewing = true; dom.hint.hidden = true; dom.showStatus.hidden = false; });
        dom.hint.append(retry, view);
      };
      if (state.phase === 'unsupported') {
        dom.hint.append(
          el('b', null, '这个窗口用不了内嵌抖音'),
          el(
            'span',
            null,
            '抖音返回 X-Frame-Options: DENY，普通浏览器标签页里的 <iframe> 一定会被拒绝；只有 Electron 的 webview 租约能绕开。',
          ),
          el('code', null, '请用 DSH 桌面版窗口打开（dsh-app://app）。'),
        );
        return;
      }
      if (state.phase === 'error') {
        dom.hint.append(
          el('b', null, '抖音窗口挂载失败'),
          el('code', null, state.detail || '未知错误'),
        );
        actions();
        return;
      }
      dom.hint.append(
        el('b', null, '正在打开抖音…'),
        el('span', null, '首次加载可能较慢；登录状态能否保留取决于网站和浏览器会话，可能需要重新登录。'),
      );
      actions();
    }

    function el(tag, attrs, text) {
      const node = document.createElement(tag);
      if (attrs !== null && attrs !== undefined) for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
      if (text !== undefined) node.textContent = text;
      return node;
    }

    /**
     * Whether a rejected `loadURL` is the site interrupting its own navigation.
     *
     * douyin.com answers the bare origin with a redirect to
     * `/?recommend=1&from_nav=1`, which aborts the navigation that asked for it.
     * Electron surfaces that through the remote-method bridge as
     * `Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: ERR_ABORTED (-3)`
     * — a plain Error whose `.code` is NOT set — so the code has to be read off
     * the message as well. `did-fail-load` already ignores `-3`; this keeps the
     * two paths consistent instead of painting a permanent failure over a page
     * that loaded fine.
     */
    function isAbortedNavigation(error) {
      if (error === null || error === undefined) return false;
      if (error.code === 'ERR_ABORTED') return true;
      const message = typeof error === 'string' ? error : String(error.message ?? '');
      return message.includes('ERR_ABORTED') || message.includes('(-3)');
    }

    /**
     * One guest bound to one lease.
     *
     * @param host - element the webview is appended to.
     * @param onStatus - receives `{ phase, detail }` for the dock chrome.
     */
    function createController(host, onStatus) {
      let bridge = null;
      let reservation = null;
      let element = null;
      let active = false;
      let disposed = false;
      // A close invalidates all async work from that open, including remount timers.
      let generation = 0;
      let mounting = null;
      const pendingMounts = new Set();
      let retrying = null;
      let remounts = 0;
      let unsubscribeOpen = null;
      let fit = { width: 0 };

      let pageSource = { kind: 'unknown', origin: '' };
      let currentPhase = 'idle';
      let currentDetail = '';
      let waitTimer = null;
      let waitRevision = 0;
      let waitExpired = false;
      const clearWait = () => { waitRevision += 1; if (waitTimer !== null) clearTimeout(waitTimer); waitTimer = null; };
      const startWait = () => {
        clearWait();
        const started = generation;
        const revision = waitRevision;
        waitTimer = setTimeout(() => {
          if (revision !== waitRevision) return;
          waitTimer = null;
          if (!disposed && active && generation === started && !['ready', 'error', 'unsupported'].includes(currentPhase)) {
            waitExpired = true;
            status('uncertain', '等待时间较长，无法确认页面是否加载完成。可查看网页或刷新重试。');
          }
        }, 10000);
      };
      const status = (phase, detail = '') => {
        if (['ready', 'error', 'unsupported'].includes(phase)) clearWait();
        if (phase === 'ready') waitExpired = false;
        currentPhase = phase;
        currentDetail = detail;
        onStatus({ phase, detail, pageSource });
      };
      const resetSource = () => { pageSource = { kind: 'unknown', origin: '' }; };
      function updateSource(node) {
        if (disposed || !active || element !== node) return;
        resetSource();
        try {
          const url = new URL(node.getURL());
          if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== 'null') {
            const host = url.hostname;
            pageSource = { kind: host === 'douyin.com' || host.endsWith('.douyin.com') ? 'douyin' : 'other', origin: url.origin };
          }
        } catch { /* no readable current origin */ }
        status(currentPhase, currentDetail);
      }

      // This is a renderer-side check, not a host isolation boundary. The in-guest
      // origin check narrows the async navigation race, but cannot protect against
      // malicious scripts on the same origin or guarantee host-level isolation.
      function isTrustedGuest(node) {
        try {
          const url = new URL(node.getURL());
          return url.origin === 'https://www.douyin.com' && !url.username && !url.password;
        } catch { return false; }
      }

      /**
       * douyin.com lays its desktop UI out for ~1024px and clips the right-hand
       * column below that rather than reflowing, so scale the whole guest down.
       * Zoom is per-origin in Electron, so this has to run again after every
       * document load, not just once at mount.
       */
      function syncFit() {
        if (element === null) return;
        const scale = fit.width > 0 ? Math.min(1, Math.max(0.5, fit.width / FIT_WIDTH)) : 1;
        try {
          element.setZoomFactor?.(scale);
        } catch {
          /* a guest mid-navigation refuses the call; the next dom-ready retries */
        }
      }

      function detach() {
        clearWait();
        if (typeof unsubscribeOpen === 'function') {
          try {
            unsubscribeOpen();
          } catch {
            /* the preload bridge already dropped it */
          }
        }
        unsubscribeOpen = null;
        const held = element;
        element = null;
        resetSource();
        if (held === null) return;
        try {
          held.remove();
        } catch {
          /* already gone */
        }
      }

      async function release() {
        const held = reservation;
        reservation = null;
        if (held === null || bridge === null) return;
        try {
          await bridge.release(held.lease);
        } catch {
          /* the main process already dropped it (releaseAll) */
        }
      }

      async function mount() {
        const current = generation;
        if (disposed || !active || mounting === current) return;
        mounting = current;
        const work = mountInternal(current);
        pendingMounts.add(work);
        try {
          await work;
        } finally {
          pendingMounts.delete(work);
          if (mounting === current) mounting = null;
        }
      }

      async function mountInternal(current) {
        if (disposed || !active || current !== generation) return;
        bridge = desktopBrowser();
        if (bridge === null) {
          status('unsupported', '只有 DSH 桌面版窗口（dsh-app://app）才有 dshDesktop.browser');
          return;
        }
        waitExpired = false;
        status('leasing', '正在申请 webview 租约…');
        startWait();
        const acquiringBridge = bridge;
        let held;
        try {
          held = await acquiringBridge.acquire(WORKSPACE);
        } catch (error) {
          if (!disposed && active && current === generation) {
            status('error', '无法创建内嵌浏览窗口，请点击刷新重试。');
          }
          return;
        }
        if (disposed || !active || current !== generation) {
          try {
            await acquiringBridge.release(held.lease);
          } catch {
            /* nothing to do */
          }
          return;
        }
        reservation = held;
        if (currentPhase !== 'uncertain') status('attaching', '正在挂载抖音窗口…');

        const node = document.createElement('webview');
        node.className = 'dyw-frame';
        // Parity with @deepseek-ai/dsh-client-ui-sidebar-browser/lib/client.js:1336-1342:
        // `allowpopups` lets the guest reach `setWindowOpenHandler` (the main process
        // always answers `{ action: "deny" }`, but it first sends us
        // `browserOpenRequested` for http/https targets); `data-sidebar-browser-frame`
        // is the marker the shell's shortcut bridge looks for.
        // Electron's own UA carries `Electron/<version>`, and douyin.com gates parts of
        // its player on the UA string. Present as plain desktop Chrome instead.
        node.setAttribute(
          'useragent',
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        );
        node.setAttribute('name', held.lease);
        node.setAttribute('allowpopups', '');
        node.setAttribute('data-sidebar-browser-frame', 'webview');
        // The lease id IS the fragment; `params.src.slice(12)` in the main process reads it.
        node.setAttribute('src', `about:blank#${held.lease}`);
        node.setAttribute('partition', held.partition);
        // New-window links: the main process denies the popup and tells us the URL
        // instead. Follow it in this same guest rather than losing the click.
        try {
          unsubscribeOpen = bridge.onOpenRequested(held.lease, (url) => {
            if (disposed || element !== node) return;
            node.loadURL(url).catch(() => {
              /* a denied or aborted follow-up is not worth a visible error */
            });
          });
        } catch {
          unsubscribeOpen = null;
        }
        node.addEventListener('dom-ready', () => {
          if (disposed || element !== node) return;
          syncFit();
          updateSource(node);
                                                                                    
                                                                      
                                                                             
                                                                                 
                                                                                     
                                                                                    
                                                                                 
                                                                                   
                                                                                   
                                                                                       
          if (!isTrustedGuest(node)) return;
          const shim = '(function(){if(location.origin!=="https://www.douyin.com")return;if(window.__dywFs)return;window.__dywFs=1;'
            + 'var d=document,c=null,st=null,s=d.createElement("style");'
            + 's.textContent=".dyw-fs{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;margin:0!important;transform:none!important;object-fit:cover!important;z-index:2147483647!important;background:#000!important}";'
            + 'function e(){if(!s.isConnected)(d.head||d.documentElement).appendChild(s)}'
            + 'function f(el){try{d.dispatchEvent(new Event("fullscreenchange"))}catch(x){}try{d.dispatchEvent(new Event("webkitfullscreenchange"))}catch(x){}if(el){try{el.dispatchEvent(new Event("fullscreenchange"))}catch(x){}try{el.dispatchEvent(new Event("webkitfullscreenchange"))}catch(x){}}}'
            + 'function u(el){if(!el)return;el.classList.remove("dyw-fs");if(st&&st.p){try{st.p.insertBefore(el,st.n)}catch(x){try{st.p.appendChild(el)}catch(y){}}}st=null}'
            + 'function a(el){e();if(c&&c!==el)u(c);c=el;el.classList.add("dyw-fs");'
            + 'try{var q=el.getBoundingClientRect();if(q.width<innerWidth*0.9||q.height<innerHeight*0.9){st={p:el.parentNode,n:el.nextSibling};d.body.appendChild(el)}}catch(x){}'
            + 'f(el)}'
            + 'function r(){var el=c;u(c);c=null;f(el)}'
            + 'function pick(){try{var l=d.querySelectorAll("video");for(var i=0;i<l.length;i++){var b=l[i].getBoundingClientRect();if(b.width>160&&b.height>90&&b.bottom>0&&b.top<innerHeight&&b.right>0&&b.left<innerWidth)return l[i]}}catch(x){}return d.documentElement}'
            + 'window.__dywToggle=function(){if(c)r();else a(pick())};'
            + 'var p=Element.prototype;'
            + '["requestFullscreen","webkitRequestFullscreen","webkitRequestFullScreen","mozRequestFullScreen","msRequestFullscreen"].forEach(function(n){if(p[n])p[n]=function(){a(this);return Promise.resolve()}});'
            + 'var v=window.HTMLVideoElement&&HTMLVideoElement.prototype;'
            + 'if(v){v.webkitEnterFullscreen=function(){a(this)};v.webkitExitFullscreen=function(){r()};'
            + 'try{Object.defineProperty(v,"webkitSupportsFullscreen",{get:function(){return true},configurable:true})}catch(x){}'
            + 'try{Object.defineProperty(v,"webkitDisplayingFullscreen",{get:function(){return c===this},configurable:true})}catch(x){}}'
            + 'd.exitFullscreen=function(){r();return Promise.resolve()};'
            + 'd.webkitExitFullscreen=function(){r();return Promise.resolve()};'
            + 'try{Object.defineProperty(d,"fullscreenElement",{get:function(){return c},configurable:true})}catch(x){}'
            + 'try{Object.defineProperty(d,"webkitFullscreenElement",{get:function(){return c},configurable:true})}catch(x){}'
            + 'try{Object.defineProperty(d,"fullscreenEnabled",{get:function(){return true},configurable:true})}catch(x){}'
            + 'try{Object.defineProperty(d,"webkitFullscreenEnabled",{get:function(){return true},configurable:true})}catch(x){}'
            + 'd.addEventListener("dblclick",function(ev){var t=ev.target;if(t&&t.closest&&t.closest("input,textarea,[contenteditable]"))return;ev.preventDefault();window.__dywToggle()},true);'
            + 'd.addEventListener("keydown",function(ev){if(ev.key==="Escape"&&c){ev.stopPropagation();r()}},true);'
            + '})();';
          node.executeJavaScript(shim).catch(() => {
            /* a guest mid-navigation refuses the call; the next dom-ready retries */
          });
        });
        let homeRequested = false;
        let mainLoadFailed = false;
        let committedTrusted = false;
        let committedURL = '';
        let finishedObserved = false;
        let navigationRevision = 0;
        let initialLoadRevision = null;
        node.addEventListener('did-start-navigation', (event) => {
          if (disposed || element !== node || !active || !event.isMainFrame || event.isInPlace) return;
          // getURL() may still expose the previous document at navigation start.
          navigationRevision += 1;
          if (homeRequested && initialLoadRevision === null) initialLoadRevision = navigationRevision;
          committedTrusted = false;
          committedURL = '';
          finishedObserved = false;
          mainLoadFailed = false;
          resetSource();
          if (waitExpired) status('uncertain', '等待时间较长，无法确认页面是否加载完成。可查看网页或刷新重试。');
          else {
            status('loading', '正在打开页面…');
            if (waitTimer === null) startWait();
          }
        });
        node.addEventListener('did-navigate', (event) => {
          if (disposed || element !== node || !active) return;
          // did-navigate is a main-frame commit. getURL() may lag or already
          // reflect another same-origin URL; check the current origin at finish.
          committedTrusted = false;
          committedURL = '';
          try {
            const committed = new URL(event.url);
            committedTrusted = committed.origin === new URL(HOME).origin && !committed.username && !committed.password;
            if (committedTrusted) committedURL = committed.href;
          } catch { /* invalid commit */ }
          updateSource(node);
        });
        node.addEventListener('did-navigate-in-page', (event) => {
          if (event.isMainFrame) updateSource(node);
        });
        node.addEventListener(
          'dom-ready',
          () => {
            if (disposed || element !== node) return;
            homeRequested = true;
            const requestedRevision = navigationRevision;
            const onRejection = (error) => {
              // The first start may be delivered synchronously or asynchronously
              // by loadURL. Later starts supersede it, but without navigation IDs
              // even the first observed start cannot be attributed with certainty.
              const expectedRevision = initialLoadRevision ?? requestedRevision;
              if (disposed || !active || element !== node || navigationRevision !== expectedRevision || currentPhase === 'ready') return;
              if (isAbortedNavigation(error)) return;
              mainLoadFailed = true;
              status('error', '无法打开页面，请检查电脑网络设置后点击刷新重试。');
            };
            try { Promise.resolve(node.loadURL(HOME)).catch(onRejection); }
            catch (error) { onRejection(error); }
          },
          { once: true },
        );
        node.addEventListener('did-fail-load', (event) => {
          if (disposed || element !== node) return;
          // -3 is ERR_ABORTED: the page redirected, superseded, or cancelled its
          // own load. A later did-finish-load or dom-ready proves it succeeded.
          if (!event.isMainFrame || event.errorCode === -3) return;
          mainLoadFailed = true;
          status('error', '页面加载失败，请检查电脑网络设置后点击刷新重试。');
        });
        const checkFinished = () => {
          if (disposed || element !== node || !active || !homeRequested || mainLoadFailed || !finishedObserved) return;
          // Completion has no URL or navigation ID. Require a trusted main-frame
          // commit since the last start and a trusted current URL, but this cannot
          // prove which navigation emitted a delayed completion event.
          if (!committedTrusted || !isTrustedGuest(node)) return;
          let currentURL;
          try { currentURL = new URL(node.getURL()).href; } catch { return; }
          if (currentURL !== committedURL) {
            // Same-origin mismatch could be a delayed event. Only expose the page
            // when Electron explicitly says loading stopped; do not claim ready.
            try { if (node.isLoading() !== false) return; } catch { return; }
            status('uncertain', '页面来源已确认，但加载事件无法对应到具体导航。');
            return;
          }
          remounts = 0;
          status('ready', '');
        };
        node.addEventListener('did-finish-load', () => {
          if (disposed || element !== node || !active) return;
          finishedObserved = true;
          checkFinished();
        });
        // did-finish-load can precede the loading flag clearing.
        node.addEventListener('did-stop-loading', checkFinished);
        node.addEventListener(
          'destroyed',
          () => {
            if (disposed || element !== node) return;
            // Unsubscribe before remounting; the lease was already dropped by
            // the host, so detach must not release it.
            detach();
            reservation = null;
            if (!active) return;
            if (remounts >= MAX_REMOUNTS) {
              status('error', '窗口被反复销毁（宿主窗口可能刚刷新过），已停止自动重挂');
              return;
            }
            remounts += 1;
            status('attaching', `窗口被销毁，正在重挂（第 ${remounts} 次）…`);
            setTimeout(() => {
              if (active && !disposed && current === generation) void mount();
            }, 400);
          },
          { once: true },
        );

        element = node;
        host.appendChild(node);
        syncFit();
      }

      return {
        async open() {
          if (disposed || active) return;
          active = true;
          remounts = 0;
          await mount();
        },
        async close() {
          if (!active) { generation += 1; return; }
          active = false;
          const closed = ++generation;
          detach();
          await release();
          if (!disposed && !active && generation === closed) status('idle', '');
        },
        retry() {
          if (retrying !== null) return retrying;
          if (disposed || !active) return Promise.resolve();
          const closing = this.close();
          const closedGeneration = generation;
          retrying = (async () => {
            await closing;
            if (disposed || active || generation !== closedGeneration) return;
            if (pendingMounts.size) status('attaching', '正在等待旧窗口请求结束并释放，再重新打开。');
            // A stale acquire owns its lease until its continuation releases it.
            await Promise.allSettled([...pendingMounts]);
            if (disposed || active || generation !== closedGeneration) return;
            await this.open();
          })().finally(() => { retrying = null; });
          return retrying;
        },
        reload() {
          if (element === null) {
            if (active && !disposed) void mount();
            return;
          }
          element.reload?.();
        },
        /**
         * Toggle the page's fullscreen *inside the guest*. The shim installed on
         * every dom-ready owns that state; the expansion is bounded by the guest
         * viewport — this panel's body — never by the desktop window. Only the
         * page's own control calls this now; the bar has no mirror button.
         */
        toggleFullscreen() {
          if (element === null || !isTrustedGuest(element)) return;
          element.executeJavaScript('if(location.origin==="https://www.douyin.com")window.__dywToggle&&window.__dywToggle()').catch(() => {
            /* a guest mid-navigation refuses the call; the next dom-ready retries */
          });
        },
        /** Called on every move/resize so the guest keeps matching the panel. */
        applyFit(width) {
          fit = { width };
          syncFit();
        },
        async dispose() {
          disposed = true;
          active = false;
          generation += 1;
          detach();
          await release();
        },
      };
    }

    /** The sidebar-foot button. The dock it toggles lives on `document.body`. */
    function DouyinToggle() {
      const [open, setOpen] = react.useState(false);
      const [state, setState] = react.useState({ phase: 'idle', detail: '' });
      const domRef = react.useRef(null);
      const controllerRef = react.useRef(null);
                                                                          
      const behindRef = react.useRef(false);

      react.useEffect(() => {
        if (!open) return undefined;
        behindRef.current = false;
        const dom = createDockDom(
          () => setOpen(false),
          () => {
            const current = domRef.current;
            if (current === null) return;
            controllerRef.current?.applyFit(current.dock.getBoundingClientRect().width);
          },
        );
        domRef.current = dom;
        const controller = createController(dom.host, setState);
        controllerRef.current = controller;
        dom.onRetry = () => { void controller.retry(); };
        controller.applyFit(dom.dock.getBoundingClientRect().width);
        paintDock(dom, { phase: 'idle', detail: '' });
        void controller.open();
        return () => {
          domRef.current = null;
          controllerRef.current = null;
          void controller.dispose();
          dom.dock.remove();
        };
      }, [open]);

      react.useEffect(() => {
        const dom = domRef.current;
        if (dom === null) return;
        paintDock(dom, state);
      }, [state]);

                                                                      
                                                                                         
                                                                                          
                                                                            
                                                                                    
                                                                                        
                                                                                           

      return h(
        'button',
        {
          type: 'button',
          className: 'dyw-toggle',
          'data-open': open ? 'true' : 'false',
          title: open ? '收起抖音内嵌窗口' : '打开抖音内嵌窗口',
          'aria-label': open ? '收起抖音内嵌窗口' : '打开抖音内嵌窗口',
          onClick: () => {
                                                                             
                                                                                     
            if (open && behindRef.current) {
              behindRef.current = false;
              domRef.current?.dock.removeAttribute('data-behind');
              if (domRef.current) globalThis.__dsDockTopmost?.(domRef.current.dock, true);
              return;
            }
            setOpen((value) => !value);
          },
        },
        glyph(),
      );
    }

    /* =====================================================================
     * Main-area edition (adapted in this workspace).
     *
     * The dock chrome above (createDockDom / paintDock / DouyinToggle) is kept
     * as an unused fallback. The plugin now registers a left-sidebar panel icon
     * that selects a `main` view, plus a persistent `shell.overlay` container
     * that keeps the leased Electron <webview> alive across panel switches. The
     * webview kernel (createController) is untouched and still drives the guest.
     * ===================================================================== */
    const PANEL_ID = 'douyin-sidebar';
    const VIEW_ID = 'douyin-sidebar.viewport';
    const SLOT_PANEL = 'sidebar.panellist';
    const SLOT_MAIN = 'main';
    const SLOT_OVERLAY = 'shell.overlay';
    const CONTAINER_Z_INDEX = 10;

    const COPY = {
      title: '抖音',
      reload: '刷新抖音',
      close: '关闭抖音',
      reopen: '重新打开',
      closed: '抖音已关闭',
      closedHint: '关闭后不再占用后台，也不会继续播放。切换到别的面板再点左侧抖音图标即可重新打开。',
      loading: '正在打开抖音…',
      loadingHint: '首次加载可能较慢；登录状态能否保留取决于网站和浏览器会话，可能需要重新登录。',
      unsupported: '此面板只在 DSH 桌面端可用：当前运行环境没有桌面浏览器桥。',
      error: '页面加载失败',
    };

    function createViewportStore() {
      let rect;
      const listeners = new Set();
      return {
        get: () => rect,
        set(next) {
          if (next && rect && next.left === rect.left && next.top === rect.top && next.width === rect.width && next.height === rect.height) return;
          rect = next;
          for (const l of [...listeners]) l(rect);
        },
        subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
      };
    }

    function createStatusStore() {
      let state = { phase: 'idle', detail: '' };
      const listeners = new Set();
      return {
        get: () => state,
        set(next) { state = next; for (const l of [...listeners]) l(state); },
        subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
      };
    }

    /** Mount the guest once and keep it; switching panels only hides the overlay. */
    function createDouyinSession(status) {
      let controller = null;
      let host = null;
      let opened = false;
      let closed = false;
      let fit = 0;
      return {
        attachHost(node) { host = node; },
        open() {
          if (closed || opened || controller !== null || host === null) return;
          opened = true;
          controller = createController(host, (s) => status.set(s));
          controller.applyFit(fit);
          void controller.open();
        },
        applyFit(width) { fit = width; controller?.applyFit(width); },
        reload() { controller?.reload(); },
        retry() { return controller?.retry(); },
        /* 
                                                                                  
                                                                                   
                                                                                
                                                                                   
                                                                             
         */
        async close() {
          const held = controller;
          controller = null;
          opened = false;
          closed = true;
          status.set({ phase: 'closed', detail: '' });
          await held?.dispose();
        },
        /** Leaving the panel clears the closed state, so coming back reopens it. */
        reopen() { closed = false; this.open(); },
        async dispose() { await controller?.dispose(); controller = null; opened = false; closed = false; },
      };
    }

    const viewport = createViewportStore();
    const statusStore = createStatusStore();
    const session = createDouyinSession(statusStore);

    function glyphSized(size) {
      const s = typeof size === 'number' ? size : 18;
      return h('svg', { width: s, height: s, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false', style: { display: 'block' } },
        h('path', { d: 'M14.2 3h3.1c.3 2.05 1.62 3.55 3.7 3.86v3.02c-1.45-.03-2.72-.44-3.85-1.2v6.5a5.72 5.72 0 1 1-5.72-5.72c.3 0 .6.02.9.07v3.15a2.6 2.6 0 1 0 1.87 2.5V3z', fill: 'currentColor' }));
    }

    /** Left-sidebar panel icon (the slot passes { size, active }). */
    function DouyinIcon(props) {
      return glyphSized(props?.size);
    }

    /** `main` entry: a transparent box that reports where the overlay must sit. */
    function PanelPlaceholder() {
      const ref = react.useRef(null);
      react.useLayoutEffect(() => {
        const node = ref.current;
        if (node === null) return undefined;
        const publish = () => {
          const r = node.getBoundingClientRect();
          viewport.set({ left: r.left, top: r.top, width: r.width, height: r.height });
        };
        publish();
        const observer = new ResizeObserver(publish);
        observer.observe(node);
        window.addEventListener('resize', publish);
        const timer = setInterval(publish, 1000);
        return () => {
          observer.disconnect();
          window.removeEventListener('resize', publish);
          clearInterval(timer);
          viewport.set(undefined);
        };
      }, []);
      return h('div', {
        ref,
        'data-dsh-douyin-placeholder': '',
        style: { height: '100%', minHeight: 0, background: 'var(--dsw-alias-bg-base, transparent)' },
      });
    }

    function ToolButton(props) {
      return h('button', {
        type: 'button',
        title: props.label,
        'aria-label': props.label,
        onClick: props.onClick,
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 28, height: 28, flex: 'none', padding: 0, border: 0,
          borderRadius: 'var(--dsw-radius-sm, 6px)', background: 'transparent',
          color: 'var(--dsw-alias-label-secondary, #9aa0a6)', cursor: 'pointer',
        },
      }, props.children);
    }

    function reloadGlyph() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false', style: { display: 'block' } },
        h('path', { d: 'M20 12a8 8 0 1 1-2.4-5.7' }),
        h('path', { d: 'M20 4v5h-5' }));
    }

    /*                                                                          
                                         */
    function closeGlyph() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false', style: { display: 'block' } },
        h('path', { d: 'M6 6l12 12' }),
        h('path', { d: 'M18 6L6 18' }));
    }

    /** `shell.overlay` entry: always mounted, so the guest survives panel switches. */
    function BrowserViewport() {
      const [state, setState] = react.useState(statusStore.get());
      const [rect, setRect] = react.useState(viewport.get());
      const [peek, setPeek] = react.useState(false);
      const hostRef = react.useRef(null);

      react.useEffect(() => statusStore.subscribe(setState), []);
      react.useEffect(() => { if (state.phase === 'ready' || state.phase === 'closed' || state.phase === 'uncertain') setPeek(false); }, [state.phase]);
      react.useEffect(() => viewport.subscribe(setRect), []);
      react.useEffect(() => { if (hostRef.current !== null) session.attachHost(hostRef.current); }, []);

      const visible = rect !== undefined;
      // Entering the panel always reopens a guest that was closed earlier; the
      // close button only applies while the panel stays open.
      react.useEffect(() => { if (visible) session.reopen(); }, [visible]);
      react.useEffect(() => { if (visible && rect) session.applyFit(rect.width); }, [visible, rect ? rect.width : 0]);

      let hintTitle = COPY.loading;
      let hintBody = state.detail || COPY.loadingHint;
      if (state.phase === 'unsupported') { hintTitle = COPY.unsupported; hintBody = state.detail || ''; }
      else if (state.phase === 'error') { hintTitle = COPY.error; hintBody = state.detail || ''; }
      else if (state.phase === 'closed') { hintTitle = COPY.closed; hintBody = COPY.closedHint; }
      const canRecover = !['ready', 'closed', 'unsupported'].includes(state.phase);
      const banner = state.phase === 'error';
      // An unconfirmed page remains unconfirmed internally, but must be usable
      // without an overlay. Actual failures still show a visible retry banner.
      const showHint = !['ready', 'uncertain'].includes(state.phase) && (banner || !(peek && canRecover));

      const style = {
        position: 'fixed', zIndex: CONTAINER_Z_INDEX, pointerEvents: 'auto',
        display: visible ? 'flex' : 'none', flexDirection: 'column', minHeight: 0, overflow: 'hidden',
        background: 'var(--dsw-alias-bg-base, #101014)', color: 'var(--dsw-alias-label-primary, #e8e8e8)',
        ...(visible ? { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` } : {}),
      };

      return h('div', { 'data-dsh-douyin-viewport': '', 'aria-hidden': visible ? undefined : 'true', style },
        h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 8, height: 38, flex: 'none', padding: '0 10px',
            background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))',
            borderBottom: '0.5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.16))',
          },
        },
          h('span', { style: { color: 'var(--dsw-alias-label-primary, #e8e8e8)', fontSize: 13, fontWeight: 600 } }, COPY.title),
          h('span', { style: { flex: 'auto' } }),
          h(ToolButton, { label: COPY.reload, onClick: () => session.reload() }, reloadGlyph()),
          h(ToolButton, { label: COPY.close, onClick: () => { void session.close(); } }, closeGlyph()),
        ),
        h('div', { style: { position: 'relative', flex: 'auto', minHeight: 0 } },
          h('div', { ref: hostRef, 'data-dsh-douyin-host': '', style: { position: 'absolute', inset: 0, display: 'flex' } }),
          showHint && h('div', {
            style: {
              position: 'absolute', ...(banner ? { top: 0, left: 0, right: 0 } : { inset: 0 }), display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24, boxSizing: 'border-box',
              textAlign: 'center', color: 'var(--dsw-alias-label-tertiary, #9aa0a6)',
              font: '12px/1.7 system-ui, sans-serif',
              background: 'var(--dsw-alias-bg-base, #101014)',
              /*                                       
                                                  */
              pointerEvents: 'auto',
            },
          },
            h('b', { style: { color: '#fe2c55', fontSize: 13, fontWeight: 600 } }, hintTitle),
            hintBody ? h('span', null, hintBody) : null,
            canRecover && h('div', { style: { display: 'flex', gap: 8 } },
              h('button', { type: 'button', onClick: () => { setPeek(false); void session.retry(); } }, '重试'),
              !banner && h('button', { type: 'button', onClick: () => setPeek(true) }, '查看网页'),
            ),
            state.phase === 'closed' && h('button', {
              type: 'button',
              onClick: () => session.reopen(),
              style: {
                marginTop: 4, padding: '5px 14px', border: 0, cursor: 'pointer',
                borderRadius: 'var(--dsw-radius-sm, 6px)',
                background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))',
                color: 'var(--dsw-alias-label-primary, #e8e8e8)', font: '12px/1.4 system-ui, sans-serif',
              },
            }, COPY.reopen),
          ),
        ),
      );
    }

    function apply(ctx) {
      installStyle();
      if (typeof ctx?.slots?.inject !== 'function' || typeof ctx?.slots?.register !== 'function') {
        console.error('[dsh-douyin-sidebar] 没有 slots 服务，面板未挂载');
        return;
      }
      ctx.slots.inject(SLOT_PANEL, function* () {
        yield ctx.slots.register({ name: SLOT_PANEL, id: PANEL_ID, order: 40, label: COPY.title }, DouyinIcon);
      });
      ctx.slots.inject(SLOT_MAIN, function* () {
        yield ctx.slots.register({ name: SLOT_MAIN, key: PANEL_ID }, PanelPlaceholder);
      });
      ctx.slots.inject(SLOT_OVERLAY, function* () {
        yield ctx.slots.register({ name: SLOT_OVERLAY, id: VIEW_ID }, BrowserViewport);
      });
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
          void session.dispose();
          const s = document.getElementById(STYLE_ID);
          if (s !== null) s.remove();
        }, 'dsh-douyin-sidebar: cleanup');
      }
    }

    exports.inject = ['slots'];
    exports.apply = apply;
    return module.exports;
  },
});