/**
 * Helpers that treat RTCDataChannel and test doubles the same way.
 *
 * The transfer engines only rely on:
 *   readyState, bufferedAmount, bufferedAmountLowThreshold,
 *   send(), close(), and the open/close/error/message/bufferedamountlow events.
 */

/** Bind an event listener with a matcher that works on channels and fakes. */
export function bindEvent(target, type, handler) {
  if (typeof target.addEventListener === 'function') {
    target.addEventListener(type, handler);
    return () => {
      try {
        target.removeEventListener(type, handler);
      } catch {
        /* target already torn down */
      }
    };
  }
  const property = `on${type}`;
  const previous = target[property];
  target[property] = handler;
  return () => {
    if (target[property] === handler) target[property] = previous ?? null;
  };
}

export function channelIsOpen(channel) {
  return !!channel && channel.readyState === 'open';
}

/**
 * Resolve when `channel.bufferedAmount` drops to `highWater` or below.
 *
 * Backpressure matters: without it a fast disk plus a slow peer link would
 * queue an entire large file in memory.
 *
 * @param {RTCDataChannel} channel
 * @param {{highWater:number, shouldAbort:() => boolean}} options
 */
export async function waitForWritable(channel, { highWater, shouldAbort }) {
  while (!shouldAbort()) {
    if ((channel.bufferedAmount ?? 0) <= highWater) return;
     
    await new Promise((resolve) => {
      let finished = false;
      let unbind = () => {};
      let interval = null;
      const finish = () => {
        if (finished) return;
        finished = true;
        unbind();
        if (interval) clearInterval(interval);
        resolve();
      };
      unbind = bindEvent(channel, 'bufferedamountlow', finish);
      // Safety net: some engines only fire the event when the threshold is
      // crossed after the listener was attached, and events can be missed
      // during renegotiation.
      interval = setInterval(() => {
        if ((channel.bufferedAmount ?? 0) <= highWater || shouldAbort()) finish();
      }, 150);
      if (typeof interval.unref === 'function') interval.unref();
      if ((channel.bufferedAmount ?? 0) <= highWater || shouldAbort()) finish();
    });
  }
}

/**
 * A gate the sender loops on while paused or cancelled.
 * @param {{isPaused:() => boolean, isAborted:() => boolean, subscribe:(fn:() => void) => () => void}} state
 */
export async function waitForResume(state) {
  while (state.isPaused() && !state.isAborted()) {
     
    await new Promise((resolve) => {
      const unsubscribe = state.subscribe(resolve);
      // Re-check after subscribing to close the wake-up race.
      if (!state.isPaused() || state.isAborted()) {
        unsubscribe();
        resolve();
      }
    });
  }
}

/** Simple notification bus for pause/resume/cancel wake-ups. */
export function createNotifier() {
  const listeners = new Set();
  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    notify() {
      for (const fn of [...listeners]) {
        try {
          fn();
        } catch {
          /* a listener must never break the transfer loop */
        }
      }
      listeners.clear();
    },
    clear() {
      listeners.clear();
    },
    get size() {
      return listeners.size;
    },
  };
}
