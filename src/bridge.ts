import {
  getActiveSession,
  type EventEmitter,
  type VisionAssertInput,
  type VisionFrameEvent,
  type VisionLogEvent,
  type VisionSnapshot,
  type VisionStatusEvent,
  type ViewportName
} from "./session";

export type {
  VisionFrameEvent,
  VisionStatusEvent,
  VisionLogEvent,
  VisionSnapshot,
  ViewportName
} from "./session";

export type DeviceOption = "mobile" | "desktop" | "both";

export interface LegacyStep {
  action: "fill" | "click" | "press" | "navigate" | "waitFor" | "waitForUrl";
  selector?: string;
  value?: string;
  key?: string;
  url?: string;
  ms?: number;
  urlContains?: string;
  timeoutMs?: number;
  fallbackSelectors?: string[];
}

export interface LegacyAssertion {
  type: "textVisible" | "selectorVisible" | "toastVisible" | "errorVisible" | "urlContains";
  text?: string;
  value?: string;
  selector?: string;
  timeoutMs?: number;
  exact?: boolean;
}

export interface VisionCheckInput {
  url: string;
  device: DeviceOption;
  description?: string;
  task?: { problem: string; context?: Record<string, string> };
  script?: {
    mode?: "behavior" | "visual" | "both";
    steps?: LegacyStep[];
    assertions?: LegacyAssertion[];
    holdOpenMs?: number;
    showActionMarkers?: boolean;
  };
}

export interface VisionCheckResult {
  status: "PASS" | "FAIL";
  url: string;
  finalUrl?: string;
  checks: { viewport: ViewportName; diffPixels: number; diffPercent: number }[];
  behaviorPass?: boolean;
  behaviorErrors?: string[];
  errorMessage?: string;
  failureType?:
    | "navigation_failed"
    | "step_failed"
    | "assertion_failed"
    | "plan_empty"
    | "unknown";
  nextAction?: "provide_steps" | "fix_selector" | "start_server" | "retry_with_wait" | "inspect_unknown";
  suggestion?: string;
  resolvedScript?: { source: "manual" | "auto"; steps: LegacyStep[]; assertions: LegacyAssertion[] };
  evidence?: { toasts: string[]; alerts: string[]; errors: string[] };
  timestamp: string;
}

function deviceList(device: DeviceOption): ViewportName[] {
  if (device === "both") return ["desktop", "mobile"];
  return [device];
}

function findElementId(snapshot: VisionSnapshot, selector: string): number | undefined {
  const lower = selector.toLowerCase();
  // exact match by data-testid value
  const testIdMatch = lower.match(/data-testid[*=^$]?='([^']+)'/) || lower.match(/data-testid[*=^$]?="([^"]+)"/);
  if (testIdMatch) {
    const needle = testIdMatch[1].toLowerCase();
    const hit = snapshot.elements.find(
      (el) => el.name.toLowerCase().includes(needle) || (el.placeholder ?? "").toLowerCase().includes(needle)
    );
    if (hit) return hit.id;
  }
  if (selector.includes("[type='email']") || selector.includes('[type="email"]') || selector.includes("name*='email'")) {
    return snapshot.elements.find((el) => el.type === "email" || /email/i.test(el.name) || /email/i.test(el.placeholder ?? ""))?.id;
  }
  if (selector.includes("[type='password']") || selector.includes('[type="password"]') || selector.includes("name*='password'")) {
    return snapshot.elements.find((el) => el.type === "password" || /password/i.test(el.name) || /password/i.test(el.placeholder ?? ""))?.id;
  }
  if (selector.includes("[type='tel']") || selector.includes("name*='phone']") || selector.includes("phone")) {
    return snapshot.elements.find((el) => el.type === "tel" || /phone/i.test(el.name) || /phone/i.test(el.placeholder ?? ""))?.id;
  }
  if (selector.includes("type='submit'") || /login|sign in|submit/i.test(selector)) {
    return snapshot.elements.find((el) => el.role === "button" && /(login|sign in|submit)/i.test(el.name))?.id;
  }
  if (/save/i.test(selector)) {
    return snapshot.elements.find((el) => el.role === "button" && /save/i.test(el.name))?.id;
  }
  if (/profile/i.test(selector)) {
    return snapshot.elements.find((el) => /profile/i.test(el.name) || (el.href ?? "").toLowerCase().includes("profile"))?.id;
  }
  return undefined;
}

function legacyAssertToNew(a: LegacyAssertion): VisionAssertInput | undefined {
  if (a.type === "textVisible") {
    return { kind: "textVisible", value: a.text ?? a.value ?? "", timeoutMs: a.timeoutMs };
  }
  if (a.type === "toastVisible") {
    return { kind: "toastVisible", value: a.text ?? a.value, timeoutMs: a.timeoutMs, exact: a.exact };
  }
  if (a.type === "errorVisible") {
    return { kind: "errorVisible", value: a.text ?? a.value, timeoutMs: a.timeoutMs, exact: a.exact };
  }
  if (a.type === "urlContains") {
    return { kind: "urlContains", value: a.value ?? "", timeoutMs: a.timeoutMs };
  }
  return undefined;
}

export async function runVisionCheck(
  input: VisionCheckInput,
  emit?: EventEmitter
): Promise<VisionCheckResult> {
  const session = getActiveSession(emit);
  emit?.({ type: "status", state: "running", device: input.device, url: input.url });

  const viewports = deviceList(input.device);
  const result: VisionCheckResult = {
    status: "FAIL",
    url: input.url,
    checks: [],
    timestamp: new Date().toISOString()
  };
  const behaviorErrors: string[] = [];
  let behaviorPass = true;
  let evidence = { toasts: [], alerts: [], errors: [] } as {
    toasts: string[];
    alerts: string[];
    errors: string[];
  };

  const steps = input.script?.steps ?? [];
  const assertions = input.script?.assertions ?? [];
  result.resolvedScript = { source: "manual", steps, assertions };

  if (steps.length === 0 && assertions.length === 0 && !input.task) {
    // pure smoke check
    for (const viewport of viewports) {
      try {
        const snapshot = await session.open(input.url, viewport);
        evidence = snapshot.evidence;
        result.finalUrl = snapshot.url;
        result.checks.push({ viewport, diffPixels: 0, diffPercent: 0 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        result.failureType = "navigation_failed";
        result.errorMessage = msg;
        result.nextAction = "start_server";
        result.suggestion = "Verify the dev server is running and reachable.";
        result.evidence = evidence;
        emit?.({ type: "status", state: "done", result });
        return result;
      }
    }
    result.status = "PASS";
    result.evidence = evidence;
    emit?.({ type: "status", state: "done", result });
    return result;
  }

  if (steps.length === 0 && input.task) {
    result.failureType = "plan_empty";
    result.errorMessage =
      "Plain-English auto-planning is no longer supported in vision_check. Use vision_open + vision_observe + vision_act for conversational control.";
    result.nextAction = "provide_steps";
    result.suggestion =
      "Switch your CLI to call vision_open / vision_observe / vision_act for full control, or provide explicit script.steps.";
    result.evidence = evidence;
    emit?.({ type: "status", state: "done", result });
    return result;
  }

  for (const viewport of viewports) {
    let snapshot: VisionSnapshot;
    try {
      snapshot = await session.open(input.url, viewport);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Navigation failed";
      result.failureType = "navigation_failed";
      result.errorMessage = msg;
      result.nextAction = "start_server";
      result.suggestion = "Verify the dev server is running and reachable.";
      result.evidence = evidence;
      emit?.({ type: "status", state: "done", result });
      return result;
    }
    evidence = snapshot.evidence;
    result.finalUrl = snapshot.url;
    result.checks.push({ viewport, diffPixels: 0, diffPercent: 0 });

    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      try {
        if (step.action === "navigate" && step.url) {
          snapshot = await session.navigate(step.url);
        } else if (step.action === "waitForUrl" && step.urlContains) {
          snapshot = await session.wait({
            kind: "urlContains",
            value: step.urlContains,
            timeoutMs: step.timeoutMs
          });
        } else if (step.action === "waitFor") {
          if (step.selector) {
            snapshot = await session.wait({
              kind: "selectorVisible",
              value: step.selector,
              timeoutMs: step.timeoutMs ?? step.ms
            });
          } else {
            snapshot = await session.wait({ kind: "ms", value: step.ms ?? 300 });
          }
        } else if (step.selector && (step.action === "fill" || step.action === "click" || step.action === "press")) {
          let id = findElementId(snapshot, step.selector);
          if (!id) {
            for (const fb of step.fallbackSelectors ?? []) {
              id = findElementId(snapshot, fb);
              if (id) break;
            }
          }
          if (!id) {
            throw new Error(`Could not match selector to any visible element: ${step.selector}`);
          }
          if (step.action === "fill") {
            snapshot = await session.act({ id, action: "fill", value: step.value ?? "" });
          } else if (step.action === "click") {
            snapshot = await session.act({ id, action: "click" });
          } else {
            snapshot = await session.act({ id, action: "press", key: step.key ?? "Enter" });
          }
        }
        evidence = snapshot.evidence;
        result.finalUrl = snapshot.url;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Step failed";
        behaviorPass = false;
        behaviorErrors.push(`[${viewport}] step ${i} (${step.action}) failed: ${msg}`);
        result.failureType = "step_failed";
        result.errorMessage = msg;
        result.nextAction = "fix_selector";
        result.suggestion =
          "Use the granular vision_observe/vision_act tools instead of CSS selectors for reliable element targeting.";
        break;
      }
    }

    if (behaviorPass) {
      for (const assertion of assertions) {
        const mapped = legacyAssertToNew(assertion);
        if (!mapped) continue;
        const out = await session.assert(mapped);
        evidence = out.evidence;
        if (!out.pass) {
          behaviorPass = false;
          behaviorErrors.push(`[${viewport}] assertion ${assertion.type} failed: ${out.message ?? ""}`);
          result.failureType = "assertion_failed";
          result.errorMessage = out.message;
          result.nextAction = "retry_with_wait";
          result.suggestion = "Increase timeoutMs or use a more specific assertion.";
          break;
        }
      }
    }
  }

  if (assertions.length > 0) result.behaviorPass = behaviorPass;
  if (behaviorErrors.length > 0) result.behaviorErrors = behaviorErrors;
  result.evidence = evidence;
  result.status = behaviorPass && !result.failureType ? "PASS" : "FAIL";
  if (result.status === "FAIL" && !result.failureType) {
    result.failureType = "unknown";
    result.nextAction = "inspect_unknown";
  }
  emit?.({ type: "status", state: "done", result });
  return result;
}

export { getActiveSession, disposeActiveSession } from "./session";
