// Centralized toast + confirm store (Svelte 5 runes module).
//
// Runes are allowed in `.svelte.js` modules. We export a single reactive
// `toastState` object and MUTATE its properties (never reassign the export) so
// reactivity is preserved across every importing component.
//
//   import { toast, confirmDialog } from "../shared/stores/toasts.svelte.js";
//   toast.success("Profile created");
//   if (await confirmDialog({ message: "Delete this?", danger: true })) { ... }
//
// <Toaster /> (mounted once in App.svelte) renders `toastState`.

let _id = 0;

/** @type {{ items: Array<{id:number,type:string,title:string,message:string}>, confirm: any }} */
export const toastState = $state({ items: [], confirm: null });

const DEFAULT_TIMEOUT = { success: 4000, info: 5000, warning: 7000, error: 9000 };

/**
 * Push a toast. Returns its id so callers can dismiss it early.
 * Pass `timeout: 0` to make it sticky (manual dismiss only).
 */
export function pushToast({ type = "info", title = "", message = "", timeout } = {}) {
  const id = ++_id;
  toastState.items.push({ id, type, title, message: String(message ?? "") });
  const ms = timeout ?? DEFAULT_TIMEOUT[type] ?? 5000;
  if (ms > 0) setTimeout(() => dismissToast(id), ms);
  return id;
}

export function dismissToast(id) {
  const i = toastState.items.findIndex((t) => t.id === id);
  if (i !== -1) toastState.items.splice(i, 1);
}

export function clearToasts() {
  toastState.items.splice(0, toastState.items.length);
}

/** Convenience helpers. */
export const toast = {
  success: (message, title = "Success") => pushToast({ type: "success", title, message }),
  error: (message, title = "Error") => pushToast({ type: "error", title, message }),
  warning: (message, title = "Heads up") => pushToast({ type: "warning", title, message }),
  info: (message, title = "") => pushToast({ type: "info", title, message }),
};

/**
 * Promise-based replacement for window.confirm().
 * Resolves true on confirm, false on cancel / backdrop / Escape.
 */
export function confirmDialog({
  title = "Are you sure?",
  message = "",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    // If a confirm is already open, resolve it as cancelled first.
    if (toastState.confirm) toastState.confirm.resolve(false);
    toastState.confirm = {
      title,
      message,
      confirmLabel,
      cancelLabel,
      danger,
      resolve: (val) => {
        toastState.confirm = null;
        resolve(val);
      },
    };
  });
}
