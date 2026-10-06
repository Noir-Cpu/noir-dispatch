import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type DemoStep } from "./api";

/** How often the browser asks for the next step while the demo is running and the tab is visible. */
export const DEMO_STEP_MS = 2500;
/** The browser stops stepping after this long; the visitor can press the button again. */
export const DEMO_MAX_MS = 6 * 60_000;

export type DemoStatus = "idle" | "running" | "paused" | "finished" | "stopped";

/**
 * Drives the on-demand demo. One POST per step, one at a time, only while the tab is visible and the order is not finished.
 * Nothing runs when the tab is hidden or closed, so the server only does work (and Neon compute is only used) while someone
 * is actually watching their own order.
 */
export function useDemo(orderId: string, onStep: (s: DemoStep) => void) {
  const [status, setStatus] = useState<DemoStatus>("idle");
  const [last, setLast] = useState<DemoStep | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const cb = useRef(onStep);
  cb.current = onStep;
  const running = status === "running";

  const start = useCallback(() => {
    setMessage(null);
    setStatus("running");
  }, []);
  const stop = useCallback(() => {
    setMessage("Demo paused.");
    setStatus("paused");
  }, []);

  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    let timer: number | undefined;
    const ctl = new AbortController();
    const startedAt = Date.now();

    const tick = async () => {
      if (cancelled) return;
      if (document.visibilityState === "hidden") {
        setMessage("Paused because this tab is hidden. The demo only runs while you are looking at it.");
        setStatus("paused");
        return;
      }
      if (Date.now() - startedAt > DEMO_MAX_MS) {
        setMessage("Stopped after 6 minutes. Press Run demo to carry on.");
        setStatus("stopped");
        return;
      }
      try {
        const r = await api.demoStep(orderId, ctl.signal);
        if (cancelled) return;
        setLast(r);
        cb.current(r);
        if (r.done) {
          setStatus("finished");
          return;
        }
        timer = window.setTimeout(tick, DEMO_STEP_MS);
      } catch (e) {
        if (cancelled || (e instanceof DOMException && e.name === "AbortError")) return;
        const err = e as ApiError;
        setMessage(
          err.status === 404
            ? "The demo is not switched on for this site."
            : err.status === 429
              ? err.code === "daily_cap" || err.code === "step_limit"
                ? err.message
                : "Too many requests from this device. Wait a moment and press Run demo again."
              : err.status === 503
                ? err.message
                : err.message || "The demo stopped because of an error.",
        );
        setStatus("stopped");
      }
    };
    void tick();

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        window.clearTimeout(timer);
        ctl.abort();
        cancelled = true;
        setMessage("Paused because this tab is hidden. The demo only runs while you are looking at it.");
        setStatus("paused");
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      ctl.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [running, orderId]);

  return { status, running, last, message, start, stop };
}
