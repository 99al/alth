function createThreadRunRegistry() {
  const activeRuns = new Map();

  function isActive(run) {
    return Boolean(
      run &&
      !run.cancelled &&
      activeRuns.get(run.threadID) === run
    );
  }

  function cancel(threadID) {
    const key = String(threadID);
    const run = activeRuns.get(key);

    if (!run) {
      return false;
    }

    run.cancelled = true;

    if (run.cancelDelay) {
      run.cancelDelay();
    }

    for (const timer of run.timeouts) {
      clearTimeout(timer);
    }

    for (const interval of run.intervals) {
      clearInterval(interval);
    }

    run.timeouts.clear();
    run.intervals.clear();
    activeRuns.delete(key);
    return true;
  }

  function begin(threadID, { replace = false } = {}) {
    const key = String(threadID);

    if (activeRuns.has(key)) {
      if (!replace) {
        return null;
      }

      cancel(key);
    }

    const run = {
      threadID: key,
      cancelled: false,
      timeouts: new Set(),
      intervals: new Set(),
      cancelDelay: null
    };

    activeRuns.set(key, run);
    return run;
  }

  function wait(run, delayMs) {
    return new Promise(resolve => {
      if (!isActive(run)) {
        resolve(false);
        return;
      }

      let timer;
      let settled = false;

      const settle = elapsed => {
        if (settled) {
          return;
        }

        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
          run.timeouts.delete(timer);
        }

        if (run.cancelDelay === cancelDelay) {
          run.cancelDelay = null;
        }

        resolve(elapsed && isActive(run));
      };

      const cancelDelay = () => settle(false);
      timer = setTimeout(() => settle(true), delayMs);
      run.timeouts.add(timer);
      run.cancelDelay = cancelDelay;
    });
  }

  function scheduleTimeout(run, callback, delayMs) {
    if (!isActive(run)) {
      return null;
    }

    const timer = setTimeout(() => {
      run.timeouts.delete(timer);
      if (isActive(run)) {
        callback();
      }
    }, delayMs);

    run.timeouts.add(timer);
    return timer;
  }

  function scheduleInterval(run, callback, intervalMs) {
    if (!isActive(run)) {
      return null;
    }

    const interval = setInterval(() => {
      if (isActive(run)) {
        callback();
      }
    }, intervalMs);

    run.intervals.add(interval);
    return interval;
  }

  function finish(run) {
    if (!isActive(run)) {
      return false;
    }

    return cancel(run.threadID);
  }

  function cancelAll() {
    let cancelled = 0;

    for (const threadID of [...activeRuns.keys()]) {
      if (cancel(threadID)) {
        cancelled += 1;
      }
    }

    return cancelled;
  }

  return {
    begin,
    wait,
    scheduleTimeout,
    scheduleInterval,
    isActive,
    finish,
    cancel,
    cancelAll,
    has: threadID => activeRuns.has(String(threadID)),
    get size() {
      return activeRuns.size;
    }
  };
}

module.exports = { createThreadRunRegistry };
