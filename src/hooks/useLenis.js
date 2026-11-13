/**
 * useLenis — lightweight Lenis smooth-scroll hook
 *
 * Usage:
 *   // Window scroll (TradeDetail, etc.)
 *   useLenis();
 *
 *   // Custom element scroll (WeeklyJournal inner container)
 *   useLenis({ wrapperRef, contentRef });
 *
 * Returns the Lenis instance ref so callers can call lenis.scrollTo() etc.
 */
import { useEffect, useRef } from 'react';
import Lenis from 'lenis';

/**
 * @param {object} [options]
 * @param {React.RefObject<HTMLElement>} [options.wrapperRef]
 * @param {React.RefObject<HTMLElement>} [options.contentRef]
 * @param {number}   [options.duration=1.2]
 * @param {boolean}  [options.smoothWheel=true]
 * @param {boolean}  [options.syncTouch=false]
 * @param {'vertical'|'horizontal'|'both'} [options.orientation='vertical']
 * @param {(e: WheelEvent) => boolean} [options.shouldPrevent]
 * @returns {React.MutableRefObject<Lenis|null>}
 */
export function useLenis(options = {}) {
  const lenisRef = useRef(null);

  const {
    wrapperRef,
    contentRef,
    duration = 1.2,
    smoothWheel = true,
    syncTouch = false,
    orientation = 'vertical',
    shouldPrevent,
  } = options;

  // Use a stable dependency: the actual DOM node from the ref
  const wrapperEl = wrapperRef?.current ?? null;
  const contentEl = contentRef?.current ?? null;

  useEffect(() => {
    // For element-based scroll, wait until nodes are available
    if (wrapperRef && !wrapperEl) return;
    if (contentRef && !contentEl) return;

    const lenisOpts = {
      duration,
      smoothWheel,
      syncTouch,
      orientation,
      ...(wrapperEl ? { wrapper: wrapperEl, content: contentEl } : {}),
    };

    const lenis = new Lenis(lenisOpts);
    lenisRef.current = lenis;

    // Tick Lenis every frame
    let rafId;
    const tick = (time) => {
      lenis.raf(time);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    // Wheel guard: pause/resume Lenis for specific events (e.g. Ctrl+Wheel)
    let onWheel;
    if (shouldPrevent) {
      const target = wrapperEl ?? window;
      onWheel = (e) => {
        if (shouldPrevent(e)) lenis.stop();
        else lenis.start();
      };
      target.addEventListener('wheel', onWheel, { passive: false });
    }

    return () => {
      cancelAnimationFrame(rafId);
      lenis.destroy();
      lenisRef.current = null;
      if (onWheel) {
        const target = wrapperEl ?? window;
        target.removeEventListener('wheel', onWheel);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrapperEl, contentEl]);

  return lenisRef;
}
