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
 *
 * SMOOTH-SCROLL NOTES (regression fix, see BUG-REPORT.md):
 * - Lenis 1.3's built-in `autoRaf` is used instead of a hand-rolled
 *   requestAnimationFrame loop. The old loop ticked `lenis.raf()` every
 *   frame unconditionally, even when nothing was scrolling.
 * - `duration` default is 0.9s (was 1.2s). 1.2s felt laggy / floaty and
 *   made Virtuoso re-render rows for over a second after every wheel
 *   flick. 0.9s with Lenis' default exponential-out easing still feels
 *   smooth without trailing behind the user's hand.
 * - Callers that restore scroll position MUST use `lenis.scrollTo(x, {
 *   immediate: true, force: true })` instead of setting
 *   `container.scrollTop` directly: Lenis owns the scroll position and
 *   will animate back / fight a direct assignment.
 */
import { useEffect, useRef } from 'react';
import Lenis from 'lenis';

/**
 * @param {object} [options]
 * @param {React.RefObject<HTMLElement>} [options.wrapperRef]
 * @param {React.RefObject<HTMLElement>} [options.contentRef]
 * @param {number}   [options.duration=0.9]
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
    duration = 0.9,
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
      // Lenis runs its own rAF loop; no manual tick needed.
      autoRaf: true,
      ...(wrapperEl ? { wrapper: wrapperEl, content: contentEl } : {}),
    };

    const lenis = new Lenis(lenisOpts);
    lenisRef.current = lenis;

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
